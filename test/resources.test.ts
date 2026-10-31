// Synthetic fixtures only; no game bytes.
import { describe, expect, it } from 'vitest';
import {
    adpcmSamples,
    decodeSpuAdpcm,
    lengthString,
    parseAnimationHeader,
    parseSequenceName,
    parseSoundDescriptor,
} from '../src/index.ts';

const u16 = (n: number): number[] => [n & 255, n >> 8];
const u32 = (n: number): number[] => [...u16(n & 0xffff), ...u16(n >>> 16)];
const str = (s: string, pad = 0): number[] => [
    ...u16(s.length + pad),
    ...[...s].map((c) => c.charCodeAt(0)),
    ...new Array(pad).fill(0),
];

describe('resource names', () => {
    it('reads a length-prefixed NUL padded string', () => {
        const r = lengthString(Uint8Array.from([...str('hello', 3), 9, 9]));
        expect(r.text).toBe('hello');
        expect(r.end).toBe(10);
    });

    it('parses an SDB descriptor with and without subtitle', () => {
        const effect = Uint8Array.from([
            ...str('Boom', 2),
            ...u32(2),
            ...u32(0x100001),
            ...u32(44100),
            ...new Array(40).fill(0),
        ]);
        expect(parseSoundDescriptor(effect)).toEqual({ name: 'Boom', rate: 44100, text: '' });
        const text = 'Hi there\0\0';
        const voice = Uint8Array.from([
            ...str('C1-A'),
            ...u32(0x2002),
            ...u32(0x100001),
            ...u32(22050),
            ...new Array(20).fill(0),
            ...u16(text.length),
            ...[...text].map((c) => c.charCodeAt(0)),
        ]);
        const d = parseSoundDescriptor(voice);
        expect(d.name).toBe('C1-A');
        expect(d.rate).toBe(22050);
        expect(d.text).toBe('Hi there');
    });

    it('falls back to 22050 Hz for an implausible rate', () => {
        const rec = Uint8Array.from([...str('x'), ...u32(0), ...u32(0), ...u32(7), ...new Array(30).fill(0)]);
        expect(parseSoundDescriptor(rec).rate).toBe(22050);
    });

    it('parses an animation header and a sequence name', () => {
        const rec = Uint8Array.from([...str('Idle', 0), 0, 0, 0x80, 0x3f, ...u32(0), ...u32(65), ...u32(32)]);
        expect(parseAnimationHeader(rec)).toEqual({ name: 'Idle', frames: 65 });
        expect(parseSequenceName(Uint8Array.from([...str('6.04 Gate', 1), 1, 2, 3]))).toBe('6.04 Gate');
    });
});

describe('SPU ADPCM', () => {
    const block = (shiftPred: number, flags: number, nibbles: number[]): number[] => {
        const out = [shiftPred, flags];
        for (let i = 0; i < 28; i += 2) out.push((nibbles[i] ?? 0) | ((nibbles[i + 1] ?? 0) << 4));
        return out;
    };

    it('decodes predictor 0 nibbles at shift 12 to the signed nibble values', () => {
        const pcm = decodeSpuAdpcm(Uint8Array.from(block(12, 0, [1, 15, 7, 8, 2])));
        expect([...pcm.slice(0, 5)]).toEqual([1, -1, 7, -8, 2]);
        expect(pcm.length).toBe(28);
    });

    it('applies the predictor filters across samples and blocks', () => {
        // predictor 1: s = v + (prev * 60 >> 6). Start 64 (shift 6: v=1 -> 64), then v=0 -> 60.
        const pcm = decodeSpuAdpcm(Uint8Array.from(block(6 | 0x10, 0, [1, 0, 0])));
        expect([...pcm.slice(0, 3)]).toEqual([64, 60, 56]);
    });

    it('stops after the block with the end flag and clamps', () => {
        const data = Uint8Array.from([...block(0, 1, [7]), ...block(12, 0, [1])]);
        expect(decodeSpuAdpcm(data).length).toBe(28);
        const loud = Uint8Array.from(block(0, 0, [7, 7, 7]));
        for (const v of decodeSpuAdpcm(loud)) expect(Math.abs(v)).toBeLessThanOrEqual(32767);
        expect(adpcmSamples(33)).toBe(56);
    });
});
