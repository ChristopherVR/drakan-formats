// Synthetic fixtures only; no game bytes.
import { zlibSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { SrscReader } from '../src/srsc.ts';
import { decodeSpuAdpcm, parseSoundDescriptor } from '../src/resources.ts';
import {
    SoundMap,
    appendToPs2Sdb,
    convertPcSounds,
    decodeSdbSamples,
    encodeSdbSamples,
    encodeVag,
    nextSdbIds,
    parsePcSounds,
    pcmToMono16,
    resamplePcm,
    sdbKey,
    snrDb,
    writePs2Sdb,
} from '../src/ootfsound.ts';

const u16 = (n: number): number[] => [n & 255, (n >> 8) & 255];
const u32 = (n: number): number[] => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];
const f32 = (n: number): number[] => {
    const d = new DataView(new ArrayBuffer(4));
    d.setFloat32(0, n, true);
    return [0, 1, 2, 3].map((i) => d.getUint8(i));
};
const str = (s: string): number[] => {
    const n = s.length + 1;
    return [...u16(n + (n % 2)), ...[...s].map((c) => c.charCodeAt(0)), 0, ...(n % 2 ? [0] : [])];
};

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

function pcSound(
    name: string,
    pcm: Int16Array | Uint8Array,
    o: { bits?: number; ch?: number; rate?: number; flags?: number; z?: boolean; vol?: number },
): number[] {
    const raw = pcm instanceof Int16Array ? new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength) : pcm;
    const head = [
        ...str(name),
        ...u32(o.flags ?? 0),
        ...u16(o.ch ?? 1),
        ...u16(o.bits ?? 16),
        ...u32(o.rate ?? 22050),
        ...u32((o.vol ?? -300) >>> 0),
        ...f32(15),
        ...u32(5),
        ...u32(raw.length),
    ];
    if (o.z) {
        const z = zlibSync(raw);
        return [...head, ...u32(1), ...u32(z.length), ...z];
    }
    return [...head, ...u32(0), ...raw];
}

/** A voice-like test signal: two sines, a noise burst and silence. */
function signal(n: number, rate = 22050): Int16Array {
    const s = new Int16Array(n);
    let seed = 12345;
    for (let i = 0; i < n; i++) {
        const t = i / rate;
        let v = 9000 * Math.sin(2 * Math.PI * 440 * t) + 4000 * Math.sin(2 * Math.PI * 1370 * t);
        if (i > n / 2 && i < (n * 3) / 4) {
            seed = (seed * 1103515245 + 12345) & 0x7fffffff;
            v += ((seed >> 8) % 4001) - 2000;
        }
        if (i > (n * 3) / 4) v = 0;
        s[i] = Math.round(v);
    }
    return s;
}

describe('PS-ADPCM encoder', () => {
    it('round-trips a test signal above 30 dB SNR through the shared decoder', () => {
        const pcm = signal(22050);
        const vag = encodeVag(pcm);
        expect(vag.length).toBe(Math.ceil(pcm.length / 28) * 16);
        const back = decodeSpuAdpcm(vag);
        expect(back.length).toBeGreaterThanOrEqual(pcm.length);
        expect(snrDb(pcm, back)).toBeGreaterThan(30);
    });

    it('is lossless on silence and flags the last block', () => {
        const vag = encodeVag(new Int16Array(100));
        expect(snrDb(new Int16Array(100), decodeSpuAdpcm(vag))).toBe(Infinity);
        expect(vag[vag.length - 15]).toBe(1);
        const loop = encodeVag(signal(280), { loop: true });
        expect(loop[1]).toBe(4);
        expect(loop[loop.length - 15]).toBe(3);
    });

    it('clamps full-scale square waves without overflow', () => {
        const sq = new Int16Array(560).map((_, i) => (i % 40 < 20 ? 32767 : -32768));
        const back = decodeSpuAdpcm(encodeVag(sq));
        expect(snrDb(sq, back)).toBeGreaterThan(15);
    });

    it('writes the disc 0x0304 layout: zero block, data, end block, 0x77 sentinel', () => {
        const pcm = signal(560);
        const s = encodeSdbSamples(pcm);
        expect(s.length).toBe((20 + 3) * 16);
        expect([...s.subarray(0, 16)]).toEqual(new Array(16).fill(0));
        expect(s[16 + 19 * 16 + 1]).toBe(0);
        expect([...s.subarray(16 + 20 * 16, 16 + 21 * 16)]).toEqual([0, 1, ...new Array(14).fill(0)]);
        expect([...s.subarray(s.length - 16)]).toEqual(new Array(16).fill(0x77));
        expect(snrDb(pcm, decodeSdbSamples(s))).toBeGreaterThan(30);
    });
});

describe('PC sound parsing', () => {
    it('reads raw, zlib, 8-bit and stereo records and groups', async () => {
        const a = signal(2000);
        const b = Uint8Array.from({ length: 100 }, (_, i) => 128 + ((i % 10) - 5) * 10);
        const st = new Int16Array([1000, 3000, -1000, -3000]);
        const bank = await parsePcSounds(
            pcSrsc([
                { type: 0x301, id: 1, sub: 0, data: str('GUI') },
                { type: 0x302, id: 7, sub: 1, data: pcSound('beep', a, { z: true, flags: 8 }) },
                { type: 0x302, id: 9, sub: 1, data: pcSound('b8', b, { bits: 8, rate: 11025 }) },
                { type: 0x302, id: 11, sub: 1, data: pcSound('stereo', st, { ch: 2, rate: 44100 }) },
                { type: 0x300, id: 0, sub: 0, data: [1, 0, 2, 0] },
            ]),
        );
        expect(bank.warnings).toEqual([]);
        expect(bank.groups.get(1)).toBe('GUI');
        expect(bank.sounds.map((s) => s.name)).toEqual(['beep', 'b8', 'stereo']);
        expect(bank.sounds[0]!.flags).toBe(8);
        expect([...bank.sounds[0]!.pcm]).toEqual([...a]);
        expect(bank.sounds[1]!.pcm.length).toBe(100);
        expect(bank.sounds[1]!.rate).toBe(11025);
        expect([...bank.sounds[2]!.pcm]).toEqual([2000, -2000]);
        expect(bank.sounds[2]!.rate).toBe(44100);
    });

    it('skips a record whose zlib data is broken', async () => {
        const bad = pcSound('x', signal(100), { z: true });
        bad[bad.length - 3] = (bad[bad.length - 3] ?? 0) ^ 0xff;
        const bank = await parsePcSounds(pcSrsc([{ type: 0x302, id: 1, sub: 1, data: bad }]));
        expect(bank.sounds.length + bank.warnings.length).toBeGreaterThan(0);
    });

    it('converts 8-bit and stereo helpers', () => {
        expect([...pcmToMono16(Uint8Array.of(128, 255, 0), 1, 8)]).toEqual([0, 127 << 8, -128 << 8]);
    });
});

describe('PS2 SDB writer', () => {
    async function convertOne() {
        const pcm = signal(5000);
        const bank = await parsePcSounds(
            pcSrsc([
                { type: 0x302, id: 4, sub: 1, data: pcSound('Wireloop_3', pcm, { flags: 8, vol: -1000 }) },
                { type: 0x302, id: 6, sub: 1, data: pcSound('hover_2', signal(900), { rate: 44100 }) },
            ]),
        );
        const key = sdbKey('Common\\Interface\\Interface.sdb');
        const conv = convertPcSounds(new Map([[key, bank]]), { firstId: 2000, groupId: 40 });
        return { pcm, conv, key };
    }

    it('writes a standalone SDB the SRSC reader and descriptor parser accept', async () => {
        const { pcm, conv } = await convertOne();
        const bytes = writePs2Sdb(conv.sounds, [conv.group]);
        const r = await SrscReader.fromBytes(bytes);
        expect(r.platform).toBe('ps2');
        expect(r.warnings).toEqual([]);
        expect(r.entries.map((e) => e.type)).toEqual([0x300, 0x402, 0x307, 0x301, 0x302, 0x304, 0x302, 0x304]);
        const d = r.find(0x302, 2000, 40)!;
        const desc = await r.readRaw(d);
        expect(parseSoundDescriptor(desc)).toMatchObject({ name: 'Wireloop_3', rate: 22050 });
        // name field is padded like the disc: 10 chars stay 10, 'hover_2' becomes 10
        expect(new DataView(desc.buffer, desc.byteOffset).getUint16(0, true)).toBe(10);
        const d2 = await r.readRaw(r.find(0x302, 2001, 40)!);
        expect(new DataView(d2.buffer, d2.byteOffset).getUint16(0, true)).toBe(10);
        // rate 44100 is resampled to the 22050 default cap
        expect(parseSoundDescriptor(d2).rate).toBe(22050);
        const dv = new DataView(desc.buffer, desc.byteOffset);
        expect(dv.getUint32(12, true)).toBe(0xa); // loop + common
        expect(dv.getUint32(16, true)).toBe(0x00100001);
        expect(dv.getInt32(24, true)).toBe(-1000);
        expect(dv.getUint32(40, true)).toBe(0x55);
        expect(desc.length).toBe(12 + 48);
        const adpcm = await r.readRaw(r.find(0x304, 2000, 40)!);
        expect(dv.getUint32(52, true)).toBe(adpcm.length);
        expect(snrDb(pcm, decodeSdbSamples(adpcm))).toBeGreaterThan(30);
        for (const e of r.entries) expect(e.offset % 8).toBe(0);
    });

    it('appends to an existing SDB without touching its data', async () => {
        const { conv } = await convertOne();
        const base = writePs2Sdb(conv.sounds, [conv.group]);
        const ids = await nextSdbIds(base);
        expect(ids).toEqual({ sound: 2002, group: 41 });
        const more = convertPcSounds(
            new Map([
                [
                    'x',
                    {
                        sounds: [
                            {
                                ...(
                                    await parsePcSounds(
                                        pcSrsc([{ type: 0x302, id: 1, sub: 1, data: pcSound('n', signal(300), {}) }]),
                                    )
                                ).sounds[0]!,
                            },
                        ],
                        groups: new Map(),
                        warnings: [],
                    },
                ],
            ]),
            { firstId: ids.sound, groupId: ids.group },
        );
        const out = await appendToPs2Sdb(base, more.sounds, [more.group]);
        const r0 = await SrscReader.fromBytes(base);
        const r1 = await SrscReader.fromBytes(out);
        expect(r1.entries.length).toBe(r0.entries.length + 3);
        expect(r1.warnings).toEqual([]);
        for (const e of r0.entries) {
            const e1 = r1.find(e.type, e.id, e.sub)!;
            expect(await r1.readRaw(e1)).toEqual(await r0.readRaw(e));
        }
        expect(r1.find(0x304, 2002, 41)).toBeTruthy();
        await expect(appendToPs2Sdb(base, conv.sounds, [])).rejects.toThrow(/already exists/);
    });
});

describe('id map', () => {
    it('maps PC references through dependency keys', async () => {
        const bank = await parsePcSounds(pcSrsc([{ type: 0x302, id: 4, sub: 1, data: pcSound('a', signal(100), {}) }]));
        const key = sdbKey('Common/System/System.sdb');
        const conv = convertPcSounds(new Map([[key, bank]]), { firstId: 900, groupId: 20, ps2Db: 0 });
        const keyOf = (db: number) => (db === 3 ? key : null);
        expect(conv.map.mapRef((3 << 16) | 4, keyOf)).toBe(900);
        expect(conv.map.mapRef((3 << 16) | 5, keyOf)).toBeNull();
        expect(conv.map.mapRef((2 << 16) | 4, keyOf)).toBeNull();
        expect(conv.map.mapRef(0, keyOf)).toBeNull();
        const m = new SoundMap(3);
        m.set('k', 1, 77);
        expect(m.get('k', 1)).toBe((3 << 16) | 77);
    });

    it('resamples by an integer ratio', () => {
        const out = resamplePcm(Int16Array.from([0, 100, 200, 300]), 44100, 22050);
        expect([...out]).toEqual([50, 250]);
    });
});
