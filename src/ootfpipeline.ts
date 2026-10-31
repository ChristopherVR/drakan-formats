import { strToU8 } from 'fflate';
import {
    convertPcLevel,
    dominantTexture,
    encodeString,
    ps2ClassTables,
    type ClassTarget,
    type ConversionReport,
    type Ps2LevelParts,
} from './convert.ts';
import {
    objectParamSpecs,
    parseObjectList,
    parseLevelHeader,
    setObjectParams,
    LVL_TYPE_HEADER,
    LVL_TYPE_OBJECTS,
    type LvlDependency,
    type LvlObject,
    type ParamSpec,
} from './lvl.ts';
import { ODB_CLASS_TYPE, ODB_FIELDS_TYPE, buildOdbIndex, parseOdbClasses, type OdbClass } from './odb.ts';
import { resourceKind, type ResourceContext, type ResourceKind } from './convert.ts';
import { FIELD_SOUND } from './fields.ts';
import { convertPcSounds, parsePcSounds, sdbKey, writePs2Sdb, type PcSoundBank } from './ootfsound.ts';
import { convertPcSequences, ssdPackFiles, usedIdsOf } from './ootfseq.ts';
import { SrscReader } from './srsc.ts';
import {
    TERRAIN_TXD_PATH,
    ps2CellFlags,
    TerrainTextureBuilder,
    convertTerrainTextures,
    findSplatDbIndex,
    findTerrainDbIndex,
    type TerrainTextureOptions,
} from './ootfterrain.ts';
import {
    applyCampaignExits,
    campaignExitStrings,
    campaignTitle,
    normalizeLevelRef,
    planCampaign,
    transitionFieldIndex,
    type CampaignPlan,
} from './ootfcampaign.ts';
import { applyMusicTriggers, findMusicTriggers, musicTriggerClassNames } from './ootfmusic.ts';
import { TextPlan, parseRrcStrings, rewriteClassTextDefaults, rewriteObjectTexts } from './ootftext.ts';
import { writePs2Srsc, type Ps2Entry } from './ootfcontainer.ts';
import {
    PS2_SUBSTITUTES,
    buildClassEntries,
    levelPropertiesParams,
    planClassMapping,
    type ClassPlan,
    type PcClassIn,
    type PlanOptions,
    type Ps2OdbIn,
} from './ootfclass.ts';
import { OotfAssetBuilder, type AssetReport } from './ootfassets.ts';
import { loadPcLevel, pcLevelName, resolvePcPath, type PcFileSource, type PcLevel } from './pc.ts';
import { CELL_SIZE, LVL_TYPE_LAYERS, parsePs2Terrain, terrainHeightAt } from './terrain.ts';
import { odbStemForDependency } from './odb.ts';

/**
 * One call from an Order of the Flame level to everything a PS2 mod pack needs: the converted LVL parts, the new
 * MOD / TXD / DB files for the models and textures, new ODB class records, patched `.DB` files, and a report. Stages are
 * independent: when one throws, the report says so and the level falls back to what the earlier stages produced
 * (terrain on the template's fallback texture, objects of existing PS2 classes only).
 *
 * Id maps kept consistent across the stages: textures (asset builder, `db` = the level dependency added for the shared
 * container), models (asset builder id, `db` = the dependency added to each target ODB's `.DB`), classes (plan).
 * Several levels converted together share one asset container, one class plan and the id maps.
 */

/** Directory-less name of the shared asset container ("Common\OotFCom\OotFCom" on the virtual disc). */
export const OOTF_COMMON_STEM = 'OOTFCOM';
const COMMON_DIR = 'files/ENGLISH/COMMON/OOTFCOM';
const COMMON_DEP = 'Common\\OotFCom\\OotFCom';

export interface OotfPs2Context {
    /** Template level (e.g. LEVEL1NA.LVL): header, dependency table, object list of singletons and every other entry. */
    template: SrscReader;
    /** PS2 ODBs by upper-case stem (`LEVEL1ON`). Only those named by the template's dependency table are used. */
    odbs: ReadonlyMap<string, SrscReader>;
    /** `.DB` text of each ODB stem with its disc directory (`ENGLISH/LEVELS/LEVEL1ON`); lets models be added to an ODB. */
    dbFiles?: ReadonlyMap<string, { dir: string; text: string }>;
    /** PS2 SSDs by upper-case stem (`LEVEL1ON`): the targets of converted sequences (their ids must not be reused). */
    ssds?: ReadonlyMap<string, SrscReader>;
    /** The template's splat TXD (`LEVEL1TS.TXD`); converted terrain textures are appended to it (ootfterrain.ts). */
    splatTxd?: Uint8Array;
    /**
     * The template's `Proc Textures` TXD (`PROCTEES.TXD`). When given, converted terrain textures are appended to it and
     * shipped as a replacement at `TERRAIN_TXD_PATH`; this is the only terrain texture route verified in the game
     * (docs/journal/2026-10-31/ootf-terrain.md). Takes precedence over `splatTxd`.
     */
    procTxd?: Uint8Array;
    /**
     * The host ODB's own MOD / TXD (`RESOURES.MOD` / `.TXD`). Converted models and their textures are appended to these and
     * shipped as whole-file replacements; classes cloned for the new models live in the same ODB, so their model ref is
     * `db 0` and no `.DB` or dependency changes (those stopped the Intro from loading, ootf-ingame.md bisect).
     */
    hostMod?: SrscReader;
    hostTxd?: SrscReader;
}

export interface OotfPipelineOptions {
    textures?: boolean;
    /** Terrain texture conversion options (first id, max size, texture cap). */
    terrain?: TerrainTextureOptions;
    /** Put the terrain textures in the shared container (OOTFCOM.TXD, own dependency) instead of the splat TXD. */
    terrainInCommon?: boolean;
    /** Rewrite the PS2 cell flags (high byte 0xff = opaque, see ootfterrain.ts `ps2CellFlags`). Default true. */
    terrainShading?: boolean;
    /** Debug: map each PC terrain texture to one of the template's own terrain textures (tests the blob path without new TXD data). */
    terrainDiscTextures?: boolean;
    models?: boolean;
    /** Cap on new ODB class records (see the plan stage). */
    maxNewClasses?: number;
    /** Stem of the host ODB (default RESOURES). */
    hostStem?: string;
    classes?: boolean;
    singletons?: boolean;
    /** Plan the campaign (titles, exits, strings) when more than one level is converted (default true). */
    campaign?: boolean;
    music?: boolean;
    /** Rewrite text defaults / parameters to new XDB strings (default true). */
    texts?: boolean;
    sounds?: boolean;
    sequences?: boolean;
    /** Name written into the header; default the PC level's name. */
    name?: (pc: PcLevel) => string;
    log?: (msg: string) => void;
}

export interface OotfStageResult {
    stage: string;
    ok: boolean;
    error?: string;
}

export interface OotfLevelOut {
    pcPath: string;
    title: string;
    parts: Ps2LevelParts;
    /** Per-level splat files to ship instead of the template's (`TXD` = template splat TXD plus the terrain textures). */
    splats: Record<string, Uint8Array>;
}

export interface OotfPipelineResult {
    levels: OotfLevelOut[];
    /** Mod-pack files that are not the LVL: `files/...` and `new/...` / `overrides/...` entries. */
    files: Record<string, Uint8Array>;
    stages: OotfStageResult[];
    assets: AssetReport | null;
    classPlan: ClassPlan | null;
    warnings: string[];
}

const hex4 = (n: number): string => n.toString(16).padStart(4, '0');

function cloneObject(o: LvlObject, id: number): LvlObject {
    return {
        ...o,
        id,
        pos: [...o.pos],
        rot: [...o.rot],
        scale: o.scale ? [...o.scale] : null,
        links: [],
        params: o.params.map((p) => ({ ...p, nameRaw: p.nameRaw.slice() })),
        data: [...o.data],
    };
}

async function buildPs2OdbIn(stem: string, dbIndex: number, odb: SrscReader): Promise<Ps2OdbIn> {
    const classes = await parseOdbClasses(odb);
    const raw = new Map<number, Uint8Array>();
    const group = new Map<number, number>();
    for (const e of odb.entries) {
        if (e.type !== ODB_CLASS_TYPE) continue;
        raw.set(e.id, await odb.readRaw(e));
        group.set(e.id, e.sub);
    }
    const fe = odb.entries.find((e) => e.type === ODB_FIELDS_TYPE);
    return {
        dbIndex,
        file: `${stem}.ODB`,
        classes,
        raw: (id) => raw.get(id),
        group: (id) => group.get(id),
        fieldLists: fe ? { id: fe.id, sub: fe.sub, stored: await odb.readRaw(fe) } : undefined,
    };
}

function owner(pc: PcLevel, db: number): string | null {
    const p = pc.odbPaths.get(db);
    return p ? p.replace(/\.odb$/i, '') : null;
}

/** Convert one or more PC levels that share an asset container and class plan. */
export async function convertOotfLevels(
    src: PcFileSource,
    pcPaths: readonly string[],
    ps2: OotfPs2Context,
    opt: OotfPipelineOptions = {},
): Promise<OotfPipelineResult> {
    const log = opt.log ?? (() => {});
    const res: OotfPipelineResult = { levels: [], files: {}, stages: [], assets: null, classPlan: null, warnings: [] };
    const stage = async <T>(name: string, fn: () => Promise<T>): Promise<T | null> => {
        try {
            const v = await fn();
            res.stages.push({ stage: name, ok: true });
            return v;
        } catch (e) {
            const msg = e instanceof Error ? `${e.message}` : String(e);
            res.stages.push({ stage: name, ok: false, error: msg });
            res.warnings.push(`stage ${name} failed: ${msg}`);
            log(`stage ${name} failed: ${msg}\n${(e as Error).stack ?? ''}`);
            return null;
        }
    };

    const tplHeader = parseLevelHeader(
        await ps2.template.readRaw(ps2.template.entries.find((x) => x.type === LVL_TYPE_HEADER)!),
    );
    const tplList = parseObjectList(
        await ps2.template.readRaw(ps2.template.entries.find((x) => x.type === LVL_TYPE_OBJECTS)!),
    );
    const layersEntry = ps2.template.entries.find((x) => x.type === LVL_TYPE_LAYERS)!;
    const layersRaw = await ps2.template.readRaw(layersEntry);
    const fallback = dominantTexture(parsePs2Terrain(layersRaw));
    const discRefs = (() => {
        const n = new Map<number, number>();
        for (const L of parsePs2Terrain(layersRaw))
            for (const r of L.cellTexLeft) if (r < 0xfffffffe) n.set(r, (n.get(r) ?? 0) + 1);
        return [...n]
            .sort((a, b) => b[1] - a[1])
            .slice(0, 12)
            .map((x) => x[0]);
    })();
    const classes = ps2ClassTables(tplHeader, await buildOdbIndex(new Map([...ps2.odbs])));

    const pcs: PcLevel[] = [];
    for (const p of pcPaths) {
        const pc = await stage(`load ${p}`, () => loadPcLevel(src, p));
        if (pc) pcs.push(pc);
    }

    // ---- campaign plan, text plan
    const plan0: CampaignPlan | null =
        opt.campaign !== false && pcs.length > 1 ? planCampaign(pcs, { prefix: 'OotF' }) : null;
    if (plan0) for (const w of plan0.warnings) res.warnings.push(`campaign: ${w}`);
    const textPlan = new TextPlan({ rrc: await loadRrcStrings(src) });

    // ---- shared assets
    const hostStem = (opt.hostStem ?? 'RESOURES').toUpperCase();
    const hostFile = `${hostStem}.ODB`;
    const hostDir = ps2.dbFiles?.get(hostStem)?.dir;
    const hostOk = !!(ps2.hostMod && ps2.hostTxd && hostDir);
    const maxId = (r: SrscReader | undefined, type: number): number =>
        (r?.entries ?? []).reduce((m, e) => (e.type === type ? Math.max(m, e.id) : m), 0);
    const hostGroup = ps2.hostMod?.entries.find((e) => e.type === 0x0200)?.sub ?? 1;
    const builder = new OotfAssetBuilder(src, {
        firstModelId: maxId(ps2.hostMod, 0x0200) + 1,
        firstTextureId: maxId(ps2.hostTxd, 0x0040) + 1,
    });
    const splatDb = findSplatDbIndex(tplHeader);

    // ---- classes (+ models for the classes that need one)
    const used = new Map<string, PcClassIn & { pc: PcLevel }>();
    for (const pc of pcs) {
        for (const o of pc.list.objects) {
            const cls = pc.classes.get(o.dbIndex)?.get(o.classId);
            const key = `${pc.path}|${o.dbIndex}:${o.classId}`;
            if (cls && !used.has(key)) used.set(key, { db: o.dbIndex, id: o.classId, cls, pc });
        }
    }
    const ownerOf = new Map<OdbClass, string>();
    if (opt.models !== false && opt.classes !== false && hostOk) {
        await stage('models', async () => {
            for (const u of used.values()) {
                const m = u.cls.model;
                const ow = owner(u.pc, u.db);
                if (!m || !ow) continue;
                ownerOf.set(u.cls, ow);
                await builder.addModelRef(ow, m.db, m.id);
            }
        });
    }
    const sig = (c: OdbClass): string => `${c.name}|${c.rflClass}|${(c.data ?? []).join(',')}`;
    const planKey = new Map<string, { db: number; id: number }>();
    let plan: ClassPlan | null = null;
    let ps2Odbs: Ps2OdbIn[] = [];
    if (opt.classes !== false) {
        plan = await stage('classes', async () => {
            ps2Odbs = [];
            for (const d of tplHeader.dependencies) {
                const stem = odbStemForDependency(d.path.text);
                const odb = ps2.odbs.get(stem);
                if (odb) ps2Odbs.push(await buildPs2OdbIn(stem, d.dbIndex, odb));
            }
            const input: PcClassIn[] = [];
            // One plan for all levels: the plan keys classes by (db, id), which differ per level, so each distinct
            // class (name, engine id, defaults) gets a unique pseudo db.
            for (const u of used.values()) {
                const k = sig(u.cls);
                if (planKey.has(k)) continue;
                planKey.set(k, { db: planKey.size + 1, id: u.id });
                input.push({ db: planKey.size, id: u.id, cls: u.cls });
            }
            const planOpts: PlanOptions = {
                rewriteText:
                    opt.texts === false
                        ? undefined
                        : (file, fields, data) =>
                              void rewriteClassTextDefaults(fields, data, textPlan, file.replace(/\.ODB$/i, '.XDB')),
                substituteEngineId: PS2_SUBSTITUTES,
                modelOdbFile: hostFile,
                modelFor: hostOk
                    ? (cls, file) => {
                          const ow = ownerOf.get(cls);
                          if (!ow || !cls.model || file !== hostFile) return null;
                          const id = builder.mapModelRef(cls.model.db, cls.model.id, ow);
                          return id === null ? null : { id, db: 0 };
                      }
                    : undefined,
            };
            let result = planClassMapping(input, ps2Odbs, planOpts);
            // The engine broke when an ODB grew by about 3 records / 600 bytes of field lists (ootf-ingame.md); `maxNewClasses`
            // keeps the classes used by the most objects and drops the rest, so a level can still be tested.
            if (opt.maxNewClasses !== undefined && result.synthesized.length > opt.maxNewClasses) {
                const count = new Map<string, number>();
                for (const u of used.values()) {
                    const k = sig(u.cls);
                    count.set(
                        k,
                        (count.get(k) ?? 0) +
                            u.pc.list.objects.filter((o) => o.dbIndex === u.db && o.classId === u.id).length,
                    );
                }
                const objs = (s: { pcKeys: string[] }): number =>
                    s.pcKeys.reduce((n, key) => {
                        const e = [...planKey].find(([, v]) => `${v.db}:${v.id}` === key);
                        return n + (e ? (count.get(e[0]) ?? 0) : 0);
                    }, 0);
                const keep = new Set(
                    [...result.synthesized]
                        .sort((x, y) => objs(y) - objs(x))
                        .slice(0, opt.maxNewClasses)
                        .flatMap((x) => x.pcKeys),
                );
                const mapped = new Set(result.mapped.keys());
                const sub = input.filter((i) => keep.has(`${i.db}:${i.id}`) || mapped.has(`${i.db}:${i.id}`));
                result = planClassMapping(sub, ps2Odbs, planOpts);
                res.warnings.push(
                    `classes: limited to ${opt.maxNewClasses} new class records (engine limit under investigation)`,
                );
            }
            return result;
        });
        res.classPlan = plan;
    }

    const findPs2Class = (pred: (c: OdbClass) => boolean): { t: ClassTarget; cls: OdbClass } | null => {
        for (const [dbIndex, table] of classes) {
            for (const [classId, cls] of table) if (pred(cls)) return { t: { dbIndex, classId, cls }, cls };
        }
        return null;
    };
    const musicClass = findPs2Class((c) => /^triggered music loop$/i.test(c.name.trim()) && !!c.fields);
    const exitClass = findPs2Class((c) => c.rflClass === 55 && transitionFieldIndex(c.fields) >= 0);
    const resolverFor = (pc: PcLevel): ((db: number, id: number) => ClassTarget | null) | undefined => {
        if (!plan) return undefined;
        const music = opt.music !== false && musicClass ? new Set(musicTriggerClassNames(pc)) : null;
        return (db, id) => {
            const cls = pc.classes.get(db)?.get(id);
            if (cls && music?.has(cls.name)) return musicClass!.t;
            const k = cls ? planKey.get(sig(cls)) : undefined;
            return k ? plan!.resolve(k.db, k.id) : null;
        };
    };

    // ---- resource helpers shared by the stages below
    const fileOfTarget = (t: ClassTarget): string => {
        const dep = tplHeader.dependencies.find((d) => d.dbIndex === t.dbIndex);
        return `${odbStemForDependency(dep?.path.text ?? '')}.ODB`;
    };
    interface Need {
        owner: string;
        ref: number;
        target: ClassTarget | null;
    }
    const scan = async (pc: PcLevel, kind: ResourceKind): Promise<Need[]> => {
        const out: Need[] = [];
        const resolve = resolverFor(pc);
        for (const o of pc.list.objects) {
            const ow = owner(pc, o.dbIndex);
            if (!ow) continue;
            for (const sp of objectParamSpecs(o)) {
                if (resourceKind(sp.type) !== kind) continue;
                await builder.registerOwner(ow);
                const vals = Array.isArray(sp.value) ? sp.value : [sp.value];
                for (const v of vals) {
                    if (typeof v === 'number' && v)
                        out.push({ owner: ow, ref: v >>> 0, target: resolve?.(o.dbIndex, o.classId) ?? null });
                }
            }
        }
        return out;
    };

    // ---- sounds: the sounds that object parameters name, in one new SDB of the shared container
    let soundLookup: ((ownerPath: string, ref: number) => number | null) | null = null;
    if (opt.sounds === true) {
        await stage('sounds', async () => {
            const banks = new Map<string, PcSoundBank>();
            const want = new Map<string, Set<number>>();
            for (const pc of pcs) {
                for (const n of await scan(pc, 'sound')) {
                    const c = builder.resolveContainer(n.owner, n.ref >>> 16);
                    if (!c) continue;
                    const k = sdbKey(`${c}.sdb`);
                    (want.get(k) ?? want.set(k, new Set()).get(k)!).add(n.ref & 0xffff);
                }
            }
            for (const k of want.keys()) {
                const bytes = await src.read(`${k}.sdb`);
                if (!bytes) continue;
                const bank = await parsePcSounds(bytes);
                banks.set(k, { ...bank, sounds: bank.sounds.filter((x) => want.get(k)!.has(x.id)) });
            }
            if (!banks.size) return;
            const conv = convertPcSounds(
                banks,
                { firstId: 1, groupId: 1, groupName: 'Order of the Flame' },
                { maxBytes: 0x3f000 },
            );
            for (const w of conv.warnings.slice(0, 5)) res.warnings.push(`sounds: ${w}`);
            if (!conv.sounds.length) return;
            res.files[`files/${hostDir ?? 'ENGLISH/COMMON/RESOURES'}/${hostStem}.SDB.new`] = writePs2Sdb(conv.sounds, [
                conv.group,
            ]); // TODO merge into the host SDB
            soundLookup = (ow, ref) => {
                const c = builder.resolveContainer(ow, ref >>> 16);
                const m = c ? conv.map.get(sdbKey(`${c}.sdb`), ref & 0xffff) : null;
                return m === null ? null : m & 0xffff;
            };
        });
    }
    const seqIds = new Map<string, number>();
    const mapResource = (kind: ResourceKind, ref: number, ctx: ResourceContext): number | null => {
        const ow = owner(ctx.pc, ctx.ownerDb);
        if (!ow) return null;
        try {
            // Refs resolve through the owning ODB; only the host ODB's own MOD / SDB (db 0) carries converted resources.
            if (fileOfTarget(ctx.target) !== hostFile) return null;
            if (kind === 'sound' && soundLookup) return soundLookup(ow, ref);
            if (kind === 'model') return builder.mapModelRef(ref >>> 16, ref & 0xffff, ow);
            if (kind === 'sequence') return seqIds.get(`${ctx.pc.path}|${ow}|${ref}`) ?? null;
        } catch {
            return null;
        }
        return null;
    };
    const ssdUsed = new Map<string, Set<number>>();
    const ssdFiles: Record<string, Uint8Array> = {};

    const procDb = findTerrainDbIndex(tplHeader);
    const terrBuilder =
        opt.textures !== false && !opt.terrainInCommon && ps2.procTxd && procDb !== undefined
            ? await TerrainTextureBuilder.create(src, ps2.procTxd, procDb, opt.terrain)
            : null;

    // ---- levels
    for (const pc of pcs) {
        const procMap = terrBuilder ? await stage(`terrain textures ${pc.path}`, () => terrBuilder.addLevel(pc)) : null;
        const tex =
            !terrBuilder && opt.textures !== false && !opt.terrainInCommon && ps2.splatTxd && splatDb !== undefined
                ? await stage(`textures ${pc.path}`, () =>
                      convertTerrainTextures(pc, src, ps2.splatTxd!, splatDb, opt.terrain),
                  )
                : null;
        const title = (
            (plan0 && campaignTitle(plan0, pc.path)) ||
            (opt.name ? opt.name(pc) : pcLevelName(pc.header))
        ).slice(0, 60);
        const convertOnce = (): Ps2LevelParts =>
            convertPcLevel(pc, {
                template: { header: tplHeader, classes },
                textureFallback: fallback,
                resolveClass: resolverFor(pc),
                mapTexture: opt.terrainDiscTextures
                    ? (r) => (discRefs.length ? discRefs[r % discRefs.length]! : null)
                    : procMap
                      ? procMap
                      : tex
                        ? tex.mapTexture
                        : undefined,
                mapResource,
                name: title,
            });
        let parts = await stage(`convert ${pc.path}`, async () => convertOnce());
        if (parts && opt.sequences !== false) {
            // Sequences need the final object ids, so convert once, convert the sequences, then convert again with their refs.
            const first = parts;
            const again = await stage(`sequences ${pc.path}`, async () => {
                const needs = await scan(pc, 'sequence');
                const groups = new Map<string, { stem: string; ow: string; db: number; ids: Set<number> }>();
                for (const n of needs) {
                    if (!n.target) continue;
                    const stem = fileOfTarget(n.target).replace(/\.ODB$/, '');
                    const k = `${stem}|${n.owner}|${n.ref >>> 16}`;
                    (
                        groups.get(k) ?? groups.set(k, { stem, ow: n.owner, db: n.ref >>> 16, ids: new Set() }).get(k)!
                    ).ids.add(n.ref & 0xffff);
                }
                let any = false;
                for (const g of groups.values()) {
                    const ssd = ps2.ssds?.get(g.stem);
                    const c = builder.resolveContainer(g.ow, g.db);
                    const bytes = c ? await src.read(`${c}.ssd`) : null;
                    if (!ssd || !bytes) {
                        res.warnings.push(
                            `sequences: no ${g.stem}.SSD target or ${c}.ssd source; ${g.ids.size} sequence(s) dropped`,
                        );
                        continue;
                    }
                    const used = ssdUsed.get(g.stem) ?? ssdUsed.set(g.stem, usedIdsOf(ssd)).get(g.stem)!;
                    const conv = await convertPcSequences(await SrscReader.fromBytes(bytes), {
                        maps: { objectIdMap: first.objectIdMap },
                        usedIds: used,
                        only: g.ids,
                        pcDbIndex: g.db,
                        ps2Db: 0,
                        folderName: `OotF ${title}`.slice(0, 40),
                    });
                    Object.assign(ssdFiles, ssdPackFiles(`${g.stem}.SSD`, conv.entries));
                    for (const [k, v] of conv.idMap) seqIds.set(`${pc.path}|${g.ow}|${k}`, v);
                    any = any || conv.idMap.size > 0;
                }
                return any ? convertOnce() : first;
            });
            parts = again ?? first;
        }
        if (!parts) continue;
        if (opt.singletons !== false) {
            await stage(`singletons ${pc.path}`, async () => ensureSingletons(parts, pc, tplList.objects, classes));
        }
        const lvl = parts;
        const xdbOf = (o: LvlObject): string | null => {
            const d = tplHeader.dependencies.find((x) => x.dbIndex === o.dbIndex);
            return d ? `${odbStemForDependency(d.path.text)}.XDB` : null;
        };
        if (opt.music !== false && musicClass) {
            await stage(`music ${pc.path}`, async () => {
                applyMusicTriggers(lvl.objects, findMusicTriggers(pc), pc.path, {
                    musicClass: {
                        dbIndex: musicClass.t.dbIndex,
                        classId: musicClass.t.classId,
                        fields: musicClass.cls.fields!,
                    },
                });
            });
        }
        const cl = plan0?.byPath.get(normalizeLevelRef(pc.path));
        if (plan0 && cl && exitClass) {
            await stage(`exits ${pc.path}`, async () => {
                const exitField = (o: LvlObject) => {
                    const c = classes.get(o.dbIndex)?.get(o.classId);
                    const i = c?.rflClass === 55 ? transitionFieldIndex(c.fields) : -1;
                    return i >= 0 ? { fieldIndex: i, type: c!.fields![i]!.type, name: c!.fields![i]!.name } : null;
                };
                const i = transitionFieldIndex(exitClass.cls.fields);
                const r = applyCampaignExits(lvl.objects, cl, plan0, {
                    exitFieldOf: exitField,
                    exitClass: {
                        dbIndex: exitClass.t.dbIndex,
                        classId: exitClass.t.classId,
                        field: {
                            fieldIndex: i,
                            type: exitClass.cls.fields![i]!.type,
                            name: exitClass.cls.fields![i]!.name,
                        },
                    },
                });
                for (const w of r.warnings) res.warnings.push(w);
            });
        }
        if (opt.texts !== false)
            await stage(`texts ${pc.path}`, async () => void rewriteObjectTexts(lvl.objects, textPlan, xdbOf));
        if (opt.terrainShading !== false)
            parts.terrain = parts.terrain.map((L) => ({ ...L, cellFlags: ps2CellFlags(L) }));
        res.levels.push({ pcPath: pc.path, title, parts, splats: tex ? { TXD: tex.txd } : {} });
    }

    // ---- files
    if (terrBuilder) res.files[TERRAIN_TXD_PATH] = terrBuilder.build();
    res.assets = builder.report;
    if (hostOk) {
        await stage('assets', async () => {
            const add = builder.entries(hostGroup);
            if (!add.models.length && !add.textures.length) return;
            const dir = `files/${hostDir}`;
            const mod = ps2.hostMod!;
            const modEntries: Ps2Entry[] = [];
            for (const e of mod.entries) {
                let data = await mod.readRaw(e);
                if (e.type === 0x0202 && data.length >= 6) {
                    data = data.slice();
                    new DataView(data.buffer).setUint16(
                        4,
                        Math.max(add.lastModelId, new DataView(data.buffer).getUint16(4, true)),
                        true,
                    );
                }
                modEntries.push({ type: e.type, id: e.id, sub: e.sub, data });
            }
            res.files[`${dir}/${hostStem}.MOD`] = writePs2Srsc([...modEntries, ...add.models]);
            const txd = ps2.hostTxd!;
            const txdEntries: Ps2Entry[] = [];
            for (const e of txd.entries)
                txdEntries.push({ type: e.type, id: e.id, sub: e.sub, data: await txd.readRaw(e) });
            res.files[`${dir}/${hostStem}.TXD`] = writePs2Srsc([...txdEntries, ...add.textures]);
        });
    }
    if (plan && ps2Odbs.length) {
        await stage('class entries', async () => {
            for (const c of await buildClassEntries(plan!, ps2Odbs)) {
                const dir = c.isNew ? 'new' : 'overrides';
                res.files[`${dir}/${c.file}/${hex4(c.type)}_${c.id}_${c.sub}.bin`] = c.data;
            }
        });
    }
    if (plan0 && exitClass) {
        await stage('campaign strings', async () => {
            const xdb = `${odbStemForDependency(tplHeader.dependencies.find((d) => d.dbIndex === exitClass.t.dbIndex)?.path.text ?? '')}.XDB`;
            for (const c of campaignExitStrings(plan0, xdb)) {
                res.files[`new/${c.file}/${hex4(c.type)}_${c.id}_${c.sub}.bin`] = c.data;
            }
        });
    }
    await stage('texts', async () => {
        for (const c of textPlan.entries()) res.files[`new/${c.file}/${hex4(c.type)}_${c.id}_${c.sub}.bin`] = c.data;
        for (const w of textPlan.warnings.slice(0, 5)) res.warnings.push(`text: ${w}`);
    });
    Object.assign(res.files, ssdFiles);
    return res;
}

/** Make sure the level has Rynn, a Camera and Level Properties (the PC data lacks the last; MP maps may lack the others). */
function ensureSingletons(
    parts: Ps2LevelParts,
    pc: PcLevel,
    tpl: readonly LvlObject[],
    classes: ReadonlyMap<number, ReadonlyMap<number, OdbClass>>,
): void {
    const rflOf = (o: LvlObject): number | undefined => classes.get(o.dbIndex)?.get(o.classId)?.rflClass;
    const list = parts.objects;
    let nextId = list.objects.reduce((m, o) => Math.max(m, o.id), 0) + 1;
    for (const rfl of [9, 27, 54]) {
        const have = list.objects.find((o) => rflOf(o) === rfl);
        const t = tpl.find((o) => rflOf(o) === rfl);
        if (!t) continue;
        let target = have;
        if (!target) {
            target = cloneObject(t, nextId++);
            if (rfl === 9) {
                const L = pc.terrain[0];
                if (L) {
                    const x = (L.originX + L.width / 2) * CELL_SIZE;
                    const z = (L.originZ + L.height / 2) * CELL_SIZE;
                    const g = terrainHeightAt(pc.terrain, x, z);
                    target.pos = [x, (Number.isFinite(g) ? g : 0) + 400, z];
                }
            }
            list.objects.push(target);
        }
        if (rfl === 54) {
            const cls = classes.get(target.dbIndex)?.get(target.classId);
            let pcCls: OdbClass | undefined;
            for (const table of [...pc.classes].sort((a, b) => a[0] - b[0]).map((x) => x[1])) {
                for (const c of table.values()) if (!pcCls && c.rflClass === 54) pcCls = c;
            }
            if (cls && pcCls) {
                const { specs } = levelPropertiesParams(pcCls, cls);
                const merged = new Map<number, ParamSpec>();
                for (const s of objectParamSpecs(target)) merged.set(s.fieldIndex, s);
                for (const s of specs) merged.set(s.fieldIndex, s);
                if (specs.length) setObjectParams(list, target.id, [...merged.values()]);
            }
        }
    }
}

export type { ConversionReport };

/** Dragon.rrc strings of the install (`<0xNNNN>` references), empty when the file is missing. */
async function loadRrcStrings(src: PcFileSource): Promise<Map<number, string>> {
    try {
        const path = (await src.list()).find((p) => /(^|\/)dragon\.rrc$/i.test(p));
        const bytes = path ? await src.read(path) : null;
        return bytes ? await parseRrcStrings(await SrscReader.fromBytes(bytes)) : new Map();
    } catch {
        return new Map();
    }
}
