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

import { ootfClassDebug } from './ootfdebug.ts';
import {
    FIELD_ANIMATION,
    FIELD_CHANNEL,
    FIELD_COLOUR,
    FIELD_ENUM,
    FIELD_FLOAT,
    FIELD_INT,
    FIELD_LAYER,
    FIELD_MODEL,
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
import { appendFieldList, joinClassRecord, patchClassData, splitClassRecord } from './odbwrite.ts';

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
 * Engine classes placed in the 23 OotF levels, plus referenced-only effects/projectiles. Names: OpenDrakan's class list where it has one, else the
 * dominant PC/PS2 class name and group of that id. The kind is a judgement from names, fields and PS2 usage.
 */
const ENGINE_LIST: readonly [number, string, ClassKind][] = [
    [1, 'Expanding / Fading Effect', 'fx'],
    [3, 'Radius Damage', 'fx'],
    [6, 'Looping/Triggered Sound', 'sound'],
    [7, 'Count Down To Zero', 'logic'],
    [8, 'Weapon Projectile', 'weapon'],
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
    [58, 'Lightning Bolt', 'weapon'],
    [59, 'Giant', 'creature'],
    [60, 'Tracer / Weapon Ribbon', 'fx'],
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
    [81, 'Trail Master Effect', 'fx'],
    [82, 'Death Mage', 'creature'],
    [83, 'Stomp FX / Moving Particles', 'fx'],
    [86, 'Soul Crystal (Master of the Dragon)', 'mp'],
    [88, 'Goblin', 'creature'],
    [89, 'Magic Potion', 'item'],
    [91, 'Magic Crystal', 'item'],
    [92, 'Dr. Evil', 'creature'],
    [95, 'Arrow / Spell Projectile', 'weapon'],
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
    // Combination Lock / Class Messenger: the PS2 Combo Lock (223) lives in LEVEL4ON, which no template lists; the Message Relay
    // (224, LEVEL1ON) is in reach and does what both do in the Rift Crystal puzzle (forward a message to the linked objects).
    [123, 224],
    [137, 224],
    [130, 17],
    // Pressure Plate: the only PS2 plates live in LEVEL4ON / LEVEL8OS (not reachable from the template); a static plate prop stays.
    [29, 17],
    [120, 10],
    // PC Water Droplet (144) is the PS2 Water Drip (146: Type / Period / Deviation + Max Particles Per Period); PS2 reuses 144 for shields.
    [144, 146],
    // Dr. Evil (the four heads of the Rift World boss): the Giant is the largest humanoid creature; the clone keeps the PS2 model
    // and gets the PC class's stats by field name (Initial Health 250 ...). `BOSS_STANDINS` scales and places the objects.
    [92, 59],
    // Quest Item (the Bell Hammer): on the PS2 only a Key (33) is matched against a lock's code (the Use handler and a
    // detector's "Trigger Only If Carrying Item..." look for that class); the PS2 117 class (an egg) has no lock behaviour.
    [117, 33],
]);

/** The fields of the Pressure Plate (29), the same on the PC and in the PS2 handler (0x45de10 reads them by position). */
export const PRESSURE_PLATE_FIELDS: readonly string[] = [
    'Sink Distance (wu)',
    'Sink Speed (lu/s)',
    'Rise Speed (lu/s)',
    'Initial State',
    'Stay Down When Pressed?',
    'When Triggered',
    'Send Off Message When Triggered?',
    'Send Message When',
    'Message To Send At Top',
    'Message To Send At Bottom',
    'Sink Sound',
    'Rise Sound',
    'Triggered by Rynn Only?',
];

/** PC engine ids whose PS2 class is cloned even though the PS2 has another class under the same number (144 = shields on PS2, 92 = a creature without the Dr. Evil fields, 117 = an egg without a lock). */
export const FORCED_SUBSTITUTES: ReadonlySet<number> = new Set([144, 92, 117]);

/**
 * Substituted PC engine ids whose clone gets the converted PC model instead of the template's: the Pirate Ship (a spline
 * vehicle on the PC) becomes a static Ground Object showing the ship, a Pressure Plate (29) whose native record could not
 * be written (see `PRESSURE_PLATE_FIELDS`) a static plate that cannot be pressed, and the Bell Hammer (117) a Key that
 * shows the hammer.
 */
export const MODEL_STANDINS: ReadonlySet<number> = new Set([130, 88, 100, 101, 29, 117]);

/** Engine id of the Fader on both platforms. */
export const FADER_RFL = 136;

/**
 * A PC Fader (136) with a model fades that model in and out (the Intro's owl ring, "Presents", "Psygnosis Monolith", Surreal
 * text); only a model-less one fades the screen (OpenDrakan `Fader_Cl`: model -> the object's colour modifier, else a
 * full-screen quad). Every PS2 Fader class is model-less (a screen fader), so a model fader cloned from one showed nothing:
 * the Intro's Psygnosis plate, "Presents", the D R A K A N letters and the Surreal text never appeared (journal
 * 2026-11-08/ootf-intro-black-start.md). Such a class becomes a static Ground Object (17) with the converted PC model, like
 * the Pirate Ship: the scenes' show/hide actions still put it on and off screen at the authored times, without the alpha ramp.
 */
export const MODEL_FADER_STANDIN = 17;

/**
 * The Ground Object template a model fader is cloned from may be a breakable prop (health, explosion and damage links); the
 * stand-in is inert scenery, as the PC fader is.
 */
const MODEL_FADER_ADJUST = {
    set: [
        ['Initial Health', 0],
        ['Send Damage Along Links?', 0],
        ['AutoTarget Priority (0=highest, -1=none)', 0xffffffff],
        ['2D Explosion Object', 0],
        ['Explosion Generator', 0],
        ['Smoke Generator', 0],
    ],
} as const;

/** The PS2 engine id a PC class is cloned from instead of its own (undefined = its own id). */
export function substituteFor(
    cls: Pick<OdbClass, 'rflClass' | 'model'>,
    table: ReadonlyMap<number, number> | undefined,
): number | undefined {
    if (!table) return undefined;
    if (cls.rflClass === FADER_RFL && cls.model) return MODEL_FADER_STANDIN;
    return table.get(cls.rflClass ?? -1);
}

/** The IEEE-754 single bit pattern of a value (PS2 float fields are stored as raw dwords). */
function floatBits(v: number): number {
    const b = new DataView(new ArrayBuffer(4));
    b.setFloat32(0, v, true);
    return b.getUint32(0, true);
}

/**
 * Fix-ups of the class record cloned for a PC engine id, by PS2 field name, applied after the field-name merge:
 * `reset` keeps the template's own defaults (no PC values, so all PC classes of the id share ONE record - the per-object
 * values are written as object parameters by `ootfpuzzle.ts`), `rename` copies a scalar PC field into a differently named PS2
 * field, `set` forces a value. Ids listed here are accepted at any field coverage.
 */
export const CLONE_ADJUST: ReadonlyMap<
    number,
    { reset?: boolean; rename?: readonly (readonly [string, string])[]; set?: readonly (readonly [string, number])[] }
> = new Map([
    // Dr. Evil heads: dormant until the level's trigger wakes them (the PC "Emerge only when triggered?"), the PS2 name of it.
    // The four heads stand up to ~23000 units apart around the altar and the one that faces away never noticed the player (journal
    // 2026-11-02/ootf-drevil-fourth-head.md): they see and hear all around and far, so every head comes for the player once woken.
    [
        92,
        {
            set: [
                ['Wait For Trigger', 1],
                ['Detect Radius (lu)', floatBits(400)],
                ['Hearing Distance (lu)', floatBits(400)],
                ['Field of Vision', floatBits(360)],
                ['Break Off Radius (lu)', floatBits(400)],
            ],
        },
    ],
    // Key: the PS2 Use handler puts the matching key in Rynn's hand before it sends it to the Key Lock, and only an
    // "Equippable?" key gets there (every native key that opens a lock has it; the PC class has no such field). With the
    // template's 0 Rynn stood at Alwarren's crystal locks with the right crystal and nothing happened (issue 5).
    [33, { set: [['Equippable?', 1]] }],
    // Combination Lock: forwards the switches' ON to the counters it is linked to.
    [
        123,
        {
            reset: true,
            set: [
                ['Incoming Message', 1],
                ['Outgoing Message', 1],
            ],
        },
    ],
    // Class Messenger: relays the message that arrives (ON from the counter) as the PC object's "Message to send".
    [137, { reset: true, rename: [['Message to send', 'Outgoing Message']], set: [['Incoming Message', 1]] }],
    // Map Object / Map Trigger (quest markers): one PS2 map-marker record per marker name (`markerClassIdentity`); the
    // puzzle pass writes its journal / map text, type and map position into the record (the game reads them from the class).
    [104, { reset: true }],
    // Quickening Effect (the sparks and lightning around a power orb, linked to the orb prop): the PS2 has no engine 80 and its
    // Power FX (71) shares none of the 16 fields (spark model, flare radii ...). A Particle Spawner with its own PS2 defaults
    // stands in at the same place, so the spot still sparkles; the PC spark settings are not carried.
    [80, { reset: true }],
]);

/** Generic PC marker names that carry no text of their own (the converter leaves those markers out). */
export const GENERIC_MARKER = /^map\s*(trigger|object|message|text|icon)?\s*$/i;

/**
 * Clone identity of a PC map marker class (engine 104). The game keeps a quest by its System.ODB class id and draws the
 * journal entry, map text, Type and SubQuest? from the class record, never from the placed object (save rows `+0x18`,
 * docs/journal/2026-10-31/save-editor.md). Markers that shared one clone therefore all showed the template quest's
 * German text (issue 5, "Rette die Frau des Bauern ..."); each named marker gets its own record, markers of the same
 * name (the same quest on two levels) share one. Generic names (no text, left out by the puzzle pass) share one record.
 */
export function markerClassIdentity(name: string): string {
    const n = name.trim();
    return !n || GENERIC_MARKER.test(n) ? '' : `|marker:${squash(n)}`;
}

function adjustClone(
    pc: OdbClass,
    tpl: OdbClass,
    m: Merge,
    adj: NonNullable<ReturnType<typeof CLONE_ADJUST.get>>,
): Merge {
    const data = adj.reset ? [...(tpl.data ?? [])] : [...m.data];
    const tf = tpl.fields ?? [];
    const idx = (name: string): number => tf.findIndex((f) => f.name.trim().toLowerCase() === name.toLowerCase());
    for (const [from, to] of adj.rename ?? []) {
        const i = (pc.fields ?? []).findIndex((f) => f.name.trim().toLowerCase() === from.toLowerCase());
        const j = idx(to);
        const v = i >= 0 ? pc.data?.[i] : undefined;
        if (j >= 0 && v !== undefined && !fieldIsIndirect(tf[j]!.type)) data[j] = v;
    }
    for (const [name, value] of adj.set ?? []) {
        const j = idx(name);
        if (j >= 0 && !fieldIsIndirect(tf[j]!.type)) data[j] = value >>> 0;
    }
    return { ...m, data };
}

/** Particle emitter engine classes whose clone keeps the template's emitter model (the PC model is not converted). */
const FX_OWN_MODEL_RFL: ReadonlySet<number> = new Set(
    (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.['OOTF_FX_PCMODEL'] === '1'
        ? []
        : [43, 71, 97],
);

export const RETARGET_KINDS: ReadonlySet<ClassKind> = new Set(['logic', 'light', 'sound', 'waypoint', 'spawn']);

/**
 * Engine classes whose objects keep their PC class defaults when the class is mapped onto a same-named PS2 class
 * (`ConvertOptions.keepPcDefaults`): the logic classes (counters, timers, togglers ...), whose defaults decide which message
 * does what. Alwarren's "count down to zero" counts Off down on the PC and the PS2 "Count down to Zero" counts it up, so the
 * six crystal pillars never moved (issue 5). Stomp Players (51) have their own translation (`ootfstomp.ts`), map markers
 * (104) one reset record per marker name. Air Currents (111) keep the PS2 speed (their flight is tuned on the PS2 defaults;
 * the PC class defaults would slow Islands currents from 16 to 1 lu/s, untested).
 */
const OWN_DEFAULTS_RFL: ReadonlySet<number> = new Set([51, 104, 111]);
/**
 * Non-logic engine classes whose objects also keep their PC class defaults on a same-named PS2 class. Rigid Bodies (16): a
 * PC "Boulder" maps onto the disc's "Boulder" (RESOURES), whose "Damage (per lu/s)" is 1 and "Damage Player" off, so the
 * Ruined Village boulders (PC 50 and on) rolled into the explosive barrels without setting them off: the body's hit sends
 * Damage x speed / 2048 (handler 0x45a148), less than a barrel's 5 health. Ground Objects (17): the disc's "Barrel",
 * "Crate" and "Crate Short" have 5 health where the PC ones have 10 or 20 (Islands, Alwarren, Islands Night, Ruined Village,
 * Wartok Canyons, Grimstone Mines, Grotto: 77 objects), so they broke at the first blow; the campaign audit of 14 November
 * found no other scalar default of a name-mapped Ground Object that differs.
 */
const PC_DEFAULTS_RFL: ReadonlySet<number> = new Set([16, 17]);
/**
 * PC defaults `keepsPcDefaults` leaves at the PS2 class's value. A Rigid Body's health: the body takes its own hits off it
 * (0x45ede0 from the hit handler, terrain bounces included) and is removed at 0, and the PC "Explosion Generator" it would
 * shatter with is a class reference that is not carried, so a PC boulder with health 50 (Alwarren, Islands Night) would
 * vanish after a few bounces instead of staying immortal as on the disc class.
 */
const PC_DEFAULTS_SKIP: ReadonlyMap<number, ReadonlySet<string>> = new Map([[16, new Set(['health (-1 = immortal)'])]]);
export function pcDefaultsSkipped(rfl: number | undefined): ReadonlySet<string> | undefined {
    return rfl === undefined ? undefined : PC_DEFAULTS_SKIP.get(rfl);
}
export function keepsPcDefaults(rfl: number | undefined): boolean {
    if (rfl !== undefined && PC_DEFAULTS_RFL.has(rfl)) return true;
    return rfl !== undefined && !OWN_DEFAULTS_RFL.has(rfl) && ENGINE_CLASSES.get(rfl)?.kind === 'logic';
}

/**
 * Engine classes whose objects only exist with the template's model: a Detector (61) is the FX box model (3727) scaled by
 * the object, and the engine does not place an object of a model-less detector class at all. PS2MUSIC.ODB ships such a
 * model-less "trigger"; once the boxed templates had been used, Rift Crystal's "Creature Detector" (its exit box) was
 * cloned from it and never appeared in the world (issue 5). These classes take a template that carries a model.
 */
export const BOXED_TEMPLATE_RFL: ReadonlySet<number> = new Set([61]);

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
    /**
     * The auxiliary class reference (record body u32 at +10: class id, db) a clone must carry instead of none: a Drakan 2
     * weapon is its handle model plus a child part class named there (the mace's head, the hammer's head, the axe itself,
     * a sword's sheen layer), so a PC weapon shown with a disc weapon model needs that weapon's reference or it draws the
     * handle alone. Undefined or 0 keeps the clone without one.
     */
    companionFor?: (cls: OdbClass, odbFile: string) => number | undefined;
    modelFor?: (cls: OdbClass, odbFile: string) => { id: number; db: number } | null;
    /**
     * Animation-typed defaults (type 9, scalar or array) of a class whose model was converted with its own clips: PC animation id
     * -> the clip's id in the host ADB (`OotfAssetBuilder.mapAnimRef`), or null/undefined to keep the template's value.
     * Returns undefined for classes without converted clips.
     */
    mapAnimFor?: (cls: OdbClass) => ReadonlyMap<number, number> | undefined;
    /**
     * Model-typed defaults (type 4, scalar or array, e.g. a Morph Plug's "Morphing Models") of a PC class cloned into `odbFile`:
     * PC model ref -> the converted model's ref in that ODB's frame, or null when that model was not converted. Returns undefined
     * when no model of the class can be named there; the field then keeps the template's models.
     */
    mapModelFor?: (cls: OdbClass, odbFile: string) => ((ref: number) => number | null) | undefined;
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
    modelBounds?: (modelId: number, odbFile: string, modelDb: number) => Uint8Array | undefined;
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
    /** Converted engine79 model was explicitly rigid and selected a complete native rigid Bow template. */
    rigidBowTemplate?: boolean;
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
            // The multiplayer "Ambient Sound" box is the PS2 Ambient Transition with one slot named (`pcParamAlias`).
            ['Ambient Sound', 'AmbientTransition'],
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

/** The converted clip of the PC class's scalar animation field `name`, or undefined. */
function pcClip(
    pf: readonly { name: string; type: number }[],
    data: readonly number[],
    animMap: ReadonlyMap<number, number>,
    name: string,
): number | undefined {
    const i = pf.findIndex(
        (f) => f.name.trim() === name && fieldBase(f.type) === FIELD_ANIMATION && !fieldIsArray(f.type),
    );
    const id = i >= 0 ? (data[i] ?? 0) & 0xffff : 0;
    return id ? animMap.get(id) : undefined;
}

/**
 * A converted clip id of the PC class to stand in for template clips that do not fit the converted rig: Base Idle, else
 * Hover (a flier: the Succubus and the Queen have no Base Idle, and the lowest clip was their wing slash or spell attack,
 * which the flying creature template then looped on the ground), else the lowest.
 */
function animFallback(
    pf: readonly { name: string; type: number }[],
    data: readonly number[],
    animMap: ReadonlyMap<number, number>,
): number | undefined {
    return (
        pcClip(pf, data, animMap, 'Base Idle') ??
        pcClip(pf, data, animMap, 'Hover') ??
        [...animMap.values()].sort((a, b) => a - b)[0]
    );
}

/**
 * Template clip fields that a PC class names differently: the PS2 flying creature (30) calls the clip of a landed flier
 * "Idle On Ground", the PC Succubus (100) calls it "Idle". Tried before the fallback above.
 */
const FOREIGN_ANIM_ALIASES: ReadonlyMap<string, readonly string[]> = new Map([['idle on ground', ['Idle']]]);

/** Template clip fields that start a creature's death (the PS2 engine picks one by how the creature dies). */
const DEATH_CLIP_FIELDS = ['death', 'forward death', 'sleep death', 'idle death'] as const;

/**
 * The converted death clip of the PC class (its `Death`, else `Forward Death`, `Sleep Death`, `Idle Death`) to stand in for
 * a template death field the PC class leaves empty. With the Base Idle stand-in a slave whose PC class names only `Death`
 * got its standing pickaxe idle as `Idle Death` and `Sleep Death`: a slave placed dead stood upright, and the idle was
 * written to play once, so the living slaves froze after one swing.
 */
function deathFallback(
    pf: readonly { name: string; type: number }[],
    data: readonly number[],
    animMap: ReadonlyMap<number, number>,
): number | undefined {
    for (const name of DEATH_CLIP_FIELDS) {
        const i = pf.findIndex((f) => f.name.trim().toLowerCase() === name && fieldBase(f.type) === FIELD_ANIMATION);
        const dword = i >= 0 ? data[i] : undefined;
        if (dword === undefined) continue;
        const ids = fieldIsIndirect(pf[i]!.type) ? (decodeFieldValue(pf[i]!.type, dword, data) as number[]) : [dword];
        for (const id of ids) {
            const n = id ? animMap.get(id & 0xffff) : undefined;
            if (n !== undefined) return n;
        }
    }
    return undefined;
}

interface Merge {
    data: number[];
    copied: string[];
    skipped: string[];
    coverage: number;
    same: number;
}

/**
 * Engine ids whose PS2 "Skill Level" gates equipping (native `341858`): melee 14 and Bow 79 against the melee / archery
 * skill rows, Armor 45 against the character level. No Order of the Flame item class has a requirement field, so the
 * template's value is a Drakan 2 restriction the PC item never had (the Chain Mail cloned from "Chain Armor" needed
 * level 3, Dragon Armor level 8).
 */
const EQUIP_REQUIREMENT_RFL: ReadonlySet<number> = new Set([14, 79, 45]);

/** The template's "Skill Level" index when it is an inherited equip requirement absent from the PC schema, else -1. */
function inheritedWeaponSkillField(pc: OdbClass, tpl: OdbClass): number {
    if (
        !EQUIP_REQUIREMENT_RFL.has(pc.rflClass ?? -1) ||
        pc.rflClass !== tpl.rflClass ||
        !pc.fields ||
        pc.fields?.some((f) => f.name.trim().toLowerCase() === 'skill level')
    )
        return -1;
    const matches = (tpl.fields ?? []).flatMap((f, i) => (f.name.trim().toLowerCase() === 'skill level' ? [i] : []));
    const i = matches.length === 1 ? matches[0]! : -1;
    return i >= 0 && tpl.fields![i]!.type === FIELD_INT && tpl.data?.[i] !== undefined ? i : -1;
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
    mapModel?: (ref: number) => number | null,
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
        const isClassRef = fieldBase(f.type) === 3;
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
            if (fieldIsArray(f.type)) {
                if (!mapClassRef) {
                    skipped.push(f.name);
                    return;
                }
                const refs = decodeFieldValue(f.type, dword, pc.data ?? []) as number[];
                const mapped = refs.map((ref) => mapClassRef(ref));
                if (mapped.some((ref) => ref === null || ref === undefined)) skipped.push(f.name);
                const words = mapped.filter((ref): ref is number => ref !== null && ref !== undefined);
                out[j] = words.length ? ((words.length << 16) | out.length) >>> 0 : 0;
                out.push(...words.map((ref) => ref >>> 0));
                copied.push(f.name);
                return;
            }
            const mapped = mapClassRef ? mapClassRef(dword) : null;
            if (mapped === null || mapped === undefined) {
                skipped.push(f.name);
                return;
            }
            out[j] = mapped >>> 0;
            copied.push(f.name);
            return;
        }
        if (mapModel && fieldBase(f.type) === FIELD_MODEL) {
            // Model fields name PC models; the converted copies have new ids. Only a field whose every model converted is
            // carried: a Volcanic "ice cover" otherwise morphed through the template's Crown of Thorns spikes (issue 5).
            const refs = fieldIsIndirect(f.type)
                ? (decodeFieldValue(f.type, dword, pc.data ?? []) as number[])
                : [dword];
            const mapped = refs.map((r) => (r ? mapModel(r) : 0));
            if (mapped.some((r) => r === null)) {
                skipped.push(f.name);
                return;
            }
            const words = mapped as number[];
            if (fieldIsIndirect(f.type)) {
                out[j] = words.length ? ((words.length << 16) | out.length) >>> 0 : 0;
                out.push(...words.map((w) => w >>> 0));
            } else out[j] = words[0]! >>> 0;
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
        // PC particle classes can carry a life time of 0 (the PS2 emitter then hangs the level load in its spawn loop: rfl 43 / 71 / 97
        // cloned into a template ODB, ootf-fx-flames.md). Use 0.5 s, the life of the disc's own flame particles (0.1 to 0.8).
        if (dword === 0 && f.name === 'Particle Life Time' && fieldBase(f.type) === FIELD_FLOAT) {
            out[j] = 0x3f000000;
            copied.push(f.name);
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
        const idleFallback = animFallback(pf, pc.data ?? [], animMap);
        const dying = deathFallback(pf, pc.data ?? [], animMap);
        for (const j of foreignAnim) {
            const isDeath = (DEATH_CLIP_FIELDS as readonly string[]).includes(tf[j]!.name.trim().toLowerCase());
            const alias = FOREIGN_ANIM_ALIASES.get(tf[j]!.name.trim().toLowerCase())
                ?.map((n) => pcClip(pf, pc.data ?? [], animMap, n))
                .find((n) => n !== undefined);
            const fallback = alias ?? (isDeath ? dying : undefined) ?? idleFallback;
            if (fallback === undefined) continue;
            const v = out[j] ?? 0;
            if (fieldIsIndirect(tf[j]!.type)) {
                const n = v >>> 16;
                if (n === 0) continue;
                out[j] = ((n << 16) | out.length) >>> 0;
                for (let k = 0; k < n; k++) out.push(fallback);
            } else if ((v & 0xffff) !== 0) out[j] = fallback;
        }
    }
    // Original melee/Bow/Armor classes have no TAG skill gate. Native 341858 rejects weapons whose scalar Skill Level
    // exceeds stats row 1/2 and armour above the character level. A clone must not inherit that template restriction.
    const skill = inheritedWeaponSkillField(pc, tpl);
    if (skill >= 0) out[skill] = 0;
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
export function patchRecordModel(rec: Uint8Array, model: { id: number; db: number }, bounds?: Uint8Array): Uint8Array {
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
    if (
        (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.[
            'OOTF_IDS_BELOW_MAX'
        ] === '1'
    ) {
        for (let id = max - 1; id > min; id--) if (!taken.has(id) && !reserved?.has(id)) out.push(id);
        return out;
    }
    for (let id = max + 1 + LANGUAGE_ID_MARGIN; id <= 0xfffe; id++) if (!reserved?.has(id)) out.push(id);
    return out;
}

/**
 * New class ids start this far above the ODB maximum. The converter reads the English tree, but a pack is mounted on the
 * game language's tree, and those trees carry a few dialogue classes of their own above the English maximum (Level 1 -
 * Common: German 2356, Italian 2352 to 2356, Spanish 2352; English ends at 2351). A new record with such an id loses to the
 * language's own one: in the German game every converted Visibility Toggler of the campaign ran as a dialogue line, so
 * Alwarren's Bell Hammer was never hidden and never shown (issue 5).
 */
export const LANGUAGE_ID_MARGIN = 16;

function dataSignature(c: OdbClass): string {
    return (c.data ?? []).join(',');
}

/**
 * Decide, for every PC class, whether an existing PS2 class stands in, a new record is cloned from a PS2 class of the
 * same engine id, or the class is unsupported. Deterministic for a given input order: pass the union of the classes of
 * all levels of one pack so that every level uses the same ids. `ps2` is the set of ODBs reachable from the template.
 */
export function planClassMapping(pc: readonly PcClassIn[], ps2: readonly Ps2OdbIn[], opt: PlanOptions = {}): ClassPlan {
    const debug = ootfClassDebug();
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
        const modelFader = rfl === FADER_RFL && !!cls.model && !!opt.substituteEngineId;
        const info = modelFader ? ENGINE_CLASSES.get(MODEL_FADER_STANDIN) : ENGINE_CLASSES.get(rfl);
        let cands = byRfl.get(rfl) ?? [];
        let substituted = false;
        // The Pressure Plate (29): the handler 0x45de10 is registered in PAL, but the databases a converted level names hold no
        // class of it (the disc's two live in LEVEL4ON and LEVEL8OS). The PC class has the PS2 schema field for field, so
        // its record is written from the PC defaults with the converted PC model (ootfpush.ts).
        if (rfl === 29 && opt.modelOdbFile && opt.modelFor && cls.model) {
            const host = ps2.find((o) => o.file === opt.modelOdbFile);
            const model = host ? opt.modelFor(cls, host.file) : null;
            const bounds = model ? opt.modelBounds?.(model.id, host!.file, model.db) : undefined;
            const classId = host ? nextId(host.file) : undefined;
            if (
                host &&
                model &&
                bounds?.length === 64 &&
                classId !== undefined &&
                cls.data?.length === PRESSURE_PLATE_FIELDS.length &&
                cls.fields?.length === PRESSURE_PLATE_FIELDS.length &&
                cls.fields.every((f, i) => f.name.trim() === PRESSURE_PLATE_FIELDS[i])
            ) {
                const name = cls.name.trim() || 'OotF Pressure Plate';
                // The two sounds are PC sound references; they stay silent until they are converted.
                const data = cls.data.map((v, i) => (/Sound$/.test(PRESSURE_PLATE_FIELDS[i]!) ? 0 : v));
                const group =
                    [...host.classes.values()].find((c) => c.rflClass === 35)?.group ??
                    host.classes.values().next().value?.group ??
                    0;
                const body = new Uint8Array(94 + data.length * 4);
                const dv = view(body);
                dv.setUint16(0, group, true);
                dv.setUint16(2, model.id, true);
                dv.setUint16(4, model.db, true);
                dv.setUint16(14, 1, true); // model / bounds block follows
                body.set(bounds, 16);
                dv.setUint16(80, 29, true);
                dv.setUint16(82, 1, true);
                dv.setUint16(84, cls.icon ?? 0, true);
                dv.setUint32(86, data.length, true);
                dv.setUint32(90, data.length, true);
                data.forEach((v, i) => dv.setUint32(94 + i * 4, v >>> 0, true));
                const out: OdbClass = { ...cls, id: classId, name, group, runtimeClass: 0x1001d, model, data };
                synthesized.push({
                    pcKeys: [key],
                    name,
                    file: host.file,
                    dbIndex: host.dbIndex,
                    classId,
                    group,
                    rfl: 29,
                    template: { dbIndex: host.dbIndex, classId: 0, name: 'Native Pressure Plate schema' },
                    record: joinClassRecord(name, body),
                    cls: out,
                    copied: cls.fields.map((f) => f.name),
                    skipped: [],
                    coverage: 1,
                });
                continue;
            }
        }
        const sub = substituteFor(cls, opt.substituteEngineId);
        if ((!cands.length || FORCED_SUBSTITUTES.has(rfl) || modelFader) && sub !== undefined) {
            cands = byRfl.get(sub) ?? [];
            substituted = cands.length > 0;
        }
        // 1. same name and same engine class (unless the caller wants the PC model converted instead: `keepOwnModel`)
        const loose = squash(cls.name);
        const pickNamed = (want: string): Cand | undefined =>
            cands
                .filter((c) => squash(c.cls.name) === want)
                .sort((a, b) => a.odb.dbIndex - b.odb.dbIndex || a.id - b.id)[0];
        // Test aid: DRAKAN_DBG_NAMEMAP="PC class=PS2 class;..." maps a PC class straight onto an existing PS2 class (no clone).
        const nameMap = debug.names.get(cls.name.trim().toLowerCase());
        const named = nameMap
            ? pickNamed(squash(nameMap))
            : opt.keepOwnModel?.(cls)
              ? undefined
              : (pickNamed(loose) ?? pickNamed(aliasSquash(cls.name)));
        const namedSkill = named ? inheritedWeaponSkillField(cls, named.cls) : -1;
        const skillRestricted = namedSkill >= 0 && (named!.cls.data![namedSkill]! | 0) > 0;
        // A same-name native weapon with a skill requirement is not an equivalent original weapon. Clone it
        // instead of modifying the shared TAG record. Explicit diagnostic name mappings retain their requested target.
        if (named && (nameMap || !skillRestricted)) {
            mapped.set(key, { dbIndex: named.odb.dbIndex, classId: named.id, cls: named.cls });
            continue;
        }
        const sameNameSkillClone = !!named && skillRestricted && !nameMap;
        if (sameNameSkillClone) cands = [named!]; // keep the already equivalent native model/template
        // PAL registers Trail Master (0x10051) and its handler without shipping an ODB template.
        // Require the audited native field types and explicitly converted model; relocate its tracer reference later.
        if (!cands.length && rfl === 81) {
            const types = [0x4003, 7, 1, ...Array<number>(15).fill(2)];
            // PC editor spellings, audited in order against the native Trail Master descriptor semantics.
            const names = [
                'Special Effect (TRACER!)',
                'Face Camera',
                'Total Cycles (-1 = forever)',
                'Square progression Range (0 = linear)',
                'Initial Y Offset',
                'Initial Angle Offset',
                'Direction (1 or -1)',
                'Upward Velocity (wu/s)',
                'Max Ceiling',
                'Forward Velocity (s/rotation)',
                'Initial Radius (wu)',
                'Final Radius (wu)',
                'Max Vertical Ribbon Offset',
                'Vertical Ribbon Speed',
                'Max Horizontal Ribbon Offset',
                'Horizontal Ribbon Speed',
                'Ellipse Scale (X)',
                'Ellipse Scale (Y)',
            ];
            const host = ps2.find((o) => o.file === opt.modelOdbFile);
            const model = host && cls.model ? opt.modelFor?.(cls, host.file) : null;
            const bounds = model ? opt.modelBounds?.(model.id, host!.file, model.db) : undefined;
            if (
                !host ||
                !model ||
                opt.modelSkinned?.(cls) !== false ||
                bounds?.length !== 64 ||
                cls.fields?.length !== types.length ||
                cls.fields.some((f, i) => f.type !== types[i] || f.name.trim() !== names[i]) ||
                cls.data?.length !== types.length
            ) {
                unsupported.set(key, {
                    reason: 'needs-model',
                    detail: 'Trail Master requires the verified ordered schema, rigid converted model and bounds',
                });
                continue;
            }
            const classId = nextId(host.file);
            if (classId === undefined) {
                unsupported.set(key, { reason: 'no-free-id', detail: `${host.file} has no free class id` });
                continue;
            }
            const name = cls.name.trim() || 'OotF Trail Master';
            const data = [...cls.data];
            const group =
                [...host.classes.values()].find((c) => c.rflClass === 60)?.group ??
                host.classes.values().next().value?.group ??
                0;
            const body = new Uint8Array(94 + data.length * 4);
            const dv = view(body);
            dv.setUint16(0, group, true);
            dv.setUint16(2, model.id, true);
            dv.setUint16(4, model.db, true);
            dv.setUint32(6, 1, true); // rigid model, no skeleton/controller flags
            dv.setUint16(14, 1, true); // model/bounds block follows
            body.set(bounds, 16);
            dv.setUint16(80, 81, true);
            dv.setUint16(82, 1, true);
            dv.setUint16(84, cls.icon ?? 0, true);
            dv.setUint32(86, types.length, true);
            dv.setUint32(90, data.length, true);
            data.forEach((v, i) => dv.setUint32(94 + i * 4, v >>> 0, true));
            const out: OdbClass = { ...cls, id: classId, name, group, runtimeClass: 0x10051, model, data };
            synthesized.push({
                pcKeys: [key],
                name,
                file: host.file,
                dbIndex: host.dbIndex,
                classId,
                group,
                rfl: 81,
                template: { dbIndex: host.dbIndex, classId: 0, name: 'Native Trail Master schema' },
                record: joinClassRecord(name, body),
                cls: out,
                copied: cls.fields.map((f) => f.name),
                skipped: [],
                coverage: 1,
            });
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
        const modelStandIn = substituted && (MODEL_STANDINS.has(rfl) || modelFader);
        // Particle emitters (43, 71, 97): the PC model is only an emitter box. The clone keeps the template's own emitter model.
        const ownFxModel =
            !substituted &&
            FX_OWN_MODEL_RFL.has(rfl) &&
            !!opt.modelFor &&
            !!cls.model &&
            cands.some((c) => !!c.odb.raw?.(c.id));
        const noModel = debug.noModel?.test(cls.name) ?? false;
        // A break-away floor (44) is drawn from the pieces of its "Model List", never from the class model; a PC floor whose
        // class also names a model (Alwarren's "Brick17": model 4101, Model List [4101]) is cloned like the model-less ones.
        const breakaway = rfl === 44;
        const wantsModel =
            !breakaway &&
            !sameNameSkillClone &&
            (!substituted || modelStandIn) &&
            !ownFxModel &&
            !!kind &&
            !!opt.modelFor &&
            !!cls.model &&
            (!RETARGET_KINDS.has(kind) || rfl === 111) &&
            !noModel; // test aid: keep the template's own model
        // A model-less PC class of a mechanism / scenery / fx / generator engine class (Break Brick floor, Fire Fly Axis, Volcanic's
        // "Arrow launcher" ...) is cloned from a model-less PS2 class of the same engine id: the clone shows nothing it should not.
        // Volcanic's launcher cloned from "Bridge Generator" kept that model and its arrow ended on its first step (issue 5).
        const modelless =
            !substituted &&
            (!cls.model || breakaway) &&
            (kind === 'mechanism' || kind === 'scenery' || kind === 'fx' || kind === 'spawn') &&
            cands.some((c) => !c.cls.model && !!c.odb.raw?.(c.id));
        if (
            !kind ||
            !(
                RETARGET_KINDS.has(kind) ||
                substituted ||
                opt.borrowModelKinds?.has(kind) ||
                wantsModel ||
                modelless ||
                ownFxModel ||
                sameNameSkillClone ||
                noModel
            )
        ) {
            unsupported.set(key, {
                reason: 'needs-model',
                detail: `${info?.name ?? `engine class ${rfl}`} (${kind ?? 'unknown'}) needs a model; none can be taken from the PC data`,
            });
            continue;
        }
        // 2. clone the PS2 class of the same engine id whose defaults are closest to the PC class
        let best: { c: Cand; m: Merge } | null = null;
        const hostPool = wantsModel
            ? cands.filter(
                  (c) => c.cls.model && c.odb.raw?.(c.id) && (!opt.modelOdbFile || c.odb.file === opt.modelOdbFile),
              )
            : [];
        // No template with a model in the host ODB (doors, switches, ladders, ropes, fx ...): take one from an ODB that lists the host
        // in its .DB; the converted model is then named with that ODB's own 'db' index of the host ('modelFor').
        const pool = wantsModel
            ? hostPool.length
                ? hostPool
                : cands.filter((c) => c.cls.model && c.odb.raw?.(c.id) && opt.modelOdbFiles?.has(c.odb.file))
            : modelless
              ? cands.filter((c) => !c.cls.model && !!c.odb.raw?.(c.id))
              : ownFxModel
                ? cands.filter(
                      (c) =>
                          !!c.odb.raw?.(c.id) &&
                          (c.odb.file === opt.modelOdbFile || !!opt.modelOdbFiles?.has(c.odb.file)),
                  )
                : BOXED_TEMPLATE_RFL.has(rfl) && cands.some((c) => c.cls.model && c.odb.raw?.(c.id))
                  ? cands.filter((c) => c.cls.model && c.odb.raw?.(c.id))
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
        const rigidBow = wantsModel && rfl === 79 && opt.modelSkinned?.(cls) === false;
        if (rigidBow) {
            // Native Bow controllers are selected by class header flags, independently of the model reference.
            // A rigid PC bow has no skeleton/controller record: an animated (33) template reaches the native
            // scene walker with a null actor controller. Native rigid crossbows use flags 1 and load-clip IDs 0.
            // Keep their complete native template rather than merely clearing an animated template's flag.
            const rigid = pool.filter((c) => {
                const raw = c.odb.raw?.(c.id);
                if (!raw) return false;
                const body = splitClassRecord(raw).body;
                return body.length >= 10 && [0, 1].includes(view(body).getUint32(6, true));
            });
            pool.splice(0, pool.length, ...rigid);
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
            unsupported.set(key, {
                reason: 'no-raw-record',
                detail: rigidBow
                    ? 'no compatible rigid PS2 Bow template with class flags 0/1 carries a model'
                    : `no PS2 class of engine class ${rfl} carries a model`,
            });
            continue;
        }
        // Two new records cloned from the same template broke the ODB load in game (ootf-ingame.md bisect, K=3 vs K=2), so a
        // template is reused only when no other candidate of that engine class is left.
        const fresh = pool.filter((c) => !usedTemplates.has(`${c.odb.file}|${c.id}`));
        if (
            (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.[
                'DRAKAN_DBG_TPLRIG'
            ]
        ) {
            // Test aid: rig size of the converted model against each candidate template (flags = body u32 at 6).
            const mj = opt.modelJoints?.(cls);
            if (mj !== undefined)
                for (const c of pool) {
                    const raw = c.odb.raw?.(c.id);
                    const fl = raw ? view(splitClassRecord(raw).body).getUint32(6, true) : -1;
                    console.warn(
                        `TPLRIG ${cls.name} (${mj} joints) cand "${c.cls.name}"#${c.id} joints=${opt.templateJoints?.(c.cls, c.odb.file)} flags=${fl}`,
                    );
                }
        }
        // `reset` classes (map markers) always use one template, so every PC class of the id folds into one record.
        const resetTemplate = CLONE_ADJUST.get(rfl)?.reset
            ? [...pool]
                  .sort((a, b) => a.odb.dbIndex - b.odb.dbIndex || a.id - b.id)
                  .filter((c) => {
                      const ti = c.cls.fields?.findIndex((f) => f.name.trim().toLowerCase() === 'type') ?? -1;
                      return ti < 0 || c.cls.data?.[ti] === 1;
                  })
            : [];
        // Test aid: DRAKAN_DBG_TPLFORCE="PC class=PS2 template;..." pins the template of a class (to tell template traits from model traits).
        const forced = debug.templates.get(cls.name.trim().toLowerCase())?.toLowerCase();
        const forcedPool = forced ? pool.filter((c) => c.cls.name.trim().toLowerCase() === forced) : [];
        for (const c of forcedPool.length
            ? forcedPool
            : resetTemplate.length
              ? resetTemplate.slice(0, 1)
              : fresh.length
                ? fresh
                : pool) {
            const m = mergeDefaults(
                cls,
                c.cls,
                opt.mapClassRef,
                opt.mapAnimFor?.(cls),
                wantsModel,
                opt.modelJoints?.(cls),
                opt.mapModelFor?.(cls, c.odb.file),
            );
            if (!best || m.coverage > best.m.coverage || (m.coverage === best.m.coverage && m.same > best.m.same))
                best = { c, m };
        }
        const { c } = best!;
        const adj = modelFader ? MODEL_FADER_ADJUST : CLONE_ADJUST.get(rfl);
        const m = adj ? adjustClone(cls, c.cls, best!.m, adj) : best!.m;
        usedTemplates.add(`${c.odb.file}|${c.id}`);
        if (opt.rewriteText && c.cls.fields) opt.rewriteText(c.odb.file, c.cls.fields, m.data);
        // Model-less scenery (Dragon Detector / Dragon Location Object ... markers) is inert whatever the template's fields are.
        const floorZero = wantsModel || (substituted && kind === 'mp') || !!adj || (modelless && kind === 'scenery');
        if (m.coverage < (floorZero ? 0 : minCoverage)) {
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
                unsupported.set(key, {
                    reason: 'needs-model',
                    detail: `the PC model of "${cls.name}" was not converted`,
                });
                continue;
            }
        }
        // Reference defaults are relocated after the complete plan exists. Distinct source namespaces must not fold
        // into one clone merely because their unrelated template defaults happened to match before relocation.
        const refIdentity = cls.fields?.some((f) => fieldBase(f.type) === 3) ? `|refs:${key}` : '';
        const markerIdentity = rfl === 104 ? markerClassIdentity(cls.name) : '';
        const sig = `${c.odb.file}|${c.id}|${m.data.join(',')}|${modelRef ? `${modelRef.db}:${modelRef.id}` : ''}${refIdentity}${markerIdentity}`;
        const prev = done.get(sig);
        if (prev) {
            prev.pcKeys.push(key);
            if (rigidBow) prev.rigidBowTemplate = true;
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
        // PS2 headers carry an auxiliary class reference at +10/+12, independently of the field list. PC ODB
        // records have no equivalent (pc.ts parsePcClassRecord). Never inherit a template's unrelated companion:
        // e.g. the native air-current template attaches a Dust Devil generator to every imported river volume.
        // The one companion a clone does carry is the caller's (`companionFor`: the child part of a swapped-in disc weapon).
        // Preserve +14, which announces the following model/bounds block; actual source class defaults are relocated later.
        const recordParts = splitClassRecord(record);
        const ownHeader = recordParts.body.slice();
        view(ownHeader).setUint32(10, (raw && opt.companionFor?.(cls, c.odb.file)) || 0, true);
        record = joinClassRecord(recordParts.name, ownHeader);
        if (modelRef && raw)
            record = patchRecordModel(record, modelRef, opt.modelBounds?.(modelRef.id, c.odb.file, modelRef.db));
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
            rigidBowTemplate: rigidBow || undefined,
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

const fixedDefaults = new WeakMap<Synthesized, Map<number, number>>();

/**
 * Write class defaults (field name -> dword; a string field takes the XDB id itself) into a synthesized record and its
 * parsed `cls`. The first value written to a field wins: a later different value is returned as a conflict (map
 * coordinates excepted, the placed objects keep their own). Unknown names are ignored.
 */
export function setSynthesizedDefaults(s: Synthesized, values: readonly [string, number][]): string[] {
    const fields = s.cls.fields ?? [];
    const fixed = fixedDefaults.get(s) ?? fixedDefaults.set(s, new Map()).get(s)!;
    const edits = new Map<number, number>();
    const conflicts: string[] = [];
    for (const [name, value] of values) {
        const j = fields.findIndex((f) => f.name.trim().toLowerCase() === name.trim().toLowerCase());
        if (j < 0 || fieldIsArray(fields[j]!.type)) continue;
        const v = value >>> 0;
        const had = fixed.get(j);
        if (had !== undefined) {
            if (had !== v && !/coordinate/i.test(name))
                conflicts.push(`class ${s.name}: ${name} ${v} differs from ${had}; kept ${had}`);
            continue;
        }
        fixed.set(j, v);
        edits.set(j, v);
    }
    if (edits.size) {
        s.record = patchClassData(s.record, edits);
        const data = [...(s.cls.data ?? [])];
        for (const [j, v] of edits) data[j] = v;
        s.cls.data = data;
    }
    return conflicts;
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
        const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.[
            'DRAKAN_LEVEL_TIME'
        ];
        const hour = env !== undefined && env !== '' ? Number(env) : lum < NIGHT_FOG_LUMINANCE ? NIGHT_HOUR : undefined;
        if (hour !== undefined)
            specs.push({ fieldIndex: timeIdx, type: sf[timeIdx]!.type, name: sf[timeIdx]!.name, value: hour });
    }
    return { specs, left };
}

/** PC fog colours darker than this (mean of R, G, B, 0-255) make a converted level a night level. */
export const NIGHT_FOG_LUMINANCE = 64;
/** `Level Time (0-24hrs)` of a night level. */
export const NIGHT_HOUR = 0;
