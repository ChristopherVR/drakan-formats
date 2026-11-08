import { buildBowAimMetadata } from './ootfbowaim.ts';
import { requireGenericPropDrawLists, requireRigidWeaponDrawLists } from './ootfpropdraw.ts';
import { holdLinkedDoors } from './ootfdoors.ts';
import { splitClassRecord } from './odbwrite.ts';
import { carryStartingInventory } from './ootfstartinventory.ts';
import { ootfDebugFlag } from './ootfdebug.ts';
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
import {
    ODB_CLASS_TYPE,
    ODB_FIELDS_TYPE,
    buildOdbIndex,
    classFieldDefault,
    parseOdbClasses,
    type OdbClass,
} from './odb.ts';
import { resourceKind, type ResourceContext, type ResourceKind } from './convert.ts';
import { FIELD_ANIMATION, FIELD_MODEL, FIELD_SOUND, decodeFieldValue, fieldBase, fieldIsIndirect } from './fields.ts';
import {
    convertPcSounds,
    soundIdAllocator,
    parsePcSounds,
    ps2SoundEntries,
    sdbKey,
    writePs2Sdb,
    type PcSoundBank,
} from './ootfsound.ts';
import { applyCulling, planLevelCulling, sceneFileKey, type LevelCulling } from './ootfcull.ts';
import type { PcSequence } from './ootfseq.ts';
import { planShellTrims } from './ootfshell.ts';
import { convertStompPlayers, pcStompPlayer } from './ootfstomp.ts';
import {
    convertPcSequences,
    parsePcSequence,
    type RefLookup,
    pcLevelFov,
    skeletonChannelMap,
    sequenceSoundRefs,
    sequenceSsdStem,
    ssdPackFiles,
    usedIdsOf,
} from './ootfseq.ts';
import { SrscReader } from './srsc.ts';
import {
    TERRAIN_TXD_PATH,
    limitVisibleEntries,
    ps2CellFlags,
    TerrainTextureBuilder,
    buildTerrainPoolTxd,
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
    exitDetectorParams,
    type CampaignPlan,
} from './ootfcampaign.ts';
import {
    applyLevelMusic,
    findMusicTriggers,
    musicTriggerClassNames,
    pcInitialMusicId,
    pcInterfaceMusic,
} from './ootfmusic.ts';
import { buildOotfMusicPack, type OotfMusicPack } from './ootfdmusic.ts';
import { applyPuzzleLogic, relayDetectorSequences } from './ootfpuzzle.ts';
import { encodePs2Texture, type Ps2TextureOptions, type TextureMode } from './ootftex.ts';
import { TextPlan, isTextField, parseRrcStrings, rewriteClassTextDefaults, rewriteObjectTexts } from './ootftext.ts';
import {
    asciiLevelTitle,
    assertOotfSource,
    checkOotfSource,
    introTemplateWarning,
    detectOotfLanguage,
    type OotfLanguageGuess,
    OotfSourceError,
    isOotfAirArenaLevel,
    isOotfArenaLevel,
    ootfLevelKey,
    pickRrcPath,
    type OotfSourceProfile,
} from './ootfsource.ts';
import { writePs2Srsc, type Ps2Entry } from './ootfcontainer.ts';
import {
    ENGINE_CLASSES,
    PS2_SUBSTITUTES,
    aliasSquash,
    buildClassEntries,
    cloneClassRecord,
    keepsPcDefaults,
    setSynthesizedDefaults,
    levelPropertiesParams,
    planClassMapping,
    type ClassPlan,
    type PcClassIn,
    type PlanOptions,
    type Ps2OdbIn,
    type Synthesized,
} from './ootfclass.ts';
import { OotfAssetBuilder, type AssetReport } from './ootfassets.ts';
import { type Ps2TextureSwapOptions, effectiveSubstitutions, resolvePs2Substitutes } from './ootfps2tex.ts';
import { type Ps2ModelSwapOptions, modelKey, planPs2Models } from './ootfps2model.ts';
import { REFERENCE_ENGINES, deliberateOmission, pcParamAlias } from './ootfcoverage.ts';
import { loadPcLevel, parsePcOdbClasses, pcLevelName, resolvePcPath, type PcFileSource, type PcLevel } from './pc.ts';
import {
    classDefaultReferences,
    classReferenceClosure,
    ownedClassKey,
    relocateClassDefaultReferences,
} from './ootfclassrefs.ts';
import { CELL_SIZE, LVL_TYPE_LAYERS, parsePs2Terrain, terrainHeightAt } from './terrain.ts';
import { odbStemForDependency } from './odb.ts';
import { animName, parsePs2Anim, parseSkeleton, ps2AnimFlags, writePs2Anim, type PcAnim, type Skeleton } from './ootfanim.ts';
import { buildRig } from './skeleton.ts';
import { MOD_CHARACTER } from './model.ts';
import { SSD_SEQUENCE } from './resources.ts';
import { chooseRetargetTarget, retargetCreature } from './ootfretarget.ts';
import {
    applyMapOverride,
    classFieldIndex,
    defaultLevelMap,
    isMapClass,
    mapClassValues,
    mapPixelOf,
    mapTextureImage,
    type LevelMapOverride,
    type LevelMapSpec,
} from './ootfmap.ts';

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

/** Engine classes of particle effects: not cloned into template ODBs by default (see `modelFor` in the plan stage). */
const CROSS_FX_RFL: ReadonlySet<number> = new Set([43, 71, 97]);

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
    /** The host ODB's ADB (`RESOURES.ADB`): converted creature clips are added as `new/<HOST>.ADB/` entries past its ids. */
    hostAdb?: SrscReader;
    /** The host ODB's SDB (RESOURES.SDB): converted sounds are added to it as `new/<HOST>.SDB/` entries with free ids. */
    hostSdb?: SrscReader;
    /** The disc's PS2MUSIC.SDB: the rendered OotF music is added to it with free ids (without it the PAL id layout is assumed). */
    musicSdb?: SrscReader;
    /**
     * PS2 MOD / ADB containers by upper-case stem (`NPCS`) beyond the host's: they tell which templates of ODBs that list the host are
     * skinned (clones go into those ODBs, model refs use the host's `db` there) and which PS2 rig and clips a name-mapped creature has.
     */
    mods?: ReadonlyMap<string, SrscReader>;
    adbs?: ReadonlyMap<string, SrscReader>;
    /**
     * The PS2 player's MOD / ADB (`SYSTEM.MOD` / `SYSTEM.ADB`, stem `playerStem`, default SYSTEM). Kept apart from `mods` / `adbs` so
     * the player is never name-mapped or overridden; only the PC clips the converted scenes play on the player are retargeted onto
     * its rig and added as NEW clips of its ADB (a sequence's animation ref resolves in the actor model's own ADB, and the PS2
     * Rynn's is SYSTEM.ADB). Without them the player's scene clips cannot be resolved and Rynn slides through her scenes.
     */
    playerMod?: SrscReader;
    playerAdb?: SrscReader;
    playerStem?: string;
    /**
     * Own MOD / TXD of template ODBs that may host converted models (`LEVEL1ON`, `WORLDCON`, `FX`, `MOUNTAON`), by upper-case stem.
     * Classes cloned from those ODBs (doors, gates, switches, ladders, ropes, flames: no template with a model in the host ODB) get
     * their converted model appended to that ODB's own MOD / TXD and name it with `db 0`, as a disc class of that ODB does.
     * (Naming a RESOURES model through the template ODB's `.DB` index hung the level load.)
     */
    hostFiles?: ReadonlyMap<string, { mod: SrscReader; txd: SrscReader }>;
    /** Upper-case names of the XDBs on the disc (`SYSTEM.XDB`). A class in an ODB without one (FX) gets no text ids: its string defaults are blanked. */
    xdbFiles?: ReadonlySet<string>;
    /**
     * Reads a TXD of the disc by its path relative to the language folder (`WORLDCON/WORLDCON/WORLDCON.TXD`): the source of the
     * Drakan 2 textures `OotfPipelineOptions.ps2Textures` copies in place of OotF ones. Without it no texture is replaced.
     */
    readPs2Txd?: (discPath: string) => Promise<Uint8Array | null>;
}

export interface OotfPipelineOptions {
    textures?: boolean;
    /** Terrain texture conversion options (first id, max size, texture cap). */
    terrain?: TerrainTextureOptions;
    /** Put the terrain textures in the shared container (OOTFCOM.TXD, own dependency) instead of the splat TXD. */
    terrainInCommon?: boolean;
    /** Rewrite PS2 shading flags (high byte 0xff = opaque). Default true; collision holes are always converted. */
    terrainShading?: boolean;
    /** Debug: map each PC terrain texture to one of the template's own terrain textures (tests the blob path without new TXD data). */
    terrainDiscTextures?: boolean;
    models?: boolean;
    /** Cap on new ODB class records (see the plan stage). */
    maxNewClasses?: number;
    /** With `maxNewClasses`: keep classes whose model is a converted skinned model before the classes with the most objects. */
    preferCreatures?: boolean;
    /** Convert skinned models with their skeletons and clips (default true). */
    skinned?: boolean;
    /**
     * Name-mapped creatures (PC class with a same-named PS2 class): retarget the PC clips onto the PS2 rig when it shares at least half
     * of the PC joints (overrides the PS2 clips of the same name), else convert the PC model instead (default true).
     */
    retarget?: boolean;
    /**
     * Clone classes that need a model (doors, switches ...) from template ODBs in `OotfPs2Context.hostFiles` when the host ODB has no
     * template; the converted model goes into that ODB's own MOD / TXD (default on when `hostFiles` is given; env OOTF_XODB=0 turns it off).
     */
    crossOdb?: boolean;
    /** Generate the 0x0211 display list for every static model, not only trees (default off; env OOTF_DL_ALL=1 turns it on). */
    displayListAll?: boolean;
    /** Stem of the host ODB (default RESOURES). */
    hostStem?: string;
    classes?: boolean;
    singletons?: boolean;
    /** Plan the campaign (titles, exits, strings) when more than one level is converted (default true). */
    campaign?: boolean;
    music?: boolean;
    /**
     * Render the PC DirectMusic segments of the install's `Music.rrc` into PS2MUSIC.SDB tracks (title menu, level start, music
     * triggers; ootfdmusic.ts). Default true; false (or no Music.rrc) keeps the palette of disc tracks.
     */
    ootfMusic?: boolean;
    /** Rewrite text defaults / parameters to new XDB strings (default true). */
    texts?: boolean;
    sounds?: boolean;
    sequences?: boolean;
    /** Name written into the header; default the PC level's name. */
    name?: (pc: PcLevel) => string;
    log?: (msg: string) => void;
    /**
     * Drakan 2 textures in place of OotF ones where the curated table has a counterpart (ootfps2tex.ts). Default on with
     * `DEFAULT_PS2_TEXTURE_SUBSTITUTIONS`; `{ enabled: false }` keeps every OotF texture. Needs `OotfPs2Context.readPs2Txd`.
     */
    ps2Textures?: Ps2TextureSwapOptions;
    /**
     * Drakan 2 models for OotF enemies and weapons where the curated table has a counterpart (ootfps2model.ts). Default on with
     * `DEFAULT_PS2_MODEL_SUBSTITUTIONS` (enemies keep the disc's own clips, `enemyAnimations: 'ootf'` retargets the PC clips
     * onto the disc rigs as before); `{ enabled: false }` converts the OotF models of the table's enemies and weapons.
     */
    ps2Models?: Ps2ModelSwapOptions;
    /**
     * The map screen of each level (ootfmap.ts): every campaign level gets a Map class with its Order of the Flame parchment and
     * calibration (default on; `false` keeps the template's map). A record keyed by the lower-case PC level path replaces the
     * picture, the world rectangle or the covered part of the picture of that level.
     */
    levelMaps?: false | Readonly<Record<string, LevelMapOverride>>;
}

export interface OotfStageResult {
    stage: string;
    ok: boolean;
    error?: string;
}

export interface OotfLevelOut {
    pcPath: string;
    title: string;
    /** A multiplayer arena (by the level's name id, else its `Multiplayer/` folder): see `isOotfArenaLevel`. */
    arena: boolean;
    parts: Ps2LevelParts;
    /** Per-level splat files to ship instead of the template's (`TXD` = template splat TXD plus the terrain textures). */
    splats: Record<string, Uint8Array>;
}

/** What became of one PC class (per level): the audit behind docs/journal/2026-11-01/ootf-props-audit.md. */
export interface ClassAuditRow {
    pcPath: string;
    /** PC `db:id` of the class in the level's dependency table. */
    key: string;
    name: string;
    rfl: number;
    kind: string;
    /** Objects of the class placed in the PC level. */
    objects: number;
    /**
     * `name-mapped` = same-named PS2 class (PS2 model), `cloned` = new record (PC model when `model` is set), `omitted` = left
     * out on purpose (`deliberateOmission`: reason is its kind, detail the note), `unsupported` = a gap.
     */
    outcome: 'name-mapped' | 'cloned' | 'omitted' | 'unsupported';
    ps2Name?: string;
    template?: string;
    /** `UnsupportedReason`, `max-classes`, `no-plan`, `reference-only`, or the `OmissionKind` of an `omitted` row. */
    reason?: string;
    detail?: string;
    /** The PC class names a model: converted (`ok`), why it was skipped, or `none` when the class has no model. */
    model: 'none' | 'ok' | string;
    /** The PS2 class the object got has a model block. */
    ps2HasModel?: boolean;
}

export interface OotfPipelineResult {
    classAudit: ClassAuditRow[];
    levels: OotfLevelOut[];
    /** Mod-pack files that are not the LVL: `files/...` and `new/...` / `overrides/...` entries. */
    files: Record<string, Uint8Array>;
    stages: OotfStageResult[];
    assets: AssetReport | null;
    classPlan: ClassPlan | null;
    warnings: string[];
    /** Language of the PC install and the source checks (ootfsource.ts); null when no level loaded. */
    source: OotfSourceProfile | null;
    /** The rendered OotF music (PC id -> PS2MUSIC.SDB id, title track); null when not rendered. */
    music: OotfMusicPack | null;
    /** Drakan 2 textures used in place of OotF ones (`OotfPipelineOptions.ps2Textures`), and rows that could not be used. */
    ps2Textures?: { used: { ootf: string; ps2: string; label: string }[]; skipped: { ootf: string; reason: string }[] };
    /** Drakan 2 models used for OotF classes (`OotfPipelineOptions.ps2Models`), by OotF class name. */
    ps2Models?: { used: { ootf: string; ps2: string; label: string; category: string }[] };
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

/** The culling rewrite of the scenes of PC scene file `container` (path without extension), if it has a plan. */
function cullRewrite(culling: LevelCulling | null, container: string): ((seq: PcSequence) => PcSequence) | undefined {
    const plan = culling?.plans.get(sceneFileKey(container));
    return plan ? (seq) => applyCulling(seq, plan) : undefined;
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

/** Test aid: OOTF_TEXMODE=auto|indexed|truecolor and OOTF_TEXMAX=<edge> and OOTF_TEXPIX=<pixels> override the texture writer defaults. */
function ootfTextureEnv(): Ps2TextureOptions | undefined {
    const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
    const mode = env?.['OOTF_TEXMODE'];
    const max = Number(env?.['OOTF_TEXMAX'] ?? 0);
    const pix = Number(env?.['OOTF_TEXPIX'] ?? 0); // largest 32 bpp texture, in pixels (Infinity = never quantise)
    if (!mode && !max && !pix) return undefined;
    return {
        ...(mode ? { mode: mode as TextureMode } : {}),
        ...(max ? { maxSize: max } : {}),
        ...(pix ? { maxTruecolorPixels: pix } : {}),
    };
}

/** A PC `Multiplayer/*` level (an arena, not a campaign chapter). */
export function isOotfArenaPath(path: string): boolean {
    return /^multiplayer[\\/]/i.test(path);
}

/** Convert one or more PC levels that share an asset container and class plan. */
export async function convertOotfLevels(
    src: PcFileSource,
    pcPaths: readonly string[],
    ps2: OotfPs2Context,
    opt: OotfPipelineOptions = {},
): Promise<OotfPipelineResult> {
    const log = opt.log ?? (() => {});
    const dbgEnv0 = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};
    const res: OotfPipelineResult = {
        classAudit: [],
        levels: [],
        files: {},
        stages: [],
        assets: null,
        classPlan: null,
        warnings: [],
        source: null,
        music: null,
    };
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
    const introWarn = introTemplateWarning(tplHeader.dependencies.map((d) => d.path.text));
    if (introWarn) res.warnings.push(`template: ${introWarn}`);
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
    if (pcPaths.length && !pcs.length) {
        // Every selected level failed to read: say so (with the reader's reasons) instead of returning an empty pack.
        const why = res.stages
            .filter((x) => !x.ok)
            .map((x) => `${x.stage}: ${x.error}`)
            .slice(0, 3);
        throw new OotfSourceError(
            `None of the ${pcPaths.length} selected level(s) could be read as Order of the Flame PC levels.\n` +
                `- ${why.join('\n- ') || 'unknown reason'}\n` +
                'Check that you chose the folder of the installed game (the one with the level folders and Dragon.rrc), not a disc image, ' +
                'and that the install is complete. Localized releases (for example German) are supported; if this install is one, ' +
                'please report it on GitHub issue #3 with the converter log.',
        );
    }

    // ---- campaign plan, text plan
    // Multiplayer/* levels are arenas, not campaign chapters: one conversion can hold both (a campaign pack and an arena
    // pack converted separately collide on RESOURES/WORLDCON/PROCTEES and on the new class ids). The arenas stay out of
    // the campaign plan (no exits, default titles) and sort after the chapters in `levels`.
    const campaignPcs = pcs.filter((p) => !isOotfArenaLevel(p));
    const campaignOn = opt.campaign !== false && campaignPcs.length > 1;
    // The install's language and the facts a localized install could break: fail here with the reasons instead of
    // writing a pack whose levels have lost classes or exits (docs/journal/2026-11-06/issue-3-localized-ootf.md).
    const rrc = await loadRrcStrings(src);
    if (pcs.length) {
        res.source = checkOotfSource(pcs, rrc, (c) => transitionFieldIndex(c.fields) >= 0, campaignOn);
        log(`source language: ${res.source.language.language} (${res.source.language.evidence})`);
        for (const w of res.source.warnings) res.warnings.push(`source: ${w}`);
        assertOotfSource(res.source);
    }
    const plan0: CampaignPlan | null = campaignOn ? planCampaign(campaignPcs, { prefix: 'OotF' }) : null;
    if (plan0) for (const w of plan0.warnings) res.warnings.push(`campaign: ${w}`);
    const textPlan = new TextPlan({ rrc: rrc.strings });

    // ---- shared assets
    const hostStem = (opt.hostStem ?? 'RESOURES').toUpperCase();
    const hostFile = `${hostStem}.ODB`;
    const hostDir = ps2.dbFiles?.get(hostStem)?.dir;
    const hostOk = !!(ps2.hostMod && ps2.hostTxd && hostDir);
    const maxId = (r: SrscReader | undefined, type: number): number =>
        (r?.entries ?? []).reduce((m, e) => (e.type === type ? Math.max(m, e.id) : m), 0);
    const hostGroup = ps2.hostMod?.entries.find((e) => e.type === 0x0200)?.sub ?? 1;
    // Drakan 2 textures for OotF ones (ootfps2tex.ts): read once here, copied by the asset builders on first use.
    const ps2Subs =
        ps2.readPs2Txd && opt.textures !== false
            ? await stage('drakan 2 textures', () =>
                  resolvePs2Substitutes(effectiveSubstitutions(opt.ps2Textures), ps2.readPs2Txd!),
              )
            : null;
    for (const s of ps2Subs?.skipped ?? [])
        res.warnings.push(`drakan 2 texture for ${s.row.ootf} not used: ${s.reason}`);
    const builder = new OotfAssetBuilder(src, {
        ps2Textures: ps2Subs?.byOotf,
        firstModelId: maxId(ps2.hostMod, 0x0200) + 1,
        firstTextureId: maxId(ps2.hostTxd, 0x0040) + 1,
        // Past every clip id of the host ADB and of the ADBs of ODBs that may host clones (the clips ship to each of them).
        firstAnimId:
            Math.max(maxId(ps2.hostAdb, 0x0501), ...[...(ps2.adbs?.values() ?? [])].map((a) => maxId(a, 0x0501)), 99) +
            1,
        skinned: opt.skinned,
        texture: ootfTextureEnv(),
        displayList:
            (opt.displayListAll ??
            (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.['OOTF_DL_ALL'] ===
                '1')
                ? /./
                : undefined,
    });
    const splatDb = findSplatDbIndex(tplHeader);
    // `db` index the host has in the `.DB` of an ODB stem (0 for the host itself), null when it is not a dependency.
    const hostDbForStem = (stem: string): number | null => {
        if (stem === hostStem) return 0;
        const text = ps2.dbFiles?.get(stem)?.text;
        for (const m of text?.matchAll(/^(\d+)\s+(.+?)\s*$/gm) ?? []) {
            if (odbStemForDependency(m[2]!) === hostStem) return Number(m[1]);
        }
        return null;
    };
    // MOD / ADB container behind a `db` index of the ODB `stem` (0 = its own).
    const containerStem = (stem: string, db: number): string | null => {
        if (db === 0) return stem;
        const text = ps2.dbFiles?.get(stem)?.text;
        for (const m of text?.matchAll(/^(\d+)\s+(.+?)\s*$/gm) ?? []) {
            if (Number(m[1]) === db) return odbStemForDependency(m[2]!);
        }
        return null;
    };
    const modOf = (stem: string): SrscReader | undefined =>
        (stem === hostStem ? ps2.hostMod : undefined) ?? ps2.mods?.get(stem);
    const adbOf = (stem: string): SrscReader | undefined =>
        (stem === hostStem ? ps2.hostAdb : undefined) ?? ps2.adbs?.get(stem);
    /** Name-mapped creatures retargeted onto a PS2 rig (class, model container stem, model id, PC creature owner/ref, PS2 skeleton). */
    const retargetTodo: {
        pc: OdbClass;
        ps2Stem: string;
        modelId: number;
        sk: ReturnType<typeof parseSkeleton>;
        key: string;
    }[] = [];
    const retargetNotes: string[] = [];
    // Planned class key -> source clips actually written for its compatible native target rig.
    const sequenceRetargetMaps = new Map<string, Map<number, number>>();
    const player = playerClipBuilder(ps2);
    /** PC classes whose converted model is cloned instead of name-mapping them to a PS2 class with a foreign rig. */
    const convertOwn = new Set<OdbClass>();

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
    const ownedClasses = new Map<string, OdbClass>();
    for (const pc of pcs)
        for (const [db, table] of pc.classes) {
            const ow = owner(pc, db);
            if (!ow) continue;
            for (const [id, cls] of table) {
                ownerOf.set(cls, ow);
                ownedClasses.set(ownedClassKey(ow, id), cls);
            }
        }
    /** The PC class's own model: converted (`ok`), why the asset builder skipped it, or `none` when the class has none. */
    const modelStateOf = (cls: OdbClass): string => {
        if (!cls.model) return 'none';
        const ow = ownerOf.get(cls);
        const nid = ow ? builder.mapModelRef(cls.model.db, cls.model.id, ow) : null;
        const c = ow ? builder.resolveContainer(ow, cls.model.db) : null;
        const why = c ? builder.report.skipped.get(`model ${c.toLowerCase()}#${cls.model.id}`) : undefined;
        return nid !== null ? 'ok' : (why ?? (ow ? 'not converted' : 'owner unknown'));
    };
    /** `model 3918 is not in Alwarren.mod` when the install itself lacks the class's model, else undefined. */
    const missingModelOf = (cls: OdbClass): string | undefined => {
        const state = modelStateOf(cls);
        if (state !== 'no such model' && !/\.mod not found$/i.test(state)) return undefined;
        const ow = ownerOf.get(cls);
        const c = ow ? builder.resolveContainer(ow, cls.model!.db) : null;
        const file = (c ?? ow ?? 'its container').replace(/^.*[\\/]/, '');
        return `model ${cls.model!.id} is not in ${file}.mod`;
    };
    if (opt.classes !== false) {
        const loaded = new Set<string>();
        const initial = [...used.values()].flatMap((u) => {
            const ow = ownerOf.get(u.cls);
            return ow ? [{ owner: ow, id: u.id, cls: u.cls }] : [];
        });
        const closure = await classReferenceClosure(initial, async (source, ref) => {
            await builder.registerOwner(source.owner);
            const container = builder.resolveContainer(source.owner, ref >>> 16);
            if (!container) return null;
            const key = ownedClassKey(container, ref & 0xffff);
            if (!ownedClasses.has(key) && !loaded.has(container.toLowerCase())) {
                loaded.add(container.toLowerCase());
                const bytes = await src.read(`${container}.odb`);
                if (bytes)
                    for (const [id, cls] of await parsePcOdbClasses(await SrscReader.fromBytes(bytes))) {
                        ownedClasses.set(ownedClassKey(container, id), cls);
                        ownerOf.set(cls, container);
                    }
            }
            const cls = ownedClasses.get(key);
            return cls ? { owner: container, id: ref & 0xffff, cls } : null;
        });
        for (const c of closure)
            if (
                ![...used.values()].some(
                    (u) => ownedClassKey(ownerOf.get(u.cls) ?? '', u.id) === ownedClassKey(c.owner, c.id),
                )
            ) {
                ownerOf.set(c.cls, c.owner);
                used.set(`reference|${ownedClassKey(c.owner, c.id)}`, { db: -1, id: c.id, cls: c.cls, pc: pcs[0]! });
            }
    }
    // Drakan 2 models for OotF enemies and weapons (ootfps2model.ts): weapon class name -> model of the host's own MOD.
    const modelSwap = planPs2Models(opt.ps2Models);
    const modelSwapsUsed = new Map<string, { ootf: string; ps2: string; label: string; category: string }>();
    const ps2WeaponModels = new Map<string, number>();
    {
        const hostOdb = ps2.odbs.get((opt.hostStem ?? 'RESOURES').toUpperCase());
        if (hostOdb)
            for (const c of (await parseOdbClasses(hostOdb)).values())
                if (c.model && c.model.db === 0 && !ps2WeaponModels.has(modelKey(c.name)))
                    ps2WeaponModels.set(modelKey(c.name), c.model.id);
    }
    let culling: LevelCulling | null = null;
    if (opt.models !== false && opt.classes !== false && hostOk) {
        await stage('models', async () => {
            // Inward shells (the Intro's black backdrop box) lose the walls the PC culls from outside cut-scene cameras:
            // the PS2 culls no back faces, so those walls hid the whole Intro opening (ootfshell.ts).
            const readModel = async (c: OdbClass) => {
                const ow = ownerOf.get(c);
                return ow && c.model ? builder.readPcModel(ow, c.model.db, c.model.id) : null;
            };
            const shells = await planShellTrims(pcs, src, readModel);
            // The PC culls back faces in the Intro's scenes too: polygons never seen from the front are left out and models
            // turned away from the camera are hidden by the converted scenes (ootfcull.ts).
            culling = dbgEnv0['OOTF_NO_CULL'] === '1' ? null : await planLevelCulling(pcs, src, readModel);
            const drops = new Map<OdbClass, Set<number>>([...shells].map(([c, t]) => [c, new Set(t.drop)]));
            for (const [c, d] of culling?.drops ?? []) drops.set(c, new Set([...(drops.get(c) ?? []), ...d]));
            for (const [c, d] of drops)
                if (await builder.dropPolygonsOf(ownerOf.get(c)!, c.model!.db, c.model!.id, d)) {
                    const t = shells.get(c);
                    if (t) log(`shell ${c.name}: ${t.drop.size} of ${t.walls} walls left out (${t.placements} placed)`);
                    const k = culling?.drops.get(c);
                    if (k) log(`cull ${c.name}: ${k.size} polygon(s) never seen from the front left out`);
                }
            for (const [k, p] of culling?.plans ?? []) {
                const n = [...p.visibility.values()].reduce((m, v) => m + v.size, 0);
                if (n) log(`cull ${k}: ${n} show / hide timeline(s) in ${p.visibility.size} scene(s)`);
            }
            for (const u of used.values()) {
                const m = u.cls.model;
                const ow = ownerOf.get(u.cls);
                if (!m || !ow) continue;
                ownerOf.set(u.cls, ow);
                // A Drakan 2 weapon model in place of the PC one (ootfps2model.ts): a model of the host's own MOD.
                const swap = [14, 39, 79].includes(u.cls.rflClass ?? -1) ? modelSwap.weapon(u.cls.name) : null;
                const native = swap ? ps2WeaponModels.get(modelKey(swap.ps2)) : undefined;
                if (swap && native === undefined)
                    res.warnings.push(
                        `drakan 2 model for ${u.cls.name.trim()} not used: no ${swap.ps2} in ${hostStem}`,
                    );
                if (swap && native !== undefined && (await builder.useNativeModel(ow, m.db, m.id, native))) {
                    modelSwapsUsed.set(modelKey(u.cls.name), { ...swap, ootf: u.cls.name.trim() });
                    continue;
                }
                // Native generic props need the strip draw representation even when their model is rigid.
                await builder.addModelRef(ow, m.db, m.id, u.cls.rflClass === 17);
                // A Morph Plug (99) shows the models of its "Morphing Models" in turn: convert all of them (`mapModelFor`),
                // drawn like the disc's morph frames (display list) and with one collision shape each (`singleShapeBounds`).
                if (u.cls.rflClass === 99)
                    for (const r of morphModelRefs(u.cls)) {
                        const id = await builder.addModelRef(ow, r >>> 16, r & 0xffff, true);
                        if (id !== null) builder.singleShapeBounds(id);
                    }
            }
        });
    }
    /** Static models appended to a template ODB's own MOD / TXD (no skinned models), by ODB stem. */
    const crossBuilders = new Map<string, OotfAssetBuilder>();
    const sig = (c: OdbClass): string =>
        `${c.name}|${c.rflClass}|${(c.data ?? []).join(',')}|${classDefaultReferences(c).length ? (ownerOf.get(c) ?? '') : ''}`;
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
            // Creatures with a same-named PS2 class: retarget onto its rig when it fits, else convert the PC model (PlanOptions.keepOwnModel).
            if (opt.retarget !== false && opt.models !== false && hostOk) {
                const norm = (c: OdbClass): string =>
                    `${c.rflClass}|${c.name.toLowerCase().replace(/[^a-z0-9]+/g, '')}`;
                const byName = new Map<string, { odb: Ps2OdbIn; cls: OdbClass }>();
                for (const odb of [...ps2Odbs].sort((a, b) => b.dbIndex - a.dbIndex))
                    for (const cls of odb.classes.values()) byName.set(norm(cls), { odb, cls });
                for (const i of input) {
                    const ow = ownerOf.get(i.cls);
                    const m = i.cls.model;
                    const newId = ow && m ? builder.mapModelRef(m.db, m.id, ow) : null;
                    if (!ow || !m || newId === null || !builder.report.creatures.some((c) => c.id === newId)) continue;
                    const hit = byName.get(norm(i.cls)) ?? byName.get(`${i.cls.rflClass}|${aliasSquash(i.cls.name)}`);
                    if (!hit?.cls.model) continue;
                    // Drakan 2 enemies (ootfps2model.ts): the disc's own clips need no retarget; a row turned off keeps the PC model.
                    if (modelSwap.enemyOff(i.cls.name)) {
                        convertOwn.add(i.cls);
                        retargetNotes.push(`convert ${i.cls.name}: Drakan 2 model turned off`);
                        continue;
                    }
                    const enemy = modelSwap.enemy(i.cls.name);
                    if (enemy)
                        modelSwapsUsed.set(modelKey(i.cls.name), {
                            category: 'enemies',
                            ootf: i.cls.name.trim(),
                            ps2: hit.cls.name.trim(),
                            label: `${i.cls.name.trim()} as ${hit.cls.name.trim()}`,
                        });
                    if (enemy === 'drakan2') {
                        retargetNotes.push(`drakan 2 ${i.cls.name}: PS2 model ${hit.cls.model.id} with its own clips`);
                        continue;
                    }
                    const mStem = containerStem(hit.odb.file.replace(/\.ODB$/i, ''), hit.cls.model.db);
                    const rec = mStem ? modOf(mStem)?.find(0x0208, hit.cls.model.id) : undefined;
                    if (!mStem || !rec) continue; // the PS2 class is not skinned: nothing to retarget onto
                    const src = await builder.creatureSource(ow, m.db, m.id);
                    if (!src) continue;
                    const sk = parseSkeleton(await modOf(mStem)!.readRaw(rec), 'ps2');
                    const choice = chooseRetargetTarget(src.skeleton, [{ id: hit.cls.model.id, skeleton: sk }]);
                    if (choice) {
                        retargetTodo.push({
                            pc: i.cls,
                            ps2Stem: mStem,
                            modelId: hit.cls.model.id,
                            sk,
                            key: `${i.db}:${i.id}`,
                        });
                        retargetNotes.push(
                            `retarget ${i.cls.name}: PC ${src.skeleton.joints.length} joints -> PS2 model ${hit.cls.model.id} (${choice.match.matched} matched)`,
                        );
                    } else {
                        convertOwn.add(i.cls);
                        retargetNotes.push(
                            `convert ${i.cls.name}: no PS2 rig above 50% (PS2 model ${hit.cls.model.id})`,
                        );
                    }
                }
                res.warnings.push(...retargetNotes);
            }
            const modelFiles = new Set<string>();
            const crossOn = (opt.crossOdb ?? dbgEnv0['OOTF_XODB'] !== '0') && hostOk;
            const crossOnly = dbgEnv0['OOTF_XODB_ONLY'] ? dbgEnv0['OOTF_XODB_ONLY'].split(',') : null;
            for (const odb of ps2Odbs) {
                const st = odb.file.replace(/\.ODB$/i, '');
                if (st === hostStem) continue;
                if (crossOn && ps2.hostFiles?.has(st) && (!crossOnly || crossOnly.includes(st)))
                    modelFiles.add(odb.file);
                else if (hostDbForStem(st) !== null && ps2.mods?.has(st)) modelFiles.add(odb.file);
            }
            const crossWant: { stem: string; cls: OdbClass }[] = [];
            const skinnedIds = new Set(builder.report.creatures.map((creature) => creature.id));
            const modelSkinned = (cls: OdbClass): boolean => {
                const owner = ownerOf.get(cls);
                const id = owner && cls.model ? builder.mapModelRef(cls.model.db, cls.model.id, owner) : null;
                return id !== null && skinnedIds.has(id);
            };
            const planOpts: PlanOptions = {
                modelOdbFiles: modelFiles,
                keepOwnModel: (cls) => convertOwn.has(cls),
                rewriteText:
                    opt.texts === false || ootfDebugFlag('OOTF_NO_CLSTEXT')
                        ? undefined
                        : (file, fields, data) => {
                              const xdb = file.replace(/\.ODB$/i, '.XDB');
                              if (ps2.xdbFiles && !ps2.xdbFiles.has(xdb.toUpperCase())) {
                                  fields.forEach((f, i) => {
                                      if (isTextField(f) && data[i] !== undefined) data[i] = 0; // no XDB to hold the text
                                  });
                              } else rewriteClassTextDefaults(fields, data, textPlan, xdb);
                          },
                substituteEngineId: PS2_SUBSTITUTES,
                modelOdbFile: hostFile,
                modelSkinned,
                templateSkinned: (c, file) => {
                    const st = c.model ? containerStem(file.replace(/\.ODB$/i, ''), c.model.db) : null;
                    return !!c.model && !!st && !!modOf(st)?.find(0x0208, c.model.id);
                },
                modelBounds: (id, file, db) => {
                    const stem = file.replace(/\.ODB$/i, '');
                    // Cross-ODB models have their own id namespace. A coincident root-builder id is another model.
                    const destination = stem !== hostStem && db === 0 ? crossBuilders.get(stem) : builder;
                    return dbgEnv0['OOTF_NO_BOUNDS'] ? destination?.skeletonBounds(id) : destination?.modelBounds(id);
                },
                mapModelFor: hostOk
                    ? (cls, file) => {
                          const ow = ownerOf.get(cls);
                          const fStem = file.replace(/\.ODB$/i, '');
                          if (!ow) return undefined;
                          // A break-away floor's pieces live in its template ODB's own MOD and are named with db 0 there, as on
                          // the disc. Pieces not converted yet (the first planning pass) keep the template's list for now.
                          if (
                              cls.rflClass === BREAKAWAY_RFL &&
                              fStem !== hostStem &&
                              crossOn &&
                              ps2.hostFiles?.has(fStem) &&
                              modelFiles.has(file)
                          ) {
                              const cb = crossBuilders.get(fStem);
                              return (ref) => cb?.mapModelRef(ref >>> 16, ref & 0xffff, ow) ?? null;
                          }
                          // Only the host's own models can be named from here (cross-ODB models live in that ODB's MOD).
                          if (cls.rflClass !== 99 || fStem !== hostStem) return undefined;
                          const db = hostDbForStem(fStem);
                          if (db === null) return undefined;
                          return (ref) => {
                              const id = builder.mapModelRef(ref >>> 16, ref & 0xffff, ow);
                              return id === null ? null : ((db << 16) | id) >>> 0;
                          };
                      }
                    : undefined,
                mapAnimFor: (cls) => {
                    const ow = ownerOf.get(cls);
                    return ow && cls.model
                        ? (builder.mapAnimRef(cls.model.db, cls.model.id, ow) ?? undefined)
                        : undefined;
                },
                modelFor: hostOk
                    ? (cls, file) => {
                          const ow = ownerOf.get(cls);
                          const fStem = file.replace(/\.ODB$/i, '');
                          // The shared builder owns skeletons and clips. A class in another ODB must
                          // reference that model through its dependency, even if it has its own static MOD.
                          if (
                              !modelSkinned(cls) &&
                              fStem !== hostStem &&
                              ps2.hostFiles?.has(fStem) &&
                              modelFiles.has(file)
                          ) {
                              if (!ow || !cls.model) return null;
                              // Particle / flame classes (engine 43, 71, 97) hung the level load while their "Particle Life Time" was 0
                              // (`mergeDefaults` now sets 0.5 s); OOTF_XODB_FX=0 keeps them out of template ODBs again.
                              if (CROSS_FX_RFL.has(cls.rflClass ?? -1) && dbgEnv0['OOTF_XODB_FX'] === '0') return null;
                              const cb = crossBuilders.get(fStem);
                              if (!cb) {
                                  crossWant.push({ stem: fStem, cls });
                                  return { id: 0, db: 0 }; // first planning pass: the model is converted afterwards
                              }
                              const cid = cb.mapModelRef(cls.model.db, cls.model.id, ow);
                              return cid === null ? null : { id: cid, db: 0 };
                          }
                          const db = ow && cls.model ? hostDbForStem(fStem) : null;
                          if (!ow || !cls.model || db === null) return null;
                          const id = builder.mapModelRef(cls.model.db, cls.model.id, ow);
                          return id === null ? null : { id, db };
                      }
                    : undefined,
            };
            // Joint count of every skinned template model and of the converted PC models (rig checks in the class merge).
            const tplJoints = new Map<string, number>();
            for (const odb of ps2Odbs)
                for (const c of odb.classes.values()) {
                    if (!c.model) continue;
                    const st = containerStem(odb.file.replace(/\.ODB$/i, ''), c.model.db);
                    const rec = st ? modOf(st)?.find(0x0208, c.model.id) : undefined;
                    if (!st || !rec) continue;
                    const k = `${st}#${c.model.id}`;
                    if (!tplJoints.has(k))
                        tplJoints.set(k, parseSkeleton(await modOf(st)!.readRaw(rec), 'ps2').joints.length);
                }
            planOpts.templateJoints = (c, file) => {
                const st = c.model ? containerStem(file.replace(/\.ODB$/i, ''), c.model.db) : null;
                return st && c.model ? tplJoints.get(`${st}#${c.model.id}`) : undefined;
            };
            planOpts.modelJoints = (cls) => {
                const ow = ownerOf.get(cls);
                const id = ow && cls.model ? builder.mapModelRef(cls.model.db, cls.model.id, ow) : null;
                return id === null ? undefined : builder.report.creatures.find((c) => c.id === id)?.joints;
            };
            let result = planClassMapping(input, ps2Odbs, planOpts);
            const inputByKey = new Map<string, OdbClass>(input.map((i) => [`${i.db}:${i.id}`, i.cls]));
            const pieceWant = crossOn
                ? breakawayPieceHosts(
                      result,
                      (key) => inputByKey.get(key),
                      (stem) => !!ps2.hostFiles?.has(stem),
                  )
                : [];
            if (crossWant.length || pieceWant.length) {
                // Models of classes cloned from template ODBs go into that ODB's own MOD / TXD: convert them, then plan again.
                const crossBuilder = (stem: string): OotfAssetBuilder => {
                    const hf = ps2.hostFiles!.get(stem)!;
                    let cb = crossBuilders.get(stem);
                    if (!cb) {
                        cb = new OotfAssetBuilder(src, {
                            firstModelId: maxId(hf.mod, 0x0200) + 1,
                            firstTextureId: maxId(hf.txd, 0x0040) + 1,
                            skinned: false,
                            ps2Textures: ps2Subs?.byOotf,
                            displayList: /./, // models of template ODBs draw nothing without the strip display list 0x0211
                        });
                        crossBuilders.set(stem, cb);
                    }
                    return cb;
                };
                for (const w of crossWant) {
                    const cb = crossBuilder(w.stem);
                    const ow = ownerOf.get(w.cls);
                    if (ow && w.cls.model) await cb.addModelRef(ow, w.cls.model.db, w.cls.model.id);
                }
                // Break-away floor pieces: one collision box each, like the disc's (a one-shape OBB 0x0207 per piece).
                for (const w of pieceWant) {
                    const cb = crossBuilder(w.stem);
                    const ow = ownerOf.get(w.cls);
                    if (!ow) continue;
                    for (const r of morphModelRefs(w.cls)) {
                        const known = cb.mapModelRef(r >>> 16, r & 0xffff, ow);
                        const id = known ?? (await cb.addModelRef(ow, r >>> 16, r & 0xffff, true));
                        if (id !== null && known === null) cb.singleShapeBounds(id);
                    }
                }
                result = planClassMapping(input, ps2Odbs, planOpts);
            }
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
                const isSkinned = (s: { cls: OdbClass }): boolean =>
                    builder.report.creatures.some((c) => c.id === s.cls.model?.id);
                const objs = (s: { pcKeys: string[] }): number =>
                    s.pcKeys.reduce((n, key) => {
                        const e = [...planKey].find(([, v]) => `${v.db}:${v.id}` === key);
                        return n + (e ? (count.get(e[0]) ?? 0) : 0);
                    }, 0);
                const keep = new Set(
                    [...result.synthesized]
                        .sort(
                            (x, y) =>
                                (opt.preferCreatures ? Number(isSkinned(y)) - Number(isSkinned(x)) : 0) ||
                                objs(y) - objs(x),
                        )
                        .slice(0, opt.maxNewClasses)
                        .flatMap((x) => x.pcKeys),
                );
                const mapped = new Set(result.mapped.keys());
                // Classes that were to be converted but lost their slot go back to their same-named PS2 class.
                const sub = input.filter(
                    (i) => keep.has(`${i.db}:${i.id}`) || mapped.has(`${i.db}:${i.id}`) || convertOwn.has(i.cls),
                );
                const dropped = [...convertOwn].filter(
                    (c) =>
                        !sub.some((i) => i.cls === c) ||
                        !keep.has(`${input.find((i) => i.cls === c)!.db}:${input.find((i) => i.cls === c)!.id}`),
                );
                for (const c of dropped) convertOwn.delete(c);
                if (opt.preferCreatures)
                    res.warnings.push(
                        `classes: candidates ${result.synthesized.map((x) => `${x.name} (rfl ${x.rfl}${keep.has(x.pcKeys[0]!) ? ', kept' : ''}${isSkinned(x) ? ', SKINNED' : ''})`).join('; ')}`,
                    );
                result = planClassMapping(sub, ps2Odbs, planOpts);
                res.warnings.push(
                    `classes: limited to ${opt.maxNewClasses} new class records (engine limit under investigation)`,
                );
            }
            return result;
        });
        res.classPlan = plan;
        if (plan) {
            const sourceByKey = new Map<string, OdbClass>(
                [...used.values()].map((u) => {
                    const k = planKey.get(sig(u.cls))!;
                    return [`${k.db}:${k.id}`, u.cls] as const;
                }),
            );
            res.warnings.push(
                ...relocateClassDefaultReferences(
                    plan,
                    (key) => sourceByKey.get(key),
                    (key, ref, file) => {
                        const source = sourceByKey.get(key);
                        const ow = source && ownerOf.get(source);
                        const container = ow && builder.resolveContainer(ow, ref >>> 16);
                        const cls = container && ownedClasses.get(ownedClassKey(container, ref & 0xffff));
                        const targetKey = cls && planKey.get(sig(cls));
                        const target = targetKey && plan!.resolve(targetKey.db, targetKey.id);
                        if (!target) return null;
                        const targetStem = ps2Odbs
                            .find((o) => o.dbIndex === target.dbIndex)
                            ?.file.replace(/\.ODB$/i, '');
                        const fromStem = file.replace(/\.ODB$/i, '');
                        if (!targetStem) return null;
                        if (fromStem === targetStem) return target.classId;
                        const dbText = ps2.dbFiles?.get(fromStem)?.text;
                        for (const match of dbText?.matchAll(/^(\d+)\s+(.+?)\s*$/gm) ?? [])
                            if (odbStemForDependency(match[2]!) === targetStem)
                                return ((Number(match[1]) << 16) | target.classId) >>> 0;
                        return null;
                    },
                    (key, ref) => {
                        // An unresolved reference to a PC-only effect class (trails, gibs, flashes ...) is expected.
                        const source = sourceByKey.get(key);
                        const ow = source && ownerOf.get(source);
                        const container = ow && builder.resolveContainer(ow, ref >>> 16);
                        const cls = container && ownedClasses.get(ownedClassKey(container, ref & 0xffff));
                        return cls ? REFERENCE_ENGINES.get(cls.rflClass ?? -1) : undefined;
                    },
                    (key, ref) => {
                        const source = sourceByKey.get(key);
                        const ow = source && ownerOf.get(source);
                        const container = ow && builder.resolveContainer(ow, ref >>> 16);
                        return container ? ownedClasses.get(ownedClassKey(container, ref & 0xffff))?.name : undefined;
                    },
                ),
            );
            const bowAim = buildBowAimMetadata(plan, (key) => sourceByKey.get(key));
            if (bowAim.text) res.files['gameplay/bows.ini'] = strToU8(bowAim.text);
            res.warnings.push(...bowAim.warnings);
        }
        if (plan && opt.models !== false && hostOk) {
            const drawOwner = (file: string, db: number) => {
                const stem = containerStem(file.replace(/\.ODB$/i, ''), db);
                return stem === hostStem ? builder : stem ? crossBuilders.get(stem) : undefined;
            };
            requireGenericPropDrawLists(plan, drawOwner);
            requireRigidWeaponDrawLists(plan, drawOwner);
        }
        if (plan) {
            // PC clips retargeted onto the PS2 rig of a name-mapped creature replace the PS2 clips of the same name.
            await stage('retarget', async () => {
                const done = new Set<string>();
                for (const t of retargetTodo) {
                    const inp = [...used.values()].find((u) => u.cls === t.pc);
                    const m = t.pc.model;
                    const ow = ownerOf.get(t.pc);
                    if (
                        !inp ||
                        !m ||
                        !ow ||
                        !plan!.mapped.has(`${planKey.get(sig(t.pc))?.db}:${planKey.get(sig(t.pc))?.id}`)
                    )
                        continue;
                    const src = await builder.creatureSource(ow, m.db, m.id);
                    const adb = adbOf(t.ps2Stem);
                    if (!src || !adb) continue;
                    const res2 = retargetCreature(src.skeleton, t.sk, src.anims);
                    const own = new Map<string, number>();
                    for (const id of [...t.sk.animIds].sort((a, b) => a - b)) {
                        const e = adb.find(0x0501, id);
                        if (e) own.set(animName(await adb.readRaw(e)).toLowerCase(), id);
                    }
                    let n = 0;
                    const clips = new Map<number, number>();
                    for (const a of res2.anims) {
                        const id = own.get(a.anim.name.toLowerCase());
                        const k = `${t.ps2Stem}|${id}`;
                        if (id === undefined || done.has(k)) continue;
                        done.add(k);
                        const e1 = adb.find(0x0501, id)!;
                        // PC clips carry no loop flag (0 on 1626 of 1722 install clips; the PC engine decides by use), the
                        // PS2 engine reads it from the clip: a death clip written looping replays from its standing first
                        // frame, so a killed creature ended upright. The replaced disc clip's flags say how it is used.
                        const w = writePs2Anim({ ...a.anim, flags: ps2AnimFlags(await adb.readRaw(e1)) });
                        const e2 = adb.find(0x0502, id);
                        if (!e2) continue;
                        res.files[`overrides/${t.ps2Stem}.ADB/0501_${id}_${e1.sub}.bin`] = w.info;
                        res.files[`overrides/${t.ps2Stem}.ADB/0502_${id}_${e2.sub}.bin`] = w.data;
                        clips.set(a.id, id);
                        n++;
                    }
                    sequenceRetargetMaps.set(t.key, clips);
                    res.warnings.push(
                        `retarget ${t.pc.name}: ${n} PS2 clips of ${t.ps2Stem}.ADB replaced (${res2.anims.length} converted, ${res2.skipped.length} skipped)`,
                    );
                }
            });
        }
        if (plan) {
            const used = new Set(plan.synthesized.flatMap((s) => (s.cls.model ? [s.cls.model.id] : [])));
            builder.pruneSkinned((id) => used.has(id));
        }
        // ---- audit rows: what became of every PC class used by a level (per level, with its object count)
        for (const u of used.values()) {
            const k = planKey.get(sig(u.cls));
            const key = k ? `${k.db}:${k.id}` : '';
            const t = plan?.resolve(k?.db ?? -1, k?.id ?? -1) ?? null;
            const un = plan?.unsupported.get(key);
            const syn = plan?.synthesized.find((s) => s.pcKeys.includes(key));
            const model = modelStateOf(u.cls);
            const info = ENGINE_CLASSES.get(u.cls.rflClass ?? -1);
            res.classAudit.push({
                pcPath: u.pc.path,
                key: `${u.db}:${u.id}`,
                name: u.cls.name.trim(),
                rfl: u.cls.rflClass ?? -1,
                kind: info?.kind ?? (REFERENCE_ENGINES.has(u.cls.rflClass ?? -1) ? 'effect-reference' : 'unknown'),
                objects: u.pc.list.objects.filter((o) => o.dbIndex === u.db && o.classId === u.id).length,
                outcome: syn ? 'cloned' : t ? 'name-mapped' : 'unsupported',
                ps2Name: t?.cls.name,
                template: syn?.template.name,
                reason: t ? undefined : (un?.reason ?? (plan ? 'max-classes' : 'no-plan')),
                detail: un?.detail,
                model,
                ps2HasModel: t ? !!t.cls.model : undefined,
            });
        }
    }

    const findPs2Class = (pred: (c: OdbClass) => boolean): { t: ClassTarget; cls: OdbClass } | null => {
        for (const [dbIndex, table] of classes) {
            for (const [classId, cls] of table) if (pred(cls)) return { t: { dbIndex, classId, cls }, cls };
        }
        return null;
    };
    const musicClass = findPs2Class((c) => /^triggered music loop$/i.test(c.name.trim()) && !!c.fields);
    /** Dependency index of PS2 Music in the template level's table (LEVEL1NA: 14), what sequence music refs name. */
    const musicDb =
        tplHeader.dependencies.find((d) => odbStemForDependency(d.path.text) === 'PS2MUSIC')?.dbIndex ?? null;
    if (opt.music !== false && opt.ootfMusic !== false && pcs.length) {
        res.music = await stage('music tracks', async () => {
            const rrc = await src.read('Music.rrc');
            if (!rrc) {
                res.warnings.push('music: no Music.rrc in the install; the levels use disc tracks');
                return null;
            }
            const iface = await src.read('Common/Interface/Interface.odb');
            const interfaceMusic = iface
                ? pcInterfaceMusic(await parsePcOdbClasses(await SrscReader.fromBytes(iface)))
                : { background: 0, credits: 0 };
            const m = await buildOotfMusicPack(rrc, { hostSdb: ps2.musicSdb, interfaceMusic });
            for (const w of m.warnings) res.warnings.push(`music: ${w}`);
            Object.assign(res.files, m.files);
            log(
                `music: ${m.tracks.length} tracks (${m.tracks.map((t) => `${t.pcId}->${t.ps2Id} ${t.name} ${t.seconds.toFixed(0)}s`).join(', ')}), title ${m.title}`,
            );
            return m;
        });
    }
    const exitClass = findPs2Class((c) => c.rflClass === 55 && transitionFieldIndex(c.fields) >= 0);
    const detectorClass = findPs2Class((c) => c.rflClass === 61 && /^trigger detector$/i.test(c.name.trim()));
    const timerClass = findPs2Class((c) => c.rflClass === 62 && /^timer$/i.test(c.name.trim()) && !!c.fields);
    // Audit: music triggers never go through the class plan (the resolver below maps them to the Trigger Detector class and
    // `applyLevelMusic` rewrites them), and multiplayer pads / crystals have no PS2 object at all (the editor exports them as
    // arena spawns and markers: `ootfArenaFromPc`). Say so instead of reporting them as unsupported.
    for (const row of res.classAudit) {
        if (row.outcome !== 'unsupported') continue;
        const pc = pcs.find((p) => p.path === row.pcPath);
        if (opt.music !== false && musicClass && detectorClass && pc && musicTriggerClassNames(pc).includes(row.name)) {
            row.outcome = 'name-mapped';
            row.ps2Name = detectorClass.cls.name;
            row.reason = undefined;
            row.detail = 'music trigger: rewritten to Trigger Detectors that switch Triggered Music Loops';
        } else if (row.objects > 0 && pc) {
            const cls = pc.classes.get(Number(row.key.split(':')[0]))?.get(Number(row.key.split(':')[1]));
            const omit = cls
                ? deliberateOmission(cls, { arena: isOotfArenaLevel(pc), missingModel: missingModelOf(cls) })
                : null;
            if (omit) {
                row.outcome = 'omitted';
                row.reason = omit.kind;
                row.detail = omit.note;
            }
        } else if (row.objects === 0 && REFERENCE_ENGINES.has(row.rfl)) {
            row.reason = 'reference-only';
            row.detail = `${REFERENCE_ENGINES.get(row.rfl)} (engine ${row.rfl}): only referenced by other classes; the reference stays empty`;
        }
    }
    const resolverFor = (pc: PcLevel): ((db: number, id: number) => ClassTarget | null) | undefined => {
        if (!plan) return undefined;
        const music = opt.music !== false && musicClass && detectorClass ? new Set(musicTriggerClassNames(pc)) : null;
        return (db, id) => {
            const cls = pc.classes.get(db)?.get(id);
            if (cls && music?.has(cls.name)) return detectorClass!.t;
            const k = cls ? planKey.get(sig(cls)) : undefined;
            return k ? plan!.resolve(k.db, k.id) : null;
        };
    };
    /** For `ConvertOptions.omitClass`: the note of a class left out on purpose (ootfcoverage.ts), else null. */
    const omitterFor = (pc: PcLevel): ((db: number, id: number) => string | null) => {
        const arena = isOotfArenaLevel(pc);
        return (db, id) => {
            const cls = pc.classes.get(db)?.get(id);
            return cls ? (deliberateOmission(cls, { arena, missingModel: missingModelOf(cls) })?.note ?? null) : null;
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
            // A Stomp Player without its own list plays its PC class's default list (convertStompPlayers writes it out).
            const stomp = kind === 'sequence' ? pcStompPlayer(pc, o) : null;
            if (stomp?.sequencesFromClass && stomp.sequences.length) {
                await builder.registerOwner(ow);
                for (const v of stomp.sequences)
                    out.push({ owner: ow, ref: v, target: resolve?.(o.dbIndex, o.classId) ?? null });
            }
        }
        return out;
    };

    // A ref is `(db << 16) | id`, db relative to the owning ODB's `.DB` list (0 = its own stem). Converted sounds sit in the
    // host SDB: db 0 for the host's own classes, else the index the owner's `.DB` gives the host (null: not reachable).
    const hostDbOf = (stem: string): number | null => {
        if (stem === hostStem) return 0;
        const text = ps2.dbFiles?.get(stem)?.text;
        if (!text) return null;
        for (const m of text.matchAll(/^(\d+)\s+(.+?)\s*$/gm)) {
            if (odbStemForDependency(m[2]!) === hostStem) return Number(m[1]);
        }
        return null;
    };
    const stemOfTarget = (t: Parameters<typeof fileOfTarget>[0]): string => fileOfTarget(t).replace(/\.ODB$/i, '');
    /** Index the `.DB` of database `from` gives database `to` (0: the same one; null: not listed). */
    const dbIndexIn = (from: string, to: string): number | null => {
        if (from === to) return 0;
        const text = ps2.dbFiles?.get(from)?.text;
        if (!text) return null;
        for (const m of text.matchAll(/^(\d+)\s+(.+?)\s*$/gm))
            if (odbStemForDependency(m[2]!) === to) return Number(m[1]);
        return null;
    };
    // A sequence ref is read from the SSD of the class's own database. Converted detectors live in FX / SYSTEM, which have no
    // SSD on the disc: their scenes go to the SSD of the template's Stomp Player database instead, and a player there runs
    // them (relayDetectorSequences).
    const hasSsd = (stem: string): boolean => !!ps2.ssds?.has(stem);
    const sequencePlayer = ((): { t: ClassTarget; stem: string } | null => {
        for (const [dbIndex, table] of classes) {
            for (const [classId, cls] of table) {
                if (cls.rflClass !== 51 || !cls.fields || !/^stomp player$/i.test(cls.name.trim())) continue;
                const t: ClassTarget = { dbIndex, classId, cls };
                if (hasSsd(stemOfTarget(t))) return { t, stem: stemOfTarget(t) };
            }
        }
        return null;
    })();
    /** SSD stem that receives the sequences of a class in `stem` (null: none can). */
    const sequenceStem = (stem: string): string | null =>
        sequenceSsdStem(stem, ps2.ssds ?? new Map(), sequencePlayer?.stem ?? null);
    // ---- sounds: the sounds that object parameters name, in one new SDB of the shared container
    let soundLookup: ((ownerPath: string, ref: number) => number | null) | null = null;
    if (opt.sounds === true) {
        await stage('sounds', async () => {
            const banks = new Map<string, PcSoundBank>();
            const want = new Map<string, Set<number>>();
            for (const pc of pcs) {
                for (const n of await scan(pc, 'sound')) {
                    if (!n.target || hostDbOf(stemOfTarget(n.target)) === null) continue; // dropped object or unreachable host SDB
                    const c = builder.resolveContainer(n.owner, n.ref >>> 16);
                    if (!c) continue;
                    const k = sdbKey(`${c}.sdb`);
                    (want.get(k) ?? want.set(k, new Set()).get(k)!).add(n.ref & 0xffff);
                }
                if (opt.sequences !== false) {
                    const cinematicBanks = new Map<string, Set<number>>();
                    for (const need of await scan(pc, 'sequence')) {
                        if (!need.target || hostDbOf(stemOfTarget(need.target)) === null) continue;
                        const container = builder.resolveContainer(need.owner, need.ref >>> 16);
                        if (container)
                            (
                                cinematicBanks.get(container) ??
                                cinematicBanks.set(container, new Set()).get(container)!
                            ).add(need.ref & 0xffff);
                    }
                    for (const [container, ids] of cinematicBanks) {
                        const bytes = await src.read(`${container}.ssd`);
                        if (!bytes) {
                            res.warnings.push(`cinematic sounds: missing ${container}.ssd`);
                            continue;
                        }
                        await builder.registerOwner(container);
                        try {
                            for (const ref of await sequenceSoundRefs(await SrscReader.fromBytes(bytes), ids)) {
                                const bank = builder.resolveContainer(container, ref >>> 16);
                                if (!bank) {
                                    res.warnings.push(
                                        `cinematic sounds: ${container} cannot resolve sound 0x${ref.toString(16)}`,
                                    );
                                    continue;
                                }
                                const key = sdbKey(`${bank}.sdb`);
                                (want.get(key) ?? want.set(key, new Set()).get(key)!).add(ref & 0xffff);
                            }
                        } catch (error) {
                            res.warnings.push(`cinematic sounds: ${container}: ${String(error)}`);
                        }
                    }
                }
            }
            for (const k of want.keys()) {
                const bytes = await src.read(`${k}.sdb`);
                if (!bytes) {
                    res.warnings.push(`sounds: missing ${k}.sdb (${want.get(k)!.size} referenced clip ids)`);
                    continue;
                }
                const bank = await parsePcSounds(bytes);
                for (const warning of bank.warnings) res.warnings.push(`sounds ${k}: ${warning}`);
                banks.set(k, { ...bank, sounds: bank.sounds.filter((x) => want.get(k)!.has(x.id)) });
            }
            if (!banks.size) return;
            // Reuse gaps first, then extend the sound index. Native sound descriptor requests use full resource ids.
            const host = ps2.hostSdb;
            const perGroup = new Map<number, number>();
            for (const e of host?.entries ?? [])
                if (e.type === 0x302) perGroup.set(e.sub, (perGroup.get(e.sub) ?? 0) + 1);
            const group = [...perGroup].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 1;
            const freeId = host ? soundIdAllocator(host.entries) : undefined;
            const conv = convertPcSounds(
                banks,
                { firstId: 1, groupId: group, groupName: 'Order of the Flame', nextId: freeId },
                { maxBytes: 0x3f000, fitRates: [22050, 11025] },
            );
            for (const w of conv.warnings) res.warnings.push(`sounds: ${w}`);
            if (!conv.sounds.length) return;
            if (host) {
                for (const r of ps2SoundEntries(conv.sounds))
                    res.files[`new/${hostStem}.SDB/${hex4(r.type)}_${r.id}_${r.sub}.bin`] = r.data;
            } else {
                res.files[`files/${hostDir ?? 'ENGLISH/COMMON/RESOURES'}/${hostStem}.SDB.new`] = writePs2Sdb(
                    conv.sounds,
                    [conv.group],
                );
            }
            soundLookup = (ow, ref) => {
                const c = builder.resolveContainer(ow, ref >>> 16);
                const m = c ? conv.map.get(sdbKey(`${c}.sdb`), ref & 0xffff) : null;
                return m === null ? null : m & 0xffff;
            };
        });
    }
    const seqIds = new Map<string, number>();
    /** PC level path -> object id of the synthetic player its converted scenes hold (cinematic-only levels). */
    const heldPlayer = new Map<string, number>();
    /** PC level path -> the Rynn prop its scenes no longer play and the synthetic player that takes its place. */
    const rynnPropSwap = new Map<string, { prop: number; player: number }>();
    const mapResource = (kind: ResourceKind, ref: number, ctx: ResourceContext): number | null => {
        const ow = owner(ctx.pc, ctx.ownerDb);
        if (!ow) return null;
        try {
            // Sequences live in the SSD of the owner's stem (db 0), whatever the ODB.
            // A class in a database without an SSD cannot name one: relayDetectorSequences gives it a Stomp Player instead.
            if (kind === 'sequence')
                return ctx.target && !hasSsd(stemOfTarget(ctx.target))
                    ? null
                    : (seqIds.get(`${ctx.pc.path}|${ow}|${ref}`) ?? null);
            if (kind === 'sound') {
                const db = soundLookup ? hostDbOf(stemOfTarget(ctx.target)) : null;
                const id = db === null ? null : soundLookup!(ow, ref);
                return db === null || id === null ? null : ((db << 16) | id) >>> 0;
            }
            // Other refs resolve through the owning ODB; only the host ODB's own MOD (db 0) carries converted models.
            if (fileOfTarget(ctx.target) !== hostFile) return null;
            if (kind === 'model') return builder.mapModelRef(ref >>> 16, ref & 0xffff, ow);
        } catch {
            return null;
        }
        return null;
    };
    const ssdUsed = new Map<string, Set<number>>();
    const ssdFiles: Record<string, Uint8Array> = {};
    // Class refs in object parameters (an item a detector asks for, a creature's weapon or drops) number `db` in the .db of
    // the object's class ODB on both games, like class defaults; the level's dependency numbers only match by chance (Volcanic
    // Detector 1994's Rune Cage Key: PC db 2 is Resources in Volcano.db but the level itself in the LVL header).
    const mapObjectClassRef = (ref: number, ctx: ResourceContext): number | null => {
        const ow = owner(ctx.pc, ctx.ownerDb);
        const container = ow ? builder.resolveContainer(ow, ref >>> 16) : null;
        const cls = container ? ownedClasses.get(ownedClassKey(container, ref & 0xffff)) : undefined;
        const k = cls ? planKey.get(sig(cls)) : undefined;
        const target = k && plan ? plan.resolve(k.db, k.id) : null;
        if (!target) return null;
        const from = stemOfTarget(ctx.target);
        const to = stemOfTarget(target);
        if (from === to) return target.classId;
        for (const m of ps2.dbFiles?.get(from)?.text.matchAll(/^(\d+)\s+(.+?)\s*$/gm) ?? [])
            if (odbStemForDependency(m[2]!) === to) return ((Number(m[1]) << 16) | target.classId) >>> 0;
        return null;
    };

    const procDb = findTerrainDbIndex(tplHeader);
    const terrBuilder =
        opt.textures !== false && !opt.terrainInCommon && ps2.procTxd && procDb !== undefined
            ? await TerrainTextureBuilder.create(src, ps2.procTxd, procDb, opt.terrain)
            : null;

    // ---- level maps: one Map class (picture, world rectangle, picture rectangle) per level with an Order of the Flame parchment
    const levelMaps = new Map<string, { spec: LevelMapSpec; synth: Synthesized; texture?: Uint8Array }>();
    if (opt.levelMaps !== false && plan && ps2Odbs.length) {
        await stage('level maps', async () => {
            let rrcReader: SrscReader | null = null;
            try {
                const bytes = rrc.path ? await src.read(rrc.path) : null;
                rrcReader = bytes ? await SrscReader.fromBytes(bytes) : null;
            } catch {
                rrcReader = null;
            }
            let tpl: { odb: Ps2OdbIn; id: number; cls: OdbClass } | undefined;
            for (const odb of ps2Odbs)
                for (const [id, cls] of odb.classes) if (!tpl && cls.data && isMapClass(cls) && odb.raw?.(id)) tpl = { odb, id, cls };
            if (!tpl) {
                res.warnings.push('level maps: the template has no Map class; levels keep its map');
                return;
            }
            const overrides: Readonly<Record<string, LevelMapOverride>> = opt.levelMaps || {};
            let top = Math.max(0, ...tpl.odb.classes.keys(), ...plan.synthesized.filter((x) => x.file === tpl.odb.file).map((x) => x.classId));
            for (const pc of pcs) {
                if (isOotfArenaLevel(pc)) continue;
                const spec = applyMapOverride(rrcReader ? await defaultLevelMap(pc, rrcReader) : null, overrides[pc.path.toLowerCase()]);
                if (!spec) continue;
                const classId = ++top;
                const name = `OotF Map ${pcLevelName(pc.header)}`.slice(0, 40);
                const data = [...tpl.cls.data!];
                for (const [fname, v] of mapClassValues(spec)) {
                    const j = classFieldIndex(tpl.cls, fname);
                    if (j >= 0) data[j] = v >>> 0;
                }
                const group = tpl.odb.group?.(tpl.id) ?? tpl.cls.group;
                const synth: Synthesized = {
                    pcKeys: [],
                    name,
                    file: tpl.odb.file,
                    dbIndex: tpl.odb.dbIndex,
                    classId,
                    group,
                    rfl: tpl.cls.rflClass ?? 0,
                    template: { dbIndex: tpl.odb.dbIndex, classId: tpl.id, name: tpl.cls.name },
                    record: cloneClassRecord(tpl.odb.raw!(tpl.id)!, name, data),
                    cls: { ...tpl.cls, id: classId, name, group, data },
                    copied: [],
                    skipped: [],
                    coverage: 1,
                };
                plan.synthesized.push(synth);
                levelMaps.set(pc.path, { spec, synth });
                log(`${pc.path}: map class ${classId} (${name})`);
            }
        });
    }

    // Classes mapped onto a PS2 class by name (no clone): their objects take the PC class defaults explicitly.
    const nameMapped = new Set([...(plan?.mapped.values() ?? [])].map((t) => `${t.dbIndex}:${t.classId}`));

    // ---- levels
    for (const pc of pcs) {
        for (const db of pc.odbPaths.keys()) {
            const ow = owner(pc, db);
            if (ow) await builder.registerOwner(ow);
        }
        const procMap = terrBuilder ? await stage(`terrain textures ${pc.path}`, () => terrBuilder.addLevel(pc)) : null;
        const tex =
            !terrBuilder && opt.textures !== false && !opt.terrainInCommon && ps2.splatTxd && splatDb !== undefined
                ? await stage(`textures ${pc.path}`, () =>
                      convertTerrainTextures(pc, src, ps2.splatTxd!, splatDb, opt.terrain),
                  )
                : null;
        // Campaign titles are already runtime-safe; caller names of a localized install may hold umlauts, which the runtime
        // refuses in a level name (it then ignores the level): transliterate them (ASCII names are unchanged).
        const title =
            (plan0 && campaignTitle(plan0, pc.path)) ||
            asciiLevelTitle(opt.name ? opt.name(pc) : pcLevelName(pc.header))
                .slice(0, 60)
                .trim();
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
                mapClassRef: opt.classes !== false ? mapObjectClassRef : undefined,
                keepPcDefaults: (c, t) => keepsPcDefaults(c.rflClass) && nameMapped.has(`${t.dbIndex}:${t.classId}`),
                omitClass: omitterFor(pc),
                paramAlias: pcParamAlias,
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
                    const own = fileOfTarget(n.target).replace(/\.ODB$/, '');
                    const stem = sequenceStem(own) ?? own;
                    const k = `${stem}|${n.owner}|${n.ref >>> 16}`;
                    (
                        groups.get(k) ?? groups.set(k, { stem, ow: n.owner, db: n.ref >>> 16, ids: new Set() }).get(k)!
                    ).ids.add(n.ref & 0xffff);
                }
                let any = false;
                let converted = 0;
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
                    const actorId = (engineClass: number): number | undefined => {
                        const object = pc.list.objects.find(
                            (o) => pc.classes.get(o.dbIndex)?.get(o.classId)?.rflClass === engineClass,
                        );
                        return object ? first.objectIdMap.get(object.id) : undefined;
                    };
                    // A level with no PC player (the cinematic Intro) gets the template's Rynn from ensureSingletons, with the
                    // next free object id; its scenes hold that player so the native HUD stays hidden, as in the disc Intro.
                    const syntheticPlayer =
                        actorId(9) === undefined &&
                        opt.singletons !== false &&
                        tplList.objects.some((o) => classes.get(o.dbIndex)?.get(o.classId)?.rflClass === 9)
                            ? first.objects.objects.reduce((m, o) => Math.max(m, o.id), 0) + 1
                            : undefined;
                    if (syntheticPlayer !== undefined) heldPlayer.set(pc.path, syntheticPlayer);
                    const ssdReader = await SrscReader.fromBytes(bytes);
                    // A level without a PC player can show Rynn as a prop of her model (the Intro's "Rynn", engine class 17,
                    // the PC Rynn model): its scenes play the synthetic PS2 player instead, which takes the prop's place.
                    const rynnProp =
                        syntheticPlayer === undefined
                            ? undefined
                            : pc.list.objects.find((o) => {
                                  const c = pc.classes.get(o.dbIndex)?.get(o.classId);
                                  return !!c?.model && c.rflClass !== 9 && /^w?rynn$/i.test(c.name.trim());
                              });
                    const propTarget = rynnProp && first.objectIdMap.get(rynnProp.id);
                    if (rynnProp && propTarget !== undefined && syntheticPlayer !== undefined)
                        rynnPropSwap.set(pc.path, { prop: propTarget, player: syntheticPlayer });
                    const sceneObjectIds: RefLookup = {
                        get: (id) => (rynnProp && id === rynnProp.id ? syntheticPlayer : first.objectIdMap.get(id)),
                    };
                    // The player's scene clips, retargeted onto the PS2 player rig (new clips of its ADB), and its channel map.
                    const playerId = actorId(9) ?? (rynnProp ? syntheticPlayer : undefined);
                    const playerScene = await (async () => {
                        const object =
                            pc.list.objects.find((o) => pc.classes.get(o.dbIndex)?.get(o.classId)?.rflClass === 9) ??
                            rynnProp;
                        const cls = object && pc.classes.get(object.dbIndex)?.get(object.classId);
                        const ow = cls && ownerOf.get(cls);
                        if (playerId === undefined || !cls?.model || !ow || !player.rig) return null;
                        const refs = new Set<number>();
                        for (const e of ssdReader.entries) {
                            if (e.type !== SSD_SEQUENCE || !g.ids.has(e.id)) continue;
                            let seq;
                            try {
                                seq = parsePcSequence(e.id, e.sub, (await ssdReader.read(e)).data);
                            } catch {
                                continue;
                            }
                            for (const a of seq.actors) {
                                const mapped = a.actorType === 1 ? sceneObjectIds.get(a.objectId) : undefined;
                                if (mapped !== playerId && !(mapped === undefined && /^w?rynn$/i.test(a.name.trim())))
                                    continue;
                                for (const x of a.actions) {
                                    if (x.type !== 1) continue;
                                    const ref = new DataView(x.payload.buffer, x.payload.byteOffset).getUint32(4, true);
                                    if (ref >>> 16 === 0) refs.add(ref);
                                }
                            }
                        }
                        const source = await builder.creatureSource(ow, cls.model.db, cls.model.id);
                        const container = builder.resolveContainer(ow, cls.model.db);
                        if (!source || !container) return null;
                        const clips = await player.add(`${container}#${cls.model.id}`, source, refs);
                        for (const w of clips.warnings) res.warnings.push(`sequences ${pc.path}: player clips: ${w}`);
                        return { clips: clips.map, channels: player.channelMap(source.skeleton) };
                    })();
                    const conv = await convertPcSequences(ssdReader, {
                        maps: {
                            objectIdMap: sceneObjectIds,
                            channelMapForActor: (_actor, targetId) =>
                                targetId === playerId ? playerScene?.channels : undefined,
                            // The PS2 Rynn class has a Jaw Channel: her speech gets the lip-sync bit (tracks: ootfsound.ts).
                            lipSyncForActor: (_actor, targetId) => targetId === playerId,
                            animMapForActor: (actor, targetId) => {
                                // The PS2 player is the PS2 Rynn whatever the PC class's model: its clips live in its own ADB.
                                if (targetId === playerId && player.rig) {
                                    const clips = playerScene?.clips;
                                    return { get: (ref) => (ref >>> 16 === 0 ? clips?.get(ref & 0xffff) : undefined) };
                                }
                                // Prefer the explicit source identity, but only when it resolves to this target.
                                // Assigned/current actors have no source object id; their fallback ids are supplied
                                // by actorId() above and are actual mapped level object ids, not sentinel refs.
                                const sourceId =
                                    actor.actorType === 1 && first.objectIdMap.get(actor.objectId) === targetId
                                        ? actor.objectId
                                        : undefined;
                                const object = pc.list.objects.find((o) =>
                                    sourceId !== undefined
                                        ? o.id === sourceId
                                        : first.objectIdMap.get(o.id) === targetId,
                                );
                                const cls = object && pc.classes.get(object.dbIndex)?.get(object.classId);
                                const model = cls?.model;
                                const ow = cls && ownerOf.get(cls);
                                if (!cls || !model || !ow) return undefined;
                                const key = planKey.get(sig(cls));
                                // pruneSkinned already removed unshipped source models and their clip maps.
                                const clips =
                                    builder.mapAnimRef(model.db, model.id, ow) ??
                                    (key ? sequenceRetargetMaps.get(`${key.db}:${key.id}`) : undefined);
                                return clips
                                    ? { get: (ref) => (ref >>> 16 === 0 ? clips.get(ref & 0xffff) : undefined) }
                                    : undefined;
                            },
                            soundMap: {
                                get: (ref) => {
                                    const db = hostDbOf(g.stem);
                                    const id = c && soundLookup ? soundLookup(c, ref) : null;
                                    return db === null || id === null ? undefined : ((db << 16) | id) >>> 0;
                                },
                            },
                            // cut scene music (PC action 8): the rendered OotF track. Unlike sounds, a sequence's music
                            // ref names the LEVEL's dependency index of PS2 Music (disc: LEVEL0RO 7, LEVEL1NA 14,
                            // LEVEL2RE 18, LEVEL8OS 19 match their LVL tables, not the SSD stem's `.DB`)
                            musicMap: {
                                get: (pcId) => {
                                    const id = res.music?.ids.get(pcId);
                                    const db = musicDb;
                                    return id === undefined || db === null ? undefined : ((db << 16) | id) >>> 0;
                                },
                            },
                        },
                        playerObjectId: playerId,
                        dragonObjectId: actorId(28),
                        cameraObjectId: actorId(27),
                        cameraFov: pcLevelFov(pc),
                        holdPlayerObjectId: syntheticPlayer,
                        rewrite: c ? cullRewrite(culling, c) : undefined,
                        usedIds: used,
                        only: g.ids,
                        pcDbIndex: g.db,
                        ps2Db: 0,
                        folderName: `OotF ${title}`.slice(0, 40),
                    });
                    Object.assign(ssdFiles, ssdPackFiles(`${g.stem}.SSD`, conv.entries));
                    for (const warning of conv.report.warnings)
                        res.warnings.push(`sequences ${pc.path} (${c}): ${warning}`);
                    for (const [k, v] of conv.idMap) seqIds.set(`${pc.path}|${g.ow}|${k}`, v);
                    any = any || conv.idMap.size > 0;
                    converted += conv.idMap.size;
                }
                const referenced = [...groups.values()].reduce((n, g) => n + g.ids.size, 0);
                console.warn(`sequences ${title}: ${referenced} referenced, ${converted} converted`);
                return any ? convertOnce() : first;
            });
            parts = again ?? first;
        }
        if (!parts) continue;
        if (opt.singletons !== false) {
            await stage(`singletons ${pc.path}`, async () => {
                ensureSingletons(parts, pc, tplList.objects, classes);
                const lm = levelMaps.get(pc.path);
                const props = lm && parts.objects.objects.find((o) => classes.get(o.dbIndex)?.get(o.classId)?.rflClass === 54);
                if (lm && props) {
                    const cur = objectParamSpecs(props);
                    const spec = cur.find((x) => x.name.trim() === 'Map Object');
                    const fields = classes.get(props.dbIndex)?.get(props.classId)?.fields;
                    const j = fields?.findIndex((f) => f.name.trim() === 'Map Object') ?? -1;
                    if (spec) spec.value = lm.synth.classId;
                    else if (fields && j >= 0) cur.push({ fieldIndex: j, type: fields[j]!.type, name: 'Map Object', value: lm.synth.classId });
                    if (spec || j >= 0) setObjectParams(parts.objects, props.id, cur);
                    else res.warnings.push(`${title}: Level Properties has no Map Object field`);
                }
                const swap = rynnPropSwap.get(pc.path);
                const objs = parts.objects.objects;
                const prop = swap && objs.find((o) => o.id === swap.prop);
                const synthetic = swap && objs.find((o) => o.id === swap.player);
                if (prop && synthetic) {
                    // The PS2 Rynn stands where the PC prop stood; the prop goes (its scenes now play her).
                    synthetic.pos = [...prop.pos];
                    synthetic.rot = [...prop.rot];
                    parts.objects.objects = objs.filter((o) => o !== prop);
                    for (const o of parts.objects.objects) o.links = o.links.filter((l) => l !== prop.id);
                }
                const held = heldPlayer.get(pc.path);
                const rynn = parts.objects.objects.find((o) => classes.get(o.dbIndex)?.get(o.classId)?.rflClass === 9);
                if (held !== undefined && rynn?.id !== held)
                    res.warnings.push(
                        `${title}: the scenes hold player ${held} but the level's player is ${rynn?.id ?? 'missing'}; the HUD may show in its scenes`,
                    );
            });
        }
        const lvl = parts;
        const xdbOf = (o: LvlObject): string | null => {
            const d = tplHeader.dependencies.find((x) => x.dbIndex === o.dbIndex);
            const xdb = d ? `${odbStemForDependency(d.path.text)}.XDB` : null;
            return xdb && (!ps2.xdbFiles || ps2.xdbFiles.has(xdb)) ? xdb : null;
        };
        if (opt.music !== false && musicClass) {
            await stage(`music ${pc.path}`, async () => {
                const mc = {
                    dbIndex: musicClass.t.dbIndex,
                    classId: musicClass.t.classId,
                    fields: musicClass.cls.fields!,
                };
                const rynn = lvl.objects.objects.find((o) => classes.get(o.dbIndex)?.get(o.classId)?.rflClass === 9);
                const dc = detectorClass?.cls.fields
                    ? {
                          dbIndex: detectorClass.t.dbIndex,
                          classId: detectorClass.t.classId,
                          fields: detectorClass.cls.fields,
                      }
                    : null;
                // The level's start music (PC Level Properties `Initial Music ID`) and the Music Trigger boxes.
                const r = applyLevelMusic(lvl.objects, findMusicTriggers(pc), {
                    musicClass: mc,
                    detectorClass: dc,
                    levelPath: ootfLevelKey(pc),
                    initialPcId: res.music ? pcInitialMusicId(pc) : 0,
                    loopPos: rynn ? [...rynn.pos] : [0, 0, 0],
                    trackIds: res.music?.ids,
                });
                for (const w of r.warnings) res.warnings.push(`${title}: music: ${w}`);
                if (r.loops.size)
                    log(
                        `${title}: music: ${r.loops.size} loop(s) (${[...r.tracks].map(([k, t]) => `${k}->${t}`).join(', ')}), ${r.detectors} detector(s)`,
                    );
            });
        }
        if (dbgEnv0['OOTF_NO_PUZZLE'] !== '1') {
            await stage(`puzzles ${pc.path}`, async () => {
                const ps2Class = (o: LvlObject) =>
                    classes.get(o.dbIndex)?.get(o.classId) ??
                    plan?.synthesized.find((x) => x.dbIndex === o.dbIndex && x.classId === o.classId)?.cls;
                const rep = applyPuzzleLogic({
                    pc,
                    list: lvl.objects,
                    title,
                    classOf: ps2Class,
                    ...(detectorClass
                        ? { detector: { dbIndex: detectorClass.t.dbIndex, classId: detectorClass.t.classId } }
                        : {}),
                    ...(timerClass ? { timer: { dbIndex: timerClass.t.dbIndex, classId: timerClass.t.classId } } : {}),
                    textId: (o, text) => {
                        const xdb = xdbOf(o);
                        return xdb ? textPlan.idFor(xdb, text) : null;
                    },
                    setClassDefaults: (o, values) => {
                        const s = plan?.synthesized.find((x) => x.dbIndex === o.dbIndex && x.classId === o.classId);
                        if (s) res.warnings.push(...setSynthesizedDefaults(s, values));
                    },
                    classRef: (pcDb, pcClassId, holder) => {
                        const t = resolverFor(pc)?.(pcDb, pcClassId);
                        if (!t) return null;
                        // An object's class-ref parameter is read in the frame of its own class's database (the disc's
                        // carry-gated detectors name Resources with the index their database's .DB gives it).
                        const db = dbIndexIn(stemOfTarget({ dbIndex: holder.dbIndex } as ClassTarget), stemOfTarget(t));
                        return db === null ? null : ((db << 16) | t.classId) >>> 0;
                    },
                    warnings: res.warnings,
                    ...(levelMaps.get(pc.path) ? { mapPixel: (x: number, z: number) => mapPixelOf(levelMaps.get(pc.path)!.spec, x, z) } : {}),
                });
                if (rep.plates || rep.bossHeads || rep.markers || rep.messengers || rep.questLocks)
                    console.warn(
                        `puzzles ${title}: ${rep.plates} plates -> ${rep.detectors} detectors, ${rep.bossHeads} boss heads (${rep.deathCounters} counters), ${rep.messengers} messengers, ${rep.markers} markers (${rep.markersSkipped} skipped), ${rep.quieted} cloud ring links removed, ${rep.questLocks} quest item locks`,
                    );
            });
        }
        if (sequencePlayer && opt.sequences !== false) {
            await stage(`sequence players ${pc.path}`, async () => {
                const resolve = resolverFor(pc);
                const classOf = (o: LvlObject): OdbClass | undefined =>
                    classes.get(o.dbIndex)?.get(o.classId) ??
                    plan?.synthesized.find((x) => x.dbIndex === o.dbIndex && x.classId === o.classId)?.cls;
                // PC and PS2 number List Play Order differently and start scenes differently (ootfstomp.ts).
                const stomps = convertStompPlayers({
                    pc,
                    list: lvl.objects,
                    title,
                    classOf,
                    mapSequence: (o, ref) => {
                        const ow = owner(pc, o.dbIndex);
                        return ow ? (seqIds.get(`${pc.path}|${ow}|${ref >>> 0}`) ?? null) : null;
                    },
                    warnings: res.warnings,
                });
                const changed = stomps.filter((s) => s.ps2Order !== s.before || s.classList);
                if (changed.length)
                    console.warn(
                        `sequences ${title}: Stomp Players ${changed.map((s) => `${s.id} order ${s.before}->${s.ps2Order}${s.classList ? ' (class list)' : ''}`).join(', ')}`,
                    );
                const n = relayDetectorSequences({
                    pc,
                    list: lvl.objects,
                    title,
                    classOf,
                    player: { dbIndex: sequencePlayer.t.dbIndex, classId: sequencePlayer.t.classId },
                    relayed: (o) => {
                        const t = resolve?.(o.dbIndex, o.classId);
                        const ow = owner(pc, o.dbIndex);
                        if (!t || !ow || hasSsd(stemOfTarget(t))) return [];
                        const refs: number[] = [];
                        for (const sp of objectParamSpecs(o)) {
                            if (resourceKind(sp.type) !== 'sequence') continue;
                            for (const v of Array.isArray(sp.value) ? sp.value : [sp.value]) {
                                const m =
                                    typeof v === 'number' && v ? seqIds.get(`${pc.path}|${ow}|${v >>> 0}`) : undefined;
                                if (m !== undefined) refs.push(m);
                            }
                        }
                        return refs;
                    },
                    warnings: res.warnings,
                });
                if (n) console.warn(`sequences ${title}: ${n} detector scene(s) given a Stomp Player`);
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
                // Converted PC detectors are clones of a PS2 detector class (synthesized for this pack) or template classes.
                const detectorFieldsOf = (o: LvlObject) => {
                    const c =
                        classes.get(o.dbIndex)?.get(o.classId) ??
                        plan?.synthesized.find((x) => x.dbIndex === o.dbIndex && x.classId === o.classId)?.cls;
                    if (c?.rflClass !== 61 || !c.fields) return null;
                    return { fields: c.fields, defaults: (k: number) => Number(classFieldDefault(c, k) ?? 0) };
                };
                const r = applyCampaignExits(lvl.objects, cl, plan0, {
                    exitFieldOf: exitField,
                    detectorFieldsOf,
                    terrain: pc.terrain,
                    ...(detectorClass
                        ? { detectorClass: { dbIndex: detectorClass.t.dbIndex, classId: detectorClass.t.classId } }
                        : {}),
                    ...(detectorClass
                        ? (() => {
                              const wi = detectorClass.cls.fields!.findIndex((f) =>
                                  /^detect which\?$/i.test(f.name.trim()),
                              );
                              return wi >= 0
                                  ? {
                                        mountDetector: {
                                            fieldIndex: wi,
                                            type: detectorClass.cls.fields![wi]!.type,
                                            name: detectorClass.cls.fields![wi]!.name,
                                        },
                                    }
                                  : {};
                          })()
                        : {}),
                    ...(detectorClass
                        ? {
                              // Exit detectors send ON (as on the disc); the Trigger Detector defaults differ per database, so never rely on them.
                              detectorParams: exitDetectorParams(
                                  detectorClass.cls.fields!,
                                  dbgEnv0['OOTF_DETECT_WHICH'] === undefined ? 0 : Number(dbgEnv0['OOTF_DETECT_WHICH']),
                              ),
                          }
                        : {}),
                    ...(timerClass
                        ? {
                              timerClass: {
                                  dbIndex: timerClass.t.dbIndex,
                                  classId: timerClass.t.classId,
                                  fields: timerClass.cls.fields!,
                              },
                          }
                        : {}),
                    exitClass: {
                        dbIndex: exitClass.t.dbIndex,
                        classId: exitClass.t.classId,
                        field: {
                            fieldIndex: i,
                            type: exitClass.cls.fields![i]!.type,
                            name: exitClass.cls.fields![i]!.name,
                        },
                        ...(() => {
                            const mi = exitClass.cls.fields!.findIndex((f) =>
                                /^maintain player position$/i.test(f.name.trim()),
                            );
                            return mi >= 0
                                ? {
                                      maintain: {
                                          fieldIndex: mi,
                                          type: exitClass.cls.fields![mi]!.type,
                                          name: exitClass.cls.fields![mi]!.name,
                                          default: Number(classFieldDefault(exitClass.cls, mi) ?? 1),
                                      },
                                  }
                                : {};
                        })(),
                    },
                });
                for (const w of r.warnings) res.warnings.push(w);
            });
        }
        if (opt.texts !== false)
            await stage(`texts ${pc.path}`, async () => void rewriteObjectTexts(lvl.objects, textPlan, xdbOf));
        if (opt.terrainShading !== false)
            parts.terrain = parts.terrain.map((L) => ({ ...L, cellFlags: ps2CellFlags(L) }));
        parts.terrain = limitVisibleEntries(parts.terrain);
        const dbgEnv = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};
        if (dbgEnv['DRAKAN_DBG_MAXLAYERS'])
            parts.terrain = parts.terrain.slice(0, Number(dbgEnv['DRAKAN_DBG_MAXLAYERS']));
        const dbgName = (o: LvlObject): string =>
            classes.get(o.dbIndex)?.get(o.classId)?.name ??
            plan?.synthesized.find((x) => x.dbIndex === o.dbIndex && x.classId === o.classId)?.name ??
            '';
        if (dbgEnv['DRAKAN_DBG_LINKS']) {
            // Test aid: objects whose class name matches the regex, with the names of their link targets and of their linkers.
            const re = new RegExp(dbgEnv['DRAKAN_DBG_LINKS'], 'i');
            const objs = parts.objects.objects;
            const nm = (id: number): string => {
                const t = objs.find((x) => x.id === id);
                return t ? `${dbgName(t)}#${t.id}` : `?#${id}`;
            };
            for (const o of objs)
                if (re.test(dbgName(o)))
                    console.warn(
                        `LINKS ${dbgName(o)}#${o.id} at ${o.pos.map(Math.round)} -> [${o.links.map(nm).join(', ')}] <- [${objs
                            .filter((x) => x.links.includes(o.id))
                            .map((x) => nm(x.id))
                            .join(', ')}]`,
                    );
        }
        // DRAKAN_DBG_PULLIDS=<id,id,...> restricts DRAKAN_DBG_PULL to those object ids (limit 8), the i-th id goes to ring slot i (+x, -x, +z, -z).
        const pullArr = dbgEnv['DRAKAN_DBG_PULLIDS'] ? dbgEnv['DRAKAN_DBG_PULLIDS'].split(',').map(Number) : null;
        const pullIds = pullArr ? new Set(pullArr) : null;
        const pullIdOk = (o: LvlObject): boolean => !pullIds || pullIds.has(o.id);
        {
            // PC creatures whose "visible" flag (0x01) is clear start hidden: a Detect and Execute / timer link shows them later (Death Mages,
            // Hueges: proven in game). One that nothing links to would stay invisible for ever (the Queen has no links at all), so it is shown.
            const linked = new Set(parts.objects.objects.flatMap((x) => x.links));
            let shown = 0;
            parts.objects = {
                ...parts.objects,
                objects: parts.objects.objects.map((o) => {
                    const rfl =
                        classes.get(o.dbIndex)?.get(o.classId)?.rflClass ??
                        plan?.synthesized.find((x) => x.dbIndex === o.dbIndex && x.classId === o.classId)?.rfl ??
                        -1;
                    if (o.flags & 1 || linked.has(o.id) || ENGINE_CLASSES.get(rfl)?.kind !== 'creature') return o;
                    shown++;
                    return { ...o, flags: o.flags | 1 };
                }),
            };
            if (shown) res.warnings.push(`${pc.path}: ${shown} hidden creature(s) nothing links to made visible`);
        }
        {
            // PC levels place a few creatures already dead (Ruined Village's grunt with Initial Health -50, dead slaves with 0) and the
            // PC draws them as corpses. The PS2 engine spawns such a creature dead without playing any death clip, so it stood in its
            // idle (the disc never places one). Its idle becomes its death pose: the class's Idle Death clip, else its Death clip,
            // which plays once and holds the last frame.
            let laid = 0;
            for (const o of parts.objects.objects) {
                const cls =
                    classes.get(o.dbIndex)?.get(o.classId) ??
                    plan?.synthesized.find((x) => x.dbIndex === o.dbIndex && x.classId === o.classId)?.cls;
                const pose = cls && placedCorpsePose(o, cls);
                if (!pose) continue;
                setObjectParams({ objects: [o], warnings: [] }, o.id, pose);
                laid++;
            }
            if (laid) res.warnings.push(`${pc.path}: ${laid} creature(s) placed dead start in their death pose`);
        }
        {
            // Ambush doors wait for the trigger that sends their creature out instead of the PS2 auto-open (ootfdoors.ts).
            const held = holdLinkedDoors(
                parts.objects,
                (o) => {
                    const t = plan?.synthesized.find((x) => x.dbIndex === o.dbIndex && x.classId === o.classId);
                    return t ? { ...t.cls, rflClass: t.rfl } : classes.get(o.dbIndex)?.get(o.classId);
                },
                (o) => {
                    if (o.flags & 1) return false;
                    const rfl =
                        classes.get(o.dbIndex)?.get(o.classId)?.rflClass ??
                        plan?.synthesized.find((x) => x.dbIndex === o.dbIndex && x.classId === o.classId)?.rfl ??
                        -1;
                    return ENGINE_CLASSES.get(rfl)?.kind === 'creature';
                },
            );
            if (held.length) log(`${pc.path}: ${held.length} ambush door(s) keep Auto-Open? 0`);
        }
        if (dbgEnv['DRAKAN_DBG_DROP']) {
            // Test aid: remove every object whose class name matches the regex (bisecting a crash to a class).
            const re = new RegExp(dbgEnv['DRAKAN_DBG_DROP'], 'i');
            parts.objects = { ...parts.objects, objects: parts.objects.objects.filter((o) => !re.test(dbgName(o))) };
        }
        if (dbgEnv['DRAKAN_DBG_NOOBJ']) {
            const keep = (o: LvlObject): boolean =>
                [9, 27, 54].includes(classes.get(o.dbIndex)?.get(o.classId)?.rflClass ?? -1) ||
                classes.get(o.dbIndex)?.get(o.classId)?.name === 'Procedural Sky' ||
                (!!dbgEnv['DRAKAN_DBG_PULL'] &&
                    new RegExp(dbgEnv['DRAKAN_DBG_PULL'], 'i').test(dbgName(o)) &&
                    pullIdOk(o));
            parts.objects = { ...parts.objects, objects: parts.objects.objects.filter(keep) };
        }
        if (dbgEnv['DRAKAN_DBG_STOMP'] !== undefined) {
            // Test aid: list the sequence players; DRAKAN_DBG_STOMP=<n> also sets their Initial State to n (-1 = list only).
            const want = Number(dbgEnv['DRAKAN_DBG_STOMP']);
            for (const o of parts.objects.objects) {
                if (dbgName(o) !== 'Stomp Player') continue;
                console.warn(
                    `stomp obj ${o.id} pos ${o.pos.map(Math.round)} params ${o.params.map((p, i) => `${p.name}=${o.data[i]}`).join(' ')}`,
                );
                if (want >= 0)
                    o.params.forEach((p, i) => {
                        if (p.name.startsWith('Initial State')) o.data[i] = want;
                    });
            }
        }
        if (dbgEnv['DRAKAN_DBG_OBJSPLIT'] || dbgEnv['DRAKAN_DBG_DROPRFL'] || dbgEnv['DRAKAN_DBG_DROPNAME']) {
            // Test aids for bisecting a level that breaks: OBJSPLIT=n,k keeps essentials (rfl 9/27/54, sky) plus objects with
            // index % n == k; DROPRFL=a,b drops objects of those rfl classes; DROPNAME=<regex> drops objects by class name.
            const [sn, sk] = (dbgEnv['DRAKAN_DBG_OBJSPLIT'] ?? '').split(',').map(Number);
            const dropRfl = (dbgEnv['DRAKAN_DBG_DROPRFL'] ?? '').split(',').filter(Boolean).map(Number);
            const dropRe = dbgEnv['DRAKAN_DBG_DROPNAME'] ? new RegExp(dbgEnv['DRAKAN_DBG_DROPNAME'], 'i') : null;
            const rflOf2 = (o: LvlObject): number => classes.get(o.dbIndex)?.get(o.classId)?.rflClass ?? -1;
            parts.objects = {
                ...parts.objects,
                objects: parts.objects.objects.filter((o, i) => {
                    const essential = [9, 27, 54].includes(rflOf2(o)) || dbgName(o) === 'Procedural Sky';
                    if (essential) return true;
                    if (dropRfl.includes(rflOf2(o))) return false;
                    if (dropRe?.test(dbgName(o))) return false;
                    return sn ? i % sn === sk : true;
                }),
            };
        }
        if (dbgEnv['DRAKAN_DBG_DROPIDS']) {
            // Test aid: DRAKAN_DBG_DROPIDS=<id>,<id>... drops those objects (ids are PC ids).
            const ids = new Set(dbgEnv['DRAKAN_DBG_DROPIDS'].split(',').filter(Boolean).map(Number));
            parts.objects = { ...parts.objects, objects: parts.objects.objects.filter((o) => !ids.has(o.id)) };
        }
        if (dbgEnv['DRAKAN_DBG_MAXNAME']) {
            // Test aid: DRAKAN_DBG_MAXNAME=<regex>=<n> keeps only the first n objects whose class name matches.
            const cut = dbgEnv['DRAKAN_DBG_MAXNAME'].lastIndexOf('=');
            const re = new RegExp(dbgEnv['DRAKAN_DBG_MAXNAME'].slice(0, cut), 'i');
            const max = Number(dbgEnv['DRAKAN_DBG_MAXNAME'].slice(cut + 1));
            let seen = 0;
            parts.objects = {
                ...parts.objects,
                objects: parts.objects.objects.filter((o) => !re.test(dbgName(o)) || seen++ < max),
            };
        }
        if (dbgEnv['DRAKAN_DBG_DUMPNAME']) {
            // Test aid: print every object whose class name matches the regex (id, position, field values by name).
            const re = new RegExp(dbgEnv['DRAKAN_DBG_DUMPNAME'], 'i');
            for (const o of parts.objects.objects)
                if (re.test(dbgName(o)))
                    console.warn(
                        `DUMP ${o.id} ${dbgName(o)} pos=${o.pos.map(Math.round)} ${o.params.map((p, i) => `${p.name}=${o.data[i]}`).join(' ')}`,
                    );
        }
        if (dbgEnv['DRAKAN_DBG_LIST']) {
            const h = new Map<string, number>();
            for (const o of parts.objects.objects) h.set(dbgName(o), (h.get(dbgName(o)) ?? 0) + 1);
            console.warn(`objects: ${[...h].map(([k, v]) => `${k}x${v}`).join(', ')}`);
        }
        if (dbgEnv['DRAKAN_DBG_CLSINFO']) {
            // Test aid: how the classes whose name matches the regex were mapped (template, model, fields kept).
            const re = new RegExp(dbgEnv['DRAKAN_DBG_CLSINFO'], 'i');
            for (const s of plan?.synthesized ?? []) {
                if (!re.test(s.name)) continue;
                console.warn(
                    `CLSINFO ${s.name} -> ${s.file}#${s.classId} rfl=${s.rfl} template="${s.template.name}"#${s.template.classId} model=${JSON.stringify(s.cls.model)} cov=${s.coverage.toFixed(2)} tskin=${(() => {
                        const o = ps2Odbs.find((x) => x.dbIndex === s.template.dbIndex);
                        const tc = o?.classes.get(s.template.classId);
                        const st = tc?.model && o ? containerStem(o.file.replace(/\.ODB$/i, ''), tc.model.db) : null;
                        return !!tc?.model && !!st && !!modOf(st)?.find(0x0208, tc.model.id);
                    })()} flags=${(() => {
                        const bd = splitClassRecord(s.record).body;
                        return bd.length >= 10
                            ? new DataView(bd.buffer, bd.byteOffset, bd.byteLength).getUint32(6, true)
                            : -1;
                    })()} data=${s.cls.data?.join(',')}`,
                );
                if (dbgEnv['DRAKAN_DBG_CLSFIELDS'])
                    (s.cls.fields ?? []).forEach((f, i) =>
                        console.warn(`  F ${i} ${f.name} t=${f.type} v=${s.cls.data?.[i]}`),
                    );
            }
        }
        if (dbgEnv['DRAKAN_DBG_LISTCLS']) {
            // Test aid: histogram of the placed objects' class names (after the other filters), to compare passing and failing splits.
            const h = new Map<string, number>();
            for (const o of parts.objects.objects) h.set(dbgName(o), (h.get(dbgName(o)) ?? 0) + 1);
            console.warn(
                `LISTCLS ${[...h]
                    .sort()
                    .map(([k, v]) => `${k}=${v}`)
                    .join('; ')}`,
            );
        }
        if (dbgEnv['DRAKAN_DBG_AT']) {
            // Test aid: DRAKAN_DBG_AT=<x>,<y>,<z> puts Rynn at that world position (terrain lookups pick the wrong layer on multi-layer levels).
            const [ax, ay, az] = dbgEnv['DRAKAN_DBG_AT'].split(',').map(Number);
            const rynn = parts.objects.objects.find(
                (o) => (classes.get(o.dbIndex)?.get(o.classId)?.rflClass ?? -1) === 9,
            );
            if (rynn && ax !== undefined && ay !== undefined && az !== undefined) rynn.pos = [ax, ay, az];
        }
        if (dbgEnv['DRAKAN_DBG_PULL']) {
            // Test aid: move up to 4 objects whose class name matches the regex next to the player start.
            const re = new RegExp(dbgEnv['DRAKAN_DBG_PULL'], 'i');
            const rflOf = (o: LvlObject): number => classes.get(o.dbIndex)?.get(o.classId)?.rflClass ?? -1;
            const found = parts.objects.objects.find((o) => rflOf(o) === 9);
            // DRAKAN_DBG_PULLAT=x,y,z centres the ring there instead of on the PC start object (the PS2 player can start elsewhere,
            // e.g. mounted on a dragon: read her position from a world dump).
            const at = (dbgEnv['DRAKAN_DBG_PULLAT'] ?? '').split(',').map(Number);
            const start =
                at.length === 3 && at.every(Number.isFinite)
                    ? ({ pos: [at[0]!, at[1]!, at[2]!] } as {
                          pos: typeof found extends undefined ? never : NonNullable<typeof found>['pos'];
                      })
                    : found;
            let n = 0;
            const pulled = new Set<number>();
            const slotOf = (o: LvlObject): number => (pullArr ? pullArr.indexOf(o.id) : n - 1);
            // DRAKAN_DBG_PULLDIST=<d>,<dy>: ring distance (default 1200) and height offset (default 0) of the pulled objects.
            const [pd, pdy] = (dbgEnv['DRAKAN_DBG_PULLDIST'] ?? '1200,0').split(',').map(Number);
            if (start)
                parts.objects = {
                    ...parts.objects,
                    objects: parts.objects.objects.map((o) =>
                        n < (pullIds ? 8 : 4) &&
                        re.test(dbgName(o)) &&
                        pullIdOk(o) &&
                        (n++,
                        pulled.add(o.id),
                        console.warn(
                            `pull ${dbgName(o)} obj ${o.id} rot=${o.rot.map(Math.round)} from ${o.pos.map(Math.round)}${dbgEnv['DRAKAN_DBG_PULLP'] ? ` r=${o.radius} flags=${o.flags.toString(16)} links=${o.links} ` + o.params.map((p, i) => `${p.name}=${o.data[i]}`).join(' ') : ''}`,
                        ),
                        true)
                            ? {
                                  ...o,
                                  // DRAKAN_DBG_PULLROT=<deg> adds degrees to the pulled objects' yaw (rot[1]); a door seen face-on shows its swing.
                                  rot: [
                                      o.rot[0],
                                      o.rot[1] + Number(dbgEnv['DRAKAN_DBG_PULLROT'] ?? 0),
                                      o.rot[2],
                                  ] as typeof o.rot,
                                  // DRAKAN_DBG_PULLFLAGS=<hex> ORs object flags (1 = the PC "visible" bit): objects of flags 0 start hidden.
                                  flags: o.flags | Number.parseInt(dbgEnv['DRAKAN_DBG_PULLFLAGS'] ?? '0', 16),
                                  pos: [
                                      start.pos[0] + [pd!, -pd!, 0, 0][slotOf(o) % 4]! * (1 + (slotOf(o) >> 2) * 0.5),
                                      start.pos[1] + (pdy ?? 0),
                                      start.pos[2] + [0, 0, pd!, -pd!][slotOf(o) % 4]! * (1 + (slotOf(o) >> 2) * 0.5),
                                  ] as typeof o.pos,
                              }
                            : o,
                    ),
                };
            // DRAKAN_DBG_PULLSET=<field>=<int>;... sets fields of the pulled objects (added when the object leaves the field at
            // its class default), e.g. "Initial Health=1" so the harness can kill a creature with one blow and watch it die.
            const sets = (dbgEnv['DRAKAN_DBG_PULLSET'] ?? '').split(';').flatMap((kv) => {
                const at = kv.lastIndexOf('=');
                return at > 0 ? [{ name: kv.slice(0, at), value: Number(kv.slice(at + 1)) }] : [];
            });
            for (const o of sets.length ? parts.objects.objects : []) {
                if (!pulled.has(o.id)) continue;
                const fields = classes.get(o.dbIndex)?.get(o.classId)?.fields;
                const specs = objectParamSpecs(o);
                for (const { name, value } of sets) {
                    const have = specs.find((sp) => sp.name === name);
                    const i = fields?.findIndex((f) => f.name === name) ?? -1;
                    if (have) have.value = value;
                    else if (i >= 0) specs.push({ fieldIndex: i, type: fields![i]!.type, name, value });
                }
                setObjectParams({ objects: [o], warnings: [] }, o.id, specs);
            }
        }
        if (dbgEnv['DRAKAN_DBG_LINKADD']) {
            // Test aid: DRAKAN_DBG_LINKADD=<from>><to>,... adds link-target ids (object ids as DRAKAN_DBG_LINKS prints them), e.g. a switch to a door.
            for (const pair of dbgEnv['DRAKAN_DBG_LINKADD'].split(',')) {
                const [from, to] = pair.split('>').map(Number);
                const o = parts.objects.objects.find((x) => x.id === from);
                if (o && to !== undefined && !o.links.includes(to)) o.links = [...o.links, to];
            }
        }
        const lf = Number(
            (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.[
                'DRAKAN_TERRAIN_LAYERFLAGS'
            ] ?? 0,
        );
        if (lf) parts.terrain = parts.terrain.map((L) => ({ ...L, flags: L.flags | lf }));
        res.levels.push({
            pcPath: pc.path,
            title,
            arena: isOotfArenaLevel(pc),
            parts,
            // The level's own far textures (one per terrain group); the template's drew Surdana's colours and its magenta
            // filler on distant converted terrain (journal 2026-11-08/ootf-pink-textures.md).
            splats: tex
                ? { TXD: tex.txd }
                : terrBuilder
                  ? { TXD: buildTerrainPoolTxd(parts.terrain, (r) => terrBuilder.meanOfRef(r)) }
                  : {},
        });
    }
    // The pack lists the levels in this order (mod.toml `levels`, whose first entry is the campaign start): play order,
    // not the order the caller passed them in (a directory listing is alphabetical).
    if (plan0) {
        const at = (l: OotfLevelOut): number =>
            plan0.byPath.get(normalizeLevelRef(l.pcPath))?.index ?? Number.MAX_SAFE_INTEGER;
        res.levels.sort((a, b) => at(a) - at(b));
        const sourceByPath = new Map(pcs.map((pc) => [normalizeLevelRef(pc.path), pc]));
        const startingInventory = carryStartingInventory(
            res.levels.flatMap((level) => {
                const source = sourceByPath.get(normalizeLevelRef(level.pcPath));
                return source && plan0.byPath.has(normalizeLevelRef(level.pcPath))
                    ? [
                          {
                              source,
                              target: {
                                  dependencies: level.parts.header.dependencies,
                                  objects: level.parts.objects,
                                  objectIdMap: level.parts.objectIdMap,
                              },
                          },
                      ]
                    : [];
            }),
            (object) =>
                classes.get(object.dbIndex)?.get(object.classId) ??
                plan?.synthesized.find((s) => s.dbIndex === object.dbIndex && s.classId === object.classId)?.cls,
        );
        res.warnings.push(...startingInventory.warnings);
        if (startingInventory.copied)
            res.warnings.push(
                `campaign starting inventory: ${startingInventory.copied} source item(s) linked to the synthetic opening player`,
            );
    }

    // ---- files
    if (terrBuilder) res.files[TERRAIN_TXD_PATH] = terrBuilder.build();
    res.assets = builder.report;
    res.ps2Models = { used: [...modelSwapsUsed.values()] };
    for (const u of modelSwapsUsed.values()) log(`drakan 2 model: ${u.ootf} -> ${u.ps2}`);
    if (ps2Subs) {
        const used = new Map<string, { ootf: string; ps2: string; label: string }>();
        const kept = new Map<string, string>();
        for (const r of [builder.report, ...[...crossBuilders.values()].map((c) => c.report)])
            for (const [ootf, u] of r.ps2Textures ?? []) {
                const label = ps2Subs.byOotf.get(ootf.toLowerCase())?.row.label ?? ootf;
                if (u.used) used.set(ootf.toLowerCase(), { ootf, ps2: u.ps2, label });
                else kept.set(ootf.toLowerCase(), u.reason ?? '');
            }
        res.ps2Textures = {
            used: [...used.values()],
            skipped: [
                ...ps2Subs.skipped.map((s) => ({ ootf: s.row.ootf, reason: s.reason })),
                ...[...kept].filter(([k]) => !used.has(k)).map(([ootf, reason]) => ({ ootf, reason })),
            ],
        };
        for (const u of used.values()) log(`drakan 2 texture: ${u.label} (${u.ootf} -> ${u.ps2})`);
        for (const [ootf, reason] of kept)
            if (!used.has(ootf)) res.warnings.push(`drakan 2 texture for ${ootf} not used: ${reason}`);
    }
    if (hostOk) {
        await stage('assets', async () => {
            const add = builder.entries(hostGroup);
            if (!add.models.length && !add.textures.length) return;
            const dir = `files/${hostDir}`;
            // Death clips of converted creatures must hold their last frame (see `holdLastFrame`).
            const oneShot = new Set(plan?.synthesized.flatMap((s) => deathClipIds(s.cls)) ?? []);
            const held = builder.holdLastFrame(oneShot);
            if (held) res.warnings.push(`creature clips: ${held} death clip(s) set to play once and hold`);
            const clips = builder.animEntries();
            if (clips.length) {
                // The clips ship to the host ADB and to the ADB of every ODB that got a cloned creature class (ids are free in all of them).
                const stems = new Set([hostStem]);
                for (const s of plan?.synthesized ?? []) {
                    const st = s.file.replace(/\.ODB$/i, '');
                    if (s.cls.model && adbOf(st)) stems.add(st);
                }
                for (const stem of stems) {
                    const adbR = adbOf(stem)!;
                    for (const r of clips) res.files[`new/${stem}.ADB/${hex4(r.type)}_${r.id}_${r.sub}.bin`] = r.data;
                    // 0x0500: u16 clip count, u16 ?, u16 highest id + 1 (NPCS.ADB 1861 clips / 5990, RESOURES.ADB 23).
                    const hc = adbR ? adbR.entries.find((e) => e.type === 0x0500) : undefined;
                    if (adbR && hc) {
                        const c = (await adbR.readRaw(hc)).slice();
                        const dv = new DataView(c.buffer);
                        const top = Math.max(...clips.map((r) => r.id)) + 1;
                        dv.setUint16(0, dv.getUint16(0, true) + clips.length / 2, true);
                        dv.setUint16(4, Math.max(dv.getUint16(4, true), top), true);
                        res.files[`overrides/${stem}.ADB/0500_${hc.id}_${hc.sub}.bin`] = c;
                    }
                }
            }
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
    if (crossBuilders.size) {
        await stage('template ODB assets', async () => {
            for (const [stem, cb] of crossBuilders) {
                const hf = ps2.hostFiles!.get(stem)!;
                const dir = ps2.dbFiles?.get(stem)?.dir;
                const grp = hf.mod.entries.find((e) => e.type === 0x0200)?.sub ?? 1;
                const add = cb.entries(grp);
                if (!dir || !add.models.length) continue;
                const modEntries: Ps2Entry[] = [];
                for (const e of hf.mod.entries) {
                    let data = await hf.mod.readRaw(e);
                    if (e.type === 0x0202 && data.length >= 6) {
                        data = data.slice();
                        const dv = new DataView(data.buffer);
                        dv.setUint16(4, Math.max(add.lastModelId, dv.getUint16(4, true)), true);
                    }
                    modEntries.push({ type: e.type, id: e.id, sub: e.sub, data });
                }
                res.files[`files/${dir}/${stem}.MOD`] = writePs2Srsc([...modEntries, ...add.models]);
                const txdEntries: Ps2Entry[] = [];
                for (const e of hf.txd.entries)
                    txdEntries.push({ type: e.type, id: e.id, sub: e.sub, data: await hf.txd.readRaw(e) });
                res.files[`files/${dir}/${stem}.TXD`] = writePs2Srsc([...txdEntries, ...add.textures]);
                res.warnings.push(
                    `template ODB ${stem}: ${cb.report.models.converted} models, ${cb.report.textures.converted} textures added to its own MOD / TXD`,
                );
            }
        });
    }
    if (levelMaps.size) {
        await stage('level map textures', async () => {
            const first = [...levelMaps.values()][0]!;
            const stem = first.synth.file.replace(/\.ODB$/i, '');
            const dir = ps2.dbFiles?.get(stem)?.dir;
            const hf = ps2.hostFiles?.get(stem);
            if (!dir || !hf) {
                res.warnings.push(`level maps: ${stem} has no own TXD to hold the pictures; levels keep the template's map`);
                for (const v of levelMaps.values()) v.synth.cls = { ...v.synth.cls };
                return;
            }
            const path = `files/${dir}/${stem}.TXD`;
            const base = res.files[path] ? await SrscReader.fromBytes(res.files[path]!) : hf.txd;
            const entries: Ps2Entry[] = [];
            for (const e of base.entries) entries.push({ type: e.type, id: e.id, sub: e.sub, data: await base.readRaw(e) });
            let next = maxId(base, 0x0040) + 1;
            for (const v of levelMaps.values()) {
                const tex = encodePs2Texture(mapTextureImage(v.spec.image), {
                    mode: 'truecolor',
                    maxTruecolorPixels: Infinity,
                    square: true,
                });
                entries.push({ type: 0x0040, id: next, sub: 0, data: tex.body });
                res.warnings.push(...setSynthesizedDefaults(v.synth, [['Map Texture', next]]));
                next++;
            }
            res.files[path] = writePs2Srsc(entries);
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
    Object.assign(res.files, await player.files());
    return res;
}

/**
 * Retargets the PC clips converted scenes play on the player onto the PS2 player rig (`OotfPs2Context.playerMod`), as new
 * clips of the player's ADB with fresh ids past its own (SYSTEM.ADB: 615 clips, ids up to 2306). The PC Rynn (33 joints) is a
 * subset by name of the PS2 Rynn (65 joints: face, fingers and sheaths added), so every PC joint finds its PS2 joint; the
 * extra joints keep their bind pose. A clip is converted once even when several levels play it.
 */
function playerClipBuilder(ps2: OotfPs2Context) {
    const stem = (ps2.playerStem ?? 'SYSTEM').toUpperCase();
    const mod = ps2.playerMod;
    const adb = ps2.playerAdb;
    let skeleton: Skeleton | null | undefined;
    // The skeleton every Rynn of SYSTEM.MOD shares: the character record with root joint `wrynn` and the most joints.
    const ps2Rig = async (): Promise<Skeleton | null> => {
        if (skeleton !== undefined) return skeleton;
        let best: Skeleton | null = null;
        for (const e of mod?.entries ?? []) {
            if (e.type !== MOD_CHARACTER) continue;
            try {
                const sk = parseSkeleton(await mod!.readRaw(e), 'ps2');
                if (buildRig(sk, 0).names[0]?.toLowerCase() !== 'wrynn') continue;
                if (!best || sk.joints.length > best.joints.length) best = sk;
            } catch {
                // not a character record of this layout
            }
        }
        skeleton = best;
        return skeleton;
    };
    let nextId = (adb?.entries ?? []).reduce((m, e) => (e.type === 0x0501 ? Math.max(m, e.id) : m), 0) + 1;
    const done = new Map<string, number>();
    const entries: { id: number; info: Uint8Array; data: Uint8Array }[] = [];
    return {
        get rig(): boolean {
            return !!mod && !!adb;
        },
        /** PC channel -> PS2 channel by joint name (after `add`, which loads the PS2 rig). */
        channelMap(pcSkeleton: Skeleton): Map<number, number> | undefined {
            if (!skeleton) return undefined;
            return skeletonChannelMap(pcSkeleton, buildRig(pcSkeleton, 0).names, skeleton, buildRig(skeleton, 0).names);
        },
        /** Convert (once per source model and clip) the given PC clip refs; returns PC clip id -> new player ADB id. */
        async add(
            sourceKey: string,
            source: { skeleton: Skeleton; anims: Map<number, PcAnim> },
            refs: ReadonlySet<number>,
        ): Promise<{ map: Map<number, number>; warnings: string[] }> {
            const map = new Map<number, number>();
            const warnings: string[] = [];
    // The finger joints the PC Rynn lacks take the grip of a native armed clip (first key), so a scene sword is held.
    const GRIP_CLIPS = ['a_randomidle', 'a_1handedrmub', 'ncidle2magic_sword'];
    let grip: Map<number, [number, number, number, number]> | undefined;
    const fingerGripPose = async (sk: Skeleton, names: readonly string[]) => {
        if (grip) return grip;
        grip = new Map();
        if (!adb) return grip;
        const fingers = names.flatMap((n, d) => (/^[lr]_(th|point|middle|ring)/i.test(n) ? [d] : []));
        for (const want of GRIP_CLIPS) {
            for (const id of sk.animIds) {
                const info = adb.find(0x0501, id);
                const data = adb.find(0x0502, id);
                if (!info || !data) continue;
                const raw = await adb.readRaw(info);
                if (animName(raw).toLowerCase() !== want) continue;
                try {
                    const a = parsePs2Anim(raw, await adb.readRaw(data));
                    for (const d of fingers) {
                        const k = a.tracks[d]?.keys[0];
                        if (k) grip.set(d, [k.q[0], k.q[1], k.q[2], k.q[3]]);
                    }
                } catch {
                    // not a clip of this rig
                }
                if (grip.size) return grip;
            }
        }
        return grip;
    };
            const sk = await ps2Rig();
            if (!sk || !adb) return { map, warnings: ['no PS2 player rig'] };
            const todo = new Map<number, PcAnim>();
            for (const ref of refs) {
                const id = ref & 0xffff;
                const have = done.get(`${sourceKey}|${id}`);
                if (have !== undefined) map.set(id, have);
                else if (source.anims.has(id)) todo.set(id, source.anims.get(id)!);
                else warnings.push(`clip 0x${id.toString(16)} is not a clip of the PC player model`);
            }
            if (!todo.size) return { map, warnings };
            // Held items keep the PC hand frames (the PS2 Rynn's Rweapon is turned about 104 degrees from the PC one).
            const names = buildRig(sk, 0).names;
            const worldJoints = names.flatMap((n, d) => (/^[lr]weapon$/i.test(n) ? [d] : []));
            const holdPose = await fingerGripPose(sk, names);
            const r = retargetCreature(source.skeleton, sk, todo, { worldJoints, holdPose });
            for (const a of r.anims) {
                const id = nextId++;
                const w = writePs2Anim(a.anim);
                entries.push({ id, info: w.info, data: w.data });
                done.set(`${sourceKey}|${a.id}`, id);
                map.set(a.id, id);
            }
            for (const x of r.skipped)
                warnings.push(`clip 0x${x.id.toString(16)} (${x.name}) not retargeted: ${x.why}`);
            return { map, warnings };
        },
        /** `new/<stem>.ADB/` clip entries and the ADB header override (clip count, highest id + 1). */
        async files(): Promise<Record<string, Uint8Array>> {
            const out: Record<string, Uint8Array> = {};
            if (!adb || !entries.length) return out;
            for (const e of entries) {
                out[`new/${stem}.ADB/0501_${e.id}_0.bin`] = e.info;
                out[`new/${stem}.ADB/0502_${e.id}_0.bin`] = e.data;
            }
            // 0x0500: u16 clip count, u16 ?, u16 highest id + 1 (SYSTEM.ADB 615 / 2307), as for the host ADB.
            const hc = adb.entries.find((e) => e.type === 0x0500);
            if (hc) {
                const c = (await adb.readRaw(hc)).slice();
                const dv = new DataView(c.buffer);
                dv.setUint16(0, dv.getUint16(0, true) + entries.length, true);
                dv.setUint16(4, Math.max(dv.getUint16(4, true), Math.max(...entries.map((e) => e.id)) + 1), true);
                out[`overrides/${stem}.ADB/0500_${hc.id}_${hc.sub}.bin`] = c;
            }
            return out;
        },
    };
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
    // The sky is an object too (class 26 "Procedural Sky", db 11 in every PS2 level): without one the world has a plain
    // white backdrop and white distance fog. Every PC level has a "Sky" object, so clone the template's.
    const nameOf = (o: LvlObject): string | undefined => classes.get(o.dbIndex)?.get(o.classId)?.name;
    if (!list.objects.some((o) => nameOf(o) === 'Procedural Sky')) {
        const t = tpl.find((o) => nameOf(o) === 'Procedural Sky');
        if (t) list.objects.push(cloneObject(t, nextId++));
    }
    // Air arenas (Multiplayer/Air/*) are dragon fights: Rynn on foot has no floor. A Dragon object whose `Initial Mode` is 0
    // (Ravenshold's, the level where Rynn starts mounted) is placed at her start. Test aid DRAKAN_DBG_DRAGON=0|1 forces it.
    const dbgDragon = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.[
        'DRAKAN_DBG_DRAGON'
    ];
    if (
        (isOotfAirArenaLevel(pc) || dbgDragon === '1') &&
        dbgDragon !== '0' &&
        !list.objects.some((o) => rflOf(o) === 28)
    ) {
        const t = tpl.find((o) => rflOf(o) === 28);
        const rynn = list.objects.find((o) => rflOf(o) === 9);
        if (t && rynn) {
            const d = cloneObject(t, nextId++);
            d.pos = [rynn.pos[0], rynn.pos[1], rynn.pos[2]];
            d.rot = [...rynn.rot];
            list.objects.push(d);
            const specs = objectParamSpecs(d).map((s) => (/^Initial Mode/.test(s.name) ? { ...s, value: 0 } : s));
            setObjectParams(list, d.id, specs);
        }
    }
}

export type { ConversionReport };

/** Dragon.rrc strings of the install (`<0xNNNN>` references), empty when the file is missing or unreadable. */
async function loadRrcStrings(
    src: PcFileSource,
): Promise<{ path: string | null; others: string[]; strings: Map<number, string> }> {
    const { path, others } = pickRrcPath(await src.list());
    try {
        const bytes = path ? await src.read(path) : null;
        return { path, others, strings: bytes ? await parseRrcStrings(await SrscReader.fromBytes(bytes)) : new Map() };
    } catch {
        return { path, others, strings: new Map() };
    }
}

/**
 * The language of an install, from its Dragon.rrc (the same detection the conversion logs). For the importer to show
 * "German install" as soon as a folder is chosen; never throws.
 */
export async function detectOotfInstallLanguage(
    src: PcFileSource,
): Promise<{ language: OotfLanguageGuess; rrcPath: string | null }> {
    const rrc = await loadRrcStrings(src);
    return { language: detectOotfLanguage(rrc.strings.values()), rrcPath: rrc.path };
}

/** Engine class of break-away floors: no class model; the pieces named by "Model List" make the intact floor. */
export const BREAKAWAY_RFL = 44;

/**
 * Break-away floors of a class plan that were cloned into a template ODB with its own MOD / TXD (`hosted(stem)`): each PC
 * class with that ODB's stem, once. Their "Model List" pieces must be converted into that MOD and named with db 0 there,
 * as the disc's floors do; a template ODB naming RESOURES models through its `.DB` hung level loads (ootf-props-audit.md 5).
 */
export function breakawayPieceHosts(
    plan: Pick<ClassPlan, 'synthesized'>,
    sourceOf: (pcKey: string) => OdbClass | undefined,
    hosted: (stem: string) => boolean,
): { stem: string; cls: OdbClass }[] {
    const out: { stem: string; cls: OdbClass }[] = [];
    for (const s of plan.synthesized) {
        if (s.rfl !== BREAKAWAY_RFL) continue;
        const stem = s.file.replace(/\.ODB$/i, '');
        if (!hosted(stem)) continue;
        for (const key of s.pcKeys) {
            const cls = sourceOf(key);
            if (cls && morphModelRefs(cls).length && !out.some((w) => w.cls === cls && w.stem === stem))
                out.push({ stem, cls });
        }
    }
    return out;
}

/** Model refs (`db << 16 | id`) named by the model-typed fields of a PC class (a Morph Plug's "Morphing Models"). */
export function morphModelRefs(cls: OdbClass): number[] {
    const out: number[] = [];
    (cls.fields ?? []).forEach((f, i) => {
        const dword = cls.data?.[i];
        if (fieldBase(f.type) !== FIELD_MODEL || dword === undefined) return;
        const refs = fieldIsIndirect(f.type) ? (decodeFieldValue(f.type, dword, cls.data ?? []) as number[]) : [dword];
        for (const r of refs) if (r && !out.includes(r)) out.push(r);
    });
    return out;
}

/** Class fields that start a creature's death; the clip they name ends lying down and must not loop. */
const DEATH_FIELDS: ReadonlySet<string> = new Set(['death', 'forward death', 'sleep death']);

/** Animation ids named by a class's death fields (`DEATH_FIELDS`). */
export function deathClipIds(cls: Pick<OdbClass, 'fields' | 'data'>): number[] {
    const out: number[] = [];
    cls.fields?.forEach((f, i) => {
        const dword = cls.data?.[i];
        if (dword === undefined || fieldBase(f.type) !== FIELD_ANIMATION) return;
        if (!DEATH_FIELDS.has(f.name.trim().toLowerCase())) return;
        const ids = fieldIsIndirect(f.type) ? (decodeFieldValue(f.type, dword, cls.data ?? []) as number[]) : [dword];
        for (const id of ids) if (id) out.push(id & 0xffff);
    });
    return out;
}

/**
 * Parameters that lay a creature placed dead (an `Initial Health` parameter of 0 or less) in its death pose: `Base Idle` = the
 * class's `Idle Death` clip, else its `Death` clip, and no spontaneous idles. Null when the object is not a placed corpse or the
 * class names no such clip.
 */
export function placedCorpsePose(
    o: Pick<LvlObject, 'params' | 'data'> & Partial<LvlObject>,
    cls: Pick<OdbClass, 'fields' | 'data'>,
): ParamSpec[] | null {
    const hp = o.params.findIndex((p) => p.name.trim() === 'Initial Health');
    if (hp < 0 || (o.data[hp]! | 0) > 0 || !cls.fields || !cls.data) return null;
    const clipOf = (name: string): number => {
        const i = cls.fields!.findIndex((f) => f.name.trim() === name && fieldBase(f.type) === FIELD_ANIMATION);
        if (i < 0) return 0;
        const f = cls.fields![i]!;
        const v = fieldIsIndirect(f.type)
            ? (decodeFieldValue(f.type, cls.data![i]!, cls.data!) as number[])[0]
            : cls.data![i];
        return v ?? 0;
    };
    const clip = clipOf('Idle Death') || clipOf('Death');
    const idle = cls.fields.findIndex((f) => f.name.trim() === 'Base Idle' && fieldBase(f.type) === FIELD_ANIMATION);
    if (!clip || idle < 0) return null;
    const specs = objectParamSpecs(o as LvlObject).filter(
        (sp) => sp.name.trim() !== 'Base Idle' && sp.name.trim() !== 'Spontaneous Idle Anims',
    );
    specs.push({ fieldIndex: idle, type: cls.fields[idle]!.type, name: cls.fields[idle]!.name, value: clip });
    const spont = cls.fields.findIndex((f) => f.name.trim() === 'Spontaneous Idle Anims');
    if (spont >= 0 && fieldIsIndirect(cls.fields[spont]!.type))
        specs.push({ fieldIndex: spont, type: cls.fields[spont]!.type, name: cls.fields[spont]!.name, value: [] });
    return specs;
}
