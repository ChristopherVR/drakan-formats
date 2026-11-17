/**
 * A small PNG decoder for the textures of authored models (ootfauthored.ts): 8-bit greyscale, grey + alpha, RGB, RGBA and
 * palette images, not interlaced (what Blender and image editors write by default). Returns RGBA.
 */

import { unzlibSync } from 'fflate';
import type { RgbaImage } from './ootftex.ts';

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

export class PngError extends Error {}

export function decodePng(bytes: Uint8Array): RgbaImage {
    for (let i = 0; i < 8; i++) if (bytes[i] !== SIGNATURE[i]) throw new PngError('not a PNG file');
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let width = 0;
    let height = 0;
    let depth = 0;
    let colour = 0;
    let interlace = 0;
    let palette: Uint8Array | null = null;
    let trns: Uint8Array | null = null;
    const idat: Uint8Array[] = [];
    for (let at = 8; at + 8 <= bytes.length;) {
        const len = dv.getUint32(at);
        const type = String.fromCharCode(bytes[at + 4]!, bytes[at + 5]!, bytes[at + 6]!, bytes[at + 7]!);
        const data = bytes.subarray(at + 8, at + 8 + len);
        if (type === 'IHDR') {
            width = dv.getUint32(at + 8);
            height = dv.getUint32(at + 12);
            depth = data[8]!;
            colour = data[9]!;
            interlace = data[12]!;
        } else if (type === 'PLTE') palette = data;
        else if (type === 'tRNS') trns = data;
        else if (type === 'IDAT') idat.push(data);
        else if (type === 'IEND') break;
        at += 12 + len;
    }
    if (!width || !height) throw new PngError('no IHDR chunk');
    if (depth !== 8) throw new PngError(`bit depth ${depth} is not supported (8 only)`);
    if (interlace) throw new PngError('interlaced PNG is not supported');
    const channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[colour];
    if (!channels) throw new PngError(`colour type ${colour} is not supported`);
    if (colour === 3 && !palette) throw new PngError('palette image without PLTE');
    const total = idat.reduce((s, c) => s + c.length, 0);
    const joined = new Uint8Array(total);
    let o = 0;
    for (const c of idat) {
        joined.set(c, o);
        o += c.length;
    }
    const raw = unzlibSync(joined);
    const stride = width * channels;
    if (raw.length < height * (stride + 1)) throw new PngError('image data is short');
    const px = new Uint8Array(height * stride);
    for (let y = 0; y < height; y++) {
        const filter = raw[y * (stride + 1)]!;
        const src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
        const row = px.subarray(y * stride, (y + 1) * stride);
        const prev = y > 0 ? px.subarray((y - 1) * stride, y * stride) : null;
        for (let x = 0; x < stride; x++) {
            const a = x >= channels ? row[x - channels]! : 0;
            const b = prev ? prev[x]! : 0;
            const c = prev && x >= channels ? prev[x - channels]! : 0;
            let v = src[x]!;
            if (filter === 1) v += a;
            else if (filter === 2) v += b;
            else if (filter === 3) v += (a + b) >> 1;
            else if (filter === 4) {
                const p = a + b - c;
                const pa = Math.abs(p - a);
                const pb = Math.abs(p - b);
                const pc = Math.abs(p - c);
                v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
            } else if (filter !== 0) throw new PngError(`unknown filter ${filter}`);
            row[x] = v & 255;
        }
    }
    const rgba = new Uint8Array(width * height * 4);
    for (let i = 0; i < width * height; i++) {
        const s = i * channels;
        let r: number, g: number, b: number, al: number;
        if (colour === 6) [r, g, b, al] = [px[s]!, px[s + 1]!, px[s + 2]!, px[s + 3]!];
        else if (colour === 2) [r, g, b, al] = [px[s]!, px[s + 1]!, px[s + 2]!, 255];
        else if (colour === 4) [r, g, b, al] = [px[s]!, px[s]!, px[s]!, px[s + 1]!];
        else if (colour === 0) [r, g, b, al] = [px[s]!, px[s]!, px[s]!, 255];
        else {
            const k = px[s]!;
            [r, g, b] = [palette![k * 3] ?? 0, palette![k * 3 + 1] ?? 0, palette![k * 3 + 2] ?? 0];
            al = trns && k < trns.length ? trns[k]! : 255;
        }
        rgba.set([r, g, b, al], i * 4);
    }
    return { width, height, rgba };
}
