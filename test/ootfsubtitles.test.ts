// Synthetic fixtures only; no game bytes or game text.
import { describe, expect, it } from 'vitest';
import {
    SUBTITLE_FORMAT,
    SubtitleFileError,
    SubtitleTable,
    classifySubtitleLines,
    listObjectSounds,
    listSequenceSounds,
    mergeSubtitleFiles,
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

    it('reads the kind of a line and lets a later file set it with or without text', () => {
        const fresh = parseSubtitleFile(
            file([
                { bank: 'a/b', id: 1, cues: [{ start: 0, end: 1, text: 'Hm, hm.' }] },
                { bank: 'a/b', id: 2, kind: 'bark', cues: [{ start: 0, end: 1, text: 'Ow!' }] },
                { bank: 'a/b', id: 3, kind: 'narration', cues: [{ start: 0, end: 4, text: 'Long ago.' }] },
            ]),
        );
        expect(fresh.lines.map((l) => l.kind)).toEqual([undefined, 'bark', 'narration']);
        const hand = parseSubtitleFile(
            file([
                { bank: 'a/b', id: 1, kind: 'effect' }, // kind only: the text of the earlier file stays
                { bank: 'a/b', id: 2, cues: [{ start: 0, end: 1, text: 'Ouch!' }] }, // text only: the kind stays
                { bank: 'a/b', id: 3, kind: 'dialogue', kindReason: 'checked by ear' },
            ]),
        );
        const merged = mergeSubtitleFiles([fresh, hand]);
        const by = (id: number) => merged.lines.find((l) => l.id === id)!;
        expect(by(1)).toMatchObject({ kind: 'effect', cues: [{ text: 'Hm, hm.' }] });
        expect(by(2)).toMatchObject({ kind: 'bark', cues: [{ text: 'Ouch!' }] });
        expect(by(3)).toMatchObject({ kind: 'dialogue', kindReason: 'checked by ear', cues: [{ text: 'Long ago.' }] });
        const t = new SubtitleTable(merged);
        expect(t.clipText('a/b', 1)).toBeNull();
        expect(t.clipText('a/b', 2)).toBeNull();
        expect(t.clipText('a/b', 3)).toBe('[[0]]Long ago.[[4]]');
        expect(t.withheld.map((l) => l.id).sort()).toEqual([1, 2]);
    });

    it('names the fault of a bad file', () => {
        expect(() => parseSubtitleFile({ format: 'other', version: 1, lines: [] })).toThrow(SubtitleFileError);
        expect(() => parseSubtitleFile(file([{ bank: 'a', id: 1, kind: 'grunt', cues: [] }]))).toThrow(/kind "grunt"/);
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

/** PC class record (0x0102): name, group, model id/db, engine class, icon, field count, dwords, data, field list. */
function pcClass(name: string, fields: { type: number; name: string }[], data: number[]): number[] {
    const nm = [...name].map((c) => c.charCodeAt(0));
    const out = [...u16(nm.length + 1), ...nm, 0, ...u16(1), ...u16(0), ...u16(0), ...u16(49), ...u16(0)];
    out.push(...u32(fields.length), ...u32(data.length), ...data.flatMap(u32));
    for (const f of fields) {
        const fn = [...f.name].map((c) => c.charCodeAt(0));
        out.push(...u32(f.type), ...u16(fn.length + 1), ...fn, 0);
    }
    return out;
}

describe('sounds the game plays by itself', () => {
    const files = new Map<string, Uint8Array>([
        [
            'Common/Npc/Npcs.odb',
            pcSrsc([
                {
                    type: 0x0102,
                    id: 5,
                    sub: 1,
                    // "Ambient Sounds" is a sound array (two refs in the trailing part), "Hit Sound" one sound
                    data: pcClass(
                        'Grunt',
                        [
                            { type: 0x1005, name: 'Ambient Sounds' },
                            { type: 5, name: 'Hit Sound' },
                        ],
                        [(2 << 16) | 2, 0x0001_0007, 0x0000_0002, 0x0001_0003],
                    ),
                },
            ]),
        ],
        ['Common/Npc/Npcs.db', new TextEncoder().encode('version 1\ndependencies 1\n1 ..\\Fx\\Fx\n')],
        ['Common/Fx/Fx.sdb', new Uint8Array(0)],
    ]);
    const src: PcFileSource = {
        read: async (p) => [...files].find(([k]) => k.toLowerCase() === p.toLowerCase())?.[1] ?? null,
        list: async () => [...files.keys()],
    };

    it('lists the class defaults that name a sound, with the class and the field', async () => {
        const sounds = await listObjectSounds(src);
        expect(sounds.map((s) => `${s.bank}#${s.id}`)).toEqual(['common/fx/fx#3', 'common/fx/fx#7', 'common/npc/npcs#2']);
        expect(sounds[1]!.uses).toEqual([{ owner: 'Common/Npc/Npcs', className: 'Grunt', field: 'Hit Sound' }]);
        expect(sounds[2]!.uses[0]!.field).toBe('Ambient Sounds');
    });

    it('marks a line whose clip the game plays by itself as a bark and keeps a kind set by hand', async () => {
        const f = parseSubtitleFile(
            file([
                { bank: 'common/fx/fx', id: 7, cues: [{ start: 0, end: 1, text: 'Hey, hey.' }] },
                { bank: 'common/fx/fx', id: 3, kind: 'dialogue', cues: [{ start: 0, end: 1, text: 'Over here!' }] },
                { bank: 'common/fx/fx', id: 9, cues: [{ start: 0, end: 3, text: 'A scene line.' }] },
            ]),
        );
        const marked = classifySubtitleLines(f, await listObjectSounds(src));
        expect(marked.map((l) => l.id)).toEqual([7]);
        expect(marked[0]!.kindReason).toBe('played by Grunt . Hit Sound');
        const t = new SubtitleTable(f);
        expect(t.clipText('common/fx/fx', 7)).toBeNull();
        expect(t.clipText('common/fx/fx', 3)).toBe('[[0]]Over here![[1]]');
        expect(t.clipText('common/fx/fx', 9)).toBe('[[0]]A scene line.[[3]]');
    });
});
