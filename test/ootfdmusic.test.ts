// Synthetic fixtures only; no game bytes.
import { describe, expect, it } from 'vitest';
import {
    DMUS_PPQ,
    FIELD_FLOAT,
    FIELD_INT,
    SrscReader,
    addLevelStartMusic,
    applyMusicTriggers,
    buildOotfMusicPack,
    decodeFieldValue,
    decodeMsAdpcm,
    parseDls,
    parseSegment,
    pcInterfaceMusic,
    renderOotfTrack,
    renderSegment,
    tickSeconds,
    type ClassFieldDef,
    type LvlObjectList,
} from '../src/index.ts';

// ---------------------------------------------------------------- RIFF builders

const bytes = (...parts: (Uint8Array | number[])[]): Uint8Array => {
    const n = parts.reduce((s, p) => s + p.length, 0);
    const out = new Uint8Array(n);
    let o = 0;
    for (const p of parts) {
        out.set(p, o);
        o += p.length;
    }
    return out;
};
const cc = (s: string): number[] => [...s].map((c) => c.charCodeAt(0));
const le = (n: number, size: number): number[] => {
    const out: number[] = [];
    for (let i = 0; i < size; i++) out.push((n >>> (8 * i)) & 255);
    return out;
};
const u16 = (n: number): number[] => le(n & 0xffff, 2);
const u32 = (n: number): number[] => le(n >>> 0, 4);
const f64 = (v: number): number[] => {
    const d = new DataView(new ArrayBuffer(8));
    d.setFloat64(0, v, true);
    return [...new Uint8Array(d.buffer)];
};
const chunk = (id: string, body: Uint8Array | number[]): Uint8Array =>
    bytes(cc(id), u32(body.length), body, body.length & 1 ? [0] : []);
const list = (kind: 'RIFF' | 'LIST', type: string, ...kids: Uint8Array[]): Uint8Array => {
    const body = bytes(cc(type), ...kids);
    return bytes(cc(kind), u32(body.length), body);
};
const utf16 = (s: string): number[] => [...[...s].flatMap((c) => u16(c.charCodeAt(0))), 0, 0];
const GUID = Array.from({ length: 16 }, (_, i) => i + 1);

/** One instrument (bank 1 program `program`), one region over all keys, one 16-bit PCM wave: a sine of `period` samples. */
function dls(opts: { program?: number; period?: number; loop?: boolean; release?: number } = {}): Uint8Array {
    const period = opts.period ?? 50; // 22050 / 50 = 441 Hz at the unity note
    const n = period * 40;
    const pcm: number[] = [];
    for (let i = 0; i < n; i++) pcm.push(...u16(Math.round(Math.sin((2 * Math.PI * i) / period) * 16000)));
    const wsmp = bytes(
        u32(20),
        u16(60),
        u16(0),
        u32(0),
        u32(0),
        u32(opts.loop ? 1 : 0),
        ...(opts.loop ? [bytes(u32(16), u32(0), u32(0), u32(n))] : []),
    );
    const fmt = bytes(u16(1), u16(1), u32(22050), u32(44100), u16(2), u16(16));
    const wave = list('LIST', 'wave', chunk('fmt ', fmt), chunk('wsmp', wsmp), chunk('data', pcm));
    const art = bytes(
        u32(8),
        u32(1),
        u16(0),
        u16(0),
        u16(0x209),
        u16(0),
        u32(Math.round((opts.release ?? -1200) * 65536)),
    );
    const ins = list(
        'LIST',
        'ins ',
        chunk('insh', bytes(u32(1), u32(1), u32(opts.program ?? 4))),
        list(
            'LIST',
            'lrgn',
            list(
                'LIST',
                'rgn ',
                chunk('rgnh', bytes(u16(0), u16(127), u16(0), u16(127), u16(0), u16(0))),
                chunk('wlnk', bytes(u16(0), u16(0), u32(1), u32(0))),
            ),
        ),
        list('LIST', 'lart', chunk('art1', art)),
    );
    return list(
        'RIFF',
        'DLS ',
        chunk('colh', u32(1)),
        chunk('dlid', GUID),
        list('LIST', 'lins', ins),
        chunk('ptbl', bytes(u32(8), u32(1), u32(0))),
        list('LIST', 'wvpl', wave),
    );
}

interface Note {
    time: number;
    duration: number;
    key: number;
    vel?: number;
}

/** A segment: tempo `bpm`, a band (program `program`, volume 127) on pchannel 0, the notes, loop points. */
function segment(opts: {
    notes: Note[];
    bpm?: number;
    length?: number;
    loop?: [number, number];
    repeats?: number;
    program?: number;
    name?: string;
}): Uint8Array {
    const length = opts.length ?? DMUS_PPQ * 4;
    const [ls, le_] = opts.loop ?? [0, 0];
    const segh = bytes(u32(opts.repeats ?? 0), u32(length), u32(0), u32(ls), u32(le_), u32(0));
    const trkh = chunk('trkh', new Uint8Array(32));
    const tetr = chunk('tetr', bytes(u32(16), u32(0), u32(0), f64(opts.bpm ?? 120)));
    const evtl = chunk(
        'evtl',
        bytes(
            u32(20),
            ...opts.notes.map((n) =>
                bytes(u32(n.time), u32(n.duration), u32(0), u16(0), [0x90, n.key, n.vel ?? 127, 0, 0, 0]),
            ),
        ),
    );
    const seqt = chunk('seqt', evtl);
    const bins = bytes(
        u32(0x100 | (opts.program ?? 4)),
        u32(0),
        new Uint8Array(16),
        u32(0),
        u32(0x41),
        [64, 127],
        u16(0),
        u32(0),
    );
    const band = list(
        'RIFF',
        'DMBT',
        list(
            'LIST',
            'lbdl',
            list(
                'LIST',
                'lbnd',
                chunk('bdih', u32(0)),
                list(
                    'RIFF',
                    'DMBD',
                    list(
                        'LIST',
                        'lbil',
                        list('LIST', 'lbin', chunk('bins', bins), list('LIST', 'DMRF', chunk('guid', GUID))),
                    ),
                ),
            ),
        ),
    );
    return list(
        'RIFF',
        'DMSG',
        chunk('segh', segh),
        list('LIST', 'UNFO', chunk('UNAM', utf16(opts.name ?? 'test'))),
        list(
            'LIST',
            'trkl',
            list('RIFF', 'DMTK', trkh, tetr),
            list('RIFF', 'DMTK', trkh, seqt),
            list('RIFF', 'DMTK', trkh, band),
        ),
    );
}

/** PC SRSC (header `SRSC`, u16 0x0100, u32 index offset, u16 count), entries of type 0x401. */
function pcRrc(entries: { id: number; data: Uint8Array }[]): Uint8Array {
    let pos = 12;
    const offs = entries.map((e) => {
        const o = pos;
        pos += e.data.length;
        return o;
    });
    return bytes(
        cc('SRSC'),
        u16(0x0100),
        u32(pos),
        u16(entries.length),
        ...entries.map((e) => e.data),
        ...entries.map((e, i) => bytes(u16(0x401), u16(e.id), u16(0), u32(offs[i]!), u32(e.data.length))),
    );
}

/** Zero crossings (rising) per second over [a, b) seconds. */
function frequency(pcm: ArrayLike<number>, rate: number, a: number, b: number): number {
    let n = 0;
    for (let i = Math.round(a * rate) + 1; i < Math.round(b * rate); i++) if (pcm[i - 1]! < 0 && pcm[i]! >= 0) n++;
    return n / (b - a);
}
const rmsOf = (pcm: ArrayLike<number>, rate: number, a: number, b: number): number => {
    let s = 0;
    const i0 = Math.round(a * rate);
    const i1 = Math.min(pcm.length, Math.round(b * rate));
    for (let i = i0; i < i1; i++) s += pcm[i]! * pcm[i]!;
    return Math.sqrt(s / Math.max(1, i1 - i0));
};

// ---------------------------------------------------------------- tests

describe('MS ADPCM', () => {
    it('decodes the header samples and predicts from the coefficient pair', () => {
        // predictor 0 (256, 0), delta 16, sample1 100, sample2 50, then nibbles 0 (predict only) and 1 (+delta)
        const block = Uint8Array.from([0, ...u16(16), ...u16(100), ...u16(50), 0x01]);
        const pcm = decodeMsAdpcm(block, block.length, 4);
        expect([...pcm]).toEqual([50, 100, 100, 116]);
    });
});

describe('DLS and segments', () => {
    it('parses a collection and a segment', () => {
        const col = parseDls(dls({ loop: true }));
        expect(col.guid).toBe(GUID.map((x) => x.toString(16).padStart(2, '0')).join(''));
        expect(col.instruments).toHaveLength(1);
        expect(col.instruments[0]!).toMatchObject({ bank: 1, program: 4 });
        expect(col.instruments[0]!.regions[0]!.wave).toBe(0);
        expect(col.waves[0]!.sample?.loop).toEqual({ start: 0, length: 2000 });
        const seg = parseSegment(
            segment({ notes: [{ time: 0, duration: DMUS_PPQ, key: 60 }], loop: [0, DMUS_PPQ * 4], repeats: 0x7fff }),
        );
        expect(seg).toMatchObject({ name: 'test', repeats: 0x7fff, loopEnd: DMUS_PPQ * 4 });
        expect(seg.events).toEqual([{ time: 0, duration: DMUS_PPQ, pchannel: 0, status: 0x90, b1: 60, b2: 127 }]);
        expect(seg.bands[0]!.instruments[0]).toMatchObject({ patch: 0x104, volume: 127, collection: col.guid });
        expect(tickSeconds(seg.tempos, DMUS_PPQ * 2)).toBeCloseTo(1, 6); // 2 beats at 120 BPM
    });

    it('renders notes at their pitch and time, silent where no note plays', () => {
        const col = parseDls(dls({ loop: true, release: -2400 }));
        const seg = parseSegment(
            segment({
                notes: [
                    { time: 0, duration: DMUS_PPQ, key: 60 }, // 0..0.5 s, 441 Hz
                    { time: DMUS_PPQ * 2, duration: DMUS_PPQ, key: 72 }, // 1..1.5 s, an octave up
                ],
            }),
        );
        const r = renderSegment(seg, [col], [{ from: 0, to: seg.length, startSec: 0 }], { reverb: 0, tail: 1 });
        expect(r.rate).toBe(22050);
        expect(r.endSec).toBeCloseTo(2, 6);
        expect(frequency(r.pcm, r.rate, 0.05, 0.45)).toBeGreaterThan(420);
        expect(frequency(r.pcm, r.rate, 0.05, 0.45)).toBeLessThan(460);
        expect(frequency(r.pcm, r.rate, 1.05, 1.45)).toBeGreaterThan(860);
        expect(frequency(r.pcm, r.rate, 1.05, 1.45)).toBeLessThan(905);
        expect(rmsOf(r.pcm, r.rate, 0.7, 0.95)).toBeLessThan(0.002); // released after 0.5 s
        expect(rmsOf(r.pcm, r.rate, 0.1, 0.4)).toBeGreaterThan(0.1);
    });

    it('builds a PS2 track: intro once, the loop body repeated, the tail folded onto the start', () => {
        const col = parseDls(dls({ loop: true, release: 0 }));
        // 120 BPM: intro 1 s (beats 0-2), body 1 s (beats 2-4); a note at the very end of the body rings past the loop end
        const seg = parseSegment(
            segment({
                notes: [
                    { time: 0, duration: DMUS_PPQ, key: 60 },
                    { time: DMUS_PPQ * 3, duration: DMUS_PPQ, key: 60 },
                ],
                loop: [DMUS_PPQ * 2, DMUS_PPQ * 4],
                repeats: 0x7fff,
            }),
        );
        const t = renderOotfTrack(4, seg, [col], { minSeconds: 3.5, reverb: 0, tail: 2 });
        expect(t.loops).toBe(true);
        expect(t.introSec).toBeCloseTo(1, 6);
        expect(t.loopSec).toBeCloseTo(1, 6);
        expect(t.passes).toBe(3); // 1 + 3 x 1 >= 3.5
        expect(t.pcm.length).toBe(Math.round(4 * 22050));
        // the release of the last pass's note (0.5 s .. 1.5 s past its note off) lands on the track's start, during
        // the intro's silent second half
        expect(rmsOf(t.pcm, t.rate, 0.6, 0.9)).toBeGreaterThan(100);
        let peak = 0;
        for (const x of t.pcm) peak = Math.max(peak, Math.abs(x));
        expect(peak).toBeLessThanOrEqual(Math.round(0.89 * 32767) + 1);
    });
});

describe('OotF music pack', () => {
    it('renders the segments into PS2MUSIC.SDB entries, shares identical ones and finds the title track', async () => {
        const seg = segment({
            notes: [{ time: 0, duration: DMUS_PPQ, key: 60 }],
            loop: [0, DMUS_PPQ * 2],
            repeats: 0x7fff,
        });
        const other = segment({ notes: [{ time: 0, duration: DMUS_PPQ, key: 67 }], name: 'other' });
        const rrc = pcRrc([
            { id: 2, data: seg },
            { id: 4, data: other },
            { id: 5, data: seg },
            { id: 256, data: dls({ loop: true }) },
            { id: 4097, data: Uint8Array.from(u32(1000)) },
        ]);
        const host = await SrscReader.fromBytes(
            bytes(
                cc('SRSC'),
                u16(0x0101),
                u32(16),
                u32(2),
                u16(0),
                bytes(u16(0x302), u16(1), u16(44), u32(0), u32(0)),
                bytes(u16(0x304), u16(1), u16(44), u32(0), u32(0)),
            ),
        );
        const m = await buildOotfMusicPack(rrc, {
            hostSdb: host,
            interfaceMusic: { background: 4, credits: 7 },
            render: { minSeconds: 2, reverb: 0, tail: 1 },
        });
        expect([...m.ids]).toEqual([
            [2, 2],
            [4, 3],
            [5, 2],
        ]); // id 1 is taken by the host SDB; segment 5 equals segment 2
        expect(m.title).toBe(3);
        expect(m.credits).toBeNull();
        expect(Object.keys(m.files).sort()).toEqual([
            'new/PS2MUSIC.SDB/0302_2_44.bin',
            'new/PS2MUSIC.SDB/0302_3_44.bin',
            'new/PS2MUSIC.SDB/0304_2_44.bin',
            'new/PS2MUSIC.SDB/0304_3_44.bin',
        ]);
        expect(m.tracks.find((t) => t.pcId === 5)).toMatchObject({ ps2Id: 2, sharedWith: 2 });
        // descriptor: name, flags 0xa (looping) for the looped segment, 0x2 for the other, rate 22050, class byte 0x99
        const d = m.files['new/PS2MUSIC.SDB/0302_2_44.bin']!;
        const dv = new DataView(d.buffer, d.byteOffset);
        const o = 2 + dv.getUint16(0, true);
        expect(dv.getUint32(o, true)).toBe(0xa);
        expect(dv.getUint32(o + 8, true)).toBe(22050);
        expect(dv.getUint32(o + 28, true)).toBe(0x99);
        expect(dv.getUint32(o + 40, true)).toBe(m.files['new/PS2MUSIC.SDB/0304_2_44.bin']!.length);
        const d3 = m.files['new/PS2MUSIC.SDB/0302_3_44.bin']!;
        expect(
            new DataView(d3.buffer, d3.byteOffset).getUint32(
                2 + new DataView(d3.buffer, d3.byteOffset).getUint16(0, true),
                true,
            ),
        ).toBe(0x2);
    });

    it('reads the interface music ids', () => {
        const fields: ClassFieldDef[] = [
            { name: 'Background Music ID', type: FIELD_INT },
            { name: 'Credits Music ID', type: FIELD_INT },
        ];
        expect(pcInterfaceMusic(new Map([[1, { fields, data: [4, 7] }]]))).toEqual({ background: 4, credits: 7 });
        expect(pcInterfaceMusic(new Map())).toEqual({ background: 0, credits: 0 });
    });

    const MUSIC_FIELDS: ClassFieldDef[] = [
        { name: 'Sounds', type: 0x1005 },
        { name: 'Plays overlay music (Triggered only) ?', type: FIELD_INT },
        { name: 'Fade Out Time When Stopped', type: FIELD_FLOAT },
        { name: 'Fade In Time When Started', type: FIELD_FLOAT },
        { name: 'Start State For Triggered Sounds', type: FIELD_INT },
    ];
    const musicClass = { dbIndex: 14, classId: 20, fields: MUSIC_FIELDS };

    it('adds the level start music as a Triggered Music Loop that is on from the start', () => {
        const objects: LvlObjectList = { objects: [], warnings: [] };
        const ids = new Map([[8, 9]]);
        expect(addLevelStartMusic(objects, 0, [0, 0, 0], { musicClass, trackIds: ids })).toBeNull();
        expect(addLevelStartMusic(objects, 3, [0, 0, 0], { musicClass, trackIds: ids })).toBeNull(); // no track
        const id = addLevelStartMusic(objects, 8, [10, 20, 30], { musicClass, trackIds: ids })!;
        const o = objects.objects.find((x) => x.id === id)!;
        expect([o.classId, o.dbIndex, ...o.pos]).toEqual([20, 14, 10, 20, 30]);
        const v = (name: string) => {
            const i = o.params.findIndex((p) => p.name === name);
            return decodeFieldValue(o.params[i]!.type, o.data[i]!, o.data);
        };
        expect(v('Sounds')).toEqual([9]);
        expect(v('Start State For Triggered Sounds')).toBe(1);
        expect(v('Plays overlay music (Triggered only) ?')).toBe(0);
    });

    it('maps trigger music to the rendered tracks when given', () => {
        const objects: LvlObjectList = { objects: [], warnings: [] };
        const r = applyMusicTriggers(
            objects,
            [
                {
                    objectId: 77,
                    className: 'Music Trigger',
                    pos: [0, 0, 0],
                    rot: [0, 0, 0],
                    links: [],
                    music1: 8,
                    music2: 0,
                    fadeIn1: 3,
                    fadeOut1: 3,
                    fadeIn2: 3,
                    fadeOut2: 3,
                },
            ],
            'Mountain World/Ruined Village/Ruined Village.lvl',
            { musicClass, trackIds: new Map([[8, 9]]) },
        );
        expect([...r.tracks]).toEqual([[9, 1]]);
    });
});
