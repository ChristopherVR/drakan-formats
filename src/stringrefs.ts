// String ids used by the parameters of placed level objects, and exit destination texts (editing a level exit's target).
// Evidence: docs/reference/level-format.md (string fields: a dword whose upper half is 0 holds the string id; exits keep the
// destination as a string of the level's own XDB, section 15.4).

import { FIELD_STRING, fieldBase, fieldIsArray } from './fields.ts';
import { resolveClass, type LvlHeader, type LvlObjectList } from './lvl.ts';
import type { OdbIndex } from './odb.ts';
import type { XdbString } from './xdb.ts';

/** A placed object whose string parameter holds a string id. */
export interface ObjectStringRef {
    objectId: number;
    className: string;
    field: string;
}

/**
 * String ids held by string-typed, non-array *parameters* (per-object overrides) of the objects of one level. The id
 * is the low half of the dword when the high half (the inline text length) is 0; 0 means "no string". Class defaults are
 * `classStringRefs`.
 */
export function objectStringRefs(
    header: LvlHeader,
    list: LvlObjectList,
    odbs: OdbIndex,
): Map<number, ObjectStringRef[]> {
    const out = new Map<number, ObjectStringRef[]>();
    for (const o of list.objects) {
        let cls: ReturnType<typeof resolveClass>['class'];
        for (let i = 0; i < o.params.length; i++) {
            const p = o.params[i]!;
            if (fieldBase(p.type) !== FIELD_STRING || fieldIsArray(p.type)) continue;
            const raw = o.data[i];
            if (raw === undefined || raw >>> 16 !== 0 || (raw & 0xffff) === 0) continue;
            cls ??= resolveClass(header, odbs, o.classId, o.dbIndex).class;
            const id = raw & 0xffff;
            const l = out.get(id) ?? [];
            l.push({ objectId: o.id, className: cls?.name ?? `class ${o.classId}`, field: p.name });
            out.set(id, l);
        }
    }
    return out;
}

/**
 * New destination text for a level exit, in the form the old text used: `Levels\<name>\<name>.lvl` stays a path (with
 * the same `Levels` prefix spelling), a bare name stays a bare name. Names are the level list's names.
 */
export function exitDestinationText(oldText: string, level: string): string {
    const t = oldText.trim();
    if (!/\.lvl$/i.test(t) || !/[\\/]/.test(t)) return level;
    const first = t.split(/[\\/]/)[0] ?? 'Levels';
    return `${first}\\${level}\\${level}.lvl`;
}

/** The same string with `text` in every language slot that has text (slot 0 always), as the game shows one destination in every language. */
export function withDestination(s: XdbString, text: string): XdbString {
    const slots = Array.from({ length: Math.max(8, s.text.length) }, (_, i) => s.text[i] ?? '');
    return { ...s, text: slots.map((t, i) => (i === 0 || t ? text : t)) };
}
