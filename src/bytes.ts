/** Random-access, read-only byte provider. Lets a browser `File`/`Blob` back a multi-GB disc image without loading it. */
export interface ByteSource {
    readonly size: number;
    /** Read `length` bytes at `offset`. Reads past the end are truncated (short result), never an error. */
    read(offset: number, length: number): Promise<Uint8Array>;
}

export function bufferSource(data: ArrayBuffer | Uint8Array): ByteSource {
    const u8 = data instanceof Uint8Array ? data : new Uint8Array(data);
    return {
        size: u8.byteLength,
        read(offset, length) {
            const start = Math.min(Math.max(offset, 0), u8.byteLength);
            const end = Math.min(start + Math.max(length, 0), u8.byteLength);
            return Promise.resolve(u8.subarray(start, end));
        },
    };
}

/** Anything with Blob's `size` + `slice().arrayBuffer()` (browser File/Blob, Node Blob). */
export interface BlobLike {
    readonly size: number;
    slice(start?: number, end?: number): { arrayBuffer(): Promise<ArrayBuffer> };
}

export function blobSource(blob: BlobLike): ByteSource {
    return {
        size: blob.size,
        async read(offset, length) {
            const start = Math.min(Math.max(offset, 0), blob.size);
            const end = Math.min(start + Math.max(length, 0), blob.size);
            if (end <= start) return new Uint8Array(0);
            return new Uint8Array(await blob.slice(start, end).arrayBuffer());
        },
    };
}

export interface BlockCacheOptions {
    /** Bytes per cached block (default 64 KiB). */
    blockSize?: number;
    /** Blocks kept, least recently used dropped first (default 256: 16 MiB at the default block size). */
    maxBlocks?: number;
    /** Reads at least this long go straight to the source (default 4 blocks). */
    bypass?: number;
}

/**
 * Reads `src` in aligned blocks and keeps the recent ones. Parsing a level asks for thousands of small records (a
 * class table is a few dozen bytes each); a browser `File` answers each read with its own asynchronous slice, so the
 * cache turns those into a few block reads. Every result is a fresh copy: callers may transfer or keep its buffer.
 */
export function blockCacheSource(src: ByteSource, o: BlockCacheOptions = {}): ByteSource {
    const bs = o.blockSize ?? 64 * 1024;
    const max = o.maxBlocks ?? 256;
    const bypass = o.bypass ?? bs * 4;
    const blocks = new Map<number, Promise<Uint8Array>>();
    const block = (i: number): Promise<Uint8Array> => {
        let p = blocks.get(i);
        if (p) {
            // Most recently used last.
            blocks.delete(i);
            blocks.set(i, p);
            return p;
        }
        p = src.read(i * bs, bs);
        p.catch(() => blocks.delete(i));
        blocks.set(i, p);
        while (blocks.size > max) blocks.delete(blocks.keys().next().value!);
        return p;
    };
    return {
        size: src.size,
        async read(offset, length) {
            const start = Math.min(Math.max(offset, 0), src.size);
            const end = Math.min(start + Math.max(length, 0), src.size);
            if (end <= start) return new Uint8Array(0);
            if (end - start >= bypass) return src.read(start, end - start);
            const first = Math.floor(start / bs);
            const last = Math.floor((end - 1) / bs);
            if (first === last) return (await block(first)).slice(start - first * bs, end - first * bs);
            const parts = await Promise.all(Array.from({ length: last - first + 1 }, (_, k) => block(first + k)));
            const out = new Uint8Array(end - start);
            parts.forEach((b, k) => {
                const at = (first + k) * bs;
                const from = Math.max(start, at) - at;
                const to = Math.min(end, at + b.length) - at;
                if (to > from) out.set(b.subarray(from, to), at + from - start);
            });
            return out;
        },
    };
}

/** A window onto part of another source (used to expose one file inside an ISO as its own source). */
export function sliceSource(src: ByteSource, offset: number, size: number): ByteSource {
    return {
        size,
        read(o, l) {
            if (o >= size) return Promise.resolve(new Uint8Array(0));
            return src.read(offset + o, Math.min(l, size - o));
        },
    };
}

export function view(b: Uint8Array): DataView {
    return new DataView(b.buffer, b.byteOffset, b.byteLength);
}

export function latin1(b: Uint8Array, start = 0, end = b.length): string {
    let s = '';
    for (let i = start; i < end; i++) s += String.fromCharCode(b[i]!);
    return s;
}
