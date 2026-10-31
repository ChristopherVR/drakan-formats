// Subtitle text of a sound descriptor (SDB type 0x302) and its write-back. Layout (docs/reference/subtitles.md 3.1):
//   `u16 nameLen + name`, then at base: +0 u32 flags (bit 0x2000 = a subtitle string follows), +4 .. +31 rate, detune and
//   constants, +32 either `u16 textLen + text (cp1252, NUL padded)` (flag set) or `u32 2` (no text), then 12 tail bytes
//   (sample bytes / loop data). Checked on the 605 text and 34 non-text descriptors of LEVEL1ON: the text area is padded so
//   that the descriptor ends 4-aligned, and the tail is always 12 bytes.
// Page breaks inside a line: `\<seconds>` (`\.9` = next page after 0.9 s), see `splitSubtitlePages`.

import { latin1, view } from '../bytes.ts';

const TEXT_FLAG = 0x2000;
const TAIL = 12;

export interface SdbText {
    name: string;
    hasText: boolean;
    text: string;
}

function layout(b: Uint8Array): { base: number; name: string } | null {
    if (b.length < 2) return null;
    const n = view(b).getUint16(0, true);
    if (2 + n + 36 > b.length) return null;
    const z = b.indexOf(0, 2);
    return { base: 2 + n, name: latin1(b, 2, z < 0 || z > 2 + n ? 2 + n : z) };
}

const cp1252 = new TextDecoder('windows-1252');
// bytes 0x80..0x9f of windows-1252 that differ from latin-1, for the encoder
const CP_HIGH: Record<number, number> = {
    0x20ac: 0x80,
    0x201a: 0x82,
    0x0192: 0x83,
    0x201e: 0x84,
    0x2026: 0x85,
    0x2020: 0x86,
    0x2021: 0x87,
    0x02c6: 0x88,
    0x2030: 0x89,
    0x0160: 0x8a,
    0x2039: 0x8b,
    0x0152: 0x8c,
    0x017d: 0x8e,
    0x2018: 0x91,
    0x2019: 0x92,
    0x201c: 0x93,
    0x201d: 0x94,
    0x2022: 0x95,
    0x2013: 0x96,
    0x2014: 0x97,
    0x02dc: 0x98,
    0x2122: 0x99,
    0x0161: 0x9a,
    0x203a: 0x9b,
    0x0153: 0x9c,
    0x017e: 0x9e,
    0x0178: 0x9f,
};

export function encodeCp1252(text: string): Uint8Array {
    const out: number[] = [];
    for (const ch of text) {
        const c = ch.codePointAt(0)!;
        out.push(CP_HIGH[c] ?? (c < 256 ? c : 0x3f));
    }
    return Uint8Array.from(out);
}

export function parseSdbText(b: Uint8Array): SdbText | null {
    const l = layout(b);
    if (!l) return null;
    const dv = view(b);
    const flags = dv.getUint32(l.base, true);
    if (!(flags & TEXT_FLAG)) return { name: l.name, hasText: false, text: '' };
    const n = dv.getUint16(l.base + 32, true);
    const start = l.base + 34;
    const end = Math.min(b.length, start + n);
    let z = start;
    while (z < end && b[z] !== 0) z++;
    return { name: l.name, hasText: true, text: cp1252.decode(b.subarray(start, z)) };
}

/**
 * Descriptor with a new subtitle (an empty string leaves an empty text; the flag bit stays as it was). Everything else is copied. Returns null when `b` is not a
 * descriptor of the known layout.
 */
export function writeSdbText(b: Uint8Array, text: string): Uint8Array | null {
    const l = layout(b);
    if (!l) return null;
    const dv = view(b);
    const flags = dv.getUint32(l.base, true);
    const had = (flags & TEXT_FLAG) !== 0;
    if (parseSdbText(b)?.text === text) return b.slice(); // unchanged: keep the original padding byte for byte
    const tailStart = b.length - TAIL;
    const head = b.subarray(0, l.base + 32);
    const tail = b.subarray(tailStart);
    if (had ? tailStart < l.base + 34 : tailStart !== l.base + 36) return null;
    const mid: number[] = [];
    if (text === '' && !had) {
        mid.push(2, 0, 0, 0);
    } else {
        const raw = encodeCp1252(text);
        const start = l.base + 34;
        const len = ((start + raw.length + 1 + 3) & ~3) - start;
        mid.push(len & 255, len >> 8, ...raw);
        for (let i = raw.length; i < len; i++) mid.push(0);
    }
    const out = new Uint8Array(head.length + mid.length + tail.length);
    out.set(head, 0);
    out.set(mid, head.length);
    out.set(tail, head.length + mid.length);
    const f = view(out).getUint32(l.base, true);
    view(out).setUint32(l.base, had || text !== '' ? f | TEXT_FLAG : f, true);
    return out;
}

export interface SubtitlePage {
    text: string;
    /** Seconds the page stays before the next one (page 0 is shown at once); 0 for the last page. */
    delay: number;
}

/** Split `Have you heard? \.9 They say ...` into pages; the number after a backslash is the delay before the NEXT page. */
export function splitSubtitlePages(text: string): SubtitlePage[] {
    const pages: SubtitlePage[] = [];
    const parts = text.split('\\');
    pages.push({ text: parts[0]!.trim(), delay: 0 });
    for (let i = 1; i < parts.length; i++) {
        const m = /^(\d*\.?\d+|\d+\.?)/.exec(parts[i]!);
        const delay = m ? Number(m[1]) : 0;
        pages[pages.length - 1]!.delay = delay;
        pages.push({ text: parts[i]!.slice(m ? m[0].length : 0).trim(), delay: 0 });
    }
    return pages;
}

export function joinSubtitlePages(pages: readonly SubtitlePage[]): string {
    let out = pages[0]?.text ?? '';
    for (let i = 1; i < pages.length; i++) {
        const d = pages[i - 1]!.delay;
        const token = d > 0 && d < 1 ? String(d).replace(/^0/, '') : String(d);
        out += ' \\' + token + ' ' + pages[i]!.text;
    }
    return out;
}
