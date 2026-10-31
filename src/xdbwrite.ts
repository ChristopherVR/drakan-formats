// Writing `.XDB` string tables back as SRSC entry overrides (the read side is xdb.ts) and finding who uses a string.
//
// A mod pack changes a string by shipping the whole 0x400 entry (`overrides/<FILE>/0400_<id>_<sub>.bin`) and adds a new
// one with `new/<FILE>/0400_<id>_<sub>.bin`. The runtime hands the game the entry bytes verbatim, so the entry is exactly
// what `encodeXdbSlots` produces. Evidence for the layout and for the reference rule: docs/reference/level-format.md
// "String tables" and docs/journal/2026-10-31/story-editing.md.

import { XDB_SLOTS, XDB_STRINGS_TYPE, cp1252Byte, encodeXdbSlots, type XdbString, type XdbStrings } from './xdb.ts';
import { FIELD_STRING, fieldBase, fieldIsArray } from './fields.ts';
import type { OdbClass } from './odb.ts';

export interface XdbEntryPatch {
    type: number;
    id: number;
    sub: number;
    data: Uint8Array;
    /** True for a string the table does not have (ships under `new/`), false for a replacement (`overrides/`). */
    isNew: boolean;
}

/** Text the game can show: the slots are Windows-1252, so only code points up to U+00FF round trip here. */
export function xdbTextProblem(text: string): string | null {
    for (let i = 0; i < text.length; i++) {
        if (cp1252Byte(text[i]!) < 0) return `'${text[i]}' is not in the game's Windows-1252 font table`;
    }
    return null;
}

/** Whether two strings carry the same eight slots. */
export const sameXdbString = (a: XdbString, b: XdbString): boolean =>
    a.sub === b.sub &&
    Array.from({ length: XDB_SLOTS }, (_, i) => (a.text[i] ?? '') === (b.text[i] ?? '')).every(Boolean);

/** Entry bytes of one string set. Throws on text outside Windows-1252. */
export function encodeXdbString(s: XdbString): Uint8Array {
    for (const t of s.text) {
        const p = xdbTextProblem(t);
        if (p) throw new Error(`string ${s.id}: ${p}`);
    }
    return encodeXdbSlots(s.text);
}

/**
 * Entries to ship for the difference between the table as read and as edited: changed strings replace their entry,
 * strings with a new id are added (sub = the edited `sub`). Deleted strings are not expressible (an override cannot
 * remove an entry) and are ignored.
 */
export function diffXdbStrings(original: XdbStrings, edited: XdbStrings): XdbEntryPatch[] {
    const out: XdbEntryPatch[] = [];
    for (const [id, s] of [...edited].sort((a, b) => a[0] - b[0])) {
        const was = original.get(id);
        if (was && sameXdbString(was, s)) continue;
        out.push({ type: XDB_STRINGS_TYPE, id, sub: was ? was.sub : s.sub, data: encodeXdbString(s), isNew: !was });
    }
    return out;
}

/** A free string id: one above the table's largest (ids are small dense numbers). */
export function nextStringId(strings: XdbStrings, atLeast = 1): number {
    let m = atLeast - 1;
    for (const id of strings.keys()) m = Math.max(m, id);
    return m + 1;
}

/** Where a string id is used. */
export interface StringRef {
    /** ODB stem (`SYSTEM`) and class. */
    odb: string;
    classId: number;
    className: string;
    field: string;
}

/**
 * String ids used by class defaults: every string-typed, non-array field of a class default holds the string id itself
 * (docs/reference/level-format.md; proven for Journal Entry / Map Text / DisplayName). `id` 0 means "no string" and is
 * not counted. The XDB a class's ids point into is the one of the same database (System.ODB -> System.XDB).
 */
export function classStringRefs(odb: string, classes: Iterable<OdbClass>): Map<number, StringRef[]> {
    const out = new Map<number, StringRef[]>();
    for (const c of classes) {
        if (!c.fields || !c.data) continue;
        c.fields.forEach((f, i) => {
            if (fieldBase(f.type) !== FIELD_STRING || fieldIsArray(f.type)) return;
            const id = c.data![i]! & 0xffff;
            if (!id) return;
            const list = out.get(id) ?? [];
            list.push({ odb, classId: c.id, className: c.name, field: f.name });
            out.set(id, list);
        });
    }
    return out;
}
