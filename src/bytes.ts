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
