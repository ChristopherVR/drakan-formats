import { type Ps2Entry, parseDbText, writePs2Srsc } from './ootfcontainer.ts';
import {
    type Ps2TextureOptions,
    type RgbaImage,
    PC_TEX_MIPMAP,
    encodePs2Texture,
    isSkip,
    parsePcTextureInfo,
    readPcTexture,
} from './ootftex.ts';
import { view } from './bytes.ts';
import { type OdbClass, classFieldDefault } from './odb.ts';
import { type PcFileSource, type PcLevel, parsePcOdbClasses, resolvePcPath } from './pc.ts';
import { SrscReader } from './srsc.ts';
import { TEX_HOLE, TEX_INVISIBLE, type TerrainLayer } from './terrain.ts';
import { LAYER_TYPE_WATER } from './convert.ts';
import { TXD_ENTRY_TYPE, decodeTxd } from './txd.ts';
import { planTerrainSlots } from './terrainblob.ts';
import type { LvlHeader } from './lvl.ts';

/**
 * Terrain textures of an Order of the Flame level -> the converted PS2 level. Findings and in-game evidence:
 * docs/journal/2026-10-31/ootf-terrain.md.
 *
 * PS2 cell refs are `u16 id, u16 db`, db = index into the LVL dependency table. Verified in the game: terrain refs
 * into the template's `Proc Textures` dependency (db 9 in LEVEL1NA, file `WORLDCON/PROCTEES/PROCTEES.TXD`) with new ids
 * draw correctly when that TXD is replaced by a copy with the converted textures appended. Refs into the `_splats`
 * container (db 24) or into a new dependency did NOT work (world freeze / null call). So the one TXD to ship is the
 * template's PROCTEES.TXD plus the converted textures (`TerrainTextureBuilder.build()`), at `TERRAIN_TXD_PATH`.
 */

/** Where the replacement `Proc Textures` TXD goes inside a mod pack. */
export const TERRAIN_TXD_PATH = 'files/ENGLISH/WORLDCON/PROCTEES/PROCTEES.TXD';
/**
 * u32 at texture header +40 of converted terrain textures: the texture's material, a class of `PROCTEES.ODB` (0 in splat
 * textures). The material decides how the engine draws the texture: its "Base Tiling Size" is how many cells one tile spans
 * (the disc's grass and dirt 1, snow 2, outdoor rock 4), its "Splat Fade Distance" how far the texture is drawn over the far
 * colour map, and it gives the foot-step sounds. A PC terrain tile spans exactly one cell (every cell of every campaign level
 * maps 0..1), so the material must tile once per cell. 55 is "Patchy Snow": Base Tiling Size 1, fade 30 cells (as before),
 * no noise pass, snow foot-steps. It was 45 "Blue Snow", whose Base Tiling Size 2 stretched every converted ground texture
 * over 2 x 2 cells, twice the PC size and half its sharpness (seen in game, journal 2026-11-14/ootf-terrain-look.md). 1 is
 * "Water" (drew flat dark olive on ground); ids that are not PROCTEES classes (a counter from 114 up) froze the world in the
 * 2026-10-31 runs (journal 2026-11-08/ootf-water.md). `DRAKAN_TERRAIN_SLOT=45` gives the old look.
 */
export const TERRAIN_TEXTURE_SLOT = 55;

/**
 * Liquid surfaces. A PC terrain texture whose material (texture header +38, a class ref into the texture container's ODB)
 * is the Drakan 1 liquid material (RFL class 0x72: "Water", "blended water", "Lava FX", ...) is drawn by the PS2 engine's
 * water path only when the cell names a Proc Textures entry with a PS2 liquid material (header +40: PROCTEES classes of
 * engine class 0x100d1, which carry the scrolling textures, flow, alpha by distance, waves and specular). The disc's own
 * entries are placeholders (a "T" or an arrow) that are never shown. So liquid textures are not converted: water maps to a
 * Drakan 2 water (`nativeWaterTextures`; PROCTEES 0x10e, material 1 "Water", is the PS2 port of the same PC "Water"
 * material and the fallback), lava (damage above 0) to 0x1d7 ("Lava (Base)", Andrellian Isles, Northern Tundra). Journal 2026-11-08/ootf-water.md.
 */
export const PC_LIQUID_MATERIAL_CLASS = 0x72;
export const PS2_WATER_TEXTURE = 0x10e;
export const PS2_LAVA_TEXTURE = 0x1d7;
/** PROCTEES 0x471d: material 240 "Surdana Water" (Surdana, Ravenshold, Valley, Stratos), the look of mountain water. */
export const PS2_SURDANA_WATER_TEXTURE = 0x471d;
/**
 * Native water entries for a PC water texture of `container` (an install path without extension), best first. Mountain water
 * (Ruined Village, Wartok, the Intro, the mines, Volcano) takes Surdana's water; the Islands world keeps the plain "Water"
 * material: its seas carry the 60% shallow vertex kind (0x71), and with Surdana Water they drew pale sand coloured, with
 * PROCTEES 0x467f ("Stormy Water_Level 3a") grey gravel (journal 2026-11-08/ootf-water.md).
 */
export function nativeWaterTextures(container: string): number[] {
    return /^islands world\//i.test(container) ? [PS2_WATER_TEXTURE] : [PS2_SURDANA_WATER_TEXTURE, PS2_WATER_TEXTURE];
}

export interface TerrainTextureOptions {
    texture?: Ps2TextureOptions;
    /** Largest edge written for a terrain texture (default 256 = the largest PC source; 128 halved 54 of the Ruined Village textures). */
    maxSize?: number;
    /** Smallest edge for an opaque terrain texture (default 128 = the disc ground density; 0 keeps PC sizes). */
    minSize?: number;
    /** Keep only the N most used textures per level; the rest map to the nearest kept one by mean colour (default no cap). */
    maxTextures?: number;
    /** First id given to a converted texture (default: past the highest id in the base TXD, at least 1000). */
    firstId?: number;
    /** Header +40 value (default `TERRAIN_TEXTURE_SLOT`). */
    slot?: number;
}

export interface TerrainTextureReport {
    converted: number;
    reduced: number;
    skipped: Map<string, string>;
    bytes: number;
    /** Cells (summed over the levels added so far) whose texture has no mapping and falls back. */
    cellsUnmapped: number;
    /** PC liquid textures mapped to the template's native water / lava entries (`PS2_WATER_TEXTURE`, `PS2_LAVA_TEXTURE`). */
    liquids?: number;
}

/** The dependency index of the template's `Proc Textures` entry (9 in LEVEL1NA), or undefined. */
export function findTerrainDbIndex(header: LvlHeader): number | undefined {
    return header.dependencies.find((d) => /proc textures$/i.test(d.path.text))?.dbIndex;
}

/** The dependency index of the template's `_splats` entry (24 in LEVEL1NA), or undefined. */
export function findSplatDbIndex(header: LvlHeader): number | undefined {
    return header.dependencies.find((d) => /_splats$/i.test(d.path.text))?.dbIndex;
}

function containerOf(pc: PcLevel, db: number): string | null {
    const lvlBase = pc.path.replace(/\.lvl$/i, '');
    if (db === 0) return lvlBase;
    const dep = pc.header.dependencies.find((d) => d.dbIndex === db);
    if (!dep) return null;
    return resolvePcPath(pc.path.split('/').slice(0, -1).join('/'), dep.path.text);
}

function meanColor(rgba: Uint8Array): [number, number, number] {
    let r = 0;
    let g = 0;
    let b = 0;
    const n = rgba.length / 4;
    const step = Math.max(1, Math.floor(n / 1024));
    let k = 0;
    for (let i = 0; i < n; i += step) {
        r += rgba[i * 4]!;
        g += rgba[i * 4 + 1]!;
        b += rgba[i * 4 + 2]!;
        k++;
    }
    return [r / k, g / k, b / k];
}

/** Dev knobs for in-game experiments (process.env is absent in the browser). */
function env(k: string): number | undefined {
    const v = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.[k];
    return v ? Number(v) : undefined;
}

/**
 * Accumulates converted terrain textures from any number of levels into one TXD (the base TXD plus new ids), so levels
 * of one pack share ids. Use `addLevel` per level (async), then `build()` once.
 */
export class TerrainTextureBuilder {
    readonly report: TerrainTextureReport = {
        converted: 0,
        reduced: 0,
        skipped: new Map(),
        bytes: 0,
        cellsUnmapped: 0,
    };
    private readonly entries: Ps2Entry[] = [];
    private readonly containers = new Map<string, SrscReader | null>();
    /** `container#id` (lower case) -> new id in the target TXD. */
    private readonly ids = new Map<string, number>();
    private readonly means = new Map<number, [number, number, number]>();
    /** Texture id -> its picture shrunk to `TERRAIN_POOL_TEXELS_PER_CELL` squared texels (far textures). */
    private readonly smalls = new Map<number, Float32Array | null>();
    /** `<container>.odb` (lower case) -> its classes; `<container>.db` -> its dependency list. */
    private readonly odbs = new Map<string, Promise<Map<number, OdbClass> | null>>();
    private readonly dbs = new Map<string, Promise<Map<number, string> | null>>();
    private nextId: number;

    private constructor(
        private readonly src: PcFileSource,
        /** Dependency index the new refs use. */
        readonly db: number,
        private readonly opt: TerrainTextureOptions,
        firstFree: number,
    ) {
        this.nextId = opt.firstId ?? Math.max(1000, firstFree);
    }

    /** `baseTxd` is the template's Proc Textures TXD (its entries are re-written unchanged). */
    static async create(
        src: PcFileSource,
        baseTxd: Uint8Array,
        db: number,
        opt: TerrainTextureOptions = {},
    ): Promise<TerrainTextureBuilder> {
        const base = await SrscReader.fromBytes(baseTxd);
        let maxId = 0;
        const entries: Ps2Entry[] = [];
        for (const e of base.entries) {
            entries.push({ type: e.type, id: e.id, sub: e.sub, data: await base.readRaw(e) });
            if (e.type === TXD_ENTRY_TYPE) maxId = Math.max(maxId, e.id);
        }
        const b = new TerrainTextureBuilder(src, db, opt, maxId + 1);
        b.entries.push(...entries);
        return b;
    }

    private async open(c: string): Promise<SrscReader | null> {
        const k = c.toLowerCase();
        if (!this.containers.has(k)) {
            const bytes = await this.src.read(`${c}.txd`);
            this.containers.set(k, bytes ? await SrscReader.fromBytes(bytes) : null);
        }
        return this.containers.get(k)!;
    }

    /**
     * Convert every texture the level's terrain uses (most used first). Returns the synchronous `mapTexture` for
     * `ConvertOptions.mapTexture` (PC ref -> `db << 16 | id`, null when the texture could not be converted).
     */
    async addLevel(pc: PcLevel): Promise<(pcRef: number, pc: PcLevel, layer?: TerrainLayer) => number | null> {
        const opt = this.opt;
        const maxTextures = opt.maxTextures ?? env('DRAKAN_TERRAIN_TEX_COUNT') ?? Infinity;
        const maxSize = opt.maxSize ?? env('DRAKAN_TERRAIN_TEX_MAX') ?? 256;
        const noRef = env('DRAKAN_TERRAIN_NOREF') === 1;
        const uses = new Map<number, number>();
        const waterUses = new Map<number, number>();
        for (const L of pc.terrain) {
            const m = L.type === LAYER_TYPE_WATER ? waterUses : uses;
            for (const r of L.cellTexLeft) {
                if (r !== TEX_HOLE && r !== TEX_INVISIBLE) m.set(r, (m.get(r) ?? 0) + 1);
            }
        }
        // Water layers: liquid textures take the template's native liquid entries (see PS2_WATER_TEXTURE); a liquid
        // texture also painted on floor cells is converted for those as well (the native entry is a placeholder picture).
        const liquids = new Map<number, number>();
        for (const ref of waterUses.keys()) {
            const c = containerOf(pc, ref >>> 16);
            const liquid = c ? await this.liquidOf(c, ref & 0xffff) : null;
            const options = liquid === 'water' ? nativeWaterTextures(c!) : liquid === 'lava' ? [PS2_LAVA_TEXTURE] : [];
            const native = options.find((id) => this.hasEntry(id));
            if (native !== undefined) liquids.set(ref, ((this.db << 16) | native) >>> 0);
        }
        this.report.liquids = (this.report.liquids ?? 0) + liquids.size;
        for (const [r, n] of waterUses) if (!liquids.has(r)) uses.set(r, (uses.get(r) ?? 0) + n);
        const order = [...uses.entries()].sort((a, b) => b[1] - a[1]).map((x) => x[0]);
        const keyOf = (ref: number): string | null => {
            const c = containerOf(pc, ref >>> 16);
            return c ? `${c.toLowerCase()}#${ref & 0xffff}` : null;
        };
        const level = new Map<number, number>(); // PC ref -> full PS2 ref for this level
        const colors: { ref: number; mean: [number, number, number]; made: boolean }[] = [];
        let made = 0;
        for (const ref of order) {
            const key = keyOf(ref);
            const label = `${ref >>> 16}/${ref & 0xffff}`;
            if (!key) {
                this.report.skipped.set(label, `dependency ${ref >>> 16} not found`);
                continue;
            }
            const known = this.ids.get(key);
            if (known !== undefined && made < maxTextures) {
                level.set(ref, ((this.db << 16) | known) >>> 0);
                colors.push({ ref, mean: this.means.get(known)!, made: true });
                made++;
                continue;
            }
            const img = await this.decode(containerOf(pc, ref >>> 16)!, ref & 0xffff, label);
            if (!img) continue;
            const mean = meanColor(img.rgba);
            if (made >= maxTextures) {
                colors.push({ ref, mean, made: false }); // over the cap: only its colour matters
                continue;
            }
            if (this.nextId > 0xffff) {
                this.report.skipped.set(label, 'texture id space exhausted');
                continue;
            }
            const tex = encodePs2Texture(img, {
                fps: 10,
                maxSize,
                minSize: opt.minSize ?? env('DRAKAN_TERRAIN_TEX_MIN') ?? 128,
                slot: opt.slot ?? env('DRAKAN_TERRAIN_SLOT') ?? TERRAIN_TEXTURE_SLOT,
                // Native terrain shares a ~5.4 MiB texture cache with objects. RGBA tiles can evict each other
                // while cinematic actors wait for resources. Retain dimensions and use the native palette path.
                mode:
                    ({ 0: 'indexed', 1: 'auto', 2: 'truecolor' } as const)[env('DRAKAN_TERRAIN_TEX_MODE') ?? 0] ??
                    'indexed',
                maxTruecolorPixels: Infinity, // explicit truecolor experiments may retain their original dimensions
                ...opt.texture,
            });
            const id = this.nextId++;
            this.entries.push({ type: TXD_ENTRY_TYPE, id, sub: 0, data: tex.body });
            this.ids.set(key, id);
            this.means.set(id, mean);
            this.smalls.set(id, cellTexelsOf(decodeTxd(tex.body, { upright: false })));
            level.set(ref, ((this.db << 16) | id) >>> 0);
            colors.push({ ref, mean, made: true });
            made++;
            this.report.converted++;
            this.report.bytes += tex.body.length;
        }
        // Reduction: textures past the cap take the nearest converted one of this level by mean colour.
        const have = colors.filter((d) => d.made);
        for (const d of colors) {
            if (d.made || !have.length) continue;
            let best = have[0]!;
            let bd = Infinity;
            for (const k of have) {
                const dist = (k.mean[0] - d.mean[0]) ** 2 + (k.mean[1] - d.mean[1]) ** 2 + (k.mean[2] - d.mean[2]) ** 2;
                if (dist < bd) {
                    bd = dist;
                    best = k;
                }
            }
            level.set(d.ref, level.get(best.ref)!);
            this.report.reduced++;
        }
        for (const [r, n] of uses) if (!level.has(r)) this.report.cellsUnmapped += n;
        return (ref, _pc, layer) =>
            noRef
                ? null
                : ((layer?.type === LAYER_TYPE_WATER ? liquids.get(ref) : undefined) ?? level.get(ref) ?? null);
    }

    private hasEntry(id: number): boolean {
        return this.entries.some((x) => x.type === TXD_ENTRY_TYPE && x.id === id);
    }

    private cached<T>(
        m: Map<string, Promise<T | null>>,
        key: string,
        load: () => Promise<T | null>,
    ): Promise<T | null> {
        const k = key.toLowerCase();
        let p = m.get(k);
        if (!p) {
            p = load().catch(() => null);
            m.set(k, p);
        }
        return p;
    }

    /**
     * 'water' / 'lava' when PC texture `id` of `<container>.txd` has the Drakan 1 liquid material (`PC_LIQUID_MATERIAL_CLASS`;
     * lava = a damage above 0), else null. The material ref is `db << 16 | class`, db indexing `<container>.db` (0 = itself).
     */
    async liquidOf(container: string, id: number): Promise<'water' | 'lava' | null> {
        const c = await this.materialOf(container, id);
        if (!c || ((c.rflClass ?? c.runtimeClass ?? 0) & 0xffff) !== PC_LIQUID_MATERIAL_CLASS) return null;
        const dmg = c.fields?.findIndex((f) => f.name.startsWith('Damage (')) ?? -1;
        const damage = dmg >= 0 ? classFieldDefault(c, dmg) : 0;
        return typeof damage === 'number' && damage > 0 ? 'lava' : 'water';
    }

    /**
     * The PC material class of texture `id` of `<container>.txd` (texture header +38, `db << 16 | class`, db indexing
     * `<container>.db`, 0 = the container itself), or null.
     */
    async materialOf(container: string, id: number): Promise<OdbClass | null> {
        const txd = await this.open(container);
        const e = txd?.find(TXD_ENTRY_TYPE, id);
        if (!txd || !e) return null;
        let ref: number;
        try {
            ref = parsePcTextureInfo(await txd.readRaw(e)).materialRef;
        } catch {
            return null;
        }
        const db = ref >>> 16;
        let owner: string | null = container;
        if (db !== 0) {
            const deps = await this.cached(this.dbs, container, async () => {
                const b = await this.src.read(`${container}.db`);
                return b ? parseDbText(new TextDecoder('latin1').decode(b)) : null;
            });
            const rel = deps?.get(db);
            owner = rel ? resolvePcPath(container.split('/').slice(0, -1).join('/'), rel) : null;
        }
        if (!owner) return null;
        const classes = await this.cached(this.odbs, owner, async () => {
            const b = await this.src.read(`${owner}.odb`);
            return b ? parsePcOdbClasses(await SrscReader.fromBytes(b)) : null;
        });
        return classes?.get(ref & 0xffff) ?? null;
    }

    private async decode(container: string, id: number, label: string): Promise<RgbaImage | null> {
        const txd = await this.open(container);
        if (!txd) {
            this.report.skipped.set(label, `${container}.txd not found`);
            return null;
        }
        const t = await readPcTexture(txd, id);
        if (isSkip(t)) {
            this.report.skipped.set(label, t.reason);
            return null;
        }
        if (t.info.flags & PC_TEX_MIPMAP) {
            this.report.skipped.set(label, 'mip map entry');
            return null;
        }
        return t.image;
    }

    /**
     * Mean RGB of a texture in the target TXD (a cell ref `db << 16 | id` or a bare id): the converted ones from their
     * source pixels, the template's own entries (the fallback ground) decoded once. Null when the id is not in the TXD.
     */
    meanOfRef(ref: number): [number, number, number] | null {
        const id = ref & 0xffff;
        const known = this.means.get(id);
        if (known) return known;
        const e = this.entries.find((x) => x.type === TXD_ENTRY_TYPE && x.id === id);
        if (!e) return null;
        let mean: [number, number, number];
        try {
            mean = meanColor(decodeTxd(e.data).rgba);
        } catch {
            return null;
        }
        this.means.set(id, mean);
        return mean;
    }

    /**
     * The texture of a cell ref (as `meanOfRef`) shrunk to the far textures' density, `TERRAIN_POOL_TEXELS_PER_CELL` squared
     * RGB texels in stored row order (`cellTexelsOf`), or null when the id is not in the TXD.
     */
    texelsOfRef(ref: number): Float32Array | null {
        const id = ref & 0xffff;
        if (this.smalls.has(id)) return this.smalls.get(id)!;
        const e = this.entries.find((x) => x.type === TXD_ENTRY_TYPE && x.id === id);
        let t: Float32Array | null = null;
        try {
            t = e ? cellTexelsOf(decodeTxd(e.data, { upright: false })) : null;
        } catch {
            t = null;
        }
        this.smalls.set(id, t);
        return t;
    }

    /** The target TXD: the base entries followed by every converted texture. Ship it at `TERRAIN_TXD_PATH`. */
    build(): Uint8Array {
        return writePs2Srsc(this.entries);
    }
}

export interface TerrainTextures {
    /** `ConvertOptions.mapTexture` compatible. */
    mapTexture: (pcRef: number, pc: PcLevel, layer?: TerrainLayer) => number | null;
    /** The target TXD with the converted textures appended (for `TERRAIN_TXD_PATH`). */
    txd: Uint8Array;
    /** Dependency index the new refs use. */
    splatDb: number;
    report: TerrainTextureReport;
}

/**
 * One-level convenience over `TerrainTextureBuilder`. Pass the template's Proc Textures TXD and `findTerrainDbIndex`
 * (the parameter names `splatTxd` / `splatDb` are historical: a splat TXD does not work, see the module comment).
 */
export async function convertTerrainTextures(
    pc: PcLevel,
    src: PcFileSource,
    splatTxd: Uint8Array,
    splatDb: number,
    opt: TerrainTextureOptions = {},
): Promise<TerrainTextures> {
    const b = await TerrainTextureBuilder.create(src, splatTxd, splatDb, opt);
    const mapTexture = await b.addLevel(pc);
    return { mapTexture, txd: b.build(), splatDb, report: b.report };
}

/**
 * PS2 cell flags for a converted layer: bit 0 (diagonal) and bits 2 / 3 come from the PC flags; the high byte is 0xff
 * (opaque), the value of 95 % of the cells in the disc's levels (lower values fade the border of a layer into the layer
 * below). Bits 2 and 3 occur in the same combinations and proportions on both platforms (d : c : 9 : 5 : 8 : 4 =
 * 253k : 141k : 16k : 16k : 15k : 15k on the PAL discs, 7.0k : 1.4k : 0.7k : 0.7k : 0.8k : 0.8k in Ruined Village), so they are
 * carried over. Native collision tests skip the two triangles for flags 0x40 / 0x80 (PAL 15a2f0); texture sentinels
 * alone do not remove collision. Full holes therefore require 0xc0. Invisible cells use 0x30 on the disc and retain
 * collision. A converted layer's own triangle bits (0x40 / 0x80 / 0x10 / 0x20 on a cell with one hole or invisible triangle,
 * `ps2TriangleBits`) are kept. PC bit 1 is dropped. `DRAKAN_TERRAIN_CELLBITS` (default 0x0d) overrides the carried source bits only.
 */
export function ps2CellFlags(L: TerrainLayer, mask = cellBitsMask()): Uint16Array {
    const out = new Uint16Array(L.cellFlags.length);
    for (let c = 0; c < out.length; c++) {
        const ref = L.cellTexLeft[c]!;
        // A converted layer already carries per-triangle bits (`ps2TriangleBits`): a cell with one hole triangle keeps them.
        const own = L.source === 'ps2' ? L.cellFlags[c]! & 0xf0 : 0;
        const special = ref === TEX_HOLE ? 0xc0 : ref === TEX_INVISIBLE ? 0x30 | own : own;
        out[c] = 0xff00 | (L.cellFlags[c]! & mask) | special;
    }
    return out;
}

function cellBitsMask(): number {
    return (env('DRAKAN_TERRAIN_CELLBITS') ?? 0x0d) & 0xff;
}

/**
 * Budget for the total `visible` entries over all layers. The largest disc level has 41362 (LEVEL1NA: 483 layers, longest list 221).
 * It was 40000 after Volcano (941 layers, 67105 entries) crashed in 2026-11-01 runs; those crashes came from the ODB class counts
 * (fixed in ModPack) and Volcano now loads uncapped, three runs in a row (journal 2026-11-02/ootf-native-mips.md), so the default
 * is unlimited. `DRAKAN_TERRAIN_VISBUDGET=<n>` brings the cap back for experiments.
 */
export const MAX_VISIBLE_ENTRIES = Infinity;

/**
 * Cap the layers' `visible` lists so that their total stays within `budget`. Volcano (941 layers, 67105 entries) crashed in game
 * (corrupted objects, wild JALR at a kill-list flush) at every cap tried above the disc maximum and passed with 60 per list, so
 * the engine evidently sizes something by the total. Every list keeps its nearest layers (by origin), the longest lists are cut
 * first: the smallest per-list cap `n` with sum(min(len, n)) <= budget is used. Levels under the budget come back unchanged.
 */
export function limitVisibleEntries(
    layers: readonly TerrainLayer[],
    budget = env('DRAKAN_TERRAIN_VISBUDGET') ?? MAX_VISIBLE_ENTRIES,
): TerrainLayer[] {
    const total = layers.reduce((a, L) => a + L.visible.length, 0);
    if (total <= budget) return [...layers];
    let lo = 0;
    let hi = Math.max(...layers.map((L) => L.visible.length));
    while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (layers.reduce((a, L) => a + Math.min(L.visible.length, mid), 0) <= budget) lo = mid;
        else hi = mid - 1;
    }
    const byIndex = new Map(layers.map((L) => [L.index, L]));
    return layers.map((L) =>
        L.visible.length <= lo
            ? L
            : {
                  ...L,
                  visible: L.visible
                      .map((v) => ({
                          v,
                          d: Math.hypot(
                              (byIndex.get(v)?.originX ?? 0) - L.originX,
                              (byIndex.get(v)?.originZ ?? 0) - L.originZ,
                          ),
                      }))
                      .sort((x, y) => x.d - y.d)
                      .slice(0, lo)
                      .map((x) => x.v),
              },
    );
}

/** Texels per cell edge in a terrain group's far texture (disc: `x_hi = 4w - 1`, journal 2026-11-08/ootf-pink-textures.md). */
export const TERRAIN_POOL_TEXELS_PER_CELL = 4;
/** Header +44 (f32) of the disc's far textures (every `LEVEL*TS.TXD` entry); terrain textures carry 4. */
const POOL_HEADER_SCALE = 256;

/**
 * A ground texture shrunk to the far textures' density: `TERRAIN_POOL_TEXELS_PER_CELL` squared RGB texels (box filter), rows
 * in the picture's stored order, 48 floats. A converted tile spans one cell (`TERRAIN_TEXTURE_SLOT`), so these are the
 * texels of that cell in a far texture.
 */
export function cellTexelsOf(img: { width: number; height: number; rgba: Uint8Array }): Float32Array {
    const n = TERRAIN_POOL_TEXELS_PER_CELL;
    const out = new Float32Array(n * n * 3);
    for (let ty = 0; ty < n; ty++)
        for (let tx = 0; tx < n; tx++) {
            const y0 = Math.floor((ty * img.height) / n);
            const y1 = Math.max(y0 + 1, Math.floor(((ty + 1) * img.height) / n));
            const x0 = Math.floor((tx * img.width) / n);
            const x1 = Math.max(x0 + 1, Math.floor(((tx + 1) * img.width) / n));
            const sum = [0, 0, 0];
            for (let y = y0; y < y1; y++)
                for (let x = x0; x < x1; x++)
                    for (let k = 0; k < 3; k++) sum[k]! += img.rgba[(y * img.width + x) * 4 + k]!;
            const cnt = (y1 - y0) * (x1 - x0);
            for (let k = 0; k < 3; k++) out[(ty * n + tx) * 3 + k] = sum[k]! / cnt;
        }
    return out;
}

/**
 * The level's own `_splats` TXD (`<level>TS.TXD`): texture `n` is the far texture of terrain group `seq` n. The engine draws
 * distant terrain with it instead of the cell textures: each layer samples the `pool x pool` texture at its slot rectangle
 * (`x_lo..x_hi`, `z_lo..z_hi` of the inline blob), 4 texels per cell, rows in stored order (LEVEL1NA against LEVEL1TS:
 * chroma error 0.035 for this placement, 0.12 and more for flipped ones; brightness ratio 0.97..1.01, so no lighting is
 * baked in). Packs used to ship the template's file, so far terrain showed Surdana's colours and, wherever a converted slot
 * fell into the template's unused pool area, its magenta (248, 100, 248) filler: the pink cliffs of Wartok Canyons. The
 * slots come from `planTerrainSlots` over the same layer list, exactly as `ps2BlobBuilder` places them.
 *
 * What a texel holds: the disc's far textures are a small picture of the blended ground, not one colour per cell (only 9 %
 * of the 4 x 4 cell blocks of LEVEL1TS are one colour: textures fade into each other across cells and keep their grain).
 * One flat colour per cell made distant Order of the Flame slopes, where nearly every cell has a texture of its own, a
 * mosaic of 4-texel squares (journal 2026-11-14/ootf-terrain-look.md). So each texel takes the blend the near passes draw:
 * the textures of the cells round a vertex, weighted by how many of its (up to four) cells use them like the blob's vertex
 * weights (`buildPs2TerrainBlob`), interpolated across the cell, each texture taken from its own shrunk picture at that
 * texel (`texelsOf`, `cellTexelsOf`). Without `texelsOf` (or for a ref it does not know) a texture counts with its mean
 * colour (`colorOf`, `TerrainTextureBuilder.meanOfRef`). Texels no drawn cell covers take the group's mean colour, so
 * filtering at a slot border never reaches a foreign colour.
 */
export function buildTerrainPoolTxd(
    layers: readonly TerrainLayer[],
    colorOf: (ref: number) => readonly [number, number, number] | null,
    texelsOf?: (ref: number) => Float32Array | null,
): Uint8Array {
    const plan = planTerrainSlots(layers);
    const groups = new Map<number, { pool: number; layers: TerrainLayer[] }>();
    for (const L of layers) {
        const s = plan.get(L.index);
        if (!s) continue;
        const g = groups.get(s.seq) ?? { pool: s.pool, layers: [] };
        g.pool = Math.max(g.pool, s.pool);
        g.layers.push(L);
        groups.set(s.seq, g);
    }
    const n = TERRAIN_POOL_TEXELS_PER_CELL;
    const drawn = (ref: number): boolean => ref !== TEX_HOLE && ref !== TEX_INVISIBLE && colorOf(ref) !== null;
    const samples = new Map<number, Float32Array>();
    /** n x n RGB texels of a ref: its shrunk picture, else its mean colour everywhere. */
    const sample = (ref: number): Float32Array => {
        let t = samples.get(ref);
        if (!t) {
            t = texelsOf?.(ref) ?? undefined;
            if (!t) {
                const m = colorOf(ref)!;
                t = new Float32Array(n * n * 3);
                for (let i = 0; i < n * n; i++) t.set(m, i * 3);
            }
            samples.set(ref, t);
        }
        return t;
    };
    const entries: Ps2Entry[] = [];
    for (const seq of [...groups.keys()].sort((a, b) => a - b)) {
        const { pool, layers: members } = groups.get(seq)!;
        const sum = [0, 0, 0];
        let count = 0;
        for (const L of members)
            for (const ref of L.cellTexLeft) {
                if (!drawn(ref)) continue;
                const m = colorOf(ref)!;
                for (let k = 0; k < 3; k++) sum[k]! += m[k]!;
                count++;
            }
        const fill = count ? sum.map((v) => Math.round(v / count)) : [128, 128, 128];
        const rgba = new Uint8Array(pool * pool * 4);
        for (let i = 0; i < pool * pool; i++) rgba.set([fill[0]!, fill[1]!, fill[2]!, 255], i * 4);
        for (const L of members) {
            const s = plan.get(L.index)!;
            const W = L.width;
            const H = L.height;
            const refAt = (x: number, z: number): number | null => {
                if (x < 0 || z < 0 || x >= W || z >= H) return null;
                const r = L.cellTexLeft[z * W + x]!;
                return drawn(r) ? r : null;
            };
            for (let cz = 0; cz < H; cz++)
                for (let cx = 0; cx < W; cx++) {
                    if (refAt(cx, cz) === null) continue;
                    // Corner (a, b) of the cell is vertex (cx + a, cz + b); its weight for a texture is the number of the four
                    // cells round that vertex using it.
                    const weights = new Map<number, number[]>();
                    for (let b = 0; b <= 1; b++)
                        for (let a = 0; a <= 1; a++)
                            for (let dz = -1; dz <= 0; dz++)
                                for (let dx = -1; dx <= 0; dx++) {
                                    const r = refAt(cx + a + dx, cz + b + dz);
                                    if (r === null) continue;
                                    const w = weights.get(r) ?? [0, 0, 0, 0];
                                    w[b * 2 + a]!++;
                                    weights.set(r, w);
                                }
                    for (let tz = 0; tz < n; tz++) {
                        const z = s.zLo + cz * n + tz;
                        if (z >= pool) continue;
                        const fz = (tz + 0.5) / n;
                        for (let tx = 0; tx < n; tx++) {
                            const x = s.xLo + cx * n + tx;
                            if (x >= pool) continue;
                            const fx = (tx + 0.5) / n;
                            const o = (tz * n + tx) * 3;
                            const acc = [0, 0, 0];
                            let total = 0;
                            for (const [r, w] of weights) {
                                const wt =
                                    (w[0]! * (1 - fx) + w[1]! * fx) * (1 - fz) + (w[2]! * (1 - fx) + w[3]! * fx) * fz;
                                if (wt <= 0) continue;
                                const t = sample(r);
                                for (let k = 0; k < 3; k++) acc[k]! += wt * t[o + k]!;
                                total += wt;
                            }
                            const px = acc.map((v) => Math.min(255, Math.max(0, Math.round(v / total))));
                            rgba.set([px[0]!, px[1]!, px[2]!, 255], (z * pool + x) * 4);
                        }
                    }
                }
        }
        const tex = encodePs2Texture(
            { width: pool, height: pool, rgba },
            { mode: 'indexed', maxSize: pool, fps: 10, slot: 0, deferExact: true },
        );
        view(tex.body).setFloat32(44, POOL_HEADER_SCALE, true);
        entries.push({ type: TXD_ENTRY_TYPE, id: seq, sub: 0, data: tex.body });
    }
    return writePs2Srsc(entries);
}
