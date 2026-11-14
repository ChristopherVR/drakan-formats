import { strToU8 } from 'fflate';
import { type ModelTextureRef, ModelError, MOD_BOUNDS, MOD_CHARACTER } from './model.ts';
import {
    type Skeleton,
    type PcAnim,
    parseSkeleton,
    parsePcAnim,
    ps2AnimFlags,
    withPs2AnimFlags,
    writePs2Skeleton,
} from './ootfanim.ts';
import { convertCreatureAssets } from './ootfcreature.ts';
import { remapSkeletonVertices, withDisplayList } from './ootfdisplaylist.ts';
import { buildDbText, parseDbText } from './ootfcontainer.ts';
import {
    type NeutralModel,
    buildPs2Mod,
    writePs2ModelRecords,
    synthesizeBounds,
    sphereHierarchyCount,
    rebuildObbHierarchy,
    remapObbPolygons,
    parsePcModel,
    pcToNeutral,
    type PcModel,
    type PcToPs2Options,
} from './ootfmodel.ts';
import {
    PC_TEX_NEXT_FRAME,
    type Ps2TextureOptions,
    buildPs2Txd,
    encodePs2Texture,
    isSkip,
    parsePcTextureInfo,
    readPcTexture,
    upgradeIndexedSquareTexture,
} from './ootftex.ts';
import { type PcFileSource, type PcLevel, resolvePcPath } from './pc.ts';
import { SrscReader } from './srsc.ts';
import { TXD_ENTRY_TYPE } from './txd.ts';
import { type Ps2SubstituteTexture, substituteMismatch } from './ootfps2tex.ts';

/**
 * Packaging of converted Order of the Flame assets for a mod pack: one PS2 MOD + TXD + DB for a converted level (or for
 * a shared "OotF Common" container when one builder serves several levels). Everything the models need is copied into
 * the same TXD, so converted models reference textures with `db 0` and the `.DB` needs no dependencies.
 *
 * Flow (all async work first, lookups are synchronous so they fit `ConvertOptions.mapTexture`):
 *   const b = new OotfAssetBuilder(src);
 *   await b.prepareLevelTextures(pc);              // terrain textures of the level
 *   await b.registerOwner('Common/NPC/NPCs');      // the .db of every ODB whose classes name models
 *   await b.addModel('Common/NPC/NPCs', 1234);     // or: await b.addModelRef(owner, pcDb, pcId)
 *   convertPcLevel(pc, { ..., mapTexture: b.mapTexture });
 *   const files = b.build('files/ENGLISH/LEVELS/LEVEL9AP', 'LEVEL9AP');
 * Skinned (0x0208) models: LOD 0 only (the PC weights of a LOD are numbered inside that LOD; cap vertices are dropped), converted
 * to the PS2 vertex layout with the strip display list 0x0211, the skeleton is written as 0x0208 (no 0x0207) and the model's
 * animations are converted to PS2 clips under new ids of the host ADB (`animEntries`, `mapAnimRef`).
 * Trees (model name matching `displayList`) get a 0x0211 too: without it the tree class draws nothing.
 */

export interface AssetBuilderOptions {
    texture?: Ps2TextureOptions;
    model?: Pick<PcToPs2Options, 'keepQuads' | 'flatToSmooth' | 'flipNormals'>;
    /** Flag polygons of textures with transparency as double sided (default true). */
    doubleSidedAlpha?: boolean;
    /** Group name inside the MOD (default "OotF"). */
    group?: string;
    /** First model id / texture id handed out (defaults 2 and 1); use ids past a host container's maxima. */
    firstModelId?: number;
    firstTextureId?: number;
    /** First animation id handed out to converted creature clips (default 100; RESOURES.ADB uses 1..65). */
    firstAnimId?: number;
    /** Static models whose name matches get a regenerated 0x0211 (default trees). */
    displayList?: RegExp;
    /** Convert skinned models (default true); false skips them like before. */
    skinned?: boolean;
    /** Drakan 2 disc textures copied in place of OotF ones, by lower-case `container#id` (ootfps2tex.ts). */
    ps2Textures?: ReadonlyMap<string, Ps2SubstituteTexture>;
}

export interface AssetReport {
    models: { converted: number; triangles: number; polygonsDropped: number; flatToSmooth: number };
    textures: { converted: number; bytes: number; byBpp: Record<string, number>; lossy: number };
    /** `container#id` -> why there is no PS2 counterpart. */
    skipped: Map<string, string>;
    /** OotF `container#id` -> the Drakan 2 texture used instead (`ps2Textures`), or why the OotF one was kept. */
    ps2Textures?: Map<string, { ps2: string; used: boolean; reason?: string }>;
    /** Skinned models converted, with the number of clips written and skipped. */
    creatures: { key: string; id: number; joints: number; groups: number; anims: number; animsSkipped: number }[];
    warnings: string[];
}

export interface BuiltAssets {
    /** Files by path: `<dir>/<STEM>.MOD`, `.TXD`, `.DB`. */
    files: Record<string, Uint8Array>;
    report: AssetReport;
}

const lower = (s: string): string => s.toLowerCase();
const MOD_DISPLAY_LIST = 0x0211;
const MOD_NAME_RECORD = 0x0200;

/** A Drakan 2 model read from the disc for `OotfAssetBuilder.useDiscModel`. */
export interface DiscModelSource {
    /** Every record of the model (0x0200, 0x0203, 0x0204, 0x0207, 0x0211), bodies as on the disc. */
    records: { type: number; data: Uint8Array }[];
    /** The model in neutral form (as read from the disc). */
    model: NeutralModel;
    /** Per 0x0200 texture list entry: the texture's record bodies (first frame, then its frames), or null when not found. */
    textures: ({ ref: string; frames: Uint8Array[]; hasAlpha: boolean } | null)[];
}
const DEFAULT_DISPLAY_LIST = /tree|birch/i;

/**
 * PC cage models (Cage01wPerson2, Cage02Empty, Cage02wPerson ...: hanging cages, some with a prisoner). The PC collides
 * them through a sphere or boxes listing the bar polygons; on the PS2 Rynn walks through a sphere and pushes 100 to 150
 * units past thin listed bars, into the cage. They get one solid box (no polygon list), the disc's own form for props.
 */
const SOLID_BOX_MODEL = /^cage\d/i;

/** One solid OBB over the polygons' vertices (display-list pad vertices left out); the disc's one-shape, no-polygon form. */
function solidBoxBounds(model: NeutralModel): Uint8Array {
    const used = [...new Set(model.polygons.flatMap((p) => p.indices))];
    return synthesizeBounds(
        Float32Array.from(used.flatMap((v) => [0, 1, 2].map((k) => model.positions[v * 3 + k]!))),
        0,
    );
}

/** How far the box of a pressure plate reaches over its highest polygon beyond the plate's sink distance (world units). */
export const PLATE_BOX_HEADROOM = 96;

/**
 * Bounds of a pressure plate (ootfpush.ts): one OBB that lists every polygon and reaches `headroom` model units over the
 * tile. The engine tests an actor against an object only when their boxes overlap (0x1242d8), then against the listed
 * polygons. A flat PC tile has a box of no height; a block pushed onto the plate rests on the floor's terrain layer and does
 * not follow the tile down, so the box must still reach the block's base when the plate is at the bottom: the sink distance
 * plus `PLATE_BOX_HEADROOM`. The disc's own plate stands 130 units inside its box. Rynn stands on the listed polygons.
 */
function plateBounds(model: NeutralModel, headroom: number): Uint8Array {
    const used = [...new Set(model.polygons.flatMap((p) => p.indices))];
    const pts = used.flatMap((v) => [0, 1, 2].map((k) => model.positions[v * 3 + k]!));
    let top = -Infinity;
    for (let i = 1; i < pts.length; i += 3) top = Math.max(top, pts[i]!);
    if (pts.length) pts.push(pts[0]!, top + headroom, pts[2]!);
    return synthesizeBounds(Float32Array.from(pts), model.polygons.length);
}

/**
 * The sphere bounds of a push block (ootfpush.ts) with their lowest sphere moved `depth` model units down, or null when the
 * bounds are no sphere hierarchy. The PS2 Rigid Body rests on terrain and does not follow a plate that sinks under it; its
 * own contact query (0x459a30) must still find the sunk tile, or the plate is free to rise again under the block.
 */
export function sinkLowestSphere(bounds: Uint8Array, depth: number): Uint8Array | null {
    const n = sphereHierarchyCount(bounds);
    if (!n) return null;
    const out = bounds.slice();
    const dv = new DataView(out.buffer, out.byteOffset, out.byteLength);
    const at = (i: number): number => 76 + n * 4 + i * 16;
    let low = 0;
    for (let i = 1; i < n; i++) if (dv.getFloat32(at(i) + 4, true) < dv.getFloat32(at(low) + 4, true)) low = i;
    dv.setFloat32(at(low) + 4, dv.getFloat32(at(low) + 4, true) - depth, true);
    return out;
}

/** Rebuild polygon-index-dependent bounds, retaining the source's conservative sphere/box and excluding pad vertices. */
function rigidDisplayList(model: NeutralModel): ReturnType<typeof withDisplayList> {
    const dl = withDisplayList(model);
    if (SOLID_BOX_MODEL.test(model.name)) {
        dl.model.bounds = solidBoxBounds(dl.model);
        return dl;
    }
    const original = model.bounds ?? synthesizeBounds(model.positions, model.polygons.length);
    // Sphere hierarchies refer only to shapes, so vertex/polygon remapping cannot invalidate them.
    // In particular, native rigid weapons reject an OBB replacement and delete the item on attack.
    if (sphereHierarchyCount(original) !== null) {
        dl.model.bounds = original;
        return dl;
    }
    // An OBB hierarchy keeps its shapes (a hollow model, e.g. a tunnel shell, must stay hollow) and its polygon lists, which
    // `model.bounds` already names in `model.polygons` (pcToNeutral): they follow the display list's polygon order. A PC list
    // names every polygon crossing its box (a bar can be in several) and uses boxes without polygons as solid blocks; giving
    // each polygon only to the box holding its centre (rebuildObbHierarchy) dropped 74,147 list entries from 303 campaign props
    // and collapsed 83 hierarchies of blocker boxes into one box.
    if (model.bounds) {
        const into: number[][] = model.polygons.map(() => []);
        dl.layout.polygonSource.forEach((src, i) => into[src]?.push(i));
        const mapped = remapObbPolygons(original, into);
        if (mapped) {
            dl.model.bounds = mapped;
            return dl;
        }
    }
    // Otherwise only the leaf polygon lists are rebuilt for the new polygons (each to the leaf holding its centre).
    const kept = rebuildObbHierarchy(original, dl.model.positions, dl.model.polygons);
    if (kept) {
        dl.model.bounds = kept;
        return dl;
    }
    const bounds = synthesizeBounds(model.positions, dl.model.polygons.length);
    if (original.length >= 72) bounds.set(original.subarray(0, 72));
    dl.model.bounds = bounds;
    return dl;
}

export class OotfAssetBuilder {
    readonly report: AssetReport = {
        models: { converted: 0, triangles: 0, polygonsDropped: 0, flatToSmooth: 0 },
        textures: { converted: 0, bytes: 0, byBpp: {}, lossy: 0 },
        skipped: new Map(),
        creatures: [],
        warnings: [],
    };
    private readonly containers = new Map<string, SrscReader | null>();
    private readonly dbs = new Map<string, Map<number, string> | null>();
    /** `container#id` (lower case) -> new PS2 texture id. */
    private readonly texIds = new Map<string, number>();
    private readonly texAlpha = new Map<number, boolean>();
    /** Texture (base id) -> the models that use it; `'level'` marks the terrain's. Lets `pruneSkinned` drop what only dropped models used. */
    private readonly texUse = new Map<number, Set<string>>();
    /** Texture base id -> number of animation frames (ids base .. base + n - 1). */
    private readonly texFrames = new Map<number, number>();
    private readonly texBodies: { id: number; body: Uint8Array }[] = [];
    /** Drakan 2 texture ref (lower case) -> the id its copy got (`useSubstitute`). */
    private readonly ps2TexIds = new Map<string, number>();
    private readonly modelIds = new Map<string, number>();
    /** `container#id` (lower case) -> PC polygon indices left out of that model (`dropPolygonsOf`). */
    private readonly polygonDrops = new Map<string, ReadonlySet<number>>();
    /** Models that get the bounds of a pressure plate, with the box's headroom in model units (`requirePlateBox`). */
    private readonly plateBoxKeys = new Map<string, number>();
    /** Models whose lowest bounding sphere is moved down by that many model units (`requireSunkSphere`). */
    private readonly sunkSphereKeys = new Map<string, number>();
    private readonly models: {
        id: number;
        model: NeutralModel;
        records?: { type: number; data: Uint8Array }[];
        /** Skinned: the model's clips in `anims`. */
        clips?: number[];
        key: string;
        /** A Drakan 2 model copied from the disc (`useDiscModel`): its records and textures stay the disc's. */
        disc?: true;
    }[] = [];
    /** Converted creature clips for the host ADB. */
    private readonly anims: { id: number; info: Uint8Array; data: Uint8Array }[] = [];
    /** `container#id` -> (PC animation id -> new id). */
    private readonly animMaps = new Map<string, Map<number, number>>();
    private nextAnim: number;
    private nextTex: number;
    private nextModel: number;

    constructor(
        readonly src: PcFileSource,
        readonly options: AssetBuilderOptions = {},
    ) {
        this.nextTex = options.firstTextureId ?? 1;
        this.nextModel = options.firstModelId ?? 2;
        this.nextAnim = options.firstAnimId ?? 100;
    }

    private async open(base: string, ext: string): Promise<SrscReader | null> {
        const path = `${base}.${ext}`;
        const key = lower(path);
        if (this.containers.has(key)) return this.containers.get(key)!;
        const bytes = await this.src.read(path);
        const r = bytes ? await SrscReader.fromBytes(bytes) : null;
        this.containers.set(key, r);
        return r;
    }

    /** Load `<owner>.db` (the dependency list that resolves `db` indices of references owned by that container). */
    async registerOwner(owner: string): Promise<void> {
        const key = lower(owner);
        if (this.dbs.has(key)) return;
        const bytes = await this.src.read(`${owner}.db`);
        this.dbs.set(key, bytes ? parseDbText(new TextDecoder('latin1').decode(bytes)) : null);
    }

    /** Container base path (no extension) that `db` names for references owned by `owner`; 0 = the owner itself. */
    resolveContainer(owner: string, db: number): string | null {
        if (db === 0) return owner;
        const deps = this.dbs.get(lower(owner));
        const rel = deps?.get(db);
        if (!rel) return null;
        const dir = owner.split('/').slice(0, -1).join('/');
        return resolvePcPath(dir, rel);
    }

    // -------------------------------------------------------------------------------------------- textures

    private useTexture(id: number, user: string): void {
        const s = this.texUse.get(id) ?? this.texUse.set(id, new Set()).get(id)!;
        s.add(user);
    }

    /** Convert PC texture `id` of `<container>.txd` (and the frames that follow it). Returns the new PS2 id or null. */
    async addTexture(container: string, id: number, indexed = false): Promise<number | null> {
        // Textures of skinned models are written 8 bpp (`indexed`): see the journal, 32 bpp textures do not draw on creature classes.
        // Graded alpha is cut at 50 % (`hardAlpha`): a blended texture does not write depth, so the layered feather polygons of the
        // Intro owl (inner wing / chest cards) painted over the chest in strip order. `OOTF_SKIN_SOFT_ALPHA=1` keeps the blend (test aid).
        // They are also written square: a non-square texture (Scavenger 256x128) makes the creature body vanish (shadow only); the disc's are all square.
        const sfx = indexed ? ':i' : '';
        const key = `${lower(container)}#${id}${sfx}`;
        const known = this.texIds.get(key);
        if (known !== undefined) return known;
        if (this.texIds.has(key)) return null;
        const txd = await this.open(container, 'txd');
        if (!txd) {
            this.skip(key, `${container}.txd not found`);
            return null;
        }
        const sub = this.options.ps2Textures?.get(`${lower(container)}#${id}`);
        if (sub) {
            const used = await this.useSubstitute(txd, container, id, sfx, sub, indexed);
            if (used !== null) return used;
        }
        const first = await readPcTexture(txd, id);
        if (isSkip(first)) {
            this.skip(key, first.reason);
            return null;
        }
        // Animation frames follow with consecutive ids and the "next frame" flag.
        const frames = [first];
        for (let n = id + 1; frames.length < 64; n++) {
            const e = txd.find(0x40, n);
            if (!e) break;
            const f = await readPcTexture(txd, n);
            if (isSkip(f) || !(f.info.flags & PC_TEX_NEXT_FRAME)) break;
            frames.push(f);
        }
        if (this.nextTex + frames.length - 1 > 0xffff) {
            this.skip(key, 'texture id space exhausted');
            return null;
        }
        const base = this.nextTex;
        frames.forEach((f, i) => {
            const t = encodePs2Texture(f.image, {
                fps: f.info.fps || 10,
                ...this.options.texture,
                ...(indexed
                    ? { mode: 'indexed' as const, square: true, hardAlpha: process.env.OOTF_SKIN_SOFT_ALPHA !== '1' }
                    : {}),
            });
            if (i > 0) t.body[37] = t.body[37]! | PC_TEX_NEXT_FRAME;
            const nid = base + i;
            this.texBodies.push({ id: nid, body: t.body });
            this.texAlpha.set(nid, t.hasAlpha);
            this.texIds.set(`${lower(container)}#${f.id}${sfx}`, nid);
            this.report.textures.converted++;
            this.report.textures.bytes += t.body.length;
            this.report.textures.byBpp[t.bpp] = (this.report.textures.byBpp[t.bpp] ?? 0) + 1;
            if (t.lossy) this.report.textures.lossy++;
        });
        this.nextTex += frames.length;
        this.texFrames.set(base, frames.length);
        return base;
    }

    /**
     * Copy the Drakan 2 texture `sub` (and its frames) in place of OotF texture `id` of `container`: the record is the disc's,
     * byte for byte, so the game and the Drakan 2 HD pack see the disc texture. Null (OotF texture kept) when it does not fit.
     */
    private async useSubstitute(
        txd: SrscReader,
        container: string,
        id: number,
        sfx: string,
        sub: Ps2SubstituteTexture,
        indexed: boolean,
    ): Promise<number | null> {
        const log = (this.report.ps2Textures ??= new Map());
        const ootf = `${container}#${id}`;
        const e = txd.find(TXD_ENTRY_TYPE, id);
        let why: string | null = e ? null : 'no such OotF texture';
        if (e) {
            try {
                const info = parsePcTextureInfo(await txd.readRaw(e));
                why = substituteMismatch(sub, info.width, info.height, indexed);
            } catch (x) {
                why = x instanceof Error ? x.message : String(x);
            }
        }
        const shared = this.ps2TexIds.get(sub.row.ps2.toLowerCase());
        if (why === null && shared === undefined && this.nextTex + sub.frames.length - 1 > 0xffff)
            why = 'texture id space exhausted';
        if (why !== null) {
            log.set(ootf, { ps2: sub.row.ps2, used: false, reason: why });
            return null;
        }
        log.set(ootf, { ps2: sub.row.ps2, used: true });
        if (shared !== undefined) {
            // Several OotF textures map to one disc texture (pine trunk and log bark): one copy.
            this.texIds.set(`${lower(container)}#${id}${sfx}`, shared);
            return shared;
        }
        const base = this.nextTex;
        sub.frames.forEach((body, i) => {
            this.texBodies.push({ id: base + i, body });
            this.texAlpha.set(base + i, sub.hasAlpha);
            this.report.textures.converted++;
            this.report.textures.bytes += body.length;
            this.report.textures.byBpp[sub.bpp] = (this.report.textures.byBpp[sub.bpp] ?? 0) + 1;
        });
        this.texIds.set(`${lower(container)}#${id}${sfx}`, base);
        this.nextTex += sub.frames.length;
        this.texFrames.set(base, sub.frames.length);
        this.ps2TexIds.set(sub.row.ps2.toLowerCase(), base);
        return base;
    }

    /** Add every texture a level's terrain uses, so `mapTexture` can answer synchronously. */
    async prepareLevelTextures(pc: PcLevel): Promise<void> {
        const refs = new Set<number>();
        for (const L of pc.terrain) for (const r of L.cellTexLeft) if (r < 0xfffffffe) refs.add(r);
        for (const r of refs) {
            const c = this.levelContainer(r >>> 16, pc);
            const t = c ? await this.addTexture(c, r & 0xffff) : null;
            if (t !== null) this.useTexture(t, 'level');
        }
    }

    private levelContainer(db: number, pc: PcLevel): string | null {
        const lvlBase = pc.path.replace(/\.lvl$/i, '');
        if (db === 0) return lvlBase;
        const dep = pc.header.dependencies.find((d) => d.dbIndex === db);
        if (!dep) return null;
        return resolvePcPath(pc.path.split('/').slice(0, -1).join('/'), dep.path.text);
    }

    /** `ConvertOptions.mapTexture` compatible: terrain ref (`id | db << 16`, level dependency table) -> PS2 ref (db 0). */
    mapTexture = (pcRef: number, pc: PcLevel): number | null => {
        const c = this.levelContainer(pcRef >>> 16, pc);
        if (!c) return null;
        return this.texIds.get(`${lower(c)}#${pcRef & 0xffff}`) ?? null;
    };

    // ------------------------------------------------------------------------------------------------ models

    private skip(key: string, why: string): void {
        this.report.skipped.set(key, why);
    }

    /** Convert PC model `id` of `<container>.mod` with its textures. Returns the new PS2 model id or null. */
    async addModel(container: string, id: number, requireDisplayList = false): Promise<number | null> {
        const key = `${lower(container)}#${id}`;
        const known = this.modelIds.get(key);
        if (known !== undefined) {
            if (requireDisplayList) this.requireDisplayList(known);
            return known;
        }
        if (this.report.skipped.has(`model ${key}`)) return null;
        const fail = (why: string): null => {
            this.skip(`model ${key}`, why);
            return null;
        };
        const mod = await this.open(container, 'mod');
        if (!mod) return fail(`${container}.mod not found`);
        await this.registerOwner(container);
        let pc;
        try {
            pc = await parsePcModel(mod, id);
        } catch (e) {
            return fail(e instanceof ModelError ? e.message : String(e));
        }
        if (!pc) return fail('no such model');
        if (this.nextModel > 0xffff) return fail('model id space exhausted');
        if (pc.character && this.options.skinned === false) return fail('skinned model (conversion off)');
        let skin: { sk: Skeleton; positions: Float32Array; sphereVerts: Float32Array } | null = null;
        if (pc.character) {
            try {
                const sk = parseSkeleton(await mod.readRaw(mod.find(MOD_CHARACTER, id)!), 'pc');
                const L = sk.lods[0];
                if (!L || sk.joints.length === 0) return fail('skinned model without LOD or joints');
                // Weights, polygon indices and sphere vertices of a LOD count from that LOD's first vertex.
                const positions = pc.positions.slice(L.firstVertex * 3, (L.firstVertex + L.vertexCount) * 3);
                // PC bounding spheres name their centre by a vertex numbered from the LOD's first vertex, and those vertices sit
                // AFTER the LOD's own vertices (Scavenger: 165..174 of 180), so the sphere centres need the unsliced list.
                skin = { sk, positions, sphereVerts: pc.positions.slice(L.firstVertex * 3) };
                pc = { ...pc, positions, polygons: skinnedLodPolygons(pc.polygons, sk) };
            } catch (e) {
                return fail(`skeleton: ${e instanceof Error ? e.message : String(e)}`);
            }
        }
        const map = new Map<string, ModelTextureRef | null>();
        const used = new Set(pc.polygons.map((p) => p.texture));
        for (const [ti, t] of pc.textures.entries()) {
            if (!used.has(ti)) continue; // unused list entries are not converted
            const tc = this.resolveContainer(container, t.db);
            const nid = tc ? await this.addTexture(tc, t.id, !!skin) : null;
            if (nid !== null) this.useTexture(nid, key);
            map.set(`${t.db}/${t.id}`, nid === null ? null : { id: nid, db: 0 });
        }
        const { model, stats } = pcToNeutral(pc, {
            ...this.options.model,
            dropPolygons: skin ? undefined : this.polygonDrops.get(key),
            mapTexture: (r) => map.get(`${r.db}/${r.id}`) ?? null,
            doubleSided: (this.options.doubleSidedAlpha ?? true) ? (r) => this.texAlpha.get(r.id) === true : undefined,
            textureFrames: (r) => (r.db === 0 ? (this.texFrames.get(r.id) ?? 1) : 1),
        });
        if (model.polygons.length === 0 && pc.polygons.length > 0) return fail('no polygon left (textures missing)');
        if (model.positions.length / 3 > 0xffff) return fail('too many vertices');
        let out = model;
        let records: { type: number; data: Uint8Array }[] | undefined;
        if (skin) {
            const sk = skin.sk;
            const L = sk.lods[0]!;
            const nv = model.positions.length / 3;
            const per: { j: number; w: number }[][] = Array.from({ length: nv }, () => []);
            sk.joints.forEach((j, ji) => {
                for (const w of j.weights[0] ?? []) if (w.vertex < nv) per[w.vertex]!.push({ j: ji, w: w.weight });
            });
            const vertexJoints = per.map((l) => l.sort((a, b) => b.w - a.w).map((x) => x.j));
            let dl;
            try {
                dl = withDisplayList(model, { vertexJoints: (v) => vertexJoints[v] ?? [] });
            } catch (e) {
                return fail(`display list: ${e instanceof Error ? e.message : String(e)}`);
            }
            const anims = await this.convertClips(container, sk, key);
            const base: Skeleton = {
                ...sk,
                lodNames: [],
                lods: [{ ...L, firstVertex: 0, firstPoly: 0, vertexCount: nv }],
                joints: sk.joints.map((j) => ({ ...j, weights: [(j.weights[0] ?? []).filter((w) => w.vertex < nv)] })),
                channels: sk.channels.map((c) => ({ ...c, caps: [] })),
                spheresPerLod: [sk.spheresPerLod[0] ?? []],
                animIds: anims.ids,
            };
            const remapped = remapSkeletonVertices(base, dl.layout.source, dl.model.polygons.length);
            // Channel 0 (the whole body, joint 0) lists the polygon range of every LOD as a cap {0, 0, firstPoly, polyCount, 0} on the disc
            // (Scavenger 5055: 1693 + 223, troll 4418: 1229 + 606 + 302). All 154 disc skeletons have them; the converter used to drop them.
            const ps2sk: Skeleton = {
                ...remapped,
                channels: remapped.channels.map((c, i) =>
                    i === 0
                        ? {
                              ...c,
                              caps: remapped.lods.map((l) => ({
                                  values: [0, 0, l.firstPoly, l.polyCount, 0] as [
                                      number,
                                      number,
                                      number,
                                      number,
                                      number,
                                  ],
                                  weights: [],
                              })),
                          }
                        : c,
                ),
            };
            // PS2 character models carry shading 0x20002, a distance of 35000 and a second word of 1 (troll 4418, Scavenger 5055);
            // the PC conversion wrote shading 2 / no distance. Matching the disc did NOT make creature classes draw the body (see the journal).
            out = {
                ...dl.model,
                shading: dl.model.shading | 0x20000,
                distance: dl.model.distance ?? 35000,
                reserved: 1,
            };
            records = [
                ...writePs2ModelRecords(out).filter((r) => r.type !== MOD_BOUNDS),
                { type: MOD_CHARACTER, data: writePs2Skeleton(ps2sk, skin.sphereVerts, Infinity) },
                { type: MOD_DISPLAY_LIST, data: dl.record },
            ];
            this.report.creatures.push({
                key,
                id: 0,
                joints: sk.joints.length,
                groups: dl.layout.groups,
                anims: anims.ids.length,
                animsSkipped: anims.skipped,
            });
        } else if (
            // Geometry-only helper models (e.g. current volumes) have bounds but no triangles to submit.
            (requireDisplayList && model.polygons.length > 0) ||
            (this.options.displayList ?? DEFAULT_DISPLAY_LIST).test(pc.name)
        ) {
            try {
                // Preserve the established tree path; only newly required rigid representations need this upgrade.
                const dl =
                    requireDisplayList && !(this.options.displayList ?? DEFAULT_DISPLAY_LIST).test(pc.name)
                        ? rigidDisplayList(model)
                        : withDisplayList(model);
                out = dl.model;
                records = [...writePs2ModelRecords(out), { type: MOD_DISPLAY_LIST, data: dl.record }];
            } catch (e) {
                if (requireDisplayList)
                    return fail(`required display list: ${e instanceof Error ? e.message : String(e)}`);
                this.report.warnings.push(
                    `model ${key}: display list failed (${e instanceof Error ? e.message : String(e)})`,
                );
            }
        }
        if (!skin && this.plateBoxKeys.has(key)) {
            out = { ...out, bounds: plateBounds(out, this.plateBoxKeys.get(key)!) };
            if (records)
                records = [...writePs2ModelRecords(out), ...records.filter((r) => r.type === MOD_DISPLAY_LIST)];
        }
        const sunk =
            !skin && out.bounds && this.sunkSphereKeys.has(key)
                ? sinkLowestSphere(out.bounds, this.sunkSphereKeys.get(key)!)
                : null;
        if (sunk) {
            out = { ...out, bounds: sunk };
            if (records)
                records = [...writePs2ModelRecords(out), ...records.filter((r) => r.type === MOD_DISPLAY_LIST)];
        }
        const nid = this.nextModel++;
        this.modelIds.set(key, nid);
        if (skin) this.report.creatures[this.report.creatures.length - 1]!.id = nid;
        this.models.push({
            id: nid,
            model: out,
            records,
            key,
            clips: skin ? [...(this.animMaps.get(key)?.values() ?? [])] : undefined,
        });
        if (!skin && records?.some((r) => r.type === MOD_DISPLAY_LIST)) this.squareDrawListTextures(key, out.textures);
        const m = this.report.models;
        m.converted++;
        m.triangles += stats.trianglesOut;
        m.polygonsDropped += stats.polygonsDropped;
        if (stats.flatToSmooth) m.flatToSmooth++;
        return nid;
    }

    /** Ensure an already imported model has the generic-prop draw representation, retaining its id and bounds. */
    requireDisplayList(id: number): boolean {
        const existing = this.models.find((m) => m.id === id);
        if (!existing) return false; // Native/template models belong to their original MOD and are never rewritten here.
        if (existing.records?.some((r) => r.type === MOD_CHARACTER))
            return existing.records.some((r) => r.type === MOD_DISPLAY_LIST); // Never rebuild a skeleton as a rigid model.
        if (existing.disc) return existing.records?.some((r) => r.type === MOD_DISPLAY_LIST) === true;
        if (existing.model.polygons.length > 0 && !existing.records?.some((r) => r.type === MOD_DISPLAY_LIST)) {
            const dl = rigidDisplayList(existing.model);
            existing.model = dl.model;
            existing.records = [...writePs2ModelRecords(dl.model), { type: MOD_DISPLAY_LIST, data: dl.record }];
        }
        this.squareDrawListTextures(existing.key, existing.model.textures);
        return true;
    }

    /**
     * A model drawn from its strip display list draws nothing when one of its textures is not square, like the skinned models
     * (`addTexture`): Ruined Village's cart (a 64 x 128 plank texture) stayed invisible while the barrel and crate standing on
     * it seemed to float (journal 2026-11-08/ootf-ruined-village-ambush-props.md). Such textures of this builder are rewritten
     * square in place (8 bpp, the weapons' upgrade), keeping their ids; square ones of any depth stay as they are.
     */
    private squareDrawListTextures(key: string, textures: readonly ModelTextureRef[]): void {
        const frames = new Set<number>();
        for (const ref of textures) {
            if (ref.db !== 0) continue;
            let base = ref.id,
                count = 1;
            for (const [candidate, length] of this.texFrames)
                if (ref.id >= candidate && ref.id < candidate + length) {
                    base = candidate;
                    count = length;
                    break;
                }
            for (let frame = base; frame < base + count; frame++) frames.add(frame);
        }
        for (const frame of frames) {
            const stored = this.texBodies.find((t) => t.id === frame);
            if (!stored) continue;
            const dv = new DataView(stored.body.buffer, stored.body.byteOffset, stored.body.byteLength);
            const oldBpp = dv.getUint32(12, true);
            if (dv.getUint32(0, true) === dv.getUint32(4, true)) continue;
            let next: ReturnType<typeof upgradeIndexedSquareTexture>;
            try {
                next = upgradeIndexedSquareTexture(stored.body);
            } catch (error) {
                const warning = `model ${key}: texture ${frame} could not be made square (${error instanceof Error ? error.message : String(error)})`;
                if (!this.report.warnings.includes(warning)) this.report.warnings.push(warning);
                continue;
            }
            if (!next) continue;
            this.report.textures.bytes += next.body.length - stored.body.length;
            if (oldBpp !== next.bpp) {
                const previous = (this.report.textures.byBpp[oldBpp] ?? 0) - 1;
                if (previous > 0) this.report.textures.byBpp[oldBpp] = previous;
                else delete this.report.textures.byBpp[oldBpp];
                this.report.textures.byBpp[next.bpp] = (this.report.textures.byBpp[next.bpp] ?? 0) + 1;
            }
            if (next.lossy) this.report.textures.lossy++;
            stored.body = next.body;
        }
    }

    /**
     * Give a converted model one box over its polygons that lists all of them (a Morph Plug frame). Each morph step copies the
     * next frame's collision shapes and polygon lists into the plug's own model instance, sized for the shapes it already has, so
     * every frame of a plug needs the same layout: the disc's morph frames have one shape each. The PC's frames differ (Volcanic's
     * "IceCover01" has nine boxes, "IceCover02" to "04" one), and the plug corrupted the guest heap on its first step (journal
     * 2026-11-06/ootf-volcanic-route.md). Polygon counts and order stay as converted; frames of one plug share their topology.
     */
    singleShapeBounds(id: number): boolean {
        const m = this.models.find((x) => x.id === id);
        if (!m || m.records?.some((r) => r.type === MOD_CHARACTER)) return false;
        // Display-list pad vertices are not referenced by any polygon; keep them out of the box.
        const used = new Set(m.model.polygons.flatMap((p) => p.indices));
        const positions = Float32Array.from(
            [...used].flatMap((v) => [0, 1, 2].map((k) => m.model.positions[v * 3 + k]!)),
        );
        const bounds = synthesizeBounds(positions, m.model.polygons.length);
        m.model = { ...m.model, bounds };
        if (m.records)
            m.records = m.records.map((r) => (r.type === MOD_BOUNDS ? { type: MOD_BOUNDS, data: bounds } : r));
        return true;
    }

    /** Guard rigid weapon draw upgrades with a nonempty authored sphere hierarchy; never approximate it with boxes. */
    requireRigidWeaponDisplayList(id: number): boolean {
        const existing = this.models.find((m) => m.id === id);
        if (!existing) return false;
        const bounds = existing.model.bounds ?? existing.records?.find((r) => r.type === MOD_BOUNDS)?.data;
        const count = bounds ? sphereHierarchyCount(bounds) : null;
        if (existing.records?.some((r) => r.type === MOD_CHARACTER) || count === null || count === 0) {
            const warning = `model ${existing.key}: native rigid weapon requires a nonempty authored sphere hierarchy; draw upgrade skipped`;
            if (!this.report.warnings.includes(warning)) this.report.warnings.push(warning);
            return false;
        }
        // Keep existing ids/cache keys: a shared texture's format demand upgrades its stored representation in place.
        const frames = new Set<number>();
        for (const ref of existing.model.textures) {
            if (ref.db !== 0) {
                const warning = `model ${existing.key}: rigid weapon texture is outside the owning asset builder; draw upgrade skipped`;
                if (!this.report.warnings.includes(warning)) this.report.warnings.push(warning);
                return false;
            }
            let base = ref.id,
                count = 1;
            for (const [candidate, length] of this.texFrames)
                if (ref.id >= candidate && ref.id < candidate + length) {
                    base = candidate;
                    count = length;
                    break;
                }
            for (let frame = base; frame < base + count; frame++) frames.add(frame);
        }
        const changes: {
            stored: { id: number; body: Uint8Array };
            next: ReturnType<typeof upgradeIndexedSquareTexture>;
        }[] = [];
        try {
            for (const frame of frames) {
                const stored = this.texBodies.find((t) => t.id === frame);
                if (!stored) throw new Error(`texture ${frame} is not owned by the asset builder`);
                changes.push({ stored, next: upgradeIndexedSquareTexture(stored.body) });
            }
        } catch (error) {
            const warning = `model ${existing.key}: rigid weapon texture upgrade failed (${error instanceof Error ? error.message : String(error)})`;
            if (!this.report.warnings.includes(warning)) this.report.warnings.push(warning);
            return false;
        }
        for (const { stored, next } of changes) {
            if (!next) continue;
            const oldBpp = new DataView(stored.body.buffer, stored.body.byteOffset, stored.body.byteLength).getUint32(
                12,
                true,
            );
            this.report.textures.bytes += next.body.length - stored.body.length;
            if (oldBpp !== next.bpp) {
                const previous = (this.report.textures.byBpp[oldBpp] ?? 0) - 1;
                if (previous > 0) this.report.textures.byBpp[oldBpp] = previous;
                else delete this.report.textures.byBpp[oldBpp];
                this.report.textures.byBpp[next.bpp] = (this.report.textures.byBpp[next.bpp] ?? 0) + 1;
            }
            if (next.lossy) this.report.textures.lossy++;
            stored.body = next.body;
        }
        return this.requireDisplayList(id);
    }

    /**
     * Skeleton and clips of a PC skinned model (container + id as `addModel` takes them), without converting the model:
     * the input of `retargetCreature`. Null when the model has no skeleton.
     */
    async creatureSource(
        owner: string,
        pcDb: number,
        pcId: number,
    ): Promise<{ skeleton: Skeleton; anims: Map<number, PcAnim> } | null> {
        await this.registerOwner(owner);
        const c = this.resolveContainer(owner, pcDb);
        const mod = c ? await this.open(c, 'mod') : null;
        const e = mod?.find(MOD_CHARACTER, pcId);
        if (!c || !mod || !e) return null;
        try {
            const skeleton = parseSkeleton(await mod.readRaw(e), 'pc');
            if (skeleton.joints.length === 0) return null;
            return { skeleton, anims: (await this.loadClips(c, skeleton, `${lower(c)}#${pcId}`)).pcAnims };
        } catch {
            return null;
        }
    }

    private async loadClips(
        container: string,
        sk: Skeleton,
        key: string,
    ): Promise<{ pcAnims: Map<number, PcAnim>; skipped: number }> {
        const adb = await this.open(container, 'adb');
        const pcAnims = new Map<number, PcAnim>();
        let skipped = 0;
        for (const aid of sk.animIds) {
            const gi = adb?.find(0x0501, aid);
            const gd = adb?.find(0x0502, aid);
            const gl = adb?.find(0x0503, aid);
            if (!adb || !gi || !gd || !gl) {
                skipped++;
                continue;
            }
            try {
                pcAnims.set(aid, parsePcAnim(await adb.readRaw(gi), await adb.readRaw(gd), await adb.readRaw(gl)));
            } catch (e) {
                skipped++;
                this.report.warnings.push(
                    `creature ${key}: clip ${aid}: ${e instanceof Error ? e.message : String(e)}`,
                );
            }
        }
        return { pcAnims, skipped };
    }

    /** Convert the PC clips a skinned model lists (`<container>.adb`) and give them fresh ids; fills `animMaps`. */
    private async convertClips(
        container: string,
        sk: Skeleton,
        key: string,
    ): Promise<{ ids: number[]; skipped: number }> {
        const loaded = await this.loadClips(container, sk, key);
        let skipped = loaded.skipped;
        const r = convertCreatureAssets({
            pcSkeleton: sk,
            pcAnims: loaded.pcAnims,
            ps2Skeleton: null,
            keepChannels: true,
        });
        skipped += r.skipped.length;
        const map = new Map<number, number>();
        for (const a of r.anims) {
            if (this.nextAnim > 0xffff) {
                skipped++;
                continue;
            }
            const nid = this.nextAnim++;
            map.set(a.id, nid);
            this.anims.push({ id: nid, info: a.info, data: a.data });
        }
        this.animMaps.set(key, map);
        return { ids: [...map.values()].sort((x, y) => x - y), skipped };
    }

    /**
     * Drop the skinned models (and their clips) that `keep` rejects: the classes are planned after the models are converted,
     * and only the models of the classes that survive need to ship (a whole level's creatures are 1800+ clips, 7 MB of ADB).
     */
    pruneSkinned(keep: (modelId: number) => boolean): void {
        const drop = new Set<number>();
        for (let i = this.models.length - 1; i >= 0; i--) {
            const m = this.models[i]!;
            if (!m.clips || keep(m.id)) continue;
            m.clips.forEach((c) => drop.add(c));
            this.models.splice(i, 1);
            this.modelIds.delete(m.key);
            this.animMaps.delete(m.key);
            for (const [tex, users] of this.texUse) {
                if (!users.delete(m.key) || users.size > 0) continue;
                const n = this.texFrames.get(tex) ?? 1;
                this.texUse.delete(tex);
                this.texBodies.splice(
                    0,
                    this.texBodies.length,
                    ...this.texBodies.filter((t) => t.id < tex || t.id >= tex + n),
                );
                for (const [k, v] of this.texIds) if (v >= tex && v < tex + n) this.texIds.delete(k);
                this.report.textures.converted -= n;
            }
            const k = this.report.creatures.findIndex((c) => c.id === m.id);
            if (k >= 0) this.report.creatures.splice(k, 1);
        }
        for (let i = this.anims.length - 1; i >= 0; i--) if (drop.has(this.anims[i]!.id)) this.anims.splice(i, 1);
    }

    /** PC animation id -> id in the host ADB for a converted creature model (see `mapModelRef`); null when none. */
    mapAnimRef(pcDb: number, pcId: number, owner: string): Map<number, number> | null {
        const c = this.resolveContainer(owner, pcDb);
        return c ? (this.animMaps.get(`${lower(c)}#${pcId}`) ?? null) : null;
    }

    /**
     * Make converted clips play once and hold their last frame (PS2 0x0501 flag 1). PC clips carry no such flag, so every
     * converted clip looped, and a death clip replayed from its standing first frame. Returns how many clips changed.
     */
    holdLastFrame(ids: ReadonlySet<number>): number {
        let n = 0;
        for (const a of this.anims) {
            if (!ids.has(a.id) || ps2AnimFlags(a.info) & 1) continue;
            a.info = withPs2AnimFlags(a.info, ps2AnimFlags(a.info) | 1);
            n++;
        }
        return n;
    }

    /** Converted clips as ADB entries (0x0501 info, 0x0502 keys) for the host ADB; empty when there are no creatures. */
    animEntries(): { type: number; id: number; sub: number; data: Uint8Array }[] {
        return this.anims.flatMap((a) => [
            { type: 0x0501, id: a.id, sub: 0, data: a.info },
            { type: 0x0502, id: a.id, sub: 0, data: a.data },
        ]);
    }

    /**
     * Move the lowest bounding sphere of a push block's model `depth` world units down (`sinkLowestSphere`). Call before the
     * model is added; false when the reference does not resolve or the model was already converted.
     */
    async requireSunkSphere(owner: string, pcDb: number, pcId: number, depth: number): Promise<boolean> {
        await this.registerOwner(owner);
        const c = this.resolveContainer(owner, pcDb);
        const key = c ? `${lower(c)}#${pcId}` : '';
        if (!c || this.modelIds.has(key)) return false;
        this.sunkSphereKeys.set(key, depth / 2048);
        return true;
    }

    /**
     * Give the model of a pressure plate bounds its plate can be pressed through (`plateBounds`); `sink` is the plate's sink
     * distance in world units. Call before the model is added; false when the reference does not resolve or the model was
     * already converted.
     */
    async requirePlateBox(owner: string, pcDb: number, pcId: number, sink: number): Promise<boolean> {
        await this.registerOwner(owner);
        const c = this.resolveContainer(owner, pcDb);
        const key = c ? `${lower(c)}#${pcId}` : '';
        if (!c || this.modelIds.has(key)) return false;
        this.plateBoxKeys.set(
            key,
            Math.max(this.plateBoxKeys.get(key) ?? 0, (Math.max(0, sink) + PLATE_BOX_HEADROOM) / 2048),
        );
        return true;
    }

    /**
     * Leave PC polygons `drop` of a rigid model out of its conversion (inward shell walls, `ootfshell.ts`). Call before the
     * model is added; false when the reference does not resolve or the model was already converted.
     */
    async dropPolygonsOf(owner: string, pcDb: number, pcId: number, drop: ReadonlySet<number>): Promise<boolean> {
        await this.registerOwner(owner);
        const c = this.resolveContainer(owner, pcDb);
        const key = c ? `${lower(c)}#${pcId}` : '';
        if (!c || this.modelIds.has(key)) return false;
        this.polygonDrops.set(key, drop);
        return true;
    }

    /** The PC model a reference in `owner`'s ODB names (null when missing or unreadable), without converting it. */
    async readPcModel(owner: string, pcDb: number, pcId: number): Promise<PcModel | null> {
        await this.registerOwner(owner);
        const c = this.resolveContainer(owner, pcDb);
        const mod = c ? await this.open(c, 'mod') : null;
        if (!mod) return null;
        try {
            return await parsePcModel(mod, pcId);
        } catch {
            return null;
        }
    }

    /**
     * Model reference in `owner`'s ODB (`db` indexes `owner.db`). Generic props require a strip display list even
     * for rigid models; a later required request upgrades an already converted model without changing its id.
     */
    async addModelRef(owner: string, pcDb: number, pcId: number, requireDisplayList = false): Promise<number | null> {
        await this.registerOwner(owner);
        const c = this.resolveContainer(owner, pcDb);
        if (!c) {
            this.skip(`model ${lower(owner)}#db${pcDb}/${pcId}`, 'db index not in the .db');
            return null;
        }
        return this.addModel(c, pcId, requireDisplayList);
    }

    /**
     * Name the host container's own model `nativeId` (a Drakan 2 model, ootfps2model.ts) for PC model `pcId` of the container
     * `pcDb` resolves to from `owner`, instead of converting it: `mapModelRef` then answers `nativeId` and nothing is added to
     * the output MOD. Returns false when the reference does not resolve or the PC model was already converted.
     */
    async useNativeModel(owner: string, pcDb: number, pcId: number, nativeId: number): Promise<boolean> {
        await this.registerOwner(owner);
        const c = this.resolveContainer(owner, pcDb);
        const key = c ? `${lower(c)}#${pcId}` : null;
        if (!key || (this.modelIds.has(key) && this.modelIds.get(key) !== nativeId)) return false;
        this.modelIds.set(key, nativeId);
        return true;
    }

    /**
     * Copy a Drakan 2 model from the disc (ootfps2model.ts, props) in place of PC model `pcId` of the container `pcDb` resolves to
     * from `owner`: the model's records (vertices, polygons, strip display list) are the disc's, its bounds are one box over its
     * triangles that lists them all (per-triangle collision, as the PC props have), its textures are copied
     * byte for byte (so the Drakan 2 HD pack replaces them) and its texture list is renumbered to the copies. Returns the new id,
     * or null when the reference does not resolve, the PC model was already converted or the disc model is unusable (no
     * display list, skinned, a texture missing).
     */
    async useDiscModel(owner: string, pcDb: number, pcId: number, disc: DiscModelSource): Promise<number | null> {
        await this.registerOwner(owner);
        const c = this.resolveContainer(owner, pcDb);
        if (!c) return null;
        const key = `${lower(c)}#${pcId}`;
        const known = this.modelIds.get(key);
        if (known !== undefined) return this.models.find((m) => m.id === known)?.disc ? known : null;
        const recs = disc.records;
        const name = recs.find((r) => r.type === MOD_NAME_RECORD);
        if (!name || recs.some((r) => r.type === MOD_CHARACTER) || !recs.some((r) => r.type === MOD_DISPLAY_LIST))
            return null;
        if (disc.textures.some((t) => !t || !t.frames.length)) return null;
        if (this.nextModel > 0xffff) return null;
        const ids: number[] = [];
        for (const t of disc.textures) {
            const shared = this.ps2TexIds.get(t!.ref.toLowerCase());
            if (shared !== undefined) {
                ids.push(shared);
                continue;
            }
            if (this.nextTex + t!.frames.length - 1 > 0xffff) return null;
            const base = this.nextTex;
            t!.frames.forEach((body, i) => {
                this.texBodies.push({ id: base + i, body });
                this.texAlpha.set(base + i, t!.hasAlpha);
                this.report.textures.converted++;
                this.report.textures.bytes += body.length;
            });
            this.nextTex += t!.frames.length;
            this.texFrames.set(base, t!.frames.length);
            this.ps2TexIds.set(t!.ref.toLowerCase(), base);
            ids.push(base);
        }
        // 0x0200 ends with the texture list (u16 id, u16 db per entry): renumber it to the copies, db 0.
        const body = name.data.slice();
        const dv = new DataView(body.buffer, body.byteOffset, body.byteLength);
        const at = body.length - ids.length * 4;
        if (at < 4 || dv.getUint32(at - 4, true) !== ids.length) return null;
        ids.forEach((id, i) => {
            dv.setUint16(at + i * 4, id, true);
            dv.setUint16(at + i * 4 + 2, 0, true);
        });
        // Collision follows the drawn triangles, as the PC props' polygon lists do: the disc's own bounds of these props are solid
        // boxes, and a lying skeleton made solid kept Rynn off the armour that lies on it (journal 2026-11-14/ootf-d2-models.md).
        const used = new Set(disc.model.polygons.flatMap((q) => q.indices));
        const pts = Float32Array.from([...used].flatMap((v) => [0, 1, 2].map((k) => disc.model.positions[v * 3 + k]!)));
        const bounds = used.size ? synthesizeBounds(pts, disc.model.polygons.length) : null;
        if (!bounds) return null;
        const records = recs.map((r) =>
            r.type === MOD_NAME_RECORD
                ? { type: r.type, data: body }
                : r.type === MOD_BOUNDS
                  ? { type: r.type, data: bounds }
                  : r,
        );
        if (!records.some((r) => r.type === MOD_BOUNDS)) records.push({ type: MOD_BOUNDS, data: bounds });
        const nid = this.nextModel++;
        this.modelIds.set(key, nid);
        for (const id of ids) this.useTexture(id, key);
        this.models.push({
            id: nid,
            model: { ...disc.model, textures: ids.map((id) => ({ id, db: 0 })), bounds },
            records,
            key,
            disc: true,
        });
        this.report.models.converted++;
        return nid;
    }

    /**
     * PS2 model reference (`id`, db 0 = the level's own MOD) for a PC model reference, after `addModel` /
     * `addModelRef`; null when it was not converted (skinned, missing, failed). `owner` is the container base path
     * whose `.db` resolves `pcDb` (call `registerOwner` first).
     */
    mapModelRef(pcDb: number, pcId: number, owner: string): number | null {
        const c = this.resolveContainer(owner, pcDb);
        return c ? (this.modelIds.get(`${lower(c)}#${pcId}`) ?? null) : null;
    }

    // ------------------------------------------------------------------------------------------------ output

    /** The 64 byte bounds block at the head of a converted skinned model's 0x0208 (class records cache a copy of it); undefined otherwise. */
    skeletonBounds(newId: number): Uint8Array | undefined {
        const r = this.models.find((m) => m.id === newId)?.records?.find((x) => x.type === MOD_CHARACTER);
        return r ? r.data.slice(0, 64) : undefined;
    }

    /**
     * The 64 byte bounds block a class record caches at body 16..80 for its model (sphere, box; equals 0x0207 bytes 8..72 on all 813
     * RESOURES classes with a model): the skeleton's for a skinned model, else the model's 0x0207. A clone must carry its own model's.
     */
    modelBounds(newId: number): Uint8Array | undefined {
        const m = this.models.find((x) => x.id === newId);
        if (!m) return undefined;
        const sk = this.skeletonBounds(newId);
        if (sk) return sk;
        const r = (m.records ?? writePs2ModelRecords(m.model)).find((x) => x.type === MOD_BOUNDS);
        return r && r.data.length >= 72 ? r.data.slice(8, 72) : undefined;
    }

    /**
     * The converted records as container entries, for appending to an existing PS2 MOD / TXD (a host container whose own
     * `db 0` the class model refs resolve to): `models` = the 0x0200 / 0x0203 / 0x0204 / 0x0207 records with `sub` = `groupId`,
     * `textures` = the 0x0040 records.
     */
    entries(groupId: number): {
        models: { type: number; id: number; sub: number; data: Uint8Array }[];
        textures: { type: number; id: number; sub: number; data: Uint8Array }[];
        lastModelId: number;
    } {
        const models = this.models.flatMap(({ id, model, records }) =>
            (records ?? writePs2ModelRecords(model)).map((r) => ({ type: r.type, id, sub: groupId, data: r.data })),
        );
        const textures = this.texBodies.map((t) => ({ type: TXD_ENTRY_TYPE, id: t.id, sub: 0, data: t.body }));
        return { models, textures, lastModelId: this.models.reduce((m, x) => Math.max(m, x.id), 0) };
    }

    /** Write `<dir>/<STEM>.MOD`, `.TXD` and `.DB` (the stem is upper case, 8.3 style). */
    build(dir: string, stem: string): BuiltAssets {
        const S = stem.toUpperCase();
        const files: Record<string, Uint8Array> = {};
        files[`${dir}/${S}.MOD`] = buildPs2Mod(this.models, { group: this.options.group });
        files[`${dir}/${S}.TXD`] = buildPs2Txd(this.texBodies);
        files[`${dir}/${S}.DB`] = strToU8(buildDbText([]));
        return { files, report: this.report };
    }
}

/**
 * The polygons of a PC skinned model's first LOD. A PC LOD's `polyCount` leaves out the stump caps of its choppable channels
 * (cap `{stumpFirst, stumpCount, firstPoly, polyCount, joint}`), yet the caps sit inside the LOD's polygon run, so the first
 * `polyCount` polygons cut off its last parts: the converted Leather Wartok lost its right hand and part of a thigh, the
 * Chain and Plate Wartoks a shin. The LOD runs to the next LOD's first polygon (or the last channel cap); its stump caps,
 * which close the cut once a limb is chopped off, are left out.
 */
export function skinnedLodPolygons<P>(polygons: readonly P[], sk: Pick<Skeleton, 'lods' | 'channels'>): P[] {
    const L = sk.lods[0]!;
    const caps = sk.channels.map((c) => c.caps[0]?.values).filter((v): v is NonNullable<typeof v> => !!v);
    let end =
        sk.lods[1]?.firstPoly ??
        Math.max(L.firstPoly + L.polyCount, ...caps.map((v) => Math.max(v[0] + v[1], v[2] + v[3])));
    end = Math.min(Math.max(end, L.firstPoly + L.polyCount), polygons.length);
    const stump = new Set<number>();
    for (const v of caps) for (let i = v[0]; i < v[0] + v[1]; i++) if (v[1] > 0) stump.add(i);
    const out: P[] = [];
    for (let i = L.firstPoly; i < end; i++) if (!stump.has(i)) out.push(polygons[i]!);
    return out;
}
