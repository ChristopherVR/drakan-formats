import { type Ps2Entry, writePs2Srsc } from './ootfcontainer.ts';
import {
    type Ps2TextureOptions,
    type RgbaImage,
    PC_TEX_MIPMAP,
    encodePs2Texture,
    isSkip,
    readPcTexture,
} from './ootftex.ts';
import { type PcFileSource, type PcLevel, resolvePcPath } from './pc.ts';
import { SrscReader } from './srsc.ts';
import { TEX_HOLE, TEX_INVISIBLE, type TerrainLayer } from './terrain.ts';
import { TXD_ENTRY_TYPE } from './txd.ts';
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
 * u32 at texture header +40 of converted terrain textures. On the disc it is a per-texture number that is 0 in splat
 * textures and 1..113 (plus 199646 on a few) in Proc Textures; the engine uses it for terrain textures: 114 and above
 * froze the world, 1 drew flat dark olive, 45 (PROCTEES id 563) drew the texture correctly. Meaning unknown; 45 is the
 * only value verified to render right.
 */
export const TERRAIN_TEXTURE_SLOT = 45;

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
    async addLevel(pc: PcLevel): Promise<(pcRef: number, pc: PcLevel) => number | null> {
        const opt = this.opt;
        const maxTextures = opt.maxTextures ?? env('DRAKAN_TERRAIN_TEX_COUNT') ?? Infinity;
        const maxSize = opt.maxSize ?? env('DRAKAN_TERRAIN_TEX_MAX') ?? 256;
        const noRef = env('DRAKAN_TERRAIN_NOREF') === 1;
        const uses = new Map<number, number>();
        for (const L of pc.terrain) {
            for (const r of L.cellTexLeft) {
                if (r !== TEX_HOLE && r !== TEX_INVISIBLE) uses.set(r, (uses.get(r) ?? 0) + 1);
            }
        }
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
        return (ref) => (noRef ? null : (level.get(ref) ?? null));
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

    /** The target TXD: the base entries followed by every converted texture. Ship it at `TERRAIN_TXD_PATH`. */
    build(): Uint8Array {
        return writePs2Srsc(this.entries);
    }
}

export interface TerrainTextures {
    /** `ConvertOptions.mapTexture` compatible. */
    mapTexture: (pcRef: number, pc: PcLevel) => number | null;
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
 * collision. PC bit 1 is dropped. `DRAKAN_TERRAIN_CELLBITS` (default 0x0d) overrides the carried source bits only.
 */
export function ps2CellFlags(L: TerrainLayer, mask = cellBitsMask()): Uint16Array {
    const out = new Uint16Array(L.cellFlags.length);
    for (let c = 0; c < out.length; c++) {
        const ref = L.cellTexLeft[c]!;
        const special = ref === TEX_HOLE ? 0xc0 : ref === TEX_INVISIBLE ? 0x30 : 0;
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
