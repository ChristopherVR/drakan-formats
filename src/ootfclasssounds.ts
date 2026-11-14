import { FIELD_CLASS, FIELD_SOUND, decodeFieldValue, fieldBase, fieldIsIndirect } from './fields.ts';
import type { OdbClass } from './odb.ts';
import { patchClassData, setClassArray } from './odbwrite.ts';
import type { Synthesized } from './ootfclass.ts';

/**
 * Class-default sounds of converted classes (docs/journal/2026-11-14/ootf-class-sounds.md).
 *
 * A PC class names its sounds in fields of type 5 (a ref `db << 16 | id` into an SDB of its database, or a list of them).
 * `mergeDefaults` carries only plain values, so a clone kept the template's sound refs: Drakan 2 sounds, or ids that name
 * nothing in the clone's database (every converted torch asked for sound 0). The sounds stage converts the PC sounds these
 * fields name and writes the converted ids into the clone, field by field: a PC sound field goes to the template's sound
 * field of the same name (or the name `PC_SOUND_FIELD_ALIASES` gives it). Template sound fields the PC class has no
 * counterpart for, or no sound in, keep the template's value (`matchClassSounds` `clear` empties the latter).
 */

/** PC sound field name -> the PS2 field it plays as, where the two schemas name the same sound differently (lower case). */
export const PC_SOUND_FIELD_ALIASES: ReadonlyMap<string, string> = new Map([]);

/**
 * PC class-ref field naming a sound effect class (engine class 6, its `Sounds` list) -> the PS2 sound field that plays the
 * same sound. A PC Torch Flame names its crackle through "Sound Effect Object"; the PS2 flame (Wall Torch) has a
 * "Looping Sound" of its own.
 */
export const PC_SOUND_OBJECT_FIELDS: ReadonlyMap<string, string> = new Map([['sound effect object', 'looping sound']]);

/**
 * Template sound fields that keep the template's value whatever the PC class names (lower case). "Picked Up Sound": an item
 * whose field names a converted clip never reaches the play call when it is picked up (Ruined Village Long Sword: the
 * template's 0xc4 plays, the converted clip makes no call at all; the pickup path at 0x3471d4 checks something the
 * converted clip lacks, not established), so the converted weapons kept the Drakan 2 pickup sound rather than none.
 */
export const TEMPLATE_KEPT_SOUND_FIELDS: ReadonlySet<string> = new Set(['picked up sound']);

/** Creature voice fields a clear rule (`TemplateVoiceClear`) empties by default. Footsteps are not voices and stay. */
export const CREATURE_VOICE_FIELDS: readonly string[] = [
    'I See You Snd',
    'I Hear You Snd',
    'Got Hit Sounds',
    'Damage Reaction Sounds',
    'Death Sounds',
    'Death Sound list',
    'Hit Ground Sound',
    'Wing Flap Sounds',
    'Ambient Sounds',
    'Taunts',
    'Victory Sound',
    'Flee Sound',
    'Crouch (cower) Sound',
    'Chopped off limb sound',
    'Being burnt sound',
    'Sound to play while phasing',
];

/**
 * An OotF creature cloned from a different Drakan 2 creature: the template's sounds in `fields` (default
 * `CREATURE_VOICE_FIELDS`) are emptied unless the PC class has its own sound there (then the PC one plays, as everywhere).
 * Without a rule a PC field without a sound keeps the template's Drakan 2 sound (owner's choice), which on these classes is
 * another creature's voice.
 */
export interface TemplateVoiceClear {
    /** OotF class name (case and spacing ignored). */
    ootf: string;
    /** The Drakan 2 template it is cloned from, for the reader (not checked). */
    template?: string;
    /** Template field names to empty; default `CREATURE_VOICE_FIELDS`. */
    fields?: readonly string[];
    why: string;
}

export const DEFAULT_TEMPLATE_VOICE_CLEARS: readonly TemplateVoiceClear[] = [
    { ootf: 'Succubus', template: 'Gryphon', why: "A gryphon's death scream and landing thud on a succubus." },
    {
        ootf: 'Queen',
        template: 'Armor Gryphon',
        why: "A gryphon's alert calls and death scream on the Succubus Queen.",
    },
    { ootf: 'Drone', template: 'Blade Dragon (Crow)', why: "A crow's caw, wing flaps and landing on the Drone." },
    {
        ootf: 'Crimson Knight',
        template: 'Invisible Wartock',
        why: "A Wartok's alert, burning and phasing voice on a knight.",
    },
    {
        ootf: 'Ebon Knight',
        template: 'Savage Leader - Maulgak',
        fields: [...CREATURE_VOICE_FIELDS, 'Sound'],
        why: "Maulgak's own sound and voices on a knight.",
    },
];

const norm = (s: string): string => s.trim().toLowerCase();
const squashName = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '');

/** The template fields (lower case) the clear rules empty for the PC class `name` (empty set: no rule). */
export function templateVoiceClears(name: string, rules: readonly TemplateVoiceClear[]): ReadonlySet<string> {
    const r = rules.find((x) => squashName(x.ootf) === squashName(name));
    return new Set(r ? (r.fields ?? CREATURE_VOICE_FIELDS).map(norm) : []);
}

/**
 * The PC class refs of `PC_SOUND_OBJECT_FIELDS` that `tpl` has the sound field for, which the PC class does not fill
 * itself: the caller resolves each ref to its sound class and takes that class's sounds (`pcClassSoundRefs`).
 */
export function matchSoundObjects(
    pc: OdbClass,
    tpl: OdbClass,
): { name: string; field: number; array: boolean; ref: number }[] {
    const tf = tpl.fields ?? [];
    const own = new Set(pcClassSoundRefs(pc).map((r) => norm(r.name)));
    const out: { name: string; field: number; array: boolean; ref: number }[] = [];
    (pc.fields ?? []).forEach((f, i) => {
        const want = PC_SOUND_OBJECT_FIELDS.get(norm(f.name));
        const ref = pc.data?.[i] ?? 0;
        if (!want || fieldBase(f.type) !== FIELD_CLASS || fieldIsIndirect(f.type) || !ref || own.has(want)) return;
        const j = tf.findIndex((t) => fieldBase(t.type) === FIELD_SOUND && norm(t.name) === want);
        if (j >= 0) out.push({ name: f.name.trim(), field: j, array: fieldIsIndirect(tf[j]!.type), ref: ref >>> 0 });
    });
    return out;
}

/** One PC sound field of a class and the template field it is written to. */
export interface ClassSoundField {
    /** PC field name. */
    name: string;
    /** Index of the template field. */
    field: number;
    /** The template field is a list (else one ref). */
    array: boolean;
    /** The PC refs (`db << 16 | id` in the PC class's database frame), zeros dropped; empty: the PC class plays none. */
    refs: number[];
}

/** Sound refs of a PC class (every type 5 field, zeros dropped), by field name; `empty` also lists fields with none. */
export function pcClassSoundRefs(pc: OdbClass, empty = false): { name: string; refs: number[] }[] {
    const out: { name: string; refs: number[] }[] = [];
    (pc.fields ?? []).forEach((f, i) => {
        if (fieldBase(f.type) !== FIELD_SOUND) return;
        const v = decodeFieldValue(f.type, pc.data?.[i] ?? 0, pc.data ?? []);
        const refs = (Array.isArray(v) ? v : [v]).filter((r): r is number => typeof r === 'number' && r !== 0);
        if (refs.length || empty) out.push({ name: f.name.trim(), refs: refs.map((r) => r >>> 0) });
    });
    return out;
}

/**
 * The PC sound fields of `pc` that the template `tpl` has a sound field for (same name, else the alias), and the PC sound
 * fields with sounds it has none for (`unmatched`, names only). A PC field without a sound keeps the template's Drakan 2
 * sound (owner's choice: a sound rather than silence); with `clear` it is listed with no refs when the template's field has
 * one, so the template's sound is cleared as the PC class plays nothing there.
 */
export function matchClassSounds(
    pc: OdbClass,
    tpl: OdbClass,
    clear = false,
    clearFields: ReadonlySet<string> = new Set(),
): { fields: ClassSoundField[]; unmatched: string[] } {
    const tf = tpl.fields ?? [];
    const byName = new Map<string, number>();
    tf.forEach((f, j) => {
        if (fieldBase(f.type) === FIELD_SOUND && !byName.has(norm(f.name))) byName.set(norm(f.name), j);
    });
    const fields: ClassSoundField[] = [];
    const unmatched: string[] = [];
    for (const { name, refs } of pcClassSoundRefs(pc, true)) {
        if (TEMPLATE_KEPT_SOUND_FIELDS.has(norm(name))) continue;
        const j = byName.get(norm(name)) ?? byName.get(PC_SOUND_FIELD_ALIASES.get(norm(name)) ?? '');
        if (j === undefined) {
            if (refs.length) unmatched.push(name);
        } else if (refs.length || ((clear || clearFields.has(norm(tf[j]!.name))) && tpl.data?.[j]))
            fields.push({ name, field: j, array: fieldIsIndirect(tf[j]!.type), refs });
    }
    // A clear rule also empties the template's voice fields the PC class does not have at all.
    for (const want of clearFields) {
        const j = byName.get(want);
        if (j === undefined || !tpl.data?.[j] || fields.some((f) => f.field === j)) continue;
        fields.push({ name: tf[j]!.name.trim(), field: j, array: fieldIsIndirect(tf[j]!.type), refs: [] });
    }
    return { fields, unmatched };
}

/**
 * Write converted sound refs into a synthesized record and its parsed `cls`: `values` maps a template field index to the
 * refs in the clone's database frame. A list field gets the list (appended to the data area), a single field the first ref;
 * no refs clear the field.
 */
export function writeClassSounds(s: Synthesized, values: ReadonlyMap<number, readonly number[]>): void {
    const fields = s.cls.fields ?? [];
    const data = [...(s.cls.data ?? [])];
    const scalar = new Map<number, number>();
    let record = s.record;
    for (const [j, refs] of values) {
        const f = fields[j];
        if (!f || fieldBase(f.type) !== FIELD_SOUND) continue;
        if (!refs.length) {
            scalar.set(j, 0);
            data[j] = 0;
        } else if (fieldIsIndirect(f.type)) {
            const offset = data.length;
            record = setClassArray(record, j, refs);
            data[j] = ((refs.length << 16) | offset) >>> 0;
            data.push(...refs.map((r) => r >>> 0));
        } else {
            scalar.set(j, refs[0]! >>> 0);
            data[j] = refs[0]! >>> 0;
        }
    }
    if (scalar.size) record = patchClassData(record, scalar);
    s.record = record;
    s.cls.data = data;
}
