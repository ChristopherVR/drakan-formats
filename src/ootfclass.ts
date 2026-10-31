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
export function mergeDefaults(pc: OdbClass, tpl: OdbClass, mapClassRef?: PlanOptions['mapClassRef']): Merge {
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
    for (let id = max - 1; id > min; id--) if (!taken.has(id) && !reserved?.has(id)) out.push(id);
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
    const ordered = [...pc].sort((a, b) => a.db - b.db || a.id - b.id);
    for (const { db, id, cls } of ordered) {
        const key = pcClassKey(db, id);
        const rfl = cls.rflClass ?? -1;
        const info = ENGINE_CLASSES.get(rfl);
        const cands = byRfl.get(rfl) ?? [];
        // 1. same name and same engine class
        const loose = squash(cls.name);
        const named = cands
            .filter((c) => squash(c.cls.name) === loose)
            .sort((a, b) => a.odb.dbIndex - b.odb.dbIndex || a.id - b.id)[0];
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
        if (!kind || !(RETARGET_KINDS.has(kind) || opt.borrowModelKinds?.has(kind))) {
            unsupported.set(key, {
                reason: 'needs-model',
                detail: `${info?.name ?? `engine class ${rfl}`} (${kind ?? 'unknown'}) needs a model; none can be taken from the PC data`,
            });
            continue;
        }
        // 2. clone the PS2 class of the same engine id whose defaults are closest to the PC class
        let best: { c: Cand; m: Merge } | null = null;
        for (const c of cands) {
            const m = mergeDefaults(cls, c.cls, opt.mapClassRef);
            if (!best || m.coverage > best.m.coverage || (m.coverage === best.m.coverage && m.same > best.m.same))
                best = { c, m };
        }
        const { c, m } = best!;
        if (m.coverage < minCoverage) {
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
        const sig = `${c.odb.file}|${c.id}|${m.data.join(',')}`;
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
        const record = raw
            ? cloneClassRecord(raw, name, m.data)
            : buildPlainClassRecord({
                  name,
                  group,
                  rfl,
                  icon: c.cls.icon ?? 0,
                  fieldCount: c.cls.fields!.length,
                  data: m.data,
              });
        const out: OdbClass = {
            id: newId,
            name,
            group,
            runtimeClass: c.cls.runtimeClass,
            model: c.cls.model ?? null,
            rflClass: rfl,
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
            rfl,
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
        const value: ClassFieldValue = decodeFieldValue(pt.type, pc.data?.[i] ?? 0, pc.data ?? []);
        const current = decodeFieldValue(st.type, ps2.data?.[j] ?? 0, ps2.data ?? []);
        if (JSON.stringify(value) === JSON.stringify(current)) continue;
        specs.push({ fieldIndex: j, type: st.type, name: st.name, value });
    }
    return { specs, left };
}
