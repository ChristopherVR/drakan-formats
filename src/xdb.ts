// `.XDB` localised string databases (SRSC). Layout verified on every XDB of the PAL disc (docs/reference/level-format.md
// "String tables"):
//   type 0x330  u16 length + NUL padded name, one per group id ("Level 1 - Quests", "Locations", ...)
//   type 0x400  one string set; SRSC `id` is the string id, `sub` a group/page number. Eight slots, each `u16 length +
//               bytes` (length = round up to 4 of chars + 2, minus 2, so every slot starts 4-aligned); text is Windows-1252,
//               NUL terminated when there is padding. Slot order is the language index.
//   type 0x500 / 0x402  small headers (language count / flags)
// Every language folder of the disc carries the same XDB bytes: the folder only picks the slot the game shows.

import { latin1, view } from './bytes.ts';
import type { SrscReader } from './srsc.ts';

export const XDB_STRINGS_TYPE = 0x0400;
export const XDB_NAMES_TYPE = 0x0330;
export const XDB_SLOTS = 8;

/** Slot index per language folder of the disc (slots 5 to 7 are never filled). */
export const XDB_LANGUAGES = ['ENGLISH', 'GERMAN', 'FRENCH', 'ITALIAN', 'SPANISH'] as const;

export function languageSlot(folder: string): number {
    const i = XDB_LANGUAGES.indexOf(folder.toUpperCase() as (typeof XDB_LANGUAGES)[number]);
    return i < 0 ? 0 : i;
}

export interface XdbString {
    id: number;
    sub: number;
    /** All eight slots; empty when a language has no text. */
    text: string[];
}

export type XdbStrings = ReadonlyMap<number, XdbString>;

const cp1252 = new TextDecoder('windows-1252');

/** Decode the eight `u16 length + bytes` slots of a 0x400 body. Missing or truncated slots read as empty. */
export function decodeXdbSlots(body: Uint8Array): string[] {
    const out: string[] = [];
    const dv = view(body);
    let p = 0;
    for (let i = 0; i < XDB_SLOTS; i++) {
        if (p + 2 > body.length) {
            out.push('');
            continue;
        }
        const n = dv.getUint16(p, true);
        const end = Math.min(body.length, p + 2 + n);
        let z = p + 2;
        while (z < end && body[z] !== 0) z++;
        out.push(cp1252.decode(body.subarray(p + 2, z)));
        p += 2 + n;
    }
    return out;
}

const cp1252Reverse = new Map<number, number>();
for (let b = 0x80; b < 0xa0; b++) {
    const ch = cp1252.decode(Uint8Array.of(b));
    if (ch !== '�') cp1252Reverse.set(ch.charCodeAt(0), b);
}

/** Windows-1252 byte of a character, or -1 when it has none. */
export function cp1252Byte(ch: string): number {
    const c = ch.charCodeAt(0);
    if (c < 0x80 || (c >= 0xa0 && c <= 0xff)) return c;
    return cp1252Reverse.get(c) ?? -1;
}

/** Inverse of `decodeXdbSlots` for tests and tools: pad each text to the 4-aligned slot size. */
export function encodeXdbSlots(texts: readonly string[]): Uint8Array {
    const slots: Uint8Array[] = [];
    for (let i = 0; i < XDB_SLOTS; i++) {
        const t = texts[i] ?? '';
        const bytes = Uint8Array.from(t, (c) => Math.max(0, cp1252Byte(c)));
        const n = ((bytes.length + 2 + 3) & ~3) - 2;
        const slot = new Uint8Array(2 + n);
        view(slot).setUint16(0, n, true);
        slot.set(bytes, 2);
        slots.push(slot);
    }
    const out = new Uint8Array(slots.reduce((s, x) => s + x.length, 0));
    let o = 0;
    for (const s of slots) {
        out.set(s, o);
        o += s.length;
    }
    return out;
}

/** Every string set of an XDB keyed by string id (a later record with the same id wins). */
export async function parseXdbStrings(xdb: SrscReader): Promise<Map<number, XdbString>> {
    const out = new Map<number, XdbString>();
    for (const e of xdb.entries) {
        if (e.type !== XDB_STRINGS_TYPE) continue;
        const { data } = await xdb.read(e);
        out.set(e.id, { id: e.id, sub: e.sub, text: decodeXdbSlots(data) });
    }
    return out;
}

/** Group names (type 0x330) keyed by id. */
export async function parseXdbNames(xdb: SrscReader): Promise<Map<number, string>> {
    const out = new Map<number, string>();
    for (const e of xdb.entries) {
        if (e.type !== XDB_NAMES_TYPE) continue;
        const { data } = await xdb.read(e);
        if (data.length < 2) continue;
        const n = view(data).getUint16(0, true);
        const z = data.indexOf(0, 2);
        out.set(e.id, latin1(data, 2, Math.min(2 + n, z < 0 ? data.length : z)));
    }
    return out;
}

/**
 * Text of string `id` in language `slot`. An empty slot falls back to English (many PAL strings have no German or
 * French text), then to the empty string. Soft line breaks (`\r\n`) become spaces.
 */
export function xdbText(strings: XdbStrings, id: number, slot = 0): string {
    const s = strings.get(id);
    if (!s) return '';
    const t = s.text[slot] || s.text[0] || '';
    return t.replace(/\s*\r?\n\s*/g, ' ').trim();
}
