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
 * counterpart for keep the template's value, as the other PC defaults do.
 */

/** PC sound field name -> the PS2 field it plays as, where the two schemas name the same sound differently (lower case). */
export const PC_SOUND_FIELD_ALIASES: ReadonlyMap<string, string> = new Map([]);

/**
 * PC class-ref field naming a sound effect class (engine class 6, its `Sounds` list) -> the PS2 sound field that plays the
 * same sound. A PC Torch Flame names its crackle through "Sound Effect Object"; the PS2 flame (Wall Torch) has a
 * "Looping Sound" of its own.
 */
export const PC_SOUND_OBJECT_FIELDS: ReadonlyMap<string, string> = new Map([['sound effect object', 'looping sound']]);

const norm = (s: string): string => s.trim().toLowerCase();

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
 * fields with sounds it has none for (`unmatched`, names only). A PC field without a sound is listed with no refs when the
 * template's field has one: the PC class plays nothing there, so the template's Drakan 2 sound is cleared.
 */
export function matchClassSounds(pc: OdbClass, tpl: OdbClass): { fields: ClassSoundField[]; unmatched: string[] } {
    const tf = tpl.fields ?? [];
    const byName = new Map<string, number>();
    tf.forEach((f, j) => {
        if (fieldBase(f.type) === FIELD_SOUND && !byName.has(norm(f.name))) byName.set(norm(f.name), j);
    });
    const fields: ClassSoundField[] = [];
    const unmatched: string[] = [];
    for (const { name, refs } of pcClassSoundRefs(pc, true)) {
        const j = byName.get(norm(name)) ?? byName.get(PC_SOUND_FIELD_ALIASES.get(norm(name)) ?? '');
        if (j === undefined) {
            if (refs.length) unmatched.push(name);
        } else if (refs.length || tpl.data?.[j])
            fields.push({ name, field: j, array: fieldIsIndirect(tf[j]!.type), refs });
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
