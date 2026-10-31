import { latin1, view } from './bytes.ts';

/**
 * Names and sample data of the non-model resources a class field can reference (level-format.md section 12b):
 * sounds (SDB 0x302 descriptor + 0x304 SPU-ADPCM), animations (ADB 0x501 header + 0x502 key data) and cutscene sequences
 * (SSD 0x311). Sound layout: docs/reference/subtitles.md section 3.1 and analysis/scripts/sub_sdb_text.py.
 */

export const SDB_DESCRIPTOR = 0x302;
export const SDB_SAMPLES = 0x304;
export const ADB_ANIMATION = 0x501;
export const ADB_KEYS = 0x502;
export const SSD_SEQUENCE = 0x311;

/** `u16 length, length bytes` NUL padded string at the start of a record, and the offset after it. */
export function lengthString(b: Uint8Array): { text: string; end: number } {
    if (b.length < 2) return { text: '', end: b.length };
    const n = view(b).getUint16(0, true);
    const end = Math.min(b.length, 2 + n);
    const z = b.indexOf(0, 2);
    return { text: latin1(b, 2, z < 0 || z > end ? end : z), end };
}

export interface SoundDescriptor {
    name: string;
    /** Sample rate in Hz (22050 speech, 44100 effects seen). */
    rate: number;
    /** Subtitle text of a voice line; empty for effects. */
    text: string;
}

/** SDB 0x302: `string name, u32 flags, u32 0x00100001, u32 rate, ...`, subtitle string at +32 when `flags & 0x2000`. */
export function parseSoundDescriptor(b: Uint8Array): SoundDescriptor {
    const { text: name, end } = lengthString(b);
    const dv = view(b);
    const rate = end + 12 <= b.length ? dv.getUint32(end + 8, true) : 0;
    let text = '';
    if (end + 4 <= b.length && dv.getUint32(end, true) & 0x2000 && end + 34 <= b.length) {
        const len = dv.getUint16(end + 32, true);
        const stop = Math.min(b.length, end + 34 + len);
        const z = b.indexOf(0, end + 34);
        const bytes = b.subarray(end + 34, z < 0 || z > stop ? stop : z);
        text = new TextDecoder('windows-1252').decode(bytes);
    }
    return { name, rate: rate >= 4000 && rate <= 96000 ? rate : 22050, text };
}

const ADPCM_F0 = [0, 60, 115, 98, 122];
const ADPCM_F1 = [0, 0, -52, -55, -60];

/** Number of PCM samples `decodeSpuAdpcm` produces for `bytes` of ADPCM (28 per 16-byte block, ignoring the end flag). */
export const adpcmSamples = (bytes: number): number => Math.floor(bytes / 16) * 28;

/**
 * PS2 SPU ADPCM (VAG) to mono 16-bit PCM. Blocks are 16 bytes: `shift | predictor << 4`, a flag byte (1 = end,
 * 4 = loop start) and 14 bytes with 28 signed nibbles, low nibble first. Same decoder as analysis/scripts/sub_adpcm_wav.py.
 * Decoding stops after the first block with the end flag.
 */
export function decodeSpuAdpcm(b: Uint8Array): Int16Array {
    const blocks = Math.floor(b.length / 16);
    const out = new Int16Array(blocks * 28);
    let n = 0;
    let s1 = 0;
    let s2 = 0;
    for (let i = 0; i < blocks; i++) {
        const o = i * 16;
        const shift = b[o]! & 15;
        const pred = Math.min(b[o]! >> 4, 4);
        const f0 = ADPCM_F0[pred]!;
        const f1 = ADPCM_F1[pred]!;
        for (let j = 0; j < 14; j++) {
            const byte = b[o + 2 + j]!;
            for (let k = 0; k < 2; k++) {
                const nib = k === 0 ? byte & 15 : byte >> 4;
                const v = nib > 7 ? nib - 16 : nib;
                let s = (v << 12) >> shift;
                s += ((s1 * f0) >> 6) + ((s2 * f1) >> 6);
                s = s > 32767 ? 32767 : s < -32768 ? -32768 : s;
                out[n++] = s;
                s2 = s1;
                s1 = s;
            }
        }
        if (b[o + 1]! & 1) break;
    }
    return out.slice(0, n);
}

export interface AnimationHeader {
    name: string;
    /** Frame count (also the first u32 of the 0x502 key data). */
    frames: number;
}

/** ADB 0x501: `string name, f32 ?, u32 0, u32 frames, ...`. */
export function parseAnimationHeader(b: Uint8Array): AnimationHeader {
    const { text: name, end } = lengthString(b);
    const frames = end + 12 <= b.length ? view(b).getUint32(end + 8, true) : 0;
    return { name, frames: frames < 100000 ? frames : 0 };
}

/** SSD 0x311 cutscene sequence: the record starts with its name (`u16 length, string`). */
export function parseSequenceName(b: Uint8Array): string {
    return lengthString(b).text;
}
