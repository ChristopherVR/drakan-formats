import { strToU8 } from 'fflate';
import { type ModelTextureRef, ModelError } from './model.ts';
import { buildDbText, parseDbText } from './ootfcontainer.ts';
import { type NeutralModel, buildPs2Mod, parsePcModel, pcToNeutral, type PcToPs2Options } from './ootfmodel.ts';
import {
    PC_TEX_NEXT_FRAME,
    type Ps2TextureOptions,
    buildPs2Txd,
    encodePs2Texture,
    isSkip,
    readPcTexture,
} from './ootftex.ts';
import { type PcFileSource, type PcLevel, resolvePcPath } from './pc.ts';
import { SrscReader } from './srsc.ts';

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
 * Skinned (0x0208) models are reported in `report.skipped` and get no PS2 ref.
 */

export interface AssetBuilderOptions {
    texture?: Ps2TextureOptions;
    model?: Pick<PcToPs2Options, 'keepQuads' | 'flatToSmooth' | 'flipNormals'>;
    /** Flag polygons of textures with transparency as double sided (default true). */
    doubleSidedAlpha?: boolean;
    /** Group name inside the MOD (default "OotF"). */
    group?: string;
}

export interface AssetReport {
    models: { converted: number; triangles: number; polygonsDropped: number; flatToSmooth: number };
    textures: { converted: number; bytes: number; byBpp: Record<string, number>; lossy: number };
    /** `container#id` -> why there is no PS2 counterpart. */
    skipped: Map<string, string>;
    warnings: string[];
}

export interface BuiltAssets {
    /** Files by path: `<dir>/<STEM>.MOD`, `.TXD`, `.DB`. */
    files: Record<string, Uint8Array>;
    report: AssetReport;
}

const lower = (s: string): string => s.toLowerCase();

export class OotfAssetBuilder {
    readonly report: AssetReport = {
        models: { converted: 0, triangles: 0, polygonsDropped: 0, flatToSmooth: 0 },
        textures: { converted: 0, bytes: 0, byBpp: {}, lossy: 0 },
        skipped: new Map(),
        warnings: [],
    };
    private readonly containers = new Map<string, SrscReader | null>();
    private readonly dbs = new Map<string, Map<number, string> | null>();
    /** `container#id` (lower case) -> new PS2 texture id. */
    private readonly texIds = new Map<string, number>();
    private readonly texAlpha = new Map<number, boolean>();
    private readonly texBodies: { id: number; body: Uint8Array }[] = [];
    private readonly modelIds = new Map<string, number>();
    private readonly models: { id: number; model: NeutralModel }[] = [];
    private nextTex = 1;
    private nextModel = 2;

    constructor(
        readonly src: PcFileSource,
        readonly options: AssetBuilderOptions = {},
    ) {}

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

    /** Convert PC texture `id` of `<container>.txd` (and the frames that follow it). Returns the new PS2 id or null. */
    async addTexture(container: string, id: number): Promise<number | null> {
        const key = `${lower(container)}#${id}`;
        const known = this.texIds.get(key);
        if (known !== undefined) return known;
        if (this.texIds.has(key)) return null;
        const txd = await this.open(container, 'txd');
        if (!txd) {
            this.skip(key, `${container}.txd not found`);
            return null;
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
            const t = encodePs2Texture(f.image, { fps: f.info.fps || 10, ...this.options.texture });
            if (i > 0) t.body[37] = t.body[37]! | PC_TEX_NEXT_FRAME;
            const nid = base + i;
            this.texBodies.push({ id: nid, body: t.body });
            this.texAlpha.set(nid, t.hasAlpha);
            this.texIds.set(`${lower(container)}#${f.id}`, nid);
            this.report.textures.converted++;
            this.report.textures.bytes += t.body.length;
            this.report.textures.byBpp[t.bpp] = (this.report.textures.byBpp[t.bpp] ?? 0) + 1;
            if (t.lossy) this.report.textures.lossy++;
        });
        this.nextTex += frames.length;
        return base;
    }

    /** Add every texture a level's terrain uses, so `mapTexture` can answer synchronously. */
    async prepareLevelTextures(pc: PcLevel): Promise<void> {
        const refs = new Set<number>();
        for (const L of pc.terrain) for (const r of L.cellTexLeft) if (r < 0xfffffffe) refs.add(r);
        for (const r of refs) {
            const c = this.levelContainer(r >>> 16, pc);
            if (c) await this.addTexture(c, r & 0xffff);
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
    async addModel(container: string, id: number): Promise<number | null> {
        const key = `${lower(container)}#${id}`;
        const known = this.modelIds.get(key);
        if (known !== undefined) return known;
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
        if (pc.character) return fail('skinned model (0x0208), see ootfanim');
        if (this.nextModel > 0xffff) return fail('model id space exhausted');
        const map = new Map<string, ModelTextureRef | null>();
        const used = new Set(pc.polygons.map((p) => p.texture));
        for (const [ti, t] of pc.textures.entries()) {
            if (!used.has(ti)) continue; // unused list entries are not converted
            const tc = this.resolveContainer(container, t.db);
            const nid = tc ? await this.addTexture(tc, t.id) : null;
            map.set(`${t.db}/${t.id}`, nid === null ? null : { id: nid, db: 0 });
        }
        const { model, stats } = pcToNeutral(pc, {
            ...this.options.model,
            mapTexture: (r) => map.get(`${r.db}/${r.id}`) ?? null,
            doubleSided: (this.options.doubleSidedAlpha ?? true) ? (r) => this.texAlpha.get(r.id) === true : undefined,
        });
        if (model.polygons.length === 0 && pc.polygons.length > 0) return fail('no polygon left (textures missing)');
        if (model.positions.length / 3 > 0xffff) return fail('too many vertices');
        const nid = this.nextModel++;
        this.modelIds.set(key, nid);
        this.models.push({ id: nid, model });
        const m = this.report.models;
        m.converted++;
        m.triangles += stats.trianglesOut;
        m.polygonsDropped += stats.polygonsDropped;
        if (stats.flatToSmooth) m.flatToSmooth++;
        return nid;
    }

    /** Model reference as stored in a class of `owner`'s ODB (`db` indexes `owner.db`): convert and return the PS2 ref. */
    async addModelRef(owner: string, pcDb: number, pcId: number): Promise<number | null> {
        await this.registerOwner(owner);
        const c = this.resolveContainer(owner, pcDb);
        if (!c) {
            this.skip(`model ${lower(owner)}#db${pcDb}/${pcId}`, 'db index not in the .db');
            return null;
        }
        return this.addModel(c, pcId);
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
