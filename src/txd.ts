import { view } from './bytes.ts';
import { inflate } from './inflate.ts';

/** SRSC type of texture entries inside a .TXD. */
export const TXD_ENTRY_TYPE = 0x40;
const HDR = 0x40;

export interface TxdHeader {
    width: number;
    height: number;
    stride: number;
    bpp: number;
    flags: number;
}

export interface TxdImage extends TxdHeader {
    /** RGBA8, `width * height * 4` bytes. */
    rgba: Uint8Array;
    /** Palette kind for 8 bpp (1 = BGRA8888, 2 = ARGB1555), otherwise undefined. */
    paletteKind?: number;
    /** True when the pixel/index plane was stored as `u32 length + zlib stream` (level 0 tile set, DRAKAN2.RRC). */
    zlibPlane?: boolean;
}

export class TxdError extends Error {}

export function parseTxdHeader(b: Uint8Array): TxdHeader {
    if (b.length < HDR) throw new TxdError('texture blob shorter than its 0x40-byte header');
    const dv = view(b);
    return {
        width: dv.getUint32(0, true),
        height: dv.getUint32(4, true),
        stride: dv.getUint32(8, true),
        bpp: dv.getUint32(12, true),
        flags: dv.getUint32(16, true),
    };
}

/** PS2 alpha 0..0x80 -> 0..255. */
function alpha8(a: number): number {
    return a <= 0x80 ? Math.min(255, a * 2) : 255;
}

export interface DecodeOptions {
    /**
     * Rows are stored bottom-up in the file (runtime/ui Txd.h); analysis/scripts/txd_decode.py does not flip.
     * `true` (default) returns a top-down image; `false` keeps stored order, which is what GL texture uploads
     * (row 0 = bottom) want.
     */
    upright?: boolean;
}

/**
 * Decode a texture blob (SRSC type 0x40 payload) to RGBA8. Port of analysis/scripts/txd_decode.py `decode`, plus the
 * zlib index plane variant seen in analysis/scripts/hd_pack.py. Throws TxdError on a layout mismatch.
 */
export function decodeTxd(b: Uint8Array, opts: DecodeOptions = {}): TxdImage {
    const h = parseTxdHeader(b);
    const { width: w, height: ht, bpp } = h;
    if (w === 0 || ht === 0 || w * ht > 1 << 26) throw new TxdError(`implausible size ${w}x${ht}`);
    const px = w * ht;
    const out = new Uint8Array(px * 4);
    const img: TxdImage = { ...h, rgba: out };
    const dv = view(b);
    /** Pixel plane of `n` bytes at `pix`: stored raw, or as `u32 compressedLength + zlib stream` (DRAKAN2.RRC, level 0). */
    const plane = (pix: number, n: number): Uint8Array => {
        if (pix + n === b.length) return b.subarray(pix);
        if (pix + 4 > b.length) throw new TxdError(`size mismatch: expected ${pix + n}, have ${b.length}`);
        const clen = dv.getUint32(pix, true);
        if (pix + 4 + clen > b.length) throw new TxdError(`size mismatch: expected ${pix + n}, have ${b.length}`);
        const raw = inflate(b.subarray(pix + 4, pix + 4 + clen));
        if (!raw || raw.length !== n) throw new TxdError('size mismatch (zlib)');
        img.zlibPlane = true;
        return raw;
    };

    if (bpp === 8) {
        if (b.length < HDR + 16) throw new TxdError('truncated palette header');
        const kind = dv.getUint32(HDR, true);
        img.paletteKind = kind;
        const pal = new Uint8Array(256 * 4);
        let pix: number;
        if (kind === 1) {
            if (b.length < HDR + 16 + 1024) throw new TxdError('truncated palette');
            for (let i = 0; i < 256; i++) {
                const o = HDR + 16 + i * 4; // stored B,G,R,A
                pal[i * 4] = b[o + 2]!;
                pal[i * 4 + 1] = b[o + 1]!;
                pal[i * 4 + 2] = b[o]!;
                pal[i * 4 + 3] = alpha8(b[o + 3]!);
            }
            pix = HDR + 16 + 1024;
        } else if (kind === 2) {
            if (b.length < HDR + 16 + 512) throw new TxdError('truncated palette');
            for (let i = 0; i < 256; i++) {
                const v = dv.getUint16(HDR + 16 + i * 2, true);
                pal[i * 4] = Math.floor(((v & 31) * 255) / 31);
                pal[i * 4 + 1] = Math.floor((((v >> 5) & 31) * 255) / 31);
                pal[i * 4 + 2] = Math.floor((((v >> 10) & 31) * 255) / 31);
                pal[i * 4 + 3] = v & 0x8000 ? 255 : 0;
            }
            pix = HDR + 16 + 512;
        } else {
            throw new TxdError(`palette kind ${kind}`);
        }
        const idx = plane(pix, px);
        for (let i = 0; i < px; i++) {
            const p = idx[i]! * 4;
            out[i * 4] = pal[p]!;
            out[i * 4 + 1] = pal[p + 1]!;
            out[i * 4 + 2] = pal[p + 2]!;
            out[i * 4 + 3] = pal[p + 3]!;
        }
    } else if (bpp === 16) {
        const pl = plane(HDR, px * 2);
        const pv = view(pl);
        for (let i = 0; i < px; i++) {
            const v = pv.getUint16(i * 2, true);
            out[i * 4] = Math.floor(((v & 31) * 255) / 31);
            out[i * 4 + 1] = Math.floor((((v >> 5) & 31) * 255) / 31);
            out[i * 4 + 2] = Math.floor((((v >> 10) & 31) * 255) / 31);
            out[i * 4 + 3] = v & 0x8000 ? 255 : 0;
        }
    } else if (bpp === 24) {
        const pl = plane(HDR, px * 3);
        for (let i = 0; i < px; i++) {
            out[i * 4] = pl[i * 3]!;
            out[i * 4 + 1] = pl[i * 3 + 1]!;
            out[i * 4 + 2] = pl[i * 3 + 2]!;
            out[i * 4 + 3] = 255;
        }
    } else if (bpp === 32) {
        const pl = plane(HDR, px * 4);
        for (let i = 0; i < px; i++) {
            out[i * 4] = pl[i * 4]!;
            out[i * 4 + 1] = pl[i * 4 + 1]!;
            out[i * 4 + 2] = pl[i * 4 + 2]!;
            out[i * 4 + 3] = alpha8(pl[i * 4 + 3]!);
        }
    } else {
        throw new TxdError(`bpp ${bpp}`);
    }

    if (opts.upright ?? true) {
        const row = w * 4;
        const tmp = new Uint8Array(row);
        for (let y = 0; y < ht >> 1; y++) {
            const a = y * row;
            const c = (ht - 1 - y) * row;
            tmp.set(out.subarray(a, a + row));
            out.copyWithin(a, c, c + row);
            out.set(tmp, c);
        }
    }
    return img;
}
