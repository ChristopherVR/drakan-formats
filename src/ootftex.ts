import { view } from './bytes.ts';
import { ootfDebugFlag } from './ootfdebug.ts';
import { type Ps2Entry, writePs2Srsc } from './ootfcontainer.ts';
import { inflate } from './inflate.ts';
import type { SrscReader } from './srsc.ts';
import { TXD_ENTRY_TYPE, decodeTxd } from './txd.ts';

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

/**
 * Smooth (Catmull-Rom, wrap-around so tiling ground stays seamless) enlargement to w x h (both at least the source size).
 * Opaque images only: a cut-out texture keeps its hard alpha edge through `resampleNearest`.
 */
export function resampleSmooth(img: RgbaImage, w: number, h: number): RgbaImage {
    if (w === img.width && h === img.height) return img;
    const out = new Uint8Array(w * h * 4);
    const cr = (t: number): number => {
        const a = Math.abs(t);
        return a < 1 ? 1.5 * a * a * a - 2.5 * a * a + 1 : a < 2 ? -0.5 * a * a * a + 2.5 * a * a - 4 * a + 2 : 0;
    };
    const wrap = (v: number, n: number): number => ((v % n) + n) % n;
    const wx = new Float64Array(4);
    const wy = new Float64Array(4);
    for (let y = 0; y < h; y++) {
        const fy = ((y + 0.5) * img.height) / h - 0.5;
        const y0 = Math.floor(fy);
        for (let k = 0; k < 4; k++) wy[k] = cr(fy - (y0 - 1 + k));
        for (let x = 0; x < w; x++) {
            const fx = ((x + 0.5) * img.width) / w - 0.5;
            const x0 = Math.floor(fx);
            for (let k = 0; k < 4; k++) wx[k] = cr(fx - (x0 - 1 + k));
            for (let c = 0; c < 3; c++) {
                let acc = 0;
                for (let j = 0; j < 4; j++) {
                    const row = wrap(y0 - 1 + j, img.height) * img.width;
                    for (let i = 0; i < 4; i++)
                        acc += wy[j]! * wx[i]! * img.rgba[(row + wrap(x0 - 1 + i, img.width)) * 4 + c]!;
                }
                out[(y * w + x) * 4 + c] = Math.max(0, Math.min(255, Math.round(acc)));
            }
            out[(y * w + x) * 4 + 3] = 255;
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

/** Alpha weight of the palette refinement's distance (alpha errors show as holes or halos, colour errors much less). */
const ALPHA_WEIGHT = 4;

/**
 * 256-colour palette for an image: median cut (`quantizeRgba`), then a few k-means rounds that move every entry to the
 * mean of the colours nearest to it and map each colour to its nearest entry (median cut alone maps by box, which
 * leaves visible steps on smooth gradients: 3 dB PSNR less in the median over the converted RGBA textures). Fully
 * transparent pixels (key 0) keep an entry of their own with alpha 0, so cut-out edges never gain or lose coverage.
 */
export function quantizeRefined(
    colors: Map<number, number>,
    n = 256,
    rounds = 4,
): { palette: number[]; map: Map<number, number> } {
    const hole = colors.has(0);
    const solid = new Map(colors);
    solid.delete(0);
    const slots = Math.max(1, n - (hole ? 1 : 0));
    const keys = [...solid.keys()];
    const out = new Map<number, number>();
    if (keys.length <= slots) {
        const palette: number[] = [];
        keys.forEach((k, i) => {
            palette.push(k & 255, (k >>> 8) & 255, (k >>> 16) & 255, k >>> 24);
            out.set(k, i);
        });
        if (hole) {
            out.set(0, palette.length / 4);
            palette.push(0, 0, 0, 0);
        }
        return { palette, map: out };
    }
    const pal = Float64Array.from(quantizeRgba(solid, slots).palette);
    const m = pal.length / 4;
    const assign = new Uint16Array(keys.length);
    const sum = new Float64Array(m * 5);
    for (let round = 0; round <= rounds; round++) {
        sum.fill(0);
        for (let ki = 0; ki < keys.length; ki++) {
            const k = keys[ki]!;
            const r = k & 255;
            const g = (k >>> 8) & 255;
            const b = (k >>> 16) & 255;
            const a = k >>> 24;
            let best = 0;
            let bd = Infinity;
            for (let p = 0; p < m; p++) {
                const dr = r - pal[p * 4]!;
                const dg = g - pal[p * 4 + 1]!;
                const db = b - pal[p * 4 + 2]!;
                const da = a - pal[p * 4 + 3]!;
                const d = dr * dr + dg * dg + db * db + ALPHA_WEIGHT * da * da;
                if (d < bd) {
                    bd = d;
                    best = p;
                }
            }
            assign[ki] = best;
            const c = solid.get(k)!;
            sum[best * 5]! += r * c;
            sum[best * 5 + 1]! += g * c;
            sum[best * 5 + 2]! += b * c;
            sum[best * 5 + 3]! += a * c;
            sum[best * 5 + 4]! += c;
        }
        if (round === rounds) break;
        for (let p = 0; p < m; p++)
            if (sum[p * 5 + 4]! > 0) for (let q = 0; q < 4; q++) pal[p * 4 + q] = sum[p * 5 + q]! / sum[p * 5 + 4]!;
    }
    const palette = Array.from(pal, (v) => Math.round(v));
    keys.forEach((k, ki) => out.set(k, assign[ki]!));
    if (hole) {
        out.set(0, m);
        palette.push(0, 0, 0, 0);
    }
    return { palette, map: out };
}

/** How far an indexed version is from the source: colour PSNR (dB, weighted by coverage) and the largest alpha error. */
export function quantizeError(
    img: RgbaImage,
    palette: readonly number[],
    indexOf: (i: number) => number,
): { psnr: number; maxAlphaError: number } {
    let se = 0;
    let weight = 0;
    let maxAlphaError = 0;
    for (let i = 0; i < img.width * img.height; i++) {
        const a = img.rgba[i * 4 + 3]!;
        const p = indexOf(i) * 4;
        maxAlphaError = Math.max(maxAlphaError, Math.abs(a - palette[p + 3]!));
        if (a === 0) continue;
        const w = a / 255;
        for (let c = 0; c < 3; c++) {
            const d = img.rgba[i * 4 + c]! - palette[p + c]!;
            se += d * d * w;
        }
        weight += 3 * w;
    }
    const mse = weight > 0 ? se / weight : 0;
    return { psnr: mse === 0 ? Infinity : 10 * Math.log10((255 * 255) / mse), maxAlphaError };
}

/** Mean colour of the visible pixels next to a fully transparent one (4-neighbourhood, wrapping); black when none. */
export function holeEdgeColor(img: RgbaImage): [number, number, number] {
    const { width: w, height: h, rgba } = img;
    const sum = [0, 0, 0];
    let n = 0;
    for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
            const i = (y * w + x) * 4;
            if (rgba[i + 3] === 0) continue;
            const near = [
                ((y * w + ((x + 1) % w)) * 4) | 0,
                ((y * w + ((x + w - 1) % w)) * 4) | 0,
                ((((y + 1) % h) * w + x) * 4) | 0,
                ((((y + h - 1) % h) * w + x) * 4) | 0,
            ];
            if (!near.some((j) => rgba[j + 3] === 0)) continue;
            for (let c = 0; c < 3; c++) sum[c]! += rgba[i + c]!;
            n++;
        }
    return n ? [Math.round(sum[0]! / n), Math.round(sum[1]! / n), Math.round(sum[2]! / n)] : [0, 0, 0];
}

/**
 * `truecolor` mode: textures of at least this many pixels (128 x 128) with more than 256 colours are written 8 bpp when the
 * refined palette keeps them within `DEFAULT_INDEXED_MIN_PSNR` and `DEFAULT_INDEXED_MAX_ALPHA_ERROR`. A 256 x 256 RGBA
 * texture takes 256 KiB of the guest's texture cache, its 8 bpp version 65 KiB: Ruined Village's opening scene waited on
 * a full cache (journal 2026-11-06/issue-5-village-scene-timing.md). Smaller textures cost little and stay exact.
 */
export const DEFAULT_INDEXED_FROM_PIXELS = 128 * 128;
/** Colour PSNR an 8 bpp version must reach (dB); journal 2026-11-06/issue-5-indexed-textures.md. */
export const DEFAULT_INDEXED_MIN_PSNR = 38;
/** Largest alpha change (of 255) an 8 bpp version may make to any pixel. */
export const DEFAULT_INDEXED_MAX_ALPHA_ERROR = 8;

// -------------------------------------------------------------------------------------------- PS2 TXD writer

export type TextureMode = 'auto' | 'indexed' | 'truecolor';

export interface Ps2TextureOptions {
    /** `auto`: 8 bpp when at most 256 colours, else 16 bpp (1:5:5:5), or quantised 8 bpp with alpha when alpha is graded.
     * `indexed`: always 8 bpp (smaller; quantises). `truecolor`: 8 bpp only when at most 256 colours (exact), else 32 bpp
     * RGBA (flags word 7, alpha 0..0x80), no quantising or 5-bit reduction, but only up to `maxTruecolorPixels` (see there).
     * Default `truecolor` (the PC is not memory bound). */
    mode?: TextureMode;
    /**
     * `truecolor` only: the largest texture (w x h) written as 32 bpp when it has more than 256 colours; bigger ones are
     * quantised to 8 bpp (median cut, alpha kept in the palette; mean error 0.2..0.4 of 255 on 256 px sources, offline
     * measure of 2026-11-01). Default 128 x 128. Cause: the guest builds mip maps of every texture it uploads, and ~33
     * 256 x 256 32 bpp (or 16 bpp) object textures made Ruined Village Book load for 60 s instead of 6 s (journal
     * 2026-11-01/ootf-book-slow-load.md). Terrain passes Infinity: its 256 px 32 bpp textures load in time and carry the visible detail.
     */
    maxTruecolorPixels?: number;
    /**
     * `truecolor` only: textures of at least this many pixels with more than 256 colours are tried as 8 bpp and kept so
     * when they pass `indexedMinPsnr` and `indexedMaxAlphaError` (default `DEFAULT_INDEXED_FROM_PIXELS`; Infinity = never).
     */
    indexedFromPixels?: number;
    /** Colour PSNR (dB) an 8 bpp version must reach to replace a 32 bpp texture (default `DEFAULT_INDEXED_MIN_PSNR`). */
    indexedMinPsnr?: number;
    /** Largest alpha error (of 255) an 8 bpp version may have (default `DEFAULT_INDEXED_MAX_ALPHA_ERROR`). */
    indexedMaxAlphaError?: number;
    /** Largest edge written (default 256, the largest size on the disc). */
    maxSize?: number;
    /**
     * Smallest edge written for an opaque texture: smaller sources are enlarged with a smooth wrap-around filter
     * (default 0 = keep the source size). The disc's ground is 128 px (62 % of the cells) where Order of the Flame's is 64 px.
     */
    minSize?: number;
    /** Write a square texture (the larger edge both ways): every one of the 154 disc creature textures is square. */
    square?: boolean;
    /** Animation fps byte (disc: 10). */
    fps?: number;
    /** u32 at header +40 (disc: a per-container counter, 0 in splat textures; meaning unknown). */
    slot?: number;
    /** Defer the global lossless-image sink until a caller finalizes the encoded metadata; `exact` remains available. */
    deferExact?: boolean;
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
    /** The lossless pixels (the final size, before quantising / 5 bit reduction); set only when `lossy`. */
    exact?: RgbaImage;
}

/**
 * Receiver for the lossless pixels of every lossy encode (`body` is the finished 0x0040 record). The HD pack tooling keys them by
 * the body's SHA-1 and upscales them instead of the quantised guest texture, so the engine (HD replacement by content hash)
 * shows the full-quality picture while the guest keeps the cheap 8 bpp texture it can load fast. Unset = ignored.
 */
let exactSink: ((body: Uint8Array, exact: RgbaImage) => void) | null = null;
export function setExactSink(fn: ((body: Uint8Array, exact: RgbaImage) => void) | null): void {
    exactSink = fn;
}
function lossyResult(t: Ps2Texture, exact: RgbaImage, emit = true): Ps2Texture {
    if (emit) exactSink?.(t.body, exact);
    return { ...t, exact };
}

/**
 * Largest 32 bpp texture (pixels) of an object / creature texture. Unlimited: the engine's native mip filter (drakan_texscale)
 * makes truecolor uploads as cheap as 8 bpp ones, so nothing is quantised. `OOTF_TEXPIX=<n>` / `maxTruecolorPixels` still cap it.
 */
export const DEFAULT_MAX_TRUECOLOR_PIXELS = Infinity;

const PS2_OPAQUE = 0x7f; // palette alpha of opaque colours on the disc (201 of 207 palettes)

function ps2Alpha(a: number): number {
    return a >= 255 ? PS2_OPAQUE : Math.round((a * PS2_OPAQUE) / 255);
}

function header(
    w: number,
    h: number,
    bpp: number,
    flagsWord: number,
    alpha: boolean,
    fps: number,
    slot = 0,
): Uint8Array {
    const out = new Uint8Array(0x40);
    const dv = view(out);
    dv.setUint32(0, w, true);
    dv.setUint32(4, h, true);
    dv.setUint32(8, (w * bpp) >> 3, true);
    dv.setUint32(12, bpp, true);
    dv.setUint32(16, flagsWord, true);
    dv.setUint32(20, 0xffffffff, true);
    out[36] = fps;
    out[37] = alpha && !ootfDebugFlag('OOTF_NO_ALPHA_FLAG') ? 0x02 : 0;
    out[38] = bpp > 8 ? 0x80 : 0;
    dv.setUint32(40, slot, true);
    dv.setFloat32(44, 4, true);
    dv.setUint32(56, 1, true);
    return out;
}

/** Encode an RGBA image as a PS2 TXD record body. Sizes are rounded up to powers of two (8 .. maxSize). */
export function encodePs2Texture(src: RgbaImage, opt: Ps2TextureOptions = {}): Ps2Texture {
    const maxSize = opt.maxSize ?? 256;
    const minSize = Math.min(maxSize, opt.minSize ?? 0);
    let opaque = true;
    for (let i = 3; i < src.rgba.length && opaque; i += 4) if (src.rgba[i] !== 255) opaque = false;
    const grow = (n: number): number => Math.min(maxSize, opaque ? Math.max(pow2Ceil(n), minSize) : pow2Ceil(n));
    let w = grow(src.width);
    let h = grow(src.height);
    if (opt.square) w = h = Math.max(w, h);
    const enlarged = opaque && w >= src.width && h >= src.height && (w > src.width || h > src.height);
    const img = enlarged ? resampleSmooth(src, w, h) : resampleNearest(src, w, h);
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
    // A wholly transparent texture (the PC's "invisiblewall" and other collision-only models) is written the way the disc writes
    // its own: 16 bpp 1:5:5:5, flags word 1, every alpha bit clear (WORLDCON 401 of the disc's "invisiblewall", which shootable
    // rfl 17 targets such as "Rope Target" use; RESOURES 6028 of the null models). An 8 bpp texture with flags word 0 (opaque
    // or colour key on the disc, where no 8 bpp texture with holes carries it) draws as a black box in game. Forced 8 bpp
    // (`indexed`: skinned models, fast-draw weapons) keeps the palette form with the disc's graded-alpha flags word 8.
    if (transparent === px && opt.mode !== 'indexed') {
        const body = new Uint8Array(0x40 + px * 2);
        body.set(header(w, h, 16, 1, true, fps, opt.slot), 0);
        return { body, width: w, height: h, bpp: 16, hasAlpha: true, lossy: false };
    }
    // An enlarged texture stays truecolor too (it was 8 bpp while the guest's mip loop made 32 bpp uploads 10x slower).
    const mode = opt.mode ?? 'truecolor';
    const tooBig = mode === 'truecolor' && px > (opt.maxTruecolorPixels ?? DEFAULT_MAX_TRUECOLOR_PIXELS);
    const pixelKey = (i: number): number => (img.rgba[i * 4 + 3] === 0 ? 0 : keyOf(i));
    // Large truecolor textures go 8 bpp when the refined palette is close enough (`indexedFromPixels`).
    let refined: { palette: number[]; map: Map<number, number> } | null = null;
    if (
        mode === 'truecolor' &&
        !tooBig &&
        colors.size > 256 &&
        px >= (opt.indexedFromPixels ?? DEFAULT_INDEXED_FROM_PIXELS)
    ) {
        const q = quantizeRefined(colors, 256);
        const e = quantizeError(img, q.palette, (i) => q.map.get(pixelKey(i))!);
        if (
            e.psnr >= (opt.indexedMinPsnr ?? DEFAULT_INDEXED_MIN_PSNR) &&
            e.maxAlphaError <= (opt.indexedMaxAlphaError ?? DEFAULT_INDEXED_MAX_ALPHA_ERROR)
        )
            refined = q;
    }
    const indexed =
        colors.size <= 256 || mode === 'indexed' || tooBig || !!refined || (translucent > 0 && mode !== 'truecolor');
    if (indexed) {
        let lossy = false;
        let palette: number[];
        let lookup: (i: number) => number;
        let hole: number | undefined;
        if (colors.size <= 256) {
            const order = [...colors.keys()];
            const idx = new Map(order.map((k, i) => [k, i] as const));
            palette = order.flatMap((k) => [k & 255, (k >>> 8) & 255, (k >>> 16) & 255, k >>> 24]);
            lookup = (i) => idx.get(pixelKey(i))!;
            hole = idx.get(0);
        } else {
            lossy = true;
            const q = refined ?? quantizeRefined(colors, 256);
            palette = q.palette;
            lookup = (i) => q.map.get(pixelKey(i))!;
            hole = q.map.get(0);
        }
        // The transparent entry takes the mean colour along the holes' edges, so filtering at a cut-out edge blends toward
        // the edge's own colour instead of black (the disc's 8 bpp textures with holes never use a black alpha-0 entry).
        if (hole !== undefined && transparent < px) {
            const edge = holeEdgeColor(img);
            for (let c = 0; c < 3; c++) palette[hole * 4 + c] = edge[c]!;
        }
        // Flags word = the engine's alpha selector (sub_1bf838 maps 1 / 2 / 4 / 7, 8 to native 0x10000 .. 0x80000; the draw
        // path sub_18c52c turns texture alpha on only for a nonzero selector or a colour key). 0 means opaque: an 8 bpp
        // texture with holes and flags word 0 draws its holes in the hole colour. Graded alpha takes 8 (blend), as the disc's
        // 8 bpp textures with soft edges; hard cut-outs (every pixel opaque or clear) take 1, the binary-alpha test of the
        // disc's 16 bpp cut-outs and of its 8 bpp cut-out NPCS 6314.
        const selector = translucent > 0 || transparent === px ? 8 : transparent > 0 ? 1 : 0;
        const body = new Uint8Array(0x40 + 16 + 1024 + px);
        body.set(header(w, h, 8, selector, hasAlpha, fps, opt.slot), 0);
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
        const t8: Ps2Texture = { body, width: w, height: h, bpp: 8, hasAlpha, lossy };
        return lossy ? lossyResult(t8, img, !opt.deferExact) : t8;
    }
    if (mode === 'truecolor') {
        const body = new Uint8Array(0x40 + px * 4);
        body.set(header(w, h, 32, 7, hasAlpha, fps, opt.slot), 0);
        for (let i = 0; i < px; i++) {
            body[0x40 + i * 4] = img.rgba[i * 4]!;
            body[0x40 + i * 4 + 1] = img.rgba[i * 4 + 1]!;
            body[0x40 + i * 4 + 2] = img.rgba[i * 4 + 2]!;
            body[0x40 + i * 4 + 3] = ps2Alpha(img.rgba[i * 4 + 3]!);
        }
        return { body, width: w, height: h, bpp: 32, hasAlpha, lossy: false };
    }
    // More than 256 colours, no graded alpha: 16 bpp 1:5:5:5 (R in the low bits, A in bit 15), as the disc's 16 bpp textures.
    const body = new Uint8Array(0x40 + px * 2);
    body.set(header(w, h, 16, 1, hasAlpha, fps, opt.slot), 0);
    const dv = view(body);
    for (let i = 0; i < px; i++) {
        const r = img.rgba[i * 4]! >> 3;
        const g = img.rgba[i * 4 + 1]! >> 3;
        const b = img.rgba[i * 4 + 2]! >> 3;
        dv.setUint16(0x40 + i * 2, r | (g << 5) | (b << 10) | (img.rgba[i * 4 + 3]! >= 128 ? 0x8000 : 0), true);
    }
    return lossyResult({ body, width: w, height: h, bpp: 16, hasAlpha, lossy: true }, img, !opt.deferExact);
}

/**
 * Upgrade a converted texture in place for native fast item drawing. null means it already fits.
 * Preserve opacity/animation semantics: decoded PS2 opaque alpha is 254, not a reason to enable blending.
 */
export function upgradeIndexedSquareTexture(body: Uint8Array): Ps2Texture | null {
    const source = decodeTxd(body, { upright: false });
    if (!ps2TextureSizeOk(source.width, source.height))
        throw new OotfTextureError('unsupported fast-draw texture size');
    if (source.bpp === 8 && source.width === source.height) return null;
    const size = Math.max(source.width, source.height);
    if (source.bpp === 8) {
        // Preserve the authored palette verbatim (including every alpha byte). Only resize the index plane.
        const paletteBytes = source.paletteKind === 1 ? 1024 : 512;
        const planeAt = 0x40 + 16 + paletteBytes;
        const dv = view(body);
        const indices = source.zlibPlane
            ? inflate(body.subarray(planeAt + 4, planeAt + 4 + dv.getUint32(planeAt, true)))
            : body.subarray(planeAt);
        if (!indices || indices.length !== source.width * source.height)
            throw new OotfTextureError('invalid indexed fast-draw texture plane');
        const next = new Uint8Array(planeAt + size * size);
        next.set(body.subarray(0, planeAt));
        const out = view(next);
        out.setUint32(0, size, true);
        out.setUint32(4, size, true);
        out.setUint32(8, size, true);
        for (let y = 0; y < size; y++)
            for (let x = 0; x < size; x++)
                next[planeAt + y * size + x] =
                    indices[
                        Math.floor((y * source.height) / size) * source.width + Math.floor((x * source.width) / size)
                    ]!;
        return { body: next, width: size, height: size, bpp: 8, hasAlpha: (body[37]! & 2) !== 0, lossy: false };
    }
    // Resample before encoding, so opaque enlargement cannot select the separate smoothing path.
    const image = resampleNearest(source, size, size);
    for (let i = 3; i < image.rgba.length; i += 4) if (image.rgba[i] === 254) image.rgba[i] = 255;
    const old = view(body);
    const upgraded = encodePs2Texture(image, {
        mode: 'indexed',
        maxSize: size,
        square: true,
        fps: body[36]!,
        slot: old.getUint32(40, true),
        deferExact: true,
    });
    upgraded.body.set(body.subarray(36, 64), 36);
    upgraded.body[38] = 0; // representation flag: the upgraded pixel/index plane is 8 bpp
    upgraded.hasAlpha = (body[37]! & 2) !== 0;
    if (upgraded.lossy && upgraded.exact) exactSink?.(upgraded.body, upgraded.exact);
    return upgraded;
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
