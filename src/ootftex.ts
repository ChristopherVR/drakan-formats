import { view } from './bytes.ts';
import { type Ps2Entry, writePs2Srsc } from './ootfcontainer.ts';
import { inflate } from './inflate.ts';
import type { SrscReader } from './srsc.ts';
import { TXD_ENTRY_TYPE } from './txd.ts';

/**
 * Order of the Flame (PC) TXD texture (SRSC 0x0040) -> PS2 TXD texture. PC header: OpenDrakan
 * `doc/riot_database_format.txt` and `src/odCore/db/Texture.cpp` (header offsets re-checked on the OotF install:
 * `54 + compressedSize == record size` on every sampled texture). PS2 header and bpp / flag combinations: measured on
 * 242 textures of the PAL disc (journal 2026-10-31/ootf-models.md); decoder `txd.ts`.
 *
 * Rows are copied in stored order: PC rows are bottom-up (OpenDrakan uploads them unflipped and uses the UVs as they
 * are), the PS2 TXD is bottom-up too, so UVs need no change.
 */

export const PC_PALETTE_TYPE = 0x0030;
export const PS2_TXD_VERSION = 0x020a;
export const TXD_VERSION = 0x0402;

export class OotfTextureError extends Error {}

export interface PcTextureInfo {
    width: number;
    height: number;
    rowSpacing: number;
    bpp: number;
    alphaBpp: number;
    /** 0xRRGGBB colour that is transparent, or null (stored 0xffffffff). */
    colorKey: number | null;
    fps: number;
    /** 0x80 high quality, 0x40 dynamic, 0x20 next frame, 0x08 mip map, 0x04 alternate, 0x02 alpha channel, 0x01 alpha map. */
    flags: number;
    compression: number;
    materialRef: number;
}

export const PC_TEX_NEXT_FRAME = 0x20;
export const PC_TEX_MIPMAP = 0x08;
export const PC_TEX_ALPHA_CHANNEL = 0x02;
export const PC_TEX_ALPHA_MAP = 0x01;

/** PC palette record 0x0030: `u16 count, (r, g, b, flags)[count]`. Returns RGB triples (3 bytes per colour). */
export function parsePcPalette(b: Uint8Array): Uint8Array {
    const n = view(b).getUint16(0, true);
    const out = new Uint8Array(n * 3);
    for (let i = 0; i < n && 2 + i * 4 + 3 < b.length; i++) {
        out[i * 3] = b[2 + i * 4]!;
        out[i * 3 + 1] = b[3 + i * 4]!;
        out[i * 3 + 2] = b[4 + i * 4]!;
    }
    return out;
}

export function parsePcTextureInfo(b: Uint8Array): PcTextureInfo {
    if (b.length < 54) throw new OotfTextureError('PC texture record shorter than its 54-byte header');
    const dv = view(b);
    const key = dv.getUint32(18, true);
    return {
        width: dv.getUint32(0, true),
        height: dv.getUint32(4, true),
        rowSpacing: dv.getUint32(8, true),
        bpp: dv.getUint16(12, true),
        alphaBpp: dv.getUint16(14, true),
        colorKey: key === 0xffffffff ? null : key & 0xffffff,
        fps: b[34]!,
        flags: b[35]!,
        compression: dv.getUint32(46, true),
        materialRef: dv.getUint32(38, true),
    };
}

/** Straight RGBA8 image in stored (bottom-up) row order. */
export interface RgbaImage {
    width: number;
    height: number;
    rgba: Uint8Array;
}

function scale(v: number, bits: number): number {
    const max = (1 << bits) - 1;
    return Math.round((v * 255) / max);
}

/** Decode a PC texture record (8 bpp needs the container palette) to RGBA8. Throws OotfTextureError. */
export function decodePcTexture(b: Uint8Array, palette: Uint8Array | null): { info: PcTextureInfo; image: RgbaImage } {
    const info = parsePcTextureInfo(b);
    const { width: w, height: h, bpp } = info;
    if (w === 0 || h === 0 || w * h > 1 << 24) throw new OotfTextureError(`implausible size ${w}x${h}`);
    if (info.flags & PC_TEX_ALPHA_MAP) throw new OotfTextureError('separate alpha map is not supported');
    if (info.rowSpacing !== w * (bpp >> 3)) throw new OotfTextureError('padded rows are not supported');
    const need = w * h * (bpp >> 3);
    let data = b.subarray(54);
    if (info.compression !== 0) {
        const cs = view(b).getUint32(50, true);
        const raw = inflate(b.subarray(54, 54 + cs));
        if (!raw) throw new OotfTextureError('bad zlib stream');
        data = raw;
    }
    if (data.length < need) throw new OotfTextureError(`pixel data ${data.length} < ${need}`);
    const out = new Uint8Array(w * h * 4);
    const key = info.colorKey;
    const kr = key === null ? -1 : (key >> 16) & 255;
    const kg = key === null ? -1 : (key >> 8) & 255;
    const kb = key === null ? -1 : key & 255;
    if (bpp === 8) {
        if (!palette) throw new OotfTextureError('8 bpp texture without a palette');
        for (let i = 0; i < w * h; i++) {
            const p = data[i]! * 3;
            const r = palette[p] ?? 0;
            const g = palette[p + 1] ?? 0;
            const bl = palette[p + 2] ?? 0;
            out.set([r, g, bl, r === kr && g === kg && bl === kb ? 0 : 255], i * 4);
        }
    } else if (bpp === 16) {
        const a = info.flags & PC_TEX_ALPHA_CHANNEL ? info.alphaBpp : 0;
        const [rb, gb, bb] =
            a === 0 ? [5, 6, 5] : a === 1 ? [5, 5, 5] : a === 4 ? [4, 4, 4] : a === 8 ? [3, 3, 2] : [0, 0, 0];
        if (rb === 0) throw new OotfTextureError(`16 bpp with ${a} alpha bits`);
        const dv = view(data);
        for (let i = 0; i < w * h; i++) {
            const c = dv.getUint16(i * 2, true);
            const bl = c & ((1 << bb) - 1);
            const g = (c >> bb) & ((1 << gb) - 1);
            const r = (c >> (bb + gb)) & ((1 << rb) - 1);
            const al = a ? (c >> (rb + gb + bb)) & ((1 << a) - 1) : -1;
            out.set([scale(r, rb), scale(g, gb), scale(bl, bb), al < 0 ? 255 : scale(al, a)], i * 4);
        }
    } else if (bpp === 24) {
        for (let i = 0; i < w * h; i++) {
            const r = data[i * 3]!;
            const g = data[i * 3 + 1]!;
            const bl = data[i * 3 + 2]!;
            out.set([r, g, bl, r === kr && g === kg && bl === kb ? 0 : 255], i * 4);
        }
    } else if (bpp === 32) {
        // Byte order B, G, R, A in the engine (OpenDrakan notes it varies with the editor; unverified here).
        for (let i = 0; i < w * h; i++)
            out.set(
                [data[i * 4 + 2]!, data[i * 4 + 1]!, data[i * 4]!, info.alphaBpp === 8 ? data[i * 4 + 3]! : 255],
                i * 4,
            );
    } else throw new OotfTextureError(`bpp ${bpp}`);
    return { info, image: { width: w, height: h, rgba: out } };
}

// ------------------------------------------------------------------------------------------------ resampling

function pow2Ceil(n: number): number {
    let p = 8;
    while (p < n) p <<= 1;
    return p;
}

/** Nearest-neighbour resample (keeps palette colours; UVs are normalised so a stretch is invisible). */
export function resampleNearest(img: RgbaImage, w: number, h: number): RgbaImage {
    if (w === img.width && h === img.height) return img;
    const out = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) {
        const sy = Math.min(img.height - 1, Math.floor(((y + 0.5) * img.height) / h));
        for (let x = 0; x < w; x++) {
            const sx = Math.min(img.width - 1, Math.floor(((x + 0.5) * img.width) / w));
            out.set(img.rgba.subarray((sy * img.width + sx) * 4, (sy * img.width + sx) * 4 + 4), (y * w + x) * 4);
        }
    }
    return { width: w, height: h, rgba: out };
}

// ------------------------------------------------------------------------------------------------ quantizer

/** Median cut over weighted RGBA colours to at most `n` entries. Returns the palette (RGBA) and a lookup closure. */
export function quantizeRgba(colors: Map<number, number>, n: number): { palette: number[]; map: Map<number, number> } {
    type Box = { keys: number[]; count: number };
    const ch = (k: number, c: number): number => (k >>> (c * 8)) & 255; // key = a<<24 | b<<16 | g<<8 | r
    let boxes: Box[] = [{ keys: [...colors.keys()], count: 0 }];
    while (boxes.length < n) {
        let best = -1;
        let bestRange = 0;
        let bestCh = 0;
        boxes.forEach((bx, i) => {
            if (bx.keys.length < 2) return;
            for (let c = 0; c < 4; c++) {
                let lo = 255;
                let hi = 0;
                for (const k of bx.keys) {
                    lo = Math.min(lo, ch(k, c));
                    hi = Math.max(hi, ch(k, c));
                }
                const range = (hi - lo) * (c === 3 ? 1.5 : 1);
                if (range > bestRange) {
                    bestRange = range;
                    best = i;
                    bestCh = c;
                }
            }
        });
        if (best < 0) break;
        const bx = boxes[best]!;
        bx.keys.sort((x, y) => ch(x, bestCh) - ch(y, bestCh));
        let total = 0;
        for (const k of bx.keys) total += colors.get(k)!;
        let acc = 0;
        let cut = 1;
        for (let i = 0; i < bx.keys.length - 1; i++) {
            acc += colors.get(bx.keys[i]!)!;
            cut = i + 1;
            if (acc * 2 >= total) break;
        }
        boxes.splice(best, 1, { keys: bx.keys.slice(0, cut), count: 0 }, { keys: bx.keys.slice(cut), count: 0 });
    }
    const palette: number[] = [];
    const map = new Map<number, number>();
    boxes = boxes.filter((b) => b.keys.length > 0);
    boxes.forEach((bx, i) => {
        let w = 0;
        const s = [0, 0, 0, 0];
        for (const k of bx.keys) {
            const c = colors.get(k)!;
            w += c;
            for (let q = 0; q < 4; q++) s[q]! += ch(k, q) * c;
            map.set(k, i);
        }
        palette.push(...s.map((v) => Math.round(v / w)));
    });
    return { palette, map };
}

// -------------------------------------------------------------------------------------------- PS2 TXD writer

export type TextureMode = 'auto' | 'indexed';

export interface Ps2TextureOptions {
    /** `auto`: 8 bpp when at most 256 colours, else 16 bpp (1:5:5:5), or quantised 8 bpp with alpha when alpha is graded.
     * `indexed`: always 8 bpp (smaller; quantises). Default `auto`. */
    mode?: TextureMode;
    /** Largest edge written (default 256, the largest size on the disc). */
    maxSize?: number;
    /** Animation fps byte (disc: 10). */
    fps?: number;
}

export interface Ps2Texture {
    /** The 0x0040 record body. */
    body: Uint8Array;
    width: number;
    height: number;
    bpp: 8 | 16 | 24 | 32;
    /** Any pixel with alpha below opaque. */
    hasAlpha: boolean;
    /** True when the source had to be quantised or reduced (colour loss). */
    lossy: boolean;
}

const PS2_OPAQUE = 0x7f; // palette alpha of opaque colours on the disc (201 of 207 palettes)

function ps2Alpha(a: number): number {
    return a >= 255 ? PS2_OPAQUE : Math.round((a * PS2_OPAQUE) / 255);
}

function header(w: number, h: number, bpp: number, flagsWord: number, alpha: boolean, fps: number): Uint8Array {
    const out = new Uint8Array(0x40);
    const dv = view(out);
    dv.setUint32(0, w, true);
    dv.setUint32(4, h, true);
    dv.setUint32(8, (w * bpp) >> 3, true);
    dv.setUint32(12, bpp, true);
    dv.setUint32(16, flagsWord, true);
    dv.setUint32(20, 0xffffffff, true);
    out[36] = fps;
    out[37] = alpha ? 0x02 : 0;
    out[38] = bpp > 8 ? 0x80 : 0;
    dv.setFloat32(44, 4, true);
    dv.setUint32(56, 1, true);
    return out;
}

/** Encode an RGBA image as a PS2 TXD record body. Sizes are rounded up to powers of two (8 .. maxSize). */
export function encodePs2Texture(src: RgbaImage, opt: Ps2TextureOptions = {}): Ps2Texture {
    const maxSize = opt.maxSize ?? 256;
    const w = Math.min(maxSize, pow2Ceil(src.width));
    const h = Math.min(maxSize, pow2Ceil(src.height));
    const img = resampleNearest(src, w, h);
    const px = w * h;
    const fps = opt.fps ?? 10;
    const colors = new Map<number, number>();
    let translucent = 0;
    let transparent = 0;
    const keyOf = (i: number): number =>
        ((img.rgba[i * 4 + 3]! << 24) |
            (img.rgba[i * 4 + 2]! << 16) |
            (img.rgba[i * 4 + 1]! << 8) |
            img.rgba[i * 4]!) >>>
        0;
    for (let i = 0; i < px; i++) {
        const a = img.rgba[i * 4 + 3]!;
        if (a === 0) transparent++;
        else if (a < 255) translucent++;
        // Fully transparent pixels all share one colour so they do not eat palette entries.
        const k = a === 0 ? 0 : keyOf(i);
        colors.set(k, (colors.get(k) ?? 0) + 1);
    }
    const hasAlpha = transparent + translucent > 0;
    const mode = opt.mode ?? 'auto';
    const indexed = colors.size <= 256 || mode === 'indexed' || translucent > 0;
    if (indexed) {
        let lossy = false;
        let palette: number[];
        let lookup: (i: number) => number;
        if (colors.size <= 256) {
            const order = [...colors.keys()];
            const idx = new Map(order.map((k, i) => [k, i] as const));
            palette = order.flatMap((k) => [k & 255, (k >>> 8) & 255, (k >>> 16) & 255, k >>> 24]);
            lookup = (i) => idx.get(img.rgba[i * 4 + 3] === 0 ? 0 : keyOf(i))!;
        } else {
            lossy = true;
            const q = quantizeRgba(colors, 256);
            palette = q.palette;
            lookup = (i) => q.map.get(img.rgba[i * 4 + 3] === 0 ? 0 : keyOf(i))!;
        }
        const body = new Uint8Array(0x40 + 16 + 1024 + px);
        body.set(header(w, h, 8, translucent > 0 ? 8 : 0, hasAlpha, fps), 0);
        const dv = view(body);
        dv.setUint32(0x40, 1, true);
        dv.setUint32(0x44, 256, true);
        for (let i = 0; i < palette.length / 4; i++) {
            const o = 0x40 + 16 + i * 4;
            body[o] = palette[i * 4 + 2]!; // stored B, G, R, A
            body[o + 1] = palette[i * 4 + 1]!;
            body[o + 2] = palette[i * 4]!;
            body[o + 3] = ps2Alpha(palette[i * 4 + 3]!);
        }
        for (let i = palette.length / 4; i < 256; i++) body[0x40 + 16 + i * 4 + 3] = PS2_OPAQUE;
        for (let i = 0; i < px; i++) body[0x40 + 16 + 1024 + i] = lookup(i);
        return { body, width: w, height: h, bpp: 8, hasAlpha, lossy };
    }
    // More than 256 colours, no graded alpha: 16 bpp 1:5:5:5 (R in the low bits, A in bit 15), as the disc's 16 bpp textures.
    const body = new Uint8Array(0x40 + px * 2);
    body.set(header(w, h, 16, 1, hasAlpha, fps), 0);
    const dv = view(body);
    for (let i = 0; i < px; i++) {
        const r = img.rgba[i * 4]! >> 3;
        const g = img.rgba[i * 4 + 1]! >> 3;
        const b = img.rgba[i * 4 + 2]! >> 3;
        dv.setUint16(0x40 + i * 2, r | (g << 5) | (b << 10) | (img.rgba[i * 4 + 3]! >= 128 ? 0x8000 : 0), true);
    }
    return { body, width: w, height: h, bpp: 16, hasAlpha, lossy: true };
}

/** Does the PS2 record already fit the PS2 rules (used to decide whether a PC texture needs re-encoding). */
export function ps2TextureSizeOk(w: number, h: number): boolean {
    return w >= 8 && h >= 8 && w <= 256 && h <= 256 && (w & (w - 1)) === 0 && (h & (h - 1)) === 0;
}

// ---------------------------------------------------------------------------------------- container level

export interface PcTxdTexture {
    id: number;
    sub: number;
    info: PcTextureInfo;
    image: RgbaImage;
}

export interface PcTxdSkip {
    id: number;
    reason: string;
}

/**
 * Decode one texture of a PC TXD. Mip-map entries are not textures to convert (`PC_TEX_MIPMAP`): they are reported as
 * skipped. Returns the reason string instead of throwing.
 */
export async function readPcTexture(txd: SrscReader, id: number): Promise<PcTxdTexture | PcTxdSkip> {
    const e = txd.find(TXD_ENTRY_TYPE, id);
    if (!e) return { id, reason: 'no such texture' };
    const palEntry = txd.entries.find((x) => x.type === PC_PALETTE_TYPE);
    const palette = palEntry ? parsePcPalette(await txd.readRaw(palEntry)) : null;
    try {
        const { info, image } = decodePcTexture(await txd.readRaw(e), palette);
        return { id, sub: e.sub, info, image };
    } catch (err) {
        return { id, reason: (err as Error).message };
    }
}

export function isSkip(r: PcTxdTexture | PcTxdSkip): r is PcTxdSkip {
    return 'reason' in r;
}

/** PS2 TXD container: 0x0402 version record (0x020a) then the textures `(id, body)`, ids unique and nonzero. */
export function buildPs2Txd(textures: readonly { id: number; body: Uint8Array }[]): Uint8Array {
    const version = new Uint8Array(4);
    view(version).setUint32(0, PS2_TXD_VERSION, true);
    const entries: Ps2Entry[] = [{ type: TXD_VERSION, id: 0, sub: 0, data: version }];
    const seen = new Set<number>();
    for (const t of textures) {
        if (t.id <= 0 || t.id > 0xffff || seen.has(t.id))
            throw new OotfTextureError(`bad or duplicate texture id ${t.id}`);
        seen.add(t.id);
        entries.push({ type: TXD_ENTRY_TYPE, id: t.id, sub: 0, data: t.body });
    }
    return writePs2Srsc(entries);
}
