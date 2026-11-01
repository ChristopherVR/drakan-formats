// Order of the Flame (PC) classes -> PS2 engine classes.
//
// The PC and PS2 engines share the numbering of the engine ("RFL") classes: the `rfl_class_id` of a PC class record is
// the low 16 bits of the runtime class id of the PS2 record (docs/reference/level-format.md section 9) and every PS2
// engine class has exactly one field list (checked on all 171 engine classes of the PAL ODBs). A PC class that has no
// same-named PS2 class can therefore be *re-targeted*: a new PS2 class record is cloned from a PS2 class of the same
// engine id (same field list, same model block) and its defaults are overwritten with the PC defaults, by field name and
// type. Nothing in the clone refers to a PC resource id. Findings and census: docs/journal/2026-10-31/ootf-classes.md.
//
// Added records ship as `new/<FILE>.ODB/0102_<id>_<sub>.bin` plus a replaced 0x0103 field-list entry (modding.md).

import {
    FIELD_ANIMATION,
    FIELD_CHANNEL,
    FIELD_COLOUR,
    FIELD_ENUM,
    FIELD_FLOAT,
    FIELD_INT,
    FIELD_LAYER,
    FIELD_STRING,
    decodeFieldValue,
    fieldBase,
    fieldIsArray,
    fieldIsIndirect,
    stringToWords,
    type ClassFieldDef,
    type ClassFieldValue,
} from './fields.ts';
import type { ClassTarget } from './convert.ts';
import { view } from './bytes.ts';
import type { ParamSpec } from './lvl.ts';
import { ODB_CLASS_TYPE, ODB_FIELDS_TYPE, type OdbClass } from './odb.ts';
import { appendFieldList, joinClassRecord, splitClassRecord } from './odbwrite.ts';

// ---------------------------------------------------------------- engine class catalogue

/**
 * What a class does, for deciding how a PC class can be carried over.
 * `logic` = trigger / script / message classes, `mechanism` = interactive props (doors, switches, lifts), the rest as named.
 */
export type ClassKind =
    | 'logic'
    | 'light'
    | 'sound'
    | 'waypoint'
    | 'spawn'
    | 'fx'
    | 'scenery'
    | 'mechanism'
    | 'creature'
    | 'item'
    | 'weapon'
    | 'player'
    | 'system'
    | 'mp';

export interface EngineClassInfo {
    rfl: number;
    name: string;
    kind: ClassKind;
}

/**
 * Engine classes placed in the 23 OotF levels (80 ids). Names: OpenDrakan's class list where it has one, else the
 * dominant PC/PS2 class name and group of that id. The kind is a judgement from names, fields and PS2 usage.
 */
const ENGINE_LIST: readonly [number, string, ClassKind][] = [
    [6, 'Looping/Triggered Sound', 'sound'],
    [7, 'Count Down To Zero', 'logic'],
    [9, 'Rynn (Human Control)', 'player'],
    [10, 'Health Potion', 'item'],
    [13, 'Switch / Lever / Button', 'mechanism'],
    [14, 'Melee Weapon', 'weapon'],
    [15, 'Ladder', 'scenery'],
    [16, 'Rigid Body (boulder, barrel)', 'scenery'],
    [17, 'Ground Object / Building', 'scenery'],
    [18, 'Rynn Launch Pad (multiplayer spawn)', 'mp'],
    [19, 'Door / Gate', 'mechanism'],
    [20, 'Flame / Particle Emitter', 'fx'],
    [26, 'Sky', 'system'],
    [27, 'Tracking Camera', 'system'],
    [28, 'Dragon (player mount)', 'player'],
    [29, 'Pressure Plate', 'mechanism'],
    [30, 'Dragon (creature)', 'creature'],
    [33, 'Key / Quest Item', 'item'],
    [34, 'Key Lock', 'mechanism'],
    [35, 'Mover / Elevator Platform', 'mechanism'],
    [37, 'Ballista / Turret', 'creature'],
    [39, 'Arrow / Ammunition', 'weapon'],
    [40, 'Spider', 'creature'],
    [41, 'Scavenger', 'creature'],
    [43, 'Burning Flame / Kill Box', 'fx'],
    [44, 'Break-away Floor', 'mechanism'],
    [45, 'Armor', 'item'],
    [49, 'Orc / Troll / Slave', 'creature'],
    [51, 'STOMP Player (cut scene)', 'logic'],
    [53, 'Land Morph / Earthquake', 'logic'],
    [54, 'Level Properties', 'system'],
    [55, 'Level Transition', 'logic'],
    [57, 'Dragon Power-up', 'item'],
    [59, 'Giant', 'creature'],
    [61, 'Detector (trigger volume)', 'logic'],
    [62, 'Timer', 'logic'],
    [63, 'Generator (spawner)', 'spawn'],
    [65, 'Ambient Creature (birds, bats, fish)', 'creature'],
    [66, 'Tuiri', 'creature'],
    [68, 'Knight', 'creature'],
    [71, 'Power FX (particles)', 'fx'],
    [72, 'Null Marker / Attractor', 'waypoint'],
    [73, 'Rope / Cable', 'mechanism'],
    [74, 'Energy Door / Force Field', 'mechanism'],
    [78, 'Object Grouper', 'logic'],
    [79, 'Bow', 'weapon'],
    [80, 'Quickening Effect', 'fx'],
    [82, 'Death Mage', 'creature'],
    [83, 'Stomp FX / Moving Particles', 'fx'],
    [86, 'Soul Crystal (Master of the Dragon)', 'mp'],
    [88, 'Goblin', 'creature'],
    [89, 'Magic Potion', 'item'],
    [91, 'Magic Crystal', 'item'],
    [92, 'Dr. Evil', 'creature'],
    [97, 'Weather (rain, snow)', 'fx'],
    [99, 'Morph Plug', 'scenery'],
    [100, 'Succubus', 'creature'],
    [101, 'The Queen', 'creature'],
    [104, 'Map Object / Map Trigger', 'logic'],
    [111, 'Air / Water Current', 'logic'],
    [112, 'Waypoint', 'waypoint'],
    [116, 'EAX Preset (sound environment)', 'sound'],
    [117, 'Quest Item (Belhammer)', 'item'],
    [120, 'Multiplayer Power-up', 'mp'],
    [121, 'Visibility Toggler', 'logic'],
    [123, 'Combination Lock', 'logic'],
    [126, 'Dragon Invulnerability (multiplayer)', 'mp'],
    [127, 'DragonLaunch Pad (multiplayer spawn)', 'mp'],
    [128, 'Red Dragon Launch Pad (multiplayer)', 'mp'],
    [129, 'Music Trigger', 'sound'],
    [130, 'Pirate Ship', 'scenery'],
    [131, 'Ambient Sound Transition', 'sound'],
    [132, 'Static (Vertex) Light', 'light'],
    [133, 'Dynamic (Vertex) Light', 'light'],
    [134, 'Sparkle / Particle Spawner', 'fx'],
    [136, 'Fader', 'logic'],
    [137, 'Class Messenger', 'logic'],
    [138, 'Health Power-up', 'item'],
    [141, 'GUI Builder / Changer / Getter', 'logic'],
    [143, 'Sky / Fog Changer', 'logic'],
    [144, 'Water Droplet', 'fx'],
];

export const ENGINE_CLASSES: ReadonlyMap<number, EngineClassInfo> = new Map(
    ENGINE_LIST.map(([rfl, name, kind]) => [rfl, { rfl, name, kind }]),
);

export function engineClassInfo(rfl: number): EngineClassInfo | undefined {
    return ENGINE_CLASSES.get(rfl);
}

/** Kinds whose PC classes can be re-targeted without any PC model (the clone keeps the PS2 template's model block). */
/** Goblin 88 -> Orc 49, Succubus 100 / Queen 101 -> flying creature 30, Magic Crystal 91 -> mana power-up 171, ... */
export const PS2_SUBSTITUTES: ReadonlyMap<number, number> = new Map([
    [88, 49],
    [100, 30],
    [101, 30],
    [91, 171],
    [80, 71],
    [123, 223],
    [137, 224],
    [130, 35],
    [120, 10],
]);

export const RETARGET_KINDS: ReadonlySet<ClassKind> = new Set(['logic', 'light', 'sound', 'waypoint', 'spawn']);

// ---------------------------------------------------------------- inputs

/** A class used by the PC level(s): `db` is the PC dependency index, `cls` the parsed PC record (pc.ts). */
export interface PcClassIn {
    db: number;
    id: number;
    cls: OdbClass;
}

/** One PS2 ODB reachable from the template level's dependency table. */
export interface Ps2OdbIn {
    /** Index in the template level's dependency table (what objects store as `db_index`). */
    dbIndex: number;
    /** Container file name, e.g. `FX.ODB` (upper case; used for the `new/<FILE>/` paths). */
    file: string;
    classes: ReadonlyMap<number, OdbClass>;
    /** The raw 0x0102 payload of a class (needed to clone classes that carry a model block). */
    raw?: (classId: number) => Uint8Array | undefined;
    /** SRSC `sub` of a class (group id). */
    group?: (classId: number) => number | undefined;
    /** The 0x0103 entry as stored (zlib) with its SRSC key; needed by `buildClassEntries`. */
    fieldLists?: { id: number; sub: number; stored: Uint8Array };
}

export interface PlanOptions {
    /** Classes of these kinds may also be cloned *with the PS2 template's model* (a stand-in: creatures show a PS2 model). Default none. */
    borrowModelKinds?: ReadonlySet<ClassKind>;
    /** Minimum share of the PC class's value fields that exist in the PS2 schema (default 0.5). */
    minCoverage?: number;
    /** Class-typed defaults (type 3): PC ref (`db << 16 | id`) -> PS2 ref, or null to keep the template's. Default keep. */
    mapClassRef?: (pcRef: number) => number | null;
    /** Class ids that must not be handed out, per ODB file (e.g. ids already used by other mods). */
    reservedIds?: ReadonlyMap<string, ReadonlySet<number>>;
    /**
     * Classes that need a model (scenery, mechanisms, creatures ...) are cloned from a PS2 class of the same engine id
     * *with a model* and get the model this returns: `(PC class, target ODB file) -> {id, db}` (`db` = index in that ODB's
     * `.DB`, `id` in the container it names), or null when the PC model was not converted.
     */
    /**
     * Engine ids the PS2 engine lacks -> the PS2 engine id whose class is cloned instead (ootf-engine-gaps.md section 5).
     * Substituted classes keep the PS2 template's model (a stand-in) and use the field-name merge; `PS2_SUBSTITUTES` is the table.
     */
    substituteEngineId?: ReadonlyMap<number, number>;
    /** Called on the merged defaults of a clone: rewrite string defaults to XDB ids (`rewriteClassTextDefaults`). */
    rewriteText?: (odbFile: string, fields: readonly ClassFieldDef[], data: number[]) => void;
    /** With `modelFor`: only clone model classes from this ODB file (`RESOURES.ODB`), the one whose own MOD / TXD gets the new models. */
    modelOdbFile?: string;
    /**
     * More ODB files whose classes may be cloned for a converted model: ODBs that list `modelOdbFile` in their `.DB`, so
     * `modelFor` can name the model with that dependency's `db` index (NPCS.ODB lists Resources as dependency 2).
     */
    modelOdbFiles?: ReadonlySet<string>;
    /** True for a PC class that must not be name-mapped to a same-named PS2 class (its converted skinned model is cloned instead). */
    keepOwnModel?: (cls: OdbClass) => boolean;
    modelFor?: (cls: OdbClass, odbFile: string) => { id: number; db: number } | null;
    /**
     * Animation-typed defaults (type 9, scalar or array) of a class whose model was converted with its own clips: PC animation id
     * -> the clip's id in the host ADB (`OotfAssetBuilder.mapAnimRef`), or null/undefined to keep the template's value.
     * Returns undefined for classes without converted clips.
     */
    mapAnimFor?: (cls: OdbClass) => ReadonlyMap<number, number> | undefined;
    /**
     * Skinned models need a skinned template: a class whose model has no skeleton fails the level load (-6, ootf-skinned-creatures.md).
     * `modelSkinned(pcClass)` says the PC class's converted model is skinned, `templateSkinned(ps2Class)` that a PS2 class's model is.
     * With both, a skinned class is cloned from the skinned templates when there are any.
     */
    modelSkinned?: (cls: OdbClass) => boolean;
    templateSkinned?: (cls: OdbClass, odbFile: string) => boolean;
    /** Joint count of a PS2 class's skeleton model / of a PC class's converted skinned model (undefined: not skinned). */
    templateJoints?: (cls: OdbClass, odbFile: string) => number | undefined;
    modelJoints?: (cls: OdbClass) => number | undefined;
    /** The 64 byte 0x0208 bounds block of a converted skinned model (new id); the class record caches a copy of it (body 16..80). */
    modelBounds?: (modelId: number) => Uint8Array | undefined;
}

// ---------------------------------------------------------------- plan

export type UnsupportedReason =
    | 'no-engine-class' // the PS2 engine has no class with this id (or no ODB reachable from the template has one)
    | 'needs-model' // scenery, creature, item ...: a clone would be invisible or a wrong model
    | 'low-coverage' // the PS2 field list shares too little with the PC class
    | 'no-free-id' // the target ODB has no free class id inside its id range
    | 'no-raw-record'; // the template has a model block and its raw record was not supplied

export interface Unsupported {
    reason: UnsupportedReason;
    detail: string;
}

export interface Synthesized {
    /** `${db}:${id}` of every PC class folded into this record (identical result). */
    pcKeys: string[];
    name: string;
    /** ODB the record is added to (the template's, so model and class refs keep their meaning). */
    file: string;
    dbIndex: number;
    classId: number;
    group: number;
    rfl: number;
    /** The cloned class. */
    template: { dbIndex: number; classId: number; name: string };
    /** The 0x0102 payload. */
    record: Uint8Array;
    /** The parsed result (fields = the template's, data = merged defaults), usable as `ClassTarget.cls`. */
    cls: OdbClass;
    /** Field names whose default came from the PC class. */
    copied: string[];
    /** PC fields that were not carried (no same-named PS2 field, or a resource reference). */
    skipped: string[];
    /** Share of the PC value fields found in the PS2 schema. */
    coverage: number;
}

export interface ClassPlan {
    /** `${db}:${id}` -> existing PS2 class of the same name and engine id. */
    mapped: Map<string, ClassTarget>;
    synthesized: Synthesized[];
    unsupported: Map<string, Unsupported>;
    /** Resolve a PC class to its PS2 target (mapped or synthesized), null when unsupported. */
    resolve(db: number, id: number): ClassTarget | null;
}

const squash = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '');

/**
 * PC creature classes whose PS2 counterpart has another name (squashed PC name -> squashed PS2 name). Same creature, same rig:
 * the PS2 calls the PC trolls LeatherWartock / ChainTock / PlateTock and the PC orcs by colour. Used as a fallback after the
 * same-name lookup, so `keepOwnModel` / retarget see the PS2 class and its rig. Goblins have no PS2 class (engine id 88).
 */
export const PC_CLASS_ALIASES: ReadonlyMap<string, string> = new Map(
    (
        [
            ['Troll Leather', 'LeatherWartock : Center'],
            ['Troll Leather defense side atta', 'LeatherWartock : Flank'],
            ['Troll Chain', 'ChainTock : Center'],
            ['Troll Chain defense side attack', 'ChainTock : Flank'],
            ['Troll Plate', 'PlateTock : Center'],
            ['Troll Plate defense side attack', 'PlateTock : Flank'],
            ['Orc Leather (purple)', 'Purple Orc Center'],
            ['Orc Plate (yellow)', 'Yellow Orc : Center'],
            ['War Giant', 'Primitive Giant'],
            ['starving wargiant', 'Primitive Giant'],
        ] as const
    ).map(([pc, ps2]) => [squash(pc), squash(ps2)] as const),
);
/** The squashed PS2 name the PC class `name` is an alias of, or its own squashed name. */
export const aliasSquash = (name: string): string => PC_CLASS_ALIASES.get(squash(name)) ?? squash(name);
export const pcClassKey = (db: number, id: number): string => `${db}:${id}`;

/** Field types whose PC value is meaningful on PS2 (plain values). Everything else is a resource id of the PC data. */
function isValueField(type: number): boolean {
    const b = fieldBase(type);
    return (
        b === FIELD_INT ||
        b === FIELD_FLOAT ||
        b === FIELD_ENUM ||
        b === FIELD_COLOUR ||
        b === FIELD_STRING ||
        b === FIELD_LAYER ||
        b === 6
    );
}

const sameType = (a: number, b: number): boolean =>
    fieldBase(a) === fieldBase(b) && fieldIsArray(a) === fieldIsArray(b);

/** A converted clip id of the PC class to stand in for template clips that do not fit the converted rig: Base Idle, else the lowest. */
function animFallback(
    pf: readonly { name: string; type: number }[],
    data: readonly number[],
    animMap: ReadonlyMap<number, number>,
): number | undefined {
    const idle = pf.findIndex((f) => f.name === 'Base Idle' && fieldBase(f.type) === FIELD_ANIMATION && !fieldIsArray(f.type));
    const own = idle >= 0 ? animMap.get((data[idle] ?? 0) & 0xffff) : undefined;
    return own ?? [...animMap.values()].sort((a, b) => a - b)[0];
}

interface Merge {
    data: number[];
    copied: string[];
    skipped: string[];
    coverage: number;
    same: number;
}

/**
 * Overwrite the template's defaults with the PC class's, by field name and type. Strings and arrays append their new
 * payload at the end of the data area (the old payload stays, unused). Class-typed fields go through `mapClassRef`.
 */
export function mergeDefaults(
    pc: OdbClass,
    tpl: OdbClass,
    mapClassRef?: PlanOptions['mapClassRef'],
    animMap?: ReadonlyMap<number, number>,
    copyChannels = false,
    rigJoints?: number,
): Merge {
    const pf = pc.fields ?? [];
    const tf = tpl.fields ?? [];
    const out = [...(tpl.data ?? [])];
    const byName = new Map<string, number>();
    tf.forEach((f, i) => byName.set(f.name, i));
    const copied: string[] = [];
    const skipped: string[] = [];
    let valueFields = 0;
    let found = 0;
    let same = 0;
    // Template fields that the PC class did not supply still name the TEMPLATE rig's clips and joints.
    const convertedAnim = new Set<number>();
    const copiedChan = new Set<number>();
    pf.forEach((f, i) => {
        const isClassRef = fieldBase(f.type) === 3 && !fieldIsArray(f.type);
        const value = isValueField(f.type);
        if (value) valueFields++;
        const j = byName.get(f.name);
        const t = j === undefined ? undefined : tf[j];
        if (j === undefined || !t || !sameType(f.type, t.type)) {
            skipped.push(f.name);
            return;
        }
        if (value) found++;
        const dword = pc.data?.[i];
        if (dword === undefined) return;
        if (isClassRef) {
            const mapped = mapClassRef ? mapClassRef(dword) : null;
            if (mapped === null || mapped === undefined) {
                skipped.push(f.name);
                return;
            }
            out[j] = mapped >>> 0;
            copied.push(f.name);
            return;
        }
        if (copyChannels && fieldBase(f.type) === FIELD_CHANNEL) {
            // Channel fields (Head / Neck / Upper Body / Jaw / Weapon, Choppable and Dmg Inflicting lists) hold JOINT ids of the
            // model's rig. A converted PC model keeps its own joints, so the PC values apply; the template's belong to the PS2 rig.
            if (fieldIsIndirect(f.type)) {
                const words = decodeFieldValue(f.type, dword, pc.data ?? []) as number[];
                out[j] = ((words.length << 16) | out.length) >>> 0;
                out.push(...words);
            } else out[j] = dword;
            copiedChan.add(j);
            copied.push(f.name);
            return;
        }
        if (animMap && fieldBase(f.type) === FIELD_ANIMATION) {
            // The converted clips live in the host ADB under new ids; clips that did not convert keep the template's value.
            if (fieldIsIndirect(f.type)) {
                const words = (decodeFieldValue(f.type, dword, pc.data ?? []) as number[])
                    .map((w) => animMap.get(w & 0xffff))
                    .filter((w): w is number => w !== undefined);
                if (words.length === 0) {
                    skipped.push(f.name);
                    return;
                }
                out[j] = ((words.length << 16) | out.length) >>> 0;
                out.push(...words);
            } else {
                const n = animMap.get(dword & 0xffff);
                if (n === undefined) {
                    skipped.push(f.name);
                    return;
                }
                out[j] = n;
            }
            convertedAnim.add(j);
            copied.push(f.name);
            return;
        }
        if (!value) {
            skipped.push(f.name);
            return;
        }
        if (fieldIsIndirect(f.type)) {
            const v = decodeFieldValue(f.type, dword, pc.data ?? []);
            const words = typeof v === 'string' ? stringToWords(v) : (v as number[]);
            out[j] = ((words.length << 16) | out.length) >>> 0;
            out.push(...words);
        } else {
            if (out[j] === dword) same++;
            out[j] = dword;
        }
        copied.push(f.name);
    });
    if (copyChannels && rigJoints !== undefined)
        // Channel fields the PC class lacks keep the template's joint ids, which index the TEMPLATE's rig (Savage Leader's body
        // attachments name joints 42, 44 and 50 of a 55 joint rig). Past the converted rig's joint count they index outside the
        // creature's per-joint arrays and corrupt the heap (Volcanic hang at 0x4ac960, Rift Crystal wild jump): clamp to the root.
        tf.forEach((t, j) => {
            if (fieldBase(t.type) !== FIELD_CHANNEL || copiedChan.has(j)) return;
            const v = out[j] ?? 0;
            if (fieldIsIndirect(t.type)) {
                const n = v >>> 16;
                const off = v & 0xffff;
                for (let k = 0; k < n; k++) if ((out[off + k] ?? 0) >= rigJoints) out[off + k] = 0;
            } else if (v >= rigJoints) out[j] = 0;
        });
    const foreignAnim = animMap
        ? tf.map((_, j) => j).filter((j) => fieldBase(tf[j]!.type) === FIELD_ANIMATION && !convertedAnim.has(j))
        : [];
    if (animMap && foreignAnim.length) {
        // A clip is played on the model's skeleton by joint index: a clip with another track count than the converted rig has
        // (every clip the template names, 5100..5313 in Volcanic's Ebon Knight) does not fit it. Every such field gets a
        // converted clip of the PC class instead (its base idle, else any converted clip), which has the rig's track count.
        const fallback = animFallback(pf, pc.data ?? [], animMap);
        if (fallback !== undefined)
            for (const j of foreignAnim) {
                const v = out[j] ?? 0;
                if (fieldIsIndirect(tf[j]!.type)) {
                    const n = v >>> 16;
                    if (n === 0) continue;
                    out[j] = ((n << 16) | out.length) >>> 0;
                    for (let k = 0; k < n; k++) out.push(fallback);
                } else if ((v & 0xffff) !== 0) out[j] = fallback;
            }
    }
    return { data: out, copied, skipped, coverage: valueFields === 0 ? 1 : found / valueFields, same };
}

/**
 * Clone a PS2 class record with new defaults. The record head (group, model reference and model block, rfl id, icon,
 * field count) is kept byte for byte; the name and the data area are replaced.
 */
export function cloneClassRecord(raw: Uint8Array, name: string, data: readonly number[]): Uint8Array {
    const { body } = splitClassRecord(raw);
    const dv = view(body);
    const at = dv.getUint16(2, true) ? 86 : 22; // field count position (odb.ts parseClassBody)
    if (at + 8 > body.length) throw new Error('class record: body too short');
    const out = new Uint8Array(at + 8 + data.length * 4);
    out.set(body.subarray(0, at + 4), 0);
    const odv = view(out);
    odv.setUint32(at + 4, data.length, true);
    data.forEach((w, i) => odv.setUint32(at + 8 + i * 4, w >>> 0, true));
    return joinClassRecord(name, out);
}

/**
 * A model-less record built from nothing (10 zero bytes after the model reference, level-format.md section 12). Used by
 * the tests and as the fallback for templates without a raw record; real clones use `cloneClassRecord`.
 */
export function buildPlainClassRecord(opt: {
    name: string;
    group: number;
    rfl: number;
    icon: number;
    fieldCount: number;
    data: readonly number[];
}): Uint8Array {
    const body = new Uint8Array(30 + opt.data.length * 4);
    const dv = view(body);
    dv.setUint16(0, opt.group, true);
    dv.setUint16(16, opt.rfl, true);
    dv.setUint16(18, 1, true);
    dv.setUint16(20, opt.icon, true);
    dv.setUint32(22, opt.fieldCount, true);
    dv.setUint32(26, opt.data.length, true);
    opt.data.forEach((w, i) => dv.setUint32(30 + i * 4, w >>> 0, true));
    return joinClassRecord(opt.name, body);
}

/** Point a model-carrying class record at another model (`u16 id` at body +2, `u16 db` at +4). */
export function patchRecordModel(
    rec: Uint8Array,
    model: { id: number; db: number },
    bounds?: Uint8Array,
): Uint8Array {
    const { name, body } = splitClassRecord(rec);
    const b = body.slice();
    const dv = view(b);
    if (!dv.getUint16(2, true)) throw new Error(`class '${name}': record has no model block`);
    dv.setUint16(2, model.id, true);
    dv.setUint16(4, model.db, true);
    // The model block after the reference is a copy of the skeleton's 64 byte bounds (disc: identical for Scavenger 5055).
    if (bounds?.length === 64 && b.length >= 86) b.set(bounds, 16);
    return joinClassRecord(name, b);
}

interface Cand {
    odb: Ps2OdbIn;
    id: number;
    cls: OdbClass;
}

/** Free ids inside [min, max] of the ODB, highest first (stays clear of the story editor, which counts up from 4000). */
function freeIds(taken: ReadonlySet<number>, reserved?: ReadonlySet<number>): number[] {
    let min = Infinity;
    let max = 0;
    for (const id of taken) {
        min = Math.min(min, id);
        max = Math.max(max, id);
    }
    const out: number[] = [];
    // Ids above the ODB maximum sort last, so file order, index order and id order agree and the appended 0x0103 field
    // lists pair with their records whichever way the guest pairs them (ootf-odb-class-count.md). Below-max ids are the
    // old behaviour, kept behind OOTF_IDS_BELOW_MAX=1 for comparison.
    if ((globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.['OOTF_IDS_BELOW_MAX'] === '1') {
        for (let id = max - 1; id > min; id--) if (!taken.has(id) && !reserved?.has(id)) out.push(id);
        return out;
    }
    for (let id = max + 1; id <= 0xfffe; id++) if (!reserved?.has(id)) out.push(id);
    return out;
}

function dataSignature(c: OdbClass): string {
    return (c.data ?? []).join(',');
}

/**
 * Decide, for every PC class, whether an existing PS2 class stands in, a new record is cloned from a PS2 class of the
 * same engine id, or the class is unsupported. Deterministic for a given input order: pass the union of the classes of
 * all levels of one pack so that every level uses the same ids. `ps2` is the set of ODBs reachable from the template.
 */
export function planClassMapping(pc: readonly PcClassIn[], ps2: readonly Ps2OdbIn[], opt: PlanOptions = {}): ClassPlan {
    const minCoverage = opt.minCoverage ?? 0.5;
    const mapped = new Map<string, ClassTarget>();
    const synthesized: Synthesized[] = [];
    const unsupported = new Map<string, Unsupported>();
    const byRfl = new Map<number, Cand[]>();
    const taken = new Map<string, Set<number>>();
    for (const odb of [...ps2].sort((a, b) => a.dbIndex - b.dbIndex)) {
        const t = taken.get(odb.file) ?? taken.set(odb.file, new Set()).get(odb.file)!;
        for (const [id, cls] of odb.classes) {
            t.add(id);
            const rfl = cls.rflClass ?? (cls.runtimeClass ?? -1) & 0xffff;
            if (!cls.fields || !cls.data) continue;
            (byRfl.get(rfl) ?? byRfl.set(rfl, []).get(rfl)!).push({ odb, id, cls });
        }
    }
    const free = new Map<string, number[]>();
    const nextId = (file: string): number | undefined => {
        let list = free.get(file);
        if (!list) {
            list = freeIds(taken.get(file) ?? new Set(), opt.reservedIds?.get(file));
            free.set(file, list);
        }
        return list.shift();
    };
    const done = new Map<string, Synthesized>();
    const usedTemplates = new Set<string>();
    const ordered = [...pc].sort((a, b) => a.db - b.db || a.id - b.id);
    for (const { db, id, cls } of ordered) {
        const key = pcClassKey(db, id);
        const rfl = cls.rflClass ?? -1;
        const info = ENGINE_CLASSES.get(rfl);
        let cands = byRfl.get(rfl) ?? [];
        let substituted = false;
        if (!cands.length && opt.substituteEngineId?.has(rfl)) {
            cands = byRfl.get(opt.substituteEngineId.get(rfl)!) ?? [];
            substituted = cands.length > 0;
        }
        // 1. same name and same engine class (unless the caller wants the PC model converted instead: `keepOwnModel`)
        const loose = squash(cls.name);
        const pickNamed = (want: string): Cand | undefined =>
            cands
                .filter((c) => squash(c.cls.name) === want)
                .sort((a, b) => a.odb.dbIndex - b.odb.dbIndex || a.id - b.id)[0];
        const named = opt.keepOwnModel?.(cls) ? undefined : (pickNamed(loose) ?? pickNamed(aliasSquash(cls.name)));
        if (named) {
            mapped.set(key, { dbIndex: named.odb.dbIndex, classId: named.id, cls: named.cls });
            continue;
        }
        if (!cands.length) {
            unsupported.set(key, {
                reason: 'no-engine-class',
                detail: `engine class ${rfl}${info ? ` (${info.name})` : ''} has no PS2 class in the template's databases`,
            });
            continue;
        }
        const kind = info?.kind;
        const wantsModel = !substituted && !!kind && !!opt.modelFor && !!cls.model && !RETARGET_KINDS.has(kind);
        // A model-less PC class of a mechanism / scenery / fx engine class (Break Brick floor, Fire Fly Axis ...) is cloned from a
        // model-less PS2 class of the same engine id: the clone shows nothing it should not.
        const modelless =
            !substituted &&
            !cls.model &&
            (kind === 'mechanism' || kind === 'scenery' || kind === 'fx') &&
            cands.some((c) => !c.cls.model && !!c.odb.raw?.(c.id));
        if (!kind || !(RETARGET_KINDS.has(kind) || substituted || opt.borrowModelKinds?.has(kind) || wantsModel || modelless)) {
            unsupported.set(key, {
                reason: 'needs-model',
                detail: `${info?.name ?? `engine class ${rfl}`} (${kind ?? 'unknown'}) needs a model; none can be taken from the PC data`,
            });
            continue;
        }
        // 2. clone the PS2 class of the same engine id whose defaults are closest to the PC class
        let best: { c: Cand; m: Merge } | null = null;
        const hostPool = wantsModel
            ? cands.filter((c) => c.cls.model && c.odb.raw?.(c.id) && (!opt.modelOdbFile || c.odb.file === opt.modelOdbFile))
            : [];
        // No template with a model in the host ODB (doors, switches, ladders, ropes, fx ...): take one from an ODB that lists the host
        // in its .DB; the converted model is then named with that ODB's own 'db' index of the host ('modelFor').
        const pool = wantsModel
            ? hostPool.length
                ? hostPool
                : cands.filter((c) => c.cls.model && c.odb.raw?.(c.id) && opt.modelOdbFiles?.has(c.odb.file))
            : modelless
              ? cands.filter((c) => !c.cls.model && !!c.odb.raw?.(c.id))
              : cands;
        if (wantsModel && opt.modelSkinned?.(cls) && opt.templateSkinned) {
            // Skinned templates also come from the ODBs that list the host (their `modelFor` names the host with its `db` there).
            const sk = cands.filter(
                (c) =>
                    c.cls.model &&
                    c.odb.raw?.(c.id) &&
                    (!opt.modelOdbFile || c.odb.file === opt.modelOdbFile || opt.modelOdbFiles?.has(c.odb.file)) &&
                    opt.templateSkinned!(c.cls, c.odb.file),
            );
            if (sk.length) pool.splice(0, pool.length, ...sk);
        }
        if (wantsModel && pool.length > 1 && kind !== 'creature') {
            // Creature engine classes (Knight, Dragon ...) keep their templates: flag 32 is normal for them, and swapping Rift Crystal's
            // Crimson Knight to a flag 33 template corrupted the heap. Skinned models of generic object classes (Heuge Sailor) are filtered.
            // A template whose model-flags word (body u32 at 6) is not one of the common values 0, 1, 33 (only 8 of the 1344
            // RESOURES classes: 3 and 32, e.g. BloodVialBlood and "Nichol's Tome Stomp") makes the engine build a per-object
            // controller the cloned record cannot feed: Alwarren objects of such clones crashed on a null vtable at 0x10822c.
            const plain = pool.filter((c) => {
                const raw = c.odb.raw?.(c.id);
                if (!raw) return true;
                const body = splitClassRecord(raw).body;
                return body.length < 10 || [0, 1, 33].includes(view(body).getUint32(6, true));
            });
            if (plain.length) pool.splice(0, pool.length, ...plain);
        }
        if (!pool.length) {
            unsupported.set(key, { reason: 'no-raw-record', detail: `no PS2 class of engine class ${rfl} carries a model` });
            continue;
        }
        // Two new records cloned from the same template broke the ODB load in game (ootf-ingame.md bisect, K=3 vs K=2), so a
        // template is reused only when no other candidate of that engine class is left.
        const fresh = pool.filter((c) => !usedTemplates.has(`${c.odb.file}|${c.id}`));
        if ((globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.['DRAKAN_DBG_TPLRIG']) {
            // Test aid: rig size of the converted model against each candidate template (flags = body u32 at 6).
            const mj = opt.modelJoints?.(cls);
            if (mj !== undefined)
                for (const c of pool) {
                    const raw = c.odb.raw?.(c.id);
                    const fl = raw ? view(splitClassRecord(raw).body).getUint32(6, true) : -1;
                    console.warn(`TPLRIG ${cls.name} (${mj} joints) cand "${c.cls.name}"#${c.id} joints=${opt.templateJoints?.(c.cls, c.odb.file)} flags=${fl}`);
                }
        }
        for (const c of fresh.length ? fresh : pool) {
            const m = mergeDefaults(cls, c.cls, opt.mapClassRef, opt.mapAnimFor?.(cls), wantsModel, opt.modelJoints?.(cls));
            if (!best || m.coverage > best.m.coverage || (m.coverage === best.m.coverage && m.same > best.m.same))
                best = { c, m };
        }
        const { c, m } = best!;
        usedTemplates.add(`${c.odb.file}|${c.id}`);
        if (opt.rewriteText && c.cls.fields) opt.rewriteText(c.odb.file, c.cls.fields, m.data);
        if (m.coverage < (wantsModel || (substituted && kind === 'mp') ? 0 : minCoverage)) {
            unsupported.set(key, {
                reason: 'low-coverage',
                detail: `PS2 "${c.cls.name}" shares ${Math.round(m.coverage * 100)}% of the fields of "${cls.name}"`,
            });
            continue;
        }
        const raw = c.odb.raw?.(c.id);
        const hasModel = !!c.cls.model;
        if (!raw && hasModel) {
            unsupported.set(key, { reason: 'no-raw-record', detail: `template "${c.cls.name}" has a model block` });
            continue;
        }
        let modelRef: { id: number; db: number } | null = null;
        if (wantsModel) {
            modelRef = opt.modelFor!(cls, c.odb.file);
            if (!modelRef) {
                unsupported.set(key, { reason: 'needs-model', detail: `the PC model of "${cls.name}" was not converted` });
                continue;
            }
        }
        const sig = `${c.odb.file}|${c.id}|${m.data.join(',')}|${modelRef ? `${modelRef.db}:${modelRef.id}` : ''}`;
        const prev = done.get(sig);
        if (prev) {
            prev.pcKeys.push(key);
            continue;
        }
        const newId = nextId(c.odb.file);
        if (newId === undefined) {
            unsupported.set(key, { reason: 'no-free-id', detail: `${c.odb.file} has no free class id` });
            continue;
        }
        const group = c.odb.group?.(c.id) ?? c.cls.group;
        const name = cls.name.trim() || `OotF class ${rfl}`;
        let record = raw
            ? cloneClassRecord(raw, name, m.data)
            : buildPlainClassRecord({
                  name,
                  group,
                  rfl: c.cls.rflClass ?? rfl,
                  icon: c.cls.icon ?? 0,
                  fieldCount: c.cls.fields!.length,
                  data: m.data,
              });
        if (modelRef && raw) record = patchRecordModel(record, modelRef, opt.modelBounds?.(modelRef.id));
        const out: OdbClass = {
            id: newId,
            name,
            group,
            runtimeClass: c.cls.runtimeClass,
            model: modelRef ?? c.cls.model ?? null,
            rflClass: c.cls.rflClass ?? rfl,
            icon: c.cls.icon,
            fields: c.cls.fields,
            data: m.data,
        };
        const s: Synthesized = {
            pcKeys: [key],
            name,
            file: c.odb.file,
            dbIndex: c.odb.dbIndex,
            classId: newId,
            group,
            rfl: c.cls.rflClass ?? rfl,
            template: { dbIndex: c.odb.dbIndex, classId: c.id, name: c.cls.name },
            record,
            cls: out,
            copied: m.copied,
            skipped: m.skipped,
            coverage: m.coverage,
        };
        done.set(sig, s);
        synthesized.push(s);
    }
    const synthByKey = new Map<string, Synthesized>();
    for (const s of synthesized) for (const k of s.pcKeys) synthByKey.set(k, s);
    return {
        mapped,
        synthesized,
        unsupported,
        resolve(db, id) {
            const k = pcClassKey(db, id);
            const m = mapped.get(k);
            if (m) return m;
            const s = synthByKey.get(k);
            return s ? { dbIndex: s.dbIndex, classId: s.classId, cls: s.cls } : null;
        },
    };
}

// ---------------------------------------------------------------- writer

/** Same shape as editor-core's `StoryEntryChange`, so `buildStoryPackFiles` ships these. */
export interface ClassEntryChange {
    file: string;
    type: number;
    id: number;
    sub: number;
    data: Uint8Array;
    isNew: boolean;
}

/**
 * Mod pack entries for the synthesized records: one `new/<FILE>/0102_<id>_<sub>.bin` per record and, per touched ODB, the
 * 0x0103 entry replaced by the stored one with the clones' field lists appended **in ascending class id order** (the
 * runtime appends new entries sorted by id and pairs field lists with records by index order, ModPack.cpp). The id
 * of every class lies inside the ODB's existing id range (ids above it did not spawn, modding.md).
 */
export async function buildClassEntries(plan: ClassPlan, ps2: readonly Ps2OdbIn[]): Promise<ClassEntryChange[]> {
    const out: ClassEntryChange[] = [];
    const files = new Map<string, Synthesized[]>();
    for (const s of plan.synthesized) (files.get(s.file) ?? files.set(s.file, []).get(s.file)!).push(s);
    for (const [file, list] of [...files].sort((a, b) => a[0].localeCompare(b[0]))) {
        list.sort((a, b) => a.classId - b.classId);
        const odb = ps2.find((o) => o.file === file);
        if (!odb?.fieldLists) throw new Error(`${file}: the 0x0103 field-list entry is needed to add classes`);
        let lists = odb.fieldLists.stored;
        for (const s of list) {
            out.push({ file, type: ODB_CLASS_TYPE, id: s.classId, sub: s.group, data: s.record, isNew: true });
            lists = await appendFieldList(lists, s.cls.fields as ClassFieldDef[]);
        }
        out.push({
            file,
            type: ODB_FIELDS_TYPE,
            id: odb.fieldLists.id,
            sub: odb.fieldLists.sub,
            data: lists,
            isNew: false,
        });
    }
    return out;
}

// ---------------------------------------------------------------- Level Properties

/**
 * PC "Level Properties" is never placed in a level: the engine reads the defaults of the first class of engine id 54 in
 * the level's own ODB. PS2 places exactly one object of that class per level (12 of 14 levels; the object overrides a few
 * defaults). The converter has to place one and fill it from the PC defaults with this table.
 *
 * action: `copy` = same name, type and unit; `rename` = PS2 field has another name; `keep` = keep the PS2 template's
 * value; `hook` = needs a content decision (music); `drop` = no PS2 counterpart.
 */
export interface LevelPropertyRule {
    pc: string;
    ps2?: string;
    action: 'copy' | 'rename' | 'keep' | 'hook' | 'drop';
    note: string;
}

export const LEVEL_PROPERTY_RULES: readonly LevelPropertyRule[] = [
    {
        pc: 'Fog Color',
        action: 'drop',
        note: 'PS2 has no level-wide fog colour field (fog colour is per layer: light/ambient colour); PC values are a defaults only',
    },
    { pc: 'Fog Start Ratio', action: 'drop', note: 'PS2 only has the underwater variant' },
    {
        pc: 'Min Fog Depth (lu)',
        ps2: 'Min Fog Depth (lu)',
        action: 'copy',
        note: 'same name and unit; PC 12 vs PS2 8-90, PC draw distances are shorter: consider max(PC, template)',
    },
    {
        pc: 'Max Fog Depth (lu)',
        ps2: 'Max Fog Depth (lu)',
        action: 'copy',
        note: 'PC 12-30 (PC 20-30 in 20 of 23), PS2 20-160; consider max(PC, template)',
    },
    {
        pc: 'Default Field of View (deg)',
        ps2: 'Default Field of View (deg)',
        action: 'copy',
        note: '80 in all 23 PC levels, PS2 70-80',
    },
    {
        pc: 'Default Material Properties',
        ps2: 'Default Material Properties',
        action: 'keep',
        note: 'class reference into a PC material class; use the template level value',
    },
    {
        pc: 'Gravity (wu/s^2)',
        ps2: 'Gravity (wu/s^2)',
        action: 'copy',
        note: '6000 (4096 in 4 PC levels) vs 6000 on every PS2 level',
    },
    {
        pc: 'Flight Ceiling (wu)',
        ps2: 'Flight Ceiling (wu)',
        action: 'copy',
        note: 'PC 45000-300000, PS2 200000-300000; world units, same unit',
    },
    {
        pc: 'Slow Current Speed (lu/s)',
        ps2: 'Slow Current Speed (lu/s)',
        action: 'copy',
        note: 'same name; PC 0.2-0.25',
    },
    { pc: 'Med Current Speed (lu/s)', ps2: 'Med Current Speed (lu/s)', action: 'copy', note: 'same name; PC 0-0.5' },
    {
        pc: 'Fast Current Speed (lu/s)',
        ps2: 'Fast Current Speed (lu/s)',
        action: 'copy',
        note: 'same name; PC 0.5-1, 3 in Nemesis',
    },
    {
        pc: 'Initial Music ID',
        ps2: 'Initial Music File',
        action: 'hook',
        note: 'PC int (0, 1, 6-10) vs PS2 sound reference (db<<16|id): needs a PC music id -> PS2 music map',
    },
    { pc: 'Saveable?', ps2: 'Saveable?', action: 'copy', note: '0 in the intro, book and all multiplayer maps' },
    {
        pc: 'Level Type',
        ps2: 'Level Type',
        action: 'keep',
        note: 'PC 0/2 single player, 1 ground match, 3 Master of the Dragon; PS2 uses 2 everywhere; the PC values drive multiplayer rules that PS2 does not have',
    },
    {
        pc: 'Recharge Rate Multiplier',
        ps2: 'Recharge Rate Multiplier',
        action: 'copy',
        note: '0.25 in the three Master of the Dragon maps, else 1',
    },
    {
        pc: 'Kill Altitude (wu)',
        ps2: 'Kill Altitude (wu)',
        action: 'copy',
        note: 'only 3 PC maps set it (98000-210000, i.e. just below the 200000 layer base); 0 = off',
    },
    { pc: 'Alpha Color', action: 'drop', note: 'role unknown (not team colours); no PS2 field' },
    { pc: 'Beta  Color', action: 'drop', note: 'two spaces in the PC name; role unknown' },
    { pc: 'Gamma Color', action: 'drop', note: 'role unknown' },
    { pc: 'Delta Color', action: 'drop', note: 'role unknown' },
];

/**
 * Parameters for a placed PS2 Level Properties object: every PC default with action `copy` / `rename` that differs from
 * the PS2 class default becomes an override (fields the PS2 class defines are matched by name and type). Returns the
 * specs plus the PC fields that were left out.
 */
export function levelPropertiesParams(pc: OdbClass, ps2: OdbClass): { specs: ParamSpec[]; left: string[] } {
    const specs: ParamSpec[] = [];
    const left: string[] = [];
    const pf = pc.fields ?? [];
    const sf = ps2.fields ?? [];
    for (const rule of LEVEL_PROPERTY_RULES) {
        const i = pf.findIndex((f) => f.name === rule.pc);
        if (i < 0) continue;
        if ((rule.action !== 'copy' && rule.action !== 'rename') || !rule.ps2) {
            left.push(rule.pc);
            continue;
        }
        const j = sf.findIndex((f) => f.name === rule.ps2);
        const pt = pf[i]!;
        const st = sf[j];
        if (j < 0 || !st || !sameType(pt.type, st.type)) {
            left.push(rule.pc);
            continue;
        }
        let value: ClassFieldValue = decodeFieldValue(pt.type, pc.data?.[i] ?? 0, pc.data ?? []);
        const current = decodeFieldValue(st.type, ps2.data?.[j] ?? 0, ps2.data ?? []);
        // PC draw distances (12 / 30 lu) are shorter than anything the PS2 levels use (8 / 65-160): never shorten the template's.
        if (/^M(in|ax) Fog Depth/.test(rule.pc) && typeof value === 'number' && typeof current === 'number')
            value = Math.max(value, current);
        if (JSON.stringify(value) === JSON.stringify(current)) continue;
        specs.push({ fieldIndex: j, type: st.type, name: st.name, value });
    }
    // PS2 sky and distance fog come from the day/night cycle (`Level Time`), not from a fog colour: a dark PC fog colour
    // (Ruined Village, Rift, Mines, Volcano: black; Alwarren, Islands Night: dark green / brown) means a night level, so run the
    // template's cycle at night instead of its noon (white sky and fog over unlit ground).
    const timeIdx = sf.findIndex((f) => f.name === 'Level Time (0-24hrs)');
    const fogIdx = pf.findIndex((f) => f.name === 'Fog Color');
    if (timeIdx >= 0 && fogIdx >= 0) {
        const fog = Number(decodeFieldValue(pf[fogIdx]!.type, pc.data?.[fogIdx] ?? 0, pc.data ?? []));
        const lum = ((fog & 255) + ((fog >> 8) & 255) + ((fog >> 16) & 255)) / 3;
        const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.['DRAKAN_LEVEL_TIME'];
        const hour = env !== undefined && env !== '' ? Number(env) : lum < NIGHT_FOG_LUMINANCE ? NIGHT_HOUR : undefined;
        if (hour !== undefined) specs.push({ fieldIndex: timeIdx, type: sf[timeIdx]!.type, name: sf[timeIdx]!.name, value: hour });
    }
    return { specs, left };
}

/** PC fog colours darker than this (mean of R, G, B, 0-255) make a converted level a night level. */
export const NIGHT_FOG_LUMINANCE = 64;
/** `Level Time (0-24hrs)` of a night level. */
export const NIGHT_HOUR = 0;
