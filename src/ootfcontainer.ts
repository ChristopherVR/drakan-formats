import { view } from './bytes.ts';

/** One entry of a container to write. */
export interface Ps2Entry {
    type: number;
    id: number;
    sub: number;
    data: Uint8Array;
}

/**
 * Write a PS2 SRSC container (docs/reference/iop-and-io.md 5.4): 16-byte header `'SRSC', u16 0x0101, u32 indexOffset,
 * u32 count, u16 0`, payloads 8-byte aligned (zero padded) in entry order, index (14 bytes per entry) to end of file.
 * The index keeps the order of `entries`.
 */
export function writePs2Srsc(entries: readonly Ps2Entry[]): Uint8Array {
    let pos = 16;
    const offs: number[] = [];
    for (const e of entries) {
        pos = (pos + 7) & ~7;
        offs.push(pos);
        pos += e.data.length;
    }
    const indexOffset = (pos + 7) & ~7;
    const out = new Uint8Array(indexOffset + entries.length * 14);
    out.set([0x53, 0x52, 0x53, 0x43], 0);
    const dv = view(out);
    dv.setUint16(4, 0x0101, true);
    dv.setUint32(6, indexOffset, true);
    dv.setUint32(10, entries.length, true);
    entries.forEach((e, i) => {
        out.set(e.data, offs[i]!);
        const o = indexOffset + i * 14;
        dv.setUint16(o, e.type, true);
        dv.setUint16(o + 2, e.id, true);
        dv.setUint16(o + 4, e.sub, true);
        dv.setUint32(o + 6, offs[i]!, true);
        dv.setUint32(o + 10, e.data.length, true);
    });
    return out;
}

/** Name area size of PS2 strings: smallest `n >= chars` with `n % 4 == 2` (so `2 + n` is a multiple of 4). */
export function ps2NameLength(chars: number): number {
    let n = chars;
    while (n % 4 !== 2) n++;
    return n;
}

/** `u16 n` + name bytes (Latin-1) zero padded to the PS2 name area size. */
export function ps2String(s: string): Uint8Array {
    const n = ps2NameLength(s.length);
    const out = new Uint8Array(2 + n);
    new DataView(out.buffer).setUint16(0, n, true);
    for (let i = 0; i < s.length; i++) out[2 + i] = s.charCodeAt(i) & 255;
    return out;
}

/** `.DB` dependency list text (CRLF, as the shipped files). Paths use backslashes relative to the `.DB`. */
export function buildDbText(deps: readonly { index: number; path: string }[] = []): string {
    const lines = ['version 1', `dependencies ${deps.length}`];
    for (const d of deps) lines.push(`${d.index} ${d.path.replace(/\//g, '\\')}`);
    return lines.join('\r\n') + '\r\n';
}

/** Parse a `.DB` text: index -> path (backslashes kept). */
export function parseDbText(text: string): Map<number, string> {
    const out = new Map<number, string>();
    for (const line of text.split(/\r?\n/)) {
        const m = /^\s*(\d+)\s+(.+?)\s*$/.exec(line);
        if (m && !/^(version|dependencies)\b/.test(line.trim())) out.set(Number(m[1]), m[2]!);
    }
    return out;
}
