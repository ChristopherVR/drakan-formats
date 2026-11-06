// Order of the Flame text -> PS2 XDB string tables.
// Evidence and call order: docs/journal/2026-10-31/ootf-campaign.md section 3. Facts (counts only, from the user's install):
//
//   * `Dragon.rrc` (SRSC, PC): 426 records of type 0x0400 = UI/item/level-name strings. The body is XOR-obfuscated with a fixed
//     32-byte key repeated from byte 0 (recovered statistically from the 426 strings and confirmed by 0 undecodable bytes);
//     the text has no length prefix and no terminator. Record `id` is the string id, `sub` 0.
//   * Other files refer to them as `<0xNNNN>fallback text` (item `DisplayName`, level header names); NNNN is the Dragon.rrc id.
//   * The only prose in the levels is the class field `Message String` of Detector/Trigger classes (36 class defaults, 11
//     object overrides; hint pop-ups such as the Rimril briefing) and `DisplayName` (162 class defaults, 27 overrides).
//     OotF has no Conversation / dialogue classes (no spoken lines, no subtitles) and no Book class with text: the
//     "Ruined Village Book" is a cut-scene level.
//   * PS2: a string field of a class or object is an XDB id (dword = id, length 0) into the XDB of the class's database;
//     text in the XDB is Windows-1252 with `\r\n` line breaks (docs/reference/level-format.md section 13 / 15.4).

import { cp1252Byte } from './xdb.ts';
import { rawToCp1252 } from './ootfsource.ts';
import { encodeXdbString } from './xdbwrite.ts';
import {
    FIELD_STRING,
    decodeFieldValue,
    fieldBase,
    fieldIsArray,
    fieldIsIndirect,
    type ClassFieldDef,
} from './fields.ts';
import type { LvlObject, LvlObjectList } from './lvl.ts';
import type { SrscReader } from './srsc.ts';

// ---------------------------------------------------------------- Dragon.rrc

export const RRC_STRING_TYPE = 0x0400;

/** Repeating XOR key of the 0x0400 records of the PC `Dragon.rrc` (period 32). */
export const RRC_STRING_KEY: readonly number[] = [
    0x0d, 0x6a, 0x57, 0xbf, 0xfd, 0xee, 0x74, 0xa7, 0x39, 0xc8, 0x43, 0x1a, 0xd5, 0xaf, 0x7f, 0xfb, 0xdd, 0xe9, 0x4e,
    0x72, 0x90, 0x86, 0x35, 0xab, 0x5f, 0xfe, 0xf7, 0xba, 0xd3, 0x9c, 0xe4, 0x21,
];

/** XOR a record body with the key (the same call encodes and decodes). */
export function xorRrcString(body: Uint8Array): Uint8Array {
    const out = new Uint8Array(body.length);
    for (let i = 0; i < body.length; i++) out[i] = body[i]! ^ RRC_STRING_KEY[i & 31]!;
    return out;
}

export function decodeRrcString(body: Uint8Array): string {
    const x = xorRrcString(body);
    const z = x.indexOf(0);
    let s = '';
    for (let i = 0; i < (z < 0 ? x.length : z); i++) s += String.fromCharCode(x[i]!);
    return s;
}

/** Every 0x0400 string of a `Dragon.rrc` keyed by string id. */
export async function parseRrcStrings(rrc: SrscReader): Promise<Map<number, string>> {
    const out = new Map<number, string>();
    for (const e of rrc.entries) {
        if (e.type !== RRC_STRING_TYPE) continue;
        out.set(e.id, decodeRrcString(await rrc.readRaw(e)));
    }
    return out;
}

// ---------------------------------------------------------------- text cleanup

/** `<0xNNNN>fallback` -> {id, fallback}; plain text -> {id: null, fallback: text}. */
export function splitTextRef(raw: string): { id: number | null; fallback: string } {
    const m = /^<0x([0-9a-fA-F]+)>([\s\S]*)$/.exec(raw);
    return m ? { id: parseInt(m[1]!, 16), fallback: m[2]! } : { id: null, fallback: raw };
}

export interface TextCleanup {
    text: string;
    /** Characters replaced because Windows-1252 cannot show them. */
    replaced: string[];
}

const SUBST: Record<string, string> = {
    '…': '...',
    '→': '->',
};

/**
 * PC text (raw Windows-1252 bytes or Unicode) -> PS2 string: literal `\n` (backslash, n) and `|` line breaks become `\r\n`, bare LF/CR pairs are normalised,
 * trailing blanks go, and anything outside Windows-1252 becomes `?` (listed in `replaced`).
 */
export function cleanGameText(raw: string): TextCleanup {
    // Raw PC bytes 0x80..0x9f are Windows-1252 punctuation (German `„ “`, `’`), not control characters.
    let t = rawToCp1252(raw)
        .replace(/\\n/g, '\n')
        .replace(/\r\n|\r|\n/g, '\n')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n[ \t]+/g, '\n')
        .trim();
    const replaced: string[] = [];
    let out = '';
    for (const ch of t) {
        if (cp1252Byte(ch) >= 0) out += ch;
        else {
            out += SUBST[ch] ?? '?';
            replaced.push(ch);
        }
    }
    t = out.replace(/\n/g, '\r\n');
    return { text: t, replaced };
}

/** Resolve a stored string: the Dragon.rrc text when its id is known, else the fallback after the prefix. */
export function resolveText(raw: string, rrc?: ReadonlyMap<number, string>): string {
    const r = splitTextRef(raw);
    const hit = r.id !== null ? rrc?.get(r.id) : undefined;
    return (hit ?? r.fallback).trim();
}

// ---------------------------------------------------------------- the plan

/** Field names whose text is shown to the player (class defaults and object overrides). */
export const TEXT_FIELDS: ReadonlySet<string> = new Set(['message string', 'displayname']);

export const isTextField = (f: Pick<ClassFieldDef, 'name' | 'type'>): boolean =>
    TEXT_FIELDS.has(f.name.trim().toLowerCase()) && fieldBase(f.type) === FIELD_STRING && !fieldIsArray(f.type);

export interface TextEntryChange {
    file: string;
    type: number;
    id: number;
    sub: number;
    data: Uint8Array;
    isNew: boolean;
}

export interface TextPlanOptions {
    /** First id handed out in every XDB (default 0x6000; raised above `reserve`d ids). */
    base?: number;
    /** XDB `sub` (group) of the new strings (default 1). */
    sub?: number;
    /** Dragon.rrc strings for `<0xNNNN>` references. */
    rrc?: ReadonlyMap<number, string>;
}

/**
 * Allocates XDB string ids for converted text, one id space per XDB file, equal texts sharing one id. Plan every level of a
 * pack with one `TextPlan` so ids stay stable and unique; `entries()` are the `new/<FILE>.XDB/0400_<id>_<sub>.bin` entries.
 */
export class TextPlan {
    private readonly byFile = new Map<string, { next: number; ids: Map<string, number>; used: Set<number> }>();
    readonly warnings: string[] = [];
    private readonly base: number;
    private readonly sub: number;
    private readonly rrc: ReadonlyMap<number, string> | undefined;

    constructor(opt: TextPlanOptions = {}) {
        this.base = opt.base ?? 0x6000;
        this.sub = opt.sub ?? 1;
        this.rrc = opt.rrc;
    }

    private file(name: string) {
        const key = name.toUpperCase();
        let f = this.byFile.get(key);
        if (!f) this.byFile.set(key, (f = { next: this.base, ids: new Map(), used: new Set() }));
        return f;
    }

    /** Ids already present in the target XDB (never handed out). */
    reserve(xdbFile: string, ids: Iterable<number>): void {
        const f = this.file(xdbFile);
        for (const id of ids) {
            f.used.add(id);
            if (id >= f.next) f.next = id + 1;
        }
    }

    /** XDB id for a stored PC string (resolves `<0xNNNN>`); 0 for empty text (= "no string"). */
    idFor(xdbFile: string, raw: string): number {
        const { text, replaced } = cleanGameText(resolveText(raw, this.rrc));
        if (!text) return 0;
        if (replaced.length)
            this.warnings.push(`"${text.slice(0, 40)}": replaced ${[...new Set(replaced)].join(' ')} with ASCII`);
        const f = this.file(xdbFile);
        let id = f.ids.get(text);
        if (id === undefined) {
            while (f.used.has(f.next)) f.next++;
            id = f.next++;
            f.ids.set(text, id);
            f.used.add(id);
        }
        return id;
    }

    /** New string entries, ascending by id within each file. */
    entries(): TextEntryChange[] {
        const out: TextEntryChange[] = [];
        for (const [file, f] of [...this.byFile].sort((a, b) => a[0].localeCompare(b[0]))) {
            for (const [text, id] of [...f.ids].sort((a, b) => a[1] - b[1])) {
                out.push({
                    file,
                    type: RRC_STRING_TYPE,
                    id,
                    sub: this.sub,
                    data: encodeXdbString({ id, sub: this.sub, text: [text] }),
                    isNew: true,
                });
            }
        }
        return out;
    }

    get count(): number {
        let n = 0;
        for (const f of this.byFile.values()) n += f.ids.size;
        return n;
    }
}

// ---------------------------------------------------------------- applying the ids

/**
 * Class defaults: replace every text field's string payload with the XDB id. `data` is the class data area (what
 * `mergeDefaults` returns); the old payload words stay in the area, unused (as for every rewritten string). Call it on a
 * cloned PS2 class record's data before `cloneClassRecord`. Returns the number of fields rewritten.
 */
export function rewriteClassTextDefaults(
    fields: readonly ClassFieldDef[],
    data: number[],
    plan: TextPlan,
    xdbFile: string,
): number {
    let n = 0;
    fields.forEach((f, i) => {
        if (!isTextField(f) || data[i] === undefined) return;
        const text = String(decodeFieldValue(f.type, data[i]!, data));
        data[i] = text ? plan.idFor(xdbFile, text) : 0;
        n++;
    });
    return n;
}

/**
 * Object overrides of a converted PS2 list: every text-field parameter that still holds literal text (the converter copies
 * strings by value) becomes a plain XDB id. `xdbFileOf(o)` names the XDB of the object's class database (null: leave).
 */
export function rewriteObjectTexts(
    list: LvlObjectList,
    plan: TextPlan,
    xdbFileOf: (o: LvlObject) => string | null,
): number {
    let n = 0;
    for (const o of list.objects) {
        if (!o.params.some((p) => isTextField(p))) continue;
        const file = xdbFileOf(o);
        if (!file) continue;
        const k = o.params.length;
        const keep: { p: (typeof o.params)[number]; dword: number; words: number[] | null }[] = [];
        let changed = false;
        o.params.forEach((p, i) => {
            const dword = o.data[i]!;
            if (isTextField(p) && dword >>> 16 > 0) {
                const text = String(decodeFieldValue(p.type, dword, o.data));
                keep.push({ p, dword: plan.idFor(file, text), words: null });
                changed = true;
                n++;
            } else if (fieldIsIndirect(p.type) && dword >>> 16 > 0) {
                const off = dword & 0xffff;
                keep.push({ p, dword, words: o.data.slice(off, off + (dword >>> 16)) });
            } else keep.push({ p, dword, words: null });
        });
        if (!changed) continue;
        const data: number[] = keep.map((x) => x.dword);
        const extra: number[] = [];
        keep.forEach((x, i) => {
            if (!x.words) return;
            data[i] = ((x.words.length << 16) | (k + extra.length)) >>> 0;
            extra.push(...x.words);
        });
        o.data = [...data, ...extra];
    }
    return n;
}
