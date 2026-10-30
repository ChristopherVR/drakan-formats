import { type ByteSource, bufferSource, latin1, view } from './bytes.ts';
import { inflate } from './inflate.ts';

export const SRSC_HEADER_SIZE = 16;
export const SRSC_ENTRY_SIZE = 14;

export interface SrscEntry {
    /** Position in the index (stable identity for replacements). */
    index: number;
    type: number;
    id: number;
    sub: number;
    offset: number;
    size: number;
}

export class SrscError extends Error {}

/** zlib stream header check: CMF = 0x78 and (CMF<<8 | FLG) divisible by 31. */
export function looksLikeZlib(b: Uint8Array): boolean {
    return b.length >= 2 && b[0] === 0x78 && ((b[0]! << 8) | b[1]!) % 31 === 0;
}

/**
 * SRSC resource container: 16-byte header `'SRSC', u16 ver, u32 indexOffset, u32 count, u16 pad`, data blocks,
 * then `count` 14-byte index entries `{u16 type, u16 id, u16 sub, u32 offset, u32 size}` to end of file.
 * Layout reference: analysis/scripts/iop_srsc.py, docs/reference/iop-and-io.md section 5.4.
 */
export class SrscReader {
    private constructor(
        readonly source: ByteSource,
        /** The 16 header bytes verbatim (so re-serialising keeps the unknown pad bytes). */
        readonly header: Uint8Array,
        readonly version: number,
        readonly indexOffset: number,
        readonly entries: SrscEntry[],
        /** Bytes after the last index entry (normally empty). */
        readonly trailer: Uint8Array,
        /** Problems that do not prevent reading (range overruns, trailing bytes). */
        readonly warnings: string[],
    ) {}

    static async open(source: ByteSource): Promise<SrscReader> {
        const header = await source.read(0, SRSC_HEADER_SIZE);
        if (header.length < SRSC_HEADER_SIZE || latin1(header, 0, 4) !== 'SRSC') {
            throw new SrscError('missing SRSC magic');
        }
        const dv = view(header);
        const version = dv.getUint16(4, true);
        const indexOffset = dv.getUint32(6, true);
        const count = dv.getUint32(10, true);
        const warnings: string[] = [];
        if (indexOffset < SRSC_HEADER_SIZE || indexOffset > source.size) {
            throw new SrscError('index offset out of range');
        }
        const indexBytes = count * SRSC_ENTRY_SIZE;
        if (indexOffset + indexBytes > source.size) throw new SrscError('index runs past end of file');
        const idx = await source.read(indexOffset, source.size - indexOffset);
        const iv = view(idx);
        const entries: SrscEntry[] = [];
        for (let i = 0; i < count; i++) {
            const o = i * SRSC_ENTRY_SIZE;
            const e: SrscEntry = {
                index: i,
                type: iv.getUint16(o, true),
                id: iv.getUint16(o + 2, true),
                sub: iv.getUint16(o + 4, true),
                offset: iv.getUint32(o + 6, true),
                size: iv.getUint32(o + 10, true),
            };
            if (e.offset + e.size > indexOffset) warnings.push(`entry ${i} range exceeds index offset`);
            entries.push(e);
        }
        const trailer = idx.subarray(indexBytes);
        if (trailer.length) warnings.push(`${trailer.length} trailing bytes after the index`);
        return new SrscReader(source, header, version, indexOffset, entries, trailer, warnings);
    }

    static fromBytes(data: ArrayBuffer | Uint8Array): Promise<SrscReader> {
        return SrscReader.open(bufferSource(data));
    }

    /** (type,id,sub) lookup; `sub` 0xFFFF means any instance (same rule as runtime/hle Srsc::find). */
    find(type: number, id: number, sub = 0xffff): SrscEntry | undefined {
        return this.entries.find((e) => e.type === type && e.id === id && (sub === 0xffff || e.sub === sub));
    }

    /** Stored bytes of an entry, without decompression. `max` caps the read (for previews). */
    readRaw(e: SrscEntry, max?: number): Promise<Uint8Array> {
        return this.source.read(e.offset, max === undefined ? e.size : Math.min(e.size, max));
    }

    /** Entry payload; if it starts with a valid zlib stream that inflates cleanly, the inflated bytes. */
    async read(e: SrscEntry): Promise<{ data: Uint8Array; compressed: boolean }> {
        const raw = await this.readRaw(e);
        if (looksLikeZlib(raw)) {
            const out = inflate(raw);
            if (out) return { data: out, compressed: true };
        }
        return { data: raw, compressed: false };
    }

    /** Cheap zlib detection for listings: reads only 2 bytes. */
    async isCompressed(e: SrscEntry): Promise<boolean> {
        return e.size >= 2 && looksLikeZlib(await this.readRaw(e, 2));
    }
}

/**
 * Serialise a container. Untouched entries keep their original offsets and the original data area (including any
 * alignment gaps) is copied verbatim, so an unmodified archive re-serialises byte-identically. Replaced entries are
 * appended 8-byte aligned after the old data area (old bytes stay, so other entries sharing them are unaffected).
 */
export async function writeSrsc(
    reader: SrscReader,
    replacements: ReadonlyMap<number, Uint8Array> = new Map(),
): Promise<Uint8Array> {
    const data = await reader.source.read(SRSC_HEADER_SIZE, reader.indexOffset - SRSC_HEADER_SIZE);
    const chunks: Uint8Array[] = [data];
    let pos = reader.indexOffset;
    const entries = reader.entries.map((e) => ({ ...e }));
    for (const [index, payload] of [...replacements].sort((a, b) => a[0] - b[0])) {
        const e = entries[index];
        if (!e) throw new SrscError(`no entry with index ${index}`);
        const pad = (8 - (pos % 8)) % 8;
        if (pad) chunks.push(new Uint8Array(pad));
        pos += pad;
        e.offset = pos;
        e.size = payload.length;
        chunks.push(payload);
        pos += payload.length;
    }
    const index = new Uint8Array(entries.length * SRSC_ENTRY_SIZE);
    const iv = view(index);
    entries.forEach((e, i) => {
        const o = i * SRSC_ENTRY_SIZE;
        iv.setUint16(o, e.type, true);
        iv.setUint16(o + 2, e.id, true);
        iv.setUint16(o + 4, e.sub, true);
        iv.setUint32(o + 6, e.offset, true);
        iv.setUint32(o + 10, e.size, true);
    });
    const header = reader.header.slice();
    const hv = view(header);
    hv.setUint32(6, pos, true);
    hv.setUint32(10, entries.length, true);

    const out = new Uint8Array(pos + index.length + reader.trailer.length);
    out.set(header, 0);
    let w = SRSC_HEADER_SIZE;
    for (const c of chunks) {
        out.set(c, w);
        w += c.length;
    }
    out.set(index, pos);
    out.set(reader.trailer, pos + index.length);
    return out;
}
