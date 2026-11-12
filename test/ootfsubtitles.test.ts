// Synthetic fixtures only; no game bytes or game text.
import { describe, expect, it } from 'vitest';
import {
    SUBTITLE_FORMAT,
    SubtitleFileError,
    SubtitleTable,
    listSequenceSounds,
    parseSubtitleFile,
    pcmWav,
    plainSubtitleText,
    splitLongCue,
    subtitleClipText,
} from '../src/ootfsubtitles.ts';
import { convertPcSounds, ps2SoundEntries, writePs2Descriptor, type PcSoundBank } from '../src/ootfsound.ts';
import { parseSdbText } from '../src/story/sdbtext.ts';
import type { PcFileSource } from '../src/pc.ts';

const u16 = (v: number): number[] => [v & 255, v >> 8];
const u32 = (v: number): number[] => [v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255];
const f32 = (v: number): number[] => [...new Uint8Array(new Float32Array([v]).buffer)];
const str = (s: string): number[] => {
    const n = s.length + (s.length % 2);
    return [...u16(n), ...[...s].map((c) => c.charCodeAt(0)), ...(s.length % 2 ? [0] : [])];
};
const act = (type: number, t: number, payload: number[]): number[] => [...u16(type), ...f32(t), ...payload];
const actor = (name: string, id: number, obj: number, actions: number[][]): number[] => [
    ...str(name),
    ...u32(id),
    ...u32(1),
    ...u32(0),
    ...u32(obj),
    ...u32(actions.length),
    ...actions.flat(),
];
/** PC SRSC container (index after the bodies). */
function pcSrsc(specs: { type: number; id: number; sub: number; data: number[] }[]): Uint8Array {
    const body: number[] = [];
    const offs: number[] = [];
    let pos = 12;
    for (const s of specs) {
        offs.push(pos);
        body.push(...s.data);
        pos += s.data.length;
    }
    const out = [0x53, 0x52, 0x53, 0x43, ...u16(0x0100), ...u32(pos), ...u16(specs.length), ...body];
    specs.forEach((s, i) =>
        out.push(...u16(s.type), ...u16(s.id), ...u16(s.sub), ...u32(offs[i]!), ...u32(s.data.length)),
    );
    return Uint8Array.from(out);
}

const file = (lines: unknown[]): unknown => ({ format: SUBTITLE_FORMAT, version: 1, language: 'english', lines });

describe('subtitle file', () => {
    it('reads lines, sorts cues and normalises the bank key', () => {
        const f = parseSubtitleFile(
            file([
                {
                    bank: 'World\\Level One\\Voices.sdb',
                    id: 7,
                    name: 'line 7',
                    duration: 6,
                    cues: [
                        { start: 3, end: 6, text: 'second page' },
                        { start: 0.5, end: 3, text: 'first page' },
                    ],
                },
            ]),
        );
        expect(f.lines[0]!.bank).toBe('world/level one/voices');
        expect(f.lines[0]!.cues.map((c) => c.text)).toEqual(['first page', 'second page']);
        expect(f.language).toBe('english');
    });

    it('names the fault of a bad file', () => {
        expect(() => parseSubtitleFile({ format: 'other', version: 1, lines: [] })).toThrow(SubtitleFileError);
        expect(() => parseSubtitleFile(file([{ bank: 'a', id: 1 }]))).toThrow(/line 0/);
        expect(() => parseSubtitleFile(file([{ bank: 'a', id: 1, cues: [{ start: 0, text: 'x' }] }]))).toThrow(/cue/);
    });
});

describe('clip text', () => {
    it('writes each page with its start and closes the last one', () => {
        const text = subtitleClipText({
            cues: [
                { start: 0.4, end: 3.1, text: 'A first sentence.' },
                { start: 3.1, end: 6, text: 'And a second one.' },
            ],
        });
        expect(text).toBe('[[0.4]]A first sentence.[[3.1]]And a second one.[[6]]');
    });

    it('splits a long cue at word boundaries and shares its time', () => {
        const long = Array.from({ length: 30 }, (_, i) => `word${i}`).join(' ');
        const parts = splitLongCue({ start: 2, end: 12, text: long }, 60);
        expect(parts.length).toBeGreaterThan(2);
        expect(parts.every((p) => p.text.length <= 60)).toBe(true);
        expect(parts.map((p) => p.text).join(' ')).toBe(long);
        expect(parts[0]!.start).toBe(2);
        expect(parts.at(-1)!.end).toBeCloseTo(12, 5);
        for (let i = 1; i < parts.length; i++) expect(parts[i]!.start).toBeCloseTo(parts[i - 1]!.end, 5);
    });

    it('keeps the text plain: no page marks, backslashes or typographic dashes', () => {
        expect(plainSubtitleText('“Wait” — she said… it’s  here\\now')).toBe(
            '"Wait", she said... it\'s here/now',
        );
        expect(subtitleClipText({ cues: [{ start: 0, end: 1, text: 'a [[2]] b' }] })).toBe('[[0]]a 2 b[[1]]');
        expect(subtitleClipText({ cues: [{ start: 0, end: 1, text: '   ' }] })).toBe('');
    });

    it('stops at a page end before the engine text slot overflows', () => {
        const cues = Array.from({ length: 40 }, (_, i) => ({ start: i * 2, end: i * 2 + 2, text: 'x'.repeat(70) }));
        const text = subtitleClipText({ cues });
        expect(text.length).toBeLessThanOrEqual(1000);
        expect(text.endsWith(']]')).toBe(true);
        expect(text.split('[[').length - 1).toBeGreaterThan(5);
    });

    it('looks lines up by bank and id, and skips empty ones', () => {
        const t = new SubtitleTable(
            parseSubtitleFile(
                file([
                    { bank: 'a/b', id: 3, cues: [{ start: 0, end: 2, text: 'Hello there.' }] },
                    { bank: 'a/b', id: 4, cues: [{ start: 0, end: 2, text: ' ' }] },
                ]),
            ),
        );
        expect(t.size).toBe(1);
        expect(t.clipText('A\\B.sdb', 3)).toBe('[[0]]Hello there.[[2]]');
        expect(t.clipText('a/b', 4)).toBeNull();
        expect(t.clipText('a/c', 3)).toBeNull();
    });
});

describe('sound descriptor text', () => {
    const sound = { id: 5, group: 1, name: 'voice', flags: 2, rate: 22050, volume: 0, dropoff: 15, priority: 5, pcm: new Int16Array(2205) };

    it('stores the text the way the disc does and leaves a plain descriptor unchanged', () => {
        const plain = writePs2Descriptor(sound, 4410, 1280);
        expect(parseSdbText(plain)).toMatchObject({ name: 'voice', hasText: false });
        const withText = writePs2Descriptor({ ...sound, text: '[[0]]Hello there.[[2]]' }, 4410, 1280);
        expect(parseSdbText(withText)).toEqual({ name: 'voice', hasText: true, text: '[[0]]Hello there.[[2]]' });
        expect(withText.length % 4).toBe(0);
        // the 12 tail bytes (sample sizes) are the same
        expect([...withText.subarray(withText.length - 12)]).toEqual([...plain.subarray(plain.length - 12)]);
    });

    it('gives converted clips their line and loops none', () => {
        const pcm = new Int16Array(22050);
        const bank: PcSoundBank = {
            sounds: [
                { id: 9, group: 1, name: 'line', flags: 0, channels: 1, bits: 16, rate: 22050, volume: 0, dropoff: 15, priority: 5, pcm },
                { id: 10, group: 1, name: 'wind', flags: 8, channels: 1, bits: 16, rate: 22050, volume: 0, dropoff: 15, priority: 5, pcm },
            ],
            groups: new Map(),
            warnings: [],
        };
        const conv = convertPcSounds(
            new Map([['a/b', bank]]),
            { firstId: 100, groupId: 1 },
            { text: (key, pc) => `[[0]]${key}#${pc.id}[[1]]` },
        );
        expect(conv.sounds.map((s) => s.text)).toEqual(['[[0]]a/b#9[[1]]', undefined]);
        const recs = ps2SoundEntries(conv.sounds).filter((r) => r.type === 0x302);
        expect(parseSdbText(recs[0]!.data)!.text).toBe('[[0]]a/b#9[[1]]');
        expect(parseSdbText(recs[1]!.data)!.hasText).toBe(false);
    });
});

describe('sequence sounds', () => {
    it('lists the clips sequences play with their bank, scene and time', async () => {
        const seq = [
            ...str('Scene'),
            ...u32(126),
            ...u32(0),
            ...u32(3),
            ...u32(1),
            ...actor('Narrator', 1, 100, [
                act(3, 1.5, [...u32(0x0000_0009), ...f32(4), ...u16(10000), ...u16(0x18)]),
                act(3, 7, [...u32(0x0002_0021), ...f32(2), ...u16(10000), ...u16(0x18)]),
                act(3, 9, [...u32(0x0005_0001), ...f32(2), ...u16(10000), ...u16(0x18)]),
            ]),
        ];
        const files = new Map<string, Uint8Array>([
            ['World/Level/Level.ssd', pcSrsc([{ type: 0x311, id: 4, sub: 1, data: seq }])],
            ['World/Level/Level.db', new TextEncoder().encode('version 1\ndependencies 1\n2 ..\\Common\\Voices\n')],
            ['World/Common/Voices.sdb', new Uint8Array(0)],
        ]);
        const src: PcFileSource = {
            read: async (p) => [...files].find(([k]) => k.toLowerCase() === p.toLowerCase())?.[1] ?? null,
            list: async () => [...files.keys()],
        };
        const sounds = await listSequenceSounds(src);
        // db 0 = the sequence database itself, db 2 = its dependency; db 5 is not listed and is left out
        expect(sounds.map((s) => `${s.bank}#${s.id}`)).toEqual(['world/common/voices#33', 'world/level/level#9']);
        expect(sounds[0]!.bankPath).toBe('World/Common/Voices');
        expect(sounds[1]!.uses[0]).toMatchObject({ sequence: 'Scene', actor: 'Narrator', sequenceId: 4 });
        expect(sounds[1]!.uses[0]!.time).toBeCloseTo(1.5, 5);
        expect(sounds[1]!.uses[0]!.duration).toBeCloseTo(4, 5);
    });

    it('writes clips as mono 16 bit wave files', () => {
        const wav = pcmWav(Int16Array.from([1, -2, 3]), 11025);
        expect(new TextDecoder().decode(wav.subarray(0, 4))).toBe('RIFF');
        expect(wav.length).toBe(44 + 6);
        const dv = new DataView(wav.buffer);
        expect(dv.getUint32(24, true)).toBe(11025);
        expect(dv.getInt16(46, true)).toBe(-2);
    });
});
