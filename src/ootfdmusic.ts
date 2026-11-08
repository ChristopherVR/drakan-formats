// Order of the Flame music: an offline renderer for the PC game's DirectMusic segments.
//
// `Music.rrc` (PC SRSC, type 0x401) holds the 11 segments (ids 1..11, RIFF `DMSG`) and their DLS Level 1 wave banks (ids 256..266,
// RIFF `DLS `; segment k uses the collection whose `dlid` its band names, in practice id 255 + k). Every segment is a plain
// sequence: a tempo track (`tetr`), a time signature (`tims`), one band (`DMBT`: patch, volume and transpose per performance
// channel) and a sequence track (`seqt`: notes with durations, pitch bends, and controller / pitch bend curves). No styles,
// chord maps or motifs, so a sequencer plus a DLS1 synth reproduces the music. The banks hold mono MS-ADPCM or PCM waves.
// Evidence and the PC usage (title menu = segment 4, credits = 7, level "Initial Music ID"): docs/journal/2026-11-08/ootf-main-music.md.
//
// The synth follows the DLS Level 1 model: per region a wave with unity note, fine tune, attenuation and an optional forward loop;
// the articulation's EG1 (attack, decay, sustain, release; velocity -> attack), LFO (frequency, delay, -> pitch, CC1 -> pitch),
// key velocity -> attenuation (concave, (v/127)^2), CC7 / CC11 volume ((v/127)^2 each), pitch wheel (RPN 0 range, default 2
// semitones) and the sustain pedal. The output is mono (the PS2 music tracks are mono), mixed at 44.1 kHz with a light room
// reverb (DirectMusic's software synth reverberates by default), then filtered down to the requested rate.

import { SrscReader } from './srsc.ts';
import { ps2SoundEntries, soundIdAllocator, type Ps2Sound } from './ootfsound.ts';

// ---------------------------------------------------------------- RIFF

export interface RiffChunk {
    id: string;
    /** List / form type for `RIFF` and `LIST` chunks. */
    list?: string;
    data: Uint8Array;
    children?: RiffChunk[];
    /** Offset of the chunk payload in the buffer that was parsed. */
    offset: number;
}

const fourcc = (b: Uint8Array, o: number): string => String.fromCharCode(b[o]!, b[o + 1]!, b[o + 2]!, b[o + 3]!);

/** Parse a run of RIFF chunks in `b[start, end)`; `RIFF` and `LIST` chunks are parsed recursively. */
export function parseRiff(b: Uint8Array, start = 0, end = b.length): RiffChunk[] {
    const out: RiffChunk[] = [];
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    let o = start;
    while (o + 8 <= end) {
        const id = fourcc(b, o);
        const size = dv.getUint32(o + 4, true);
        const body = Math.min(end, o + 8 + size);
        if (id === 'RIFF' || id === 'LIST') {
            const list = o + 12 <= body ? fourcc(b, o + 8) : '';
            out.push({
                id,
                list,
                data: b.subarray(o + 12, body),
                offset: o + 12,
                children: parseRiff(b, o + 12, body),
            });
        } else out.push({ id, data: b.subarray(o + 8, body), offset: o + 8 });
        o += 8 + size + (size & 1);
    }
    return out;
}

const dvOf = (b: Uint8Array): DataView => new DataView(b.buffer, b.byteOffset, b.byteLength);
const kid = (c: RiffChunk | undefined, id: string, list?: string): RiffChunk | undefined =>
    c?.children?.find((k) => k.id === id && (list === undefined || k.list === list));
const kids = (c: RiffChunk | undefined, id: string, list?: string): RiffChunk[] =>
    c?.children?.filter((k) => k.id === id && (list === undefined || k.list === list)) ?? [];
const guidHex = (b: Uint8Array | undefined): string =>
    b && b.length >= 16 ? [...b.subarray(0, 16)].map((x) => x.toString(16).padStart(2, '0')).join('') : '';
const utf16z = (b: Uint8Array | undefined): string => {
    if (!b) return '';
    let s = '';
    for (let i = 0; i + 1 < b.length; i += 2) {
        const c = b[i]! | (b[i + 1]! << 8);
        if (!c) break;
        s += String.fromCharCode(c);
    }
    return s;
};

// ---------------------------------------------------------------- MS ADPCM

const MS_ADAPT = [230, 230, 230, 230, 307, 409, 512, 614, 768, 614, 512, 409, 307, 230, 230, 230];
const MS_COEF: readonly (readonly [number, number])[] = [
    [256, 0],
    [512, -256],
    [0, 0],
    [192, 64],
    [240, 0],
    [460, -208],
    [392, -232],
];

/** Decode mono Microsoft ADPCM (format tag 2). `coefs` defaults to the standard seven pairs. */
export function decodeMsAdpcm(
    data: Uint8Array,
    blockAlign: number,
    samplesPerBlock: number,
    coefs: readonly (readonly [number, number])[] = MS_COEF,
): Int16Array {
    const blocks = Math.ceil(data.length / blockAlign);
    const out = new Int16Array(blocks * samplesPerBlock);
    const dv = dvOf(data);
    let n = 0;
    const clamp = (v: number): number => (v > 32767 ? 32767 : v < -32768 ? -32768 : v);
    for (let b = 0; b < blocks; b++) {
        const o = b * blockAlign;
        const end = Math.min(data.length, o + blockAlign);
        if (end - o < 7) break;
        const [c1, c2] = coefs[Math.min(coefs.length - 1, data[o]!)]!;
        let delta = dv.getInt16(o + 1, true);
        let s1 = dv.getInt16(o + 3, true);
        let s2 = dv.getInt16(o + 5, true);
        out[n++] = s2;
        out[n++] = s1;
        let left = samplesPerBlock - 2;
        for (let i = o + 7; i < end && left > 0; i++) {
            for (const nib of [data[i]! >> 4, data[i]! & 15]) {
                if (left <= 0) break;
                const pred = (s1 * c1 + s2 * c2) >> 8;
                const sn = nib & 8 ? nib - 16 : nib;
                const s = clamp(pred + sn * delta);
                delta = Math.max(16, (MS_ADAPT[nib]! * delta) >> 8);
                s2 = s1;
                s1 = s;
                out[n++] = s;
                left--;
            }
        }
    }
    return out.subarray(0, n);
}

// ---------------------------------------------------------------- DLS

export interface DlsLoop {
    start: number;
    length: number;
}

export interface DlsSample {
    unityNote: number;
    fineTune: number;
    /** Attenuation in centibels (0 = unity, negative = quieter). */
    gainCb: number;
    loop: DlsLoop | null;
}

export interface DlsConnection {
    src: number;
    ctl: number;
    dst: number;
    /** `lScale / 65536` (timecents, cents, centibels, 0.1 % ... by destination). */
    scale: number;
}

export interface DlsRegion {
    keyLo: number;
    keyHi: number;
    wave: number;
    sample: DlsSample | null;
    art: DlsConnection[] | null;
}

export interface DlsInstrument {
    /** `ulBank`: bit 31 drum kit, bits 8..14 CC0, bits 0..6 CC32. */
    bank: number;
    program: number;
    name: string;
    regions: DlsRegion[];
    art: DlsConnection[];
}

export interface DlsWave {
    rate: number;
    pcm: Int16Array;
    sample: DlsSample | null;
}

export interface DlsCollection {
    /** `dlid` of the collection (hex), what a band's reference names. */
    guid: string;
    name: string;
    instruments: DlsInstrument[];
    waves: DlsWave[];
    warnings: string[];
}

function parseWsmp(b: Uint8Array | undefined): DlsSample | null {
    if (!b || b.length < 20) return null;
    const dv = dvOf(b);
    const cb = dv.getUint32(0, true);
    const loops = dv.getUint32(16, true);
    let loop: DlsLoop | null = null;
    if (loops > 0 && cb + 16 <= b.length) {
        const length = dv.getUint32(cb + 12, true);
        if (length > 0) loop = { start: dv.getUint32(cb + 8, true), length };
    }
    return {
        unityNote: dv.getUint16(4, true),
        fineTune: dv.getInt16(6, true),
        gainCb: dv.getInt32(8, true) / 65536,
        loop,
    };
}

function parseArt(lart: RiffChunk | undefined): DlsConnection[] | null {
    if (!lart) return null;
    const out: DlsConnection[] = [];
    for (const a of kids(lart, 'art1')) {
        const dv = dvOf(a.data);
        const cb = dv.getUint32(0, true);
        const n = dv.getUint32(4, true);
        for (let i = 0; i < n && cb + i * 12 + 12 <= a.data.length; i++) {
            const o = cb + i * 12;
            out.push({
                src: dv.getUint16(o, true),
                ctl: dv.getUint16(o + 2, true),
                dst: dv.getUint16(o + 4, true),
                scale: dv.getInt32(o + 8, true) / 65536,
            });
        }
    }
    return out;
}

function decodeWave(w: RiffChunk, warnings: string[]): DlsWave | null {
    const fmt = kid(w, 'fmt ');
    const data = kid(w, 'data');
    if (!fmt || !data || fmt.data.length < 16) return null;
    const dv = dvOf(fmt.data);
    const tag = dv.getUint16(0, true);
    const ch = dv.getUint16(2, true);
    const rate = dv.getUint32(4, true);
    const align = dv.getUint16(12, true);
    const bits = dv.getUint16(14, true);
    let pcm: Int16Array;
    if (tag === 1 && bits === 16) {
        pcm = new Int16Array(Math.floor(data.data.length / 2 / ch));
        const d = dvOf(data.data);
        for (let i = 0; i < pcm.length; i++) pcm[i] = d.getInt16(i * 2 * ch, true);
    } else if (tag === 1 && bits === 8) {
        pcm = new Int16Array(Math.floor(data.data.length / ch));
        for (let i = 0; i < pcm.length; i++) pcm[i] = (data.data[i * ch]! - 128) << 8;
    } else if (tag === 2 && ch === 1 && fmt.data.length >= 22) {
        const spb = dv.getUint16(18, true);
        const nc = fmt.data.length >= 22 ? dv.getUint16(20, true) : 0;
        const coefs: [number, number][] = [];
        for (let i = 0; i < nc && 22 + i * 4 + 4 <= fmt.data.length; i++)
            coefs.push([dv.getInt16(22 + i * 4, true), dv.getInt16(24 + i * 4, true)]);
        pcm = decodeMsAdpcm(data.data, align, spb, coefs.length ? coefs : MS_COEF);
    } else {
        warnings.push(`wave format ${tag}/${ch}ch/${bits}bit not supported`);
        return null;
    }
    return { rate, pcm, sample: parseWsmp(kid(w, 'wsmp')?.data) };
}

/** Parse a DLS Level 1 collection (RIFF `DLS `). */
export function parseDls(bytes: Uint8Array): DlsCollection {
    const root = parseRiff(bytes)[0];
    if (!root || root.id !== 'RIFF' || root.list !== 'DLS ') throw new Error('not a DLS collection');
    const warnings: string[] = [];
    const name = (() => {
        const inam = kid(kid(root, 'LIST', 'INFO'), 'INAM')?.data;
        return inam ? String.fromCharCode(...inam).replace(/\0.*$/s, '') : '';
    })();
    // Wave pool: the ptbl cue offsets are relative to the first byte after the 'wvpl' list type.
    const wvpl = kid(root, 'LIST', 'wvpl');
    const poolWaves = kids(wvpl, 'LIST', 'wave');
    const byOffset = new Map<number, number>();
    poolWaves.forEach((w, i) => byOffset.set(w.offset - 12 - wvpl!.offset, i));
    const cues: number[] = [];
    const ptbl = kid(root, 'ptbl');
    if (ptbl) {
        const dv = dvOf(ptbl.data);
        const cb = dv.getUint32(0, true);
        const n = dv.getUint32(4, true);
        for (let i = 0; i < n && cb + i * 4 + 4 <= ptbl.data.length; i++) {
            const off = dv.getUint32(cb + i * 4, true);
            cues.push(byOffset.get(off) ?? i);
        }
    }
    const waves: DlsWave[] = [];
    const waveIndex = new Map<number, number>();
    poolWaves.forEach((w, i) => {
        const dw = decodeWave(w, warnings);
        if (dw) {
            waveIndex.set(i, waves.length);
            waves.push(dw);
        }
    });
    const instruments: DlsInstrument[] = [];
    for (const ins of kids(kid(root, 'LIST', 'lins'), 'LIST', 'ins ')) {
        const insh = kid(ins, 'insh');
        if (!insh || insh.data.length < 12) continue;
        const dv = dvOf(insh.data);
        const regions: DlsRegion[] = [];
        for (const rgn of kids(kid(ins, 'LIST', 'lrgn'), 'LIST', 'rgn ')) {
            const rgnh = kid(rgn, 'rgnh');
            const wlnk = kid(rgn, 'wlnk');
            if (!rgnh || !wlnk || rgnh.data.length < 12 || wlnk.data.length < 12) continue;
            const rv = dvOf(rgnh.data);
            const table = dvOf(wlnk.data).getUint32(8, true);
            const pool = cues.length ? (cues[table] ?? table) : table;
            const wave = waveIndex.get(pool);
            if (wave === undefined) {
                warnings.push(`region links missing wave ${table}`);
                continue;
            }
            regions.push({
                keyLo: rv.getUint16(0, true),
                keyHi: rv.getUint16(2, true),
                wave,
                sample: parseWsmp(kid(rgn, 'wsmp')?.data),
                art: parseArt(kid(rgn, 'LIST', 'lart')),
            });
        }
        const inam = kid(kid(ins, 'LIST', 'INFO'), 'INAM')?.data;
        instruments.push({
            bank: dv.getUint32(4, true),
            program: dv.getUint32(8, true),
            name: inam ? String.fromCharCode(...inam).replace(/\0.*$/s, '') : '',
            regions,
            art: parseArt(kid(ins, 'LIST', 'lart')) ?? [],
        });
    }
    return { guid: guidHex(kid(root, 'dlid')?.data), name, instruments, waves, warnings };
}

// ---------------------------------------------------------------- segments

/** DirectMusic pulses per quarter note. */
export const DMUS_PPQ = 768;

export interface DmEvent {
    /** Music time (ticks, `mtTime + nOffset`). */
    time: number;
    duration: number;
    pchannel: number;
    status: number;
    b1: number;
    b2: number;
}

export interface DmCurve {
    time: number;
    duration: number;
    pchannel: number;
    startValue: number;
    endValue: number;
    /** 3 pitch bend, 4 controller, 5 channel pressure, 6 poly pressure. */
    type: number;
    /** 0 linear, 1 instant, 2 exponential, 3 logarithmic, 4 sine. */
    shape: number;
    cc: number;
}

export interface DmBandInstrument {
    pchannel: number;
    /** `dwPatch`: bit 31 drums, bits 16..22 CC0, bits 8..14 CC32, bits 0..6 program. */
    patch: number;
    flags: number;
    pan: number;
    volume: number;
    transpose: number;
    /** GUID (hex) of the referenced DLS collection, '' when none. */
    collection: string;
}

export interface DmBand {
    time: number;
    instruments: DmBandInstrument[];
}

export interface DmSegment {
    name: string;
    repeats: number;
    length: number;
    playStart: number;
    loopStart: number;
    loopEnd: number;
    tempos: { time: number; bpm: number }[];
    events: DmEvent[];
    curves: DmCurve[];
    bands: DmBand[];
    warnings: string[];
}

const DMUS_IO_INST_VOLUME = 0x40;
const DMUS_IO_INST_TRANSPOSE = 0x80;
const DMUS_IO_INST_PATCH = 0x1;

function parseBands(form: RiffChunk): DmBand[] {
    const out: DmBand[] = [];
    for (const lbnd of kids(kid(form, 'LIST', 'lbdl'), 'LIST', 'lbnd')) {
        const bdih = kid(lbnd, 'bdih') ?? kid(lbnd, 'bd2h');
        const time = bdih && bdih.data.length >= 4 ? dvOf(bdih.data).getInt32(0, true) : 0;
        const band = kid(lbnd, 'RIFF', 'DMBD');
        const instruments: DmBandInstrument[] = [];
        for (const lbin of kids(kid(band, 'LIST', 'lbil'), 'LIST', 'lbin')) {
            const bins = kid(lbin, 'bins');
            if (!bins || bins.data.length < 34) continue;
            const dv = dvOf(bins.data);
            instruments.push({
                patch: dv.getUint32(0, true),
                pchannel: dv.getUint32(24, true),
                flags: dv.getUint32(28, true),
                pan: bins.data[32]!,
                volume: bins.data[33]!,
                transpose: bins.data.length >= 36 ? dv.getInt16(34, true) : 0,
                collection: guidHex(kid(kid(lbin, 'LIST', 'DMRF'), 'guid')?.data),
            });
        }
        out.push({ time, instruments });
    }
    return out;
}

/** Parse a DirectMusic segment (RIFF `DMSG`) with sequence, tempo and band tracks. Other track types are listed in `warnings`. */
export function parseSegment(bytes: Uint8Array): DmSegment {
    const root = parseRiff(bytes)[0];
    if (!root || root.id !== 'RIFF' || root.list !== 'DMSG') throw new Error('not a DirectMusic segment');
    const seg: DmSegment = {
        name: utf16z(kid(kid(root, 'LIST', 'UNFO'), 'UNAM')?.data),
        repeats: 0,
        length: 0,
        playStart: 0,
        loopStart: 0,
        loopEnd: 0,
        tempos: [],
        events: [],
        curves: [],
        bands: [],
        warnings: [],
    };
    const segh = kid(root, 'segh');
    if (segh && segh.data.length >= 20) {
        const dv = dvOf(segh.data);
        seg.repeats = dv.getUint32(0, true);
        seg.length = dv.getInt32(4, true);
        seg.playStart = dv.getInt32(8, true);
        seg.loopStart = dv.getInt32(12, true);
        seg.loopEnd = dv.getInt32(16, true);
    }
    for (const trk of kids(kid(root, 'LIST', 'trkl'), 'RIFF', 'DMTK')) {
        for (const c of trk.children ?? []) {
            if (c.id === 'trkh' || c.id === 'guid' || c.id === 'vers' || c.id === 'LIST') continue;
            if (c.id === 'tetr') {
                const dv = dvOf(c.data);
                const sz = dv.getUint32(0, true);
                for (let o = 4; sz >= 12 && o + sz <= c.data.length; o += sz)
                    seg.tempos.push({ time: dv.getInt32(o, true), bpm: dv.getFloat64(o + sz - 8, true) });
            } else if (c.id === 'seqt') {
                for (const s of parseRiff(c.data)) {
                    const dv = dvOf(s.data);
                    if (s.data.length < 4) continue;
                    const sz = dv.getUint32(0, true);
                    if (s.id === 'evtl' && sz >= 17) {
                        for (let o = 4; o + sz <= s.data.length; o += sz)
                            seg.events.push({
                                time: dv.getInt32(o, true) + dv.getInt16(o + 12, true),
                                duration: dv.getInt32(o + 4, true),
                                pchannel: dv.getUint32(o + 8, true),
                                status: s.data[o + 14]!,
                                b1: s.data[o + 15]!,
                                b2: s.data[o + 16]!,
                            });
                    } else if (s.id === 'curl' && sz >= 28) {
                        for (let o = 4; o + sz <= s.data.length; o += sz)
                            seg.curves.push({
                                time: dv.getInt32(o, true) + dv.getInt16(o + 16, true),
                                duration: dv.getInt32(o + 4, true),
                                pchannel: dv.getUint32(o + 12, true),
                                startValue: dv.getInt16(o + 18, true),
                                endValue: dv.getInt16(o + 20, true),
                                type: s.data[o + 24]!,
                                shape: s.data[o + 25]!,
                                cc: s.data[o + 26]!,
                            });
                    }
                }
            } else if (c.id === 'RIFF' && c.list === 'DMBT') seg.bands.push(...parseBands(c));
            else if (c.id !== 'tims') seg.warnings.push(`track ${c.id}${c.list ? `/${c.list}` : ''} ignored`);
        }
    }
    seg.tempos.sort((a, b) => a.time - b.time);
    seg.events.sort((a, b) => a.time - b.time);
    seg.bands.sort((a, b) => a.time - b.time);
    return seg;
}

/** Seconds from music time 0 to `t` under the segment's tempo map (120 BPM before the first tempo, like DirectMusic). */
export function tickSeconds(tempos: readonly { time: number; bpm: number }[], t: number): number {
    let sec = 0;
    let at = 0;
    let bpm = tempos[0]?.bpm ?? 120;
    for (const tp of tempos) {
        if (tp.time >= t) break;
        if (tp.time > at) {
            sec += ((tp.time - at) / DMUS_PPQ) * (60 / bpm);
            at = tp.time;
        }
        bpm = tp.bpm > 0 ? tp.bpm : bpm;
    }
    return sec + ((t - at) / DMUS_PPQ) * (60 / bpm);
}

// ---------------------------------------------------------------- synth

const CONN_SRC_NONE = 0;
const CONN_SRC_LFO = 1;
const CONN_SRC_KEYONVELOCITY = 2;
const CONN_SRC_KEYNUMBER = 3;
const CONN_SRC_PITCHWHEEL = 6;
const CONN_SRC_CC1 = 0x81;
const CONN_DST_ATTENUATION = 1;
const CONN_DST_PITCH = 3;
const CONN_DST_LFO_FREQUENCY = 0x104;
const CONN_DST_LFO_STARTDELAY = 0x105;
const CONN_DST_EG1_ATTACKTIME = 0x206;
const CONN_DST_EG1_DECAYTIME = 0x207;
const CONN_DST_EG1_RELEASETIME = 0x209;
const CONN_DST_EG1_SUSTAINLEVEL = 0x20a;

/** Timecents to seconds; the DLS minimum (-32768 * 65536 / 65536) is 0. */
const tcSeconds = (tc: number): number => (tc <= -32768 ? 0 : Math.pow(2, tc / 1200));

interface Articulation {
    attack: number;
    attackVel: number;
    decay: number;
    decayKey: number;
    sustainDb: number;
    release: number;
    lfoHz: number;
    lfoDelay: number;
    lfoPitch: number;
    lfoPitchMod: number;
    lfoAtten: number;
    bendRange: number | null;
    attenCb: number;
}

function articulation(conns: readonly DlsConnection[]): Articulation {
    const a: Articulation = {
        attack: -32768,
        attackVel: 0,
        decay: -32768,
        decayKey: 0,
        sustainDb: 0,
        release: -32768,
        lfoHz: 5,
        lfoDelay: 0,
        lfoPitch: 0,
        lfoPitchMod: 50,
        lfoAtten: 0,
        bendRange: null,
        attenCb: 0,
    };
    for (const c of conns) {
        if (c.src === CONN_SRC_NONE && c.ctl === 0) {
            if (c.dst === CONN_DST_EG1_ATTACKTIME) a.attack = c.scale;
            else if (c.dst === CONN_DST_EG1_DECAYTIME) a.decay = c.scale;
            else if (c.dst === CONN_DST_EG1_RELEASETIME) a.release = c.scale;
            else if (c.dst === CONN_DST_EG1_SUSTAINLEVEL)
                a.sustainDb = -96 * (1 - Math.max(0, Math.min(1000, c.scale)) / 1000);
            else if (c.dst === CONN_DST_LFO_FREQUENCY) a.lfoHz = 440 * Math.pow(2, (c.scale - 6900) / 1200);
            else if (c.dst === CONN_DST_LFO_STARTDELAY) a.lfoDelay = tcSeconds(c.scale);
            else if (c.dst === CONN_DST_ATTENUATION) a.attenCb += c.scale;
        } else if (c.src === CONN_SRC_KEYONVELOCITY && c.dst === CONN_DST_EG1_ATTACKTIME) a.attackVel = c.scale;
        else if (c.src === CONN_SRC_KEYNUMBER && c.dst === CONN_DST_EG1_DECAYTIME) a.decayKey = c.scale;
        else if (c.src === CONN_SRC_LFO && c.dst === CONN_DST_PITCH) {
            if (c.ctl === 0) a.lfoPitch = c.scale;
            else if (c.ctl === CONN_SRC_CC1) a.lfoPitchMod = c.scale;
        } else if (c.src === CONN_SRC_LFO && c.dst === CONN_DST_ATTENUATION && c.ctl === 0) a.lfoAtten = c.scale;
        else if (c.src === CONN_SRC_PITCHWHEEL && c.dst === CONN_DST_PITCH) a.bendRange = c.scale;
    }
    return a;
}

interface Voice {
    channel: Channel;
    key: number;
    wave: Float32Array;
    rate: number;
    pos: number;
    baseCents: number;
    loop: DlsLoop | null;
    gain: number;
    art: Articulation;
    stage: 0 | 1 | 2 | 3 | 4; // attack, decay, sustain, release, done
    level: number; // attack: amplitude 0..1; later stages: dB
    attackS: number;
    decayS: number;
    releaseS: number;
    held: boolean;
    age: number;
    lfoPhase: number;
    lfoWait: number;
    amp: number;
}

interface Channel {
    patch: number;
    transpose: number;
    volume: number;
    expression: number;
    bend: number;
    bendRange: number;
    mod: number;
    sustain: boolean;
    rpn: number;
    bankMsb: number;
    bankLsb: number;
}

const newChannel = (): Channel => ({
    patch: -1,
    transpose: 0,
    volume: 100,
    expression: 127,
    bend: 0,
    bendRange: 200,
    mod: 0,
    sustain: false,
    rpn: 0x3fff,
    bankMsb: 0,
    bankLsb: 0,
});

type Action =
    | { at: number; kind: 'on'; pch: number; key: number; vel: number; off: number }
    | { at: number; kind: 'off'; pch: number; key: number; id: number }
    | { at: number; kind: 'cc'; pch: number; cc: number; value: number }
    | { at: number; kind: 'bend'; pch: number; value: number }
    | { at: number; kind: 'program'; pch: number; program: number }
    | { at: number; kind: 'band'; inst: DmBandInstrument };

export interface RenderOptions {
    /** Output sample rate (default 22050; internal mixing runs at twice that, at most 48000). */
    rate?: number;
    /** Reverb send, 0 = dry (default 0.22). */
    reverb?: number;
    /** Seconds rendered after the last event for release tails (default 6). */
    tail?: number;
    /** Hard cap on concurrent voices (default 96). */
    maxVoices?: number;
}

/** One scheduled pass of a segment: events of `[from, to)` in music time, starting at `startSec` of the output. */
export interface SegmentPass {
    from: number;
    to: number;
    startSec: number;
}

export interface RenderResult {
    /** Mono samples at `rate`, -1..1 (not normalised). */
    pcm: Float32Array;
    rate: number;
    /** Seconds up to the end of the last pass (the tail follows). */
    endSec: number;
    warnings: string[];
}

function findInstrument(cols: readonly DlsCollection[], patch: number, prefer: string): DlsInstrument | null {
    const drum = (patch & 0x80000000) !== 0;
    const bank = (((patch >>> 16) & 0x7f) << 8) | ((patch >>> 8) & 0x7f);
    const program = patch & 0x7f;
    const order = [...cols].sort((a, b) => Number(b.guid === prefer) - Number(a.guid === prefer));
    for (const c of order)
        for (const ins of c.instruments)
            if ((ins.bank & 0x7fff) === bank && ins.program === program && ((ins.bank & 0x80000000) !== 0) === drum)
                return ins;
    for (const c of order) for (const ins of c.instruments) if (ins.program === program) return ins;
    return null;
}

const waveCache = new WeakMap<DlsWave, Float32Array>();
const floatWave = (w: DlsWave): Float32Array => {
    let f = waveCache.get(w);
    if (!f) {
        f = new Float32Array(w.pcm.length + 1);
        for (let i = 0; i < w.pcm.length; i++) f[i] = w.pcm[i]! / 32768;
        waveCache.set(w, f);
    }
    return f;
};

/** Curve shape value at x in [0,1]. */
function curveShape(shape: number, x: number): number {
    switch (shape) {
        case 1:
            return 1;
        case 2:
            return (Math.pow(2, 4 * x) - 1) / 15;
        case 3:
            return 1 - (Math.pow(2, 4 * (1 - x)) - 1) / 15;
        case 4:
            return (1 - Math.cos(Math.PI * x)) / 2;
        default:
            return x;
    }
}

/**
 * Render passes of a segment with the given DLS collections. Each pass plays the events, curves and bands of its music time
 * range; controller state carries over from pass to pass as in a looping DirectMusic segment.
 */
export function renderSegment(
    seg: DmSegment,
    collections: readonly DlsCollection[],
    passes: readonly SegmentPass[],
    opts: RenderOptions = {},
): RenderResult {
    const outRate = opts.rate ?? 22050;
    const rate = Math.min(48000, outRate * 2);
    const warnings: string[] = [];
    const sec = (t: number): number => tickSeconds(seg.tempos, t);
    const actions: Action[] = [];
    let noteId = 0;
    let endSec = 0;
    const firstBand = seg.bands.length ? seg.bands[0]!.time : 0;
    for (const p of passes) {
        const base = p.startSec - sec(p.from);
        const at = (t: number): number => Math.max(0, Math.round((base + sec(t)) * rate));
        endSec = Math.max(endSec, base + sec(p.to));
        for (const b of seg.bands)
            if ((b.time >= p.from && b.time < p.to) || (p === passes[0] && b.time <= p.from && b.time === firstBand))
                for (const inst of b.instruments)
                    actions.push({ at: b.time < p.from ? at(p.from) : at(b.time), kind: 'band', inst });
        for (const e of seg.events) {
            if (e.time < p.from || e.time >= p.to) continue;
            const kind = e.status & 0xf0;
            if (kind === 0x90 && e.b2 > 0) {
                const id = noteId++;
                const on = at(e.time);
                const off = Math.max(on + 1, at(e.time + Math.max(1, e.duration)));
                actions.push({ at: on, kind: 'on', pch: e.pchannel, key: e.b1, vel: e.b2, off: id });
                actions.push({ at: off, kind: 'off', pch: e.pchannel, key: e.b1, id });
            } else if (kind === 0xb0)
                actions.push({ at: at(e.time), kind: 'cc', pch: e.pchannel, cc: e.b1, value: e.b2 });
            else if (kind === 0xe0)
                actions.push({ at: at(e.time), kind: 'bend', pch: e.pchannel, value: (e.b1 | (e.b2 << 7)) - 8192 });
            else if (kind === 0xc0) actions.push({ at: at(e.time), kind: 'program', pch: e.pchannel, program: e.b1 });
        }
        for (const c of seg.curves) {
            if (c.time < p.from || c.time >= p.to || (c.type !== 3 && c.type !== 4)) continue;
            const t0 = base + sec(c.time);
            const t1 = base + sec(c.time + Math.max(0, c.duration));
            const steps = c.shape === 1 || t1 <= t0 ? 0 : Math.max(1, Math.ceil((t1 - t0) / 0.01));
            for (let i = 0; i <= steps; i++) {
                const x = steps ? i / steps : 1;
                const v = c.startValue + (c.endValue - c.startValue) * curveShape(c.shape, x);
                const pos = Math.round((t0 + (t1 - t0) * x) * rate);
                if (c.type === 3) actions.push({ at: pos, kind: 'bend', pch: c.pchannel, value: Math.round(v) - 8192 });
                else
                    actions.push({
                        at: pos,
                        kind: 'cc',
                        pch: c.pchannel,
                        cc: c.cc,
                        value: Math.max(0, Math.min(127, Math.round(v))),
                    });
            }
        }
    }
    const order = { band: 0, program: 1, cc: 2, bend: 3, off: 4, on: 5 } as const;
    actions.sort((a, b) => a.at - b.at || order[a.kind] - order[b.kind]);

    const total = Math.ceil((endSec + (opts.tail ?? 6)) * rate);
    const mix = new Float32Array(total);
    const channels = new Map<number, Channel>();
    const chan = (p: number): Channel => {
        let c = channels.get(p);
        if (!c) channels.set(p, (c = newChannel()));
        return c;
    };
    const bandCollection = new Map<number, string>();
    const voices: Voice[] = [];
    const byNote = new Map<number, Voice>();
    const maxVoices = opts.maxVoices ?? 96;
    const missing = new Set<number>();
    const BLOCK = 32;
    const dt = BLOCK / rate;

    const start = (a: Extract<Action, { kind: 'on' }>): void => {
        const c = chan(a.pch);
        if (c.patch < 0) return;
        const ins = findInstrument(collections, c.patch, bandCollection.get(a.pch) ?? '');
        if (!ins) {
            if (!missing.has(c.patch)) warnings.push(`no instrument for patch ${c.patch.toString(16)}`);
            missing.add(c.patch);
            return;
        }
        const key = Math.max(0, Math.min(127, a.key + c.transpose));
        const rgn = ins.regions.find((r) => key >= r.keyLo && key <= r.keyHi) ?? null;
        if (!rgn) return;
        const col = collections.find((cl) => cl.instruments.includes(ins))!;
        const w = col.waves[rgn.wave]!;
        const smp = rgn.sample ?? w.sample ?? { unityNote: 60, fineTune: 0, gainCb: 0, loop: null };
        const art = articulation(rgn.art ?? ins.art);
        const vel = a.vel;
        const v: Voice = {
            channel: c,
            key,
            wave: floatWave(w),
            rate: w.rate,
            pos: 0,
            baseCents: (key - smp.unityNote) * 100 + smp.fineTune,
            loop: smp.loop && smp.loop.start + smp.loop.length <= w.pcm.length ? smp.loop : null,
            gain: Math.pow(10, (smp.gainCb + art.attenCb) / 200) * (vel / 127) * (vel / 127),
            art,
            stage: 0,
            level: 0,
            attackS: tcSeconds(art.attack + (art.attackVel * vel) / 128),
            decayS: tcSeconds(art.decay + (art.decayKey * key) / 128),
            releaseS: Math.max(0.004, tcSeconds(art.release)),
            held: true,
            age: 0,
            lfoPhase: 0,
            lfoWait: art.lfoDelay,
            amp: 0,
        };
        if (art.bendRange !== null) c.bendRange = art.bendRange;
        if (voices.length >= maxVoices) {
            let k = voices.findIndex((x) => x.stage === 3);
            if (k < 0) k = 0;
            voices.splice(k, 1);
        }
        voices.push(v);
        byNote.set(a.off, v);
    };
    const release = (v: Voice): void => {
        if (v.stage >= 3) return;
        if (v.stage === 0) v.level = v.level > 1e-5 ? 20 * Math.log10(v.level) : -96;
        v.stage = 3;
    };

    let ai = 0;
    for (let s0 = 0; s0 < total; s0 += BLOCK) {
        const s1 = Math.min(total, s0 + BLOCK);
        while (ai < actions.length && actions[ai]!.at < s1) {
            const a = actions[ai++]!;
            if (a.kind === 'band') {
                const c = chan(a.inst.pchannel);
                if (a.inst.flags & DMUS_IO_INST_PATCH) c.patch = a.inst.patch;
                if (a.inst.flags & DMUS_IO_INST_VOLUME) c.volume = a.inst.volume;
                if (a.inst.flags & DMUS_IO_INST_TRANSPOSE) c.transpose = a.inst.transpose;
                if (a.inst.collection) bandCollection.set(a.inst.pchannel, a.inst.collection);
            } else if (a.kind === 'program') {
                const c = chan(a.pch);
                c.patch = (c.bankMsb << 16) | (c.bankLsb << 8) | a.program;
            } else if (a.kind === 'cc') {
                const c = chan(a.pch);
                switch (a.cc) {
                    case 0:
                        c.bankMsb = a.value;
                        break;
                    case 32:
                        c.bankLsb = a.value;
                        break;
                    case 1:
                        c.mod = a.value;
                        break;
                    case 7:
                        c.volume = a.value;
                        break;
                    case 11:
                        c.expression = a.value;
                        break;
                    case 64:
                        c.sustain = a.value >= 64;
                        if (!c.sustain) for (const v of voices) if (v.channel === c && !v.held) release(v);
                        break;
                    case 101:
                        c.rpn = (c.rpn & 0x7f) | (a.value << 7);
                        break;
                    case 100:
                        c.rpn = (c.rpn & 0x3f80) | a.value;
                        break;
                    case 6:
                        if (c.rpn === 0) c.bendRange = a.value * 100 + (c.bendRange % 100);
                        break;
                    case 38:
                        if (c.rpn === 0) c.bendRange = Math.floor(c.bendRange / 100) * 100 + a.value;
                        break;
                    case 120:
                    case 123:
                        for (const v of voices) if (v.channel === c) release(v);
                        break;
                }
            } else if (a.kind === 'bend') chan(a.pch).bend = a.value / 8192;
            else if (a.kind === 'on') start(a);
            else if (a.kind === 'off') {
                const v = byNote.get(a.id);
                byNote.delete(a.id);
                if (v) {
                    v.held = false;
                    if (!v.channel.sustain) release(v);
                }
            }
        }
        for (let vi = voices.length - 1; vi >= 0; vi--) {
            const v = voices[vi]!;
            const c = v.channel;
            // envelope at the end of this block
            if (v.stage === 0) {
                v.level = v.attackS <= 0 ? 1 : v.level + dt / v.attackS;
                if (v.level >= 1) {
                    v.level = 0;
                    v.stage = 1;
                }
            } else if (v.stage === 1) {
                v.level = v.decayS <= 0 ? v.art.sustainDb : v.level - (96 * dt) / v.decayS;
                if (v.level <= v.art.sustainDb) {
                    v.level = v.art.sustainDb;
                    v.stage = 2;
                }
            } else if (v.stage === 3) {
                v.level -= (96 * dt) / v.releaseS;
                if (v.level <= -96) v.stage = 4;
            }
            let lfo = 0;
            if (v.lfoWait > 0) v.lfoWait -= dt;
            else {
                v.lfoPhase += v.art.lfoHz * dt;
                lfo = Math.sin(2 * Math.PI * v.lfoPhase);
            }
            let env = v.stage === 0 ? v.level : v.stage === 4 ? 0 : Math.pow(10, v.level / 20);
            if (v.art.lfoAtten) env *= Math.pow(10, (v.art.lfoAtten * lfo) / 200);
            const vol = c.volume / 127;
            const expr = c.expression / 127;
            const target = v.gain * env * vol * vol * expr * expr;
            const cents =
                v.baseCents + c.bend * c.bendRange + lfo * (v.art.lfoPitch + (v.art.lfoPitchMod * c.mod) / 128);
            const step = (v.rate / rate) * Math.pow(2, cents / 1200);
            const w = v.wave;
            const len = w.length - 1;
            const loopEnd = v.loop ? v.loop.start + v.loop.length : len;
            let pos = v.pos;
            let amp = v.amp;
            const dAmp = (target - amp) / (s1 - s0);
            let done = false;
            for (let s = s0; s < s1; s++) {
                if (v.loop) {
                    while (pos >= loopEnd) pos -= v.loop.length;
                } else if (pos >= len) {
                    done = true;
                    break;
                }
                const i = pos | 0;
                const f = pos - i;
                const a0 = w[i]!;
                const a1 = v.loop && i + 1 >= loopEnd ? w[v.loop.start]! : w[i + 1]!;
                mix[s]! += (a0 + (a1 - a0) * f) * amp;
                amp += dAmp;
                pos += step;
            }
            v.pos = pos;
            v.amp = target;
            v.age += dt;
            if (done || v.stage === 4) voices.splice(vi, 1);
        }
        if (ai >= actions.length && !voices.length && s1 >= endSec * rate) {
            break;
        }
    }

    // room reverb (Freeverb-style: 8 combs, 4 allpasses; tunings for 44.1 kHz scaled to the mix rate)
    const wet = opts.reverb ?? 0.22;
    const out = wet > 0 ? new Float32Array(total) : mix;
    if (wet > 0) {
        const k = rate / 44100;
        const combs = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617].map((n) => ({
            buf: new Float32Array(Math.round(n * k)),
            i: 0,
            store: 0,
        }));
        const alls = [556, 441, 341, 225].map((n) => ({ buf: new Float32Array(Math.round(n * k)), i: 0 }));
        const fb = 0.8;
        const damp = 0.3;
        for (let s = 0; s < total; s++) {
            const x = mix[s]! * 0.03;
            let y = 0;
            for (const c of combs) {
                const o = c.buf[c.i]!;
                c.store = o * (1 - damp) + c.store * damp;
                c.buf[c.i] = x + c.store * fb;
                if (++c.i >= c.buf.length) c.i = 0;
                y += o;
            }
            for (const a of alls) {
                const o = a.buf[a.i]!;
                a.buf[a.i] = y + o * 0.5;
                if (++a.i >= a.buf.length) a.i = 0;
                y = o - y;
            }
            out[s] = mix[s]! + y * wet * 2;
        }
    }

    // down to the output rate: windowed-sinc low-pass, then decimate
    const ratio = rate / outRate;
    let pcm: Float32Array;
    if (ratio === 1) pcm = out;
    else {
        const taps = 47;
        const mid = (taps - 1) / 2;
        const fc = 0.45 / ratio;
        const h = new Float32Array(taps);
        let sum = 0;
        for (let i = 0; i < taps; i++) {
            const x = i - mid;
            const sinc = x === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * x) / (Math.PI * x);
            const win =
                0.42 - 0.5 * Math.cos((2 * Math.PI * i) / (taps - 1)) + 0.08 * Math.cos((4 * Math.PI * i) / (taps - 1));
            h[i] = sinc * win;
            sum += h[i]!;
        }
        for (let i = 0; i < taps; i++) h[i]! /= sum;
        const n = Math.floor(total / ratio);
        pcm = new Float32Array(n);
        for (let j = 0; j < n; j++) {
            const c = Math.round(j * ratio);
            let acc = 0;
            for (let i = 0; i < taps; i++) {
                const s = c + i - mid;
                if (s >= 0 && s < total) acc += out[s]! * h[i]!;
            }
            pcm[j] = acc;
        }
    }
    return { pcm, rate: outRate, endSec, warnings };
}

// ---------------------------------------------------------------- PS2 tracks

export interface OotfMusicTrack {
    /** PC music id (segment id in Music.rrc). */
    pcId: number;
    name: string;
    rate: number;
    /** Mono 16-bit samples; the PS2 engine loops the whole sample (descriptor flag 0x8). */
    pcm: Int16Array;
    loops: boolean;
    /** Seconds of the part before the segment's loop start. */
    introSec: number;
    /** Seconds of one loop pass. */
    loopSec: number;
    /** Loop passes rendered after the intro. */
    passes: number;
    warnings: string[];
}

export interface TrackOptions extends RenderOptions {
    /**
     * The PS2 streamer restarts a looping track at its first sample, while DirectMusic loops `[loopStart, loopEnd)` after the
     * intro. The loop body is repeated until the track is at least this long (default 120 s), so the intro comes back rarely.
     */
    minSeconds?: number;
    /** Peak level after normalisation (default 0.89, about -1 dBFS). */
    peak?: number;
    /** Loudness target as RMS (default 0.13, about -17.7 dBFS; the PAL title track measures close to it). */
    rms?: number;
}

/**
 * Render a segment as a PS2 music track: the intro (play start to loop start) once, then the loop body enough times for
 * `minSeconds`; the release tails ringing past the end are folded onto the start so the whole-sample loop has no gap or click.
 */
export function renderOotfTrack(
    pcId: number,
    seg: DmSegment,
    collections: readonly DlsCollection[],
    opts: TrackOptions = {},
): OotfMusicTrack {
    const sec = (t: number): number => tickSeconds(seg.tempos, t);
    const end = seg.loopEnd > 0 ? seg.loopEnd : seg.length;
    const loops = seg.repeats > 0 && end > seg.loopStart && seg.loopStart >= seg.playStart;
    const passes: SegmentPass[] = [];
    let introSec = 0;
    let loopSec = 0;
    let n = 1;
    if (loops) {
        introSec = sec(seg.loopStart) - sec(seg.playStart);
        loopSec = sec(end) - sec(seg.loopStart);
        n = Math.max(1, Math.ceil(((opts.minSeconds ?? 120) - introSec) / loopSec));
        passes.push({ from: seg.playStart, to: end, startSec: 0 });
        for (let k = 1; k < n; k++) passes.push({ from: seg.loopStart, to: end, startSec: introSec + k * loopSec });
    } else passes.push({ from: seg.playStart, to: seg.length, startSec: 0 });
    const r = renderSegment(seg, collections, passes, opts);
    const endN = Math.min(r.pcm.length, Math.round(r.endSec * r.rate));
    const f = r.pcm.slice(0, endN);
    if (loops) for (let i = endN; i < r.pcm.length && i - endN < endN; i++) f[i - endN]! += r.pcm[i]!;
    // normalise: loudness target, capped by the peak
    let peak = 0;
    let sq = 0;
    for (const x of f) {
        const a = Math.abs(x);
        if (a > peak) peak = a;
        sq += x * x;
    }
    const rms = Math.sqrt(sq / Math.max(1, f.length));
    const g = rms > 0 ? Math.min((opts.rms ?? 0.13) / rms, (opts.peak ?? 0.89) / peak) : 0;
    const pcm = new Int16Array(f.length);
    for (let i = 0; i < f.length; i++) {
        const v = Math.round(f[i]! * g * 32767);
        pcm[i] = v > 32767 ? 32767 : v < -32768 ? -32768 : v;
    }
    return {
        pcId,
        name: seg.name,
        rate: r.rate,
        pcm,
        loops,
        introSec,
        loopSec,
        passes: loops ? n : 1,
        warnings: [...seg.warnings, ...r.warnings],
    };
}

export interface OotfMusicFile {
    segments: Map<number, DmSegment>;
    collections: Map<number, DlsCollection>;
    warnings: string[];
}

/** Read the segments (ids < 256) and DLS collections (ids 256..) of the PC `Music.rrc`. */
export async function readOotfMusicRrc(bytes: Uint8Array): Promise<OotfMusicFile> {
    const r = await SrscReader.fromBytes(bytes);
    const out: OotfMusicFile = { segments: new Map(), collections: new Map(), warnings: [] };
    for (const e of r.entries) {
        const { data } = await r.read(e);
        if (data.length < 12 || fourcc(data, 0) !== 'RIFF') continue;
        const form = fourcc(data, 8);
        try {
            if (form === 'DMSG') out.segments.set(e.id, parseSegment(data));
            else if (form === 'DLS ') out.collections.set(e.id, parseDls(data));
        } catch (err) {
            out.warnings.push(`entry ${e.id}: ${(err as Error).message}`);
        }
    }
    return out;
}

/** The DLS collections a segment's band names (by GUID), else the conventional `255 + segment id`. */
export function segmentCollections(file: OotfMusicFile, pcId: number): DlsCollection[] {
    const seg = file.segments.get(pcId);
    const want = new Set(seg?.bands.flatMap((b) => b.instruments.map((i) => i.collection)).filter(Boolean) ?? []);
    const named = [...file.collections.values()].filter((c) => want.has(c.guid));
    if (named.length) return named;
    const dflt = file.collections.get(255 + pcId);
    return dflt ? [dflt] : [...file.collections.values()];
}

/** Render every segment of a `Music.rrc` (or the ids given) as PS2 music tracks. */
export async function renderOotfMusic(
    bytes: Uint8Array,
    ids?: readonly number[],
    opts: TrackOptions = {},
): Promise<{ tracks: OotfMusicTrack[]; warnings: string[] }> {
    const file = await readOotfMusicRrc(bytes);
    const tracks: OotfMusicTrack[] = [];
    const warnings = [...file.warnings];
    for (const id of ids ?? [...file.segments.keys()].sort((a, b) => a - b)) {
        const seg = file.segments.get(id);
        if (!seg) {
            warnings.push(`music ${id}: no segment`);
            continue;
        }
        tracks.push(renderOotfTrack(id, seg, segmentCollections(file, id), opts));
    }
    return { tracks, warnings };
}

// ---------------------------------------------------------------- pack entries

/** PS2MUSIC.SDB group of the PAL title track (`GUI`, id 44): the converted tracks join it (no new group record). */
export const OOTF_MUSIC_GROUP = 44;
/** Descriptor volume of the converted tracks (millibel): they are rendered about 4 dB below the disc tracks' loudness. */
export const OOTF_MUSIC_VOLUME = -100;

export interface OotfMusicPack {
    /** PC music id -> PS2MUSIC.SDB sound id (identical segments share one track). */
    ids: Map<number, number>;
    /** `new/PS2MUSIC.SDB/<type>_<id>_<group>.bin` entries. */
    files: Record<string, Uint8Array>;
    /** PS2 id of the title menu music (PC `Background Music ID`), null when it was not converted. */
    title: number | null;
    credits: number | null;
    tracks: { pcId: number; ps2Id: number; name: string; seconds: number; bytes: number; sharedWith?: number }[];
    warnings: string[];
}

const samePcm = (a: Int16Array, b: Int16Array): boolean => {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
};

/**
 * Render the music of a PC `Music.rrc` into PS2MUSIC.SDB entries. Ids come from the free ids of `hostSdb` (the disc's
 * PS2MUSIC.SDB; without it the PAL layout is assumed, whose lowest music id is 86, so 1.. are free).
 */
export async function buildOotfMusicPack(
    musicRrc: Uint8Array,
    opts: {
        hostSdb?: SrscReader;
        interfaceMusic?: { background: number; credits: number };
        group?: number;
        render?: TrackOptions;
        pcIds?: readonly number[];
    } = {},
): Promise<OotfMusicPack> {
    const { tracks, warnings } = await renderOotfMusic(musicRrc, opts.pcIds, opts.render);
    const next = soundIdAllocator(opts.hostSdb?.entries ?? []);
    const out: OotfMusicPack = { ids: new Map(), files: {}, title: null, credits: null, tracks: [], warnings };
    const sounds: Ps2Sound[] = [];
    const done: OotfMusicTrack[] = [];
    for (const t of tracks) {
        for (const w of t.warnings) warnings.push(`music ${t.pcId} ${t.name}: ${w}`);
        const twin = done.find((d) => samePcm(d.pcm, t.pcm));
        if (twin) {
            const id = out.ids.get(twin.pcId)!;
            out.ids.set(t.pcId, id);
            out.tracks.push({
                pcId: t.pcId,
                ps2Id: id,
                name: t.name,
                seconds: t.pcm.length / t.rate,
                bytes: 0,
                sharedWith: twin.pcId,
            });
            continue;
        }
        const id = next();
        if (id === null) {
            warnings.push(`music ${t.pcId}: out of sound ids`);
            break;
        }
        done.push(t);
        out.ids.set(t.pcId, id);
        sounds.push({
            id,
            group: opts.group ?? OOTF_MUSIC_GROUP,
            name: `OotF ${t.name}`.slice(0, 31),
            flags: t.loops ? 0xa : 0x2,
            rate: t.rate,
            volume: OOTF_MUSIC_VOLUME,
            dropoff: 15,
            priority: 9,
            pcm: t.pcm,
        });
        out.tracks.push({ pcId: t.pcId, ps2Id: id, name: t.name, seconds: t.pcm.length / t.rate, bytes: 0 });
    }
    for (const r of ps2SoundEntries(sounds)) {
        out.files[`new/PS2MUSIC.SDB/${r.type.toString(16).padStart(4, '0')}_${r.id}_${r.sub}.bin`] = r.data;
        if (r.type === 0x304)
            for (const tr of out.tracks) if (tr.ps2Id === r.id && !tr.sharedWith) tr.bytes = r.data.length;
    }
    const im = opts.interfaceMusic;
    if (im?.background) out.title = out.ids.get(im.background) ?? null;
    if (im?.credits) out.credits = out.ids.get(im.credits) ?? null;
    return out;
}
