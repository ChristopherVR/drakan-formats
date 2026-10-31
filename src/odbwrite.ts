// Editing ODB class records (type 0x0102) as SRSC entry overrides. A record is `u16 nameLen + name (NUL padded so that
// 2 + nameLen is a multiple of 4) + body`; the body ends in the class data area (one u32 per field, the count in the body
// header, see odb.ts parseClassBody). Scalar fields are patched in place; renaming only changes the name part, because
// nothing in the body is relative to the record start.
// The field-definition lists (type 0x0103, zlib) are matched to records by record order, so a record added with `new/`
// also needs its list appended to that entry (`appendFieldList`).

import { view } from './bytes.ts';
import { parseClassBody, parseFieldLists } from './odb.ts';
import type { ClassFieldDef } from './fields.ts';

export const ODB_GROUP_TYPE = 0x0101;

/** Name area size rule (proven on all 190 System.ODB records): 2 + n is a multiple of 4, n >= chars (no NUL needed). */
export const nameAreaSize = (chars: number): number => ((chars + 2 + 3) & ~3) - 2;

export interface ClassRecordParts {
    name: string;
    /** The bytes after the name area. */
    body: Uint8Array;
}

export function splitClassRecord(rec: Uint8Array): ClassRecordParts {
    const n = view(rec).getUint16(0, true);
    if (2 + n > rec.length) throw new Error('class record: name runs past the record');
    const nameBytes = rec.subarray(2, 2 + n);
    const z = nameBytes.indexOf(0);
    const end = z < 0 ? n : z;
    let name = '';
    for (let i = 0; i < end; i++) name += String.fromCharCode(nameBytes[i]!);
    return { name, body: rec.subarray(2 + n) };
}

export function joinClassRecord(name: string, body: Uint8Array): Uint8Array {
    const n = nameAreaSize(name.length);
    const out = new Uint8Array(2 + n + body.length);
    view(out).setUint16(0, n, true);
    for (let i = 0; i < name.length; i++) out[2 + i] = name.charCodeAt(i) & 0xff;
    out.set(body, 2 + n);
    return out;
}

/** Renamed copy of a record (the name is the developer's class name; the game never shows it). */
export function renameClassRecord(rec: Uint8Array, name: string): Uint8Array {
    return joinClassRecord(name, splitClassRecord(rec).body);
}

/**
 * Copy of a record with data dwords replaced (`edits`: field index -> u32). Throws when the body does not parse or an
 * index is out of range, so a wrong schema cannot silently write elsewhere.
 */
export function patchClassData(rec: Uint8Array, edits: ReadonlyMap<number, number>): Uint8Array {
    const { name, body } = splitClassRecord(rec);
    const parsed = parseClassBody(body);
    if (!parsed) throw new Error(`class '${name}': body does not parse`);
    const out = body.slice();
    const at = out.length - parsed.data.length * 4;
    const dv = view(out);
    for (const [i, v] of edits) {
        if (i < 0 || i >= parsed.data.length) throw new Error(`class '${name}': no data dword ${i}`);
        dv.setUint32(at + i * 4, v >>> 0, true);
    }
    return joinClassRecord(name, out);
}

export function fieldIndex(defs: readonly ClassFieldDef[], name: string): number {
    return defs.findIndex((f) => f.name === name);
}

async function zlibStream(data: Uint8Array, kind: 'compress' | 'decompress'): Promise<Uint8Array> {
    const cs = kind === 'compress' ? new CompressionStream('deflate') : new DecompressionStream('deflate');
    const w = cs.writable.getWriter();
    void w.write(data as Uint8Array<ArrayBuffer>).then(() => w.close());
    const chunks: Uint8Array[] = [];
    const r = cs.readable.getReader();
    for (;;) {
        const { done, value } = await r.read();
        if (done) break;
        chunks.push(value as Uint8Array);
    }
    const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
    let o = 0;
    for (const c of chunks) {
        out.set(c, o);
        o += c.length;
    }
    return out;
}

/** One 0x0103 list: `u32 count`, then per field `u32 type, u16 len, name (NUL terminated)`. */
export function encodeFieldList(defs: readonly ClassFieldDef[]): Uint8Array {
    const parts: Uint8Array[] = [];
    const head = new Uint8Array(4);
    view(head).setUint32(0, defs.length, true);
    parts.push(head);
    for (const d of defs) {
        // same length rule as the class names (smallest value >= chars that is 2 mod 4, NUL padded; checked on the disc)
        const len = nameAreaSize(d.name.length);
        const p = new Uint8Array(6 + len);
        const dv = view(p);
        dv.setUint32(0, d.type, true);
        dv.setUint16(4, len, true);
        for (let i = 0; i < d.name.length; i++) p[6 + i] = d.name.charCodeAt(i) & 0xff;
        parts.push(p);
    }
    const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
    let o = 0;
    for (const p of parts) {
        out.set(p, o);
        o += p.length;
    }
    return out;
}

/**
 * The 0x0103 entry with `defs` appended as the list of a record added at the end of the index. `stored` is the entry as
 * stored (zlib). Returns zlib bytes. Throws when the stored lists do not parse.
 */
export async function appendFieldList(stored: Uint8Array, defs: readonly ClassFieldDef[]): Promise<Uint8Array> {
    const raw = await zlibStream(stored, 'decompress');
    if (!parseFieldLists(raw)) throw new Error('0x0103 field lists do not parse');
    const add = encodeFieldList(defs);
    const joined = new Uint8Array(raw.length + add.length);
    joined.set(raw, 0);
    joined.set(add, raw.length);
    return zlibStream(joined, 'compress');
}
