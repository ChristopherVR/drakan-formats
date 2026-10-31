import { view } from './bytes.ts';
import { inflate } from './inflate.ts';
import { decodeSpuAdpcm } from './resources.ts';
import { SrscReader, SRSC_ENTRY_SIZE, SRSC_HEADER_SIZE } from './srsc.ts';

/**
 * Order of the Flame (PC) sounds -> PS2 SDB sounds. Layouts: docs/journal/2026-10-31/ootf-sound.md.
 *
 * PC `.sdb` (SRSC v0x0100): 0x0301 group (`string name`), 0x0302 sound
 * (`string name, u32 flags, u16 channels, u16 bits, u32 rate, i32 volume (millibel), f32 dropoff, u32 priority,
 * u32 decompressedSize, u32 compression (0 none, else zlib), [u32 compressedSize], PCM`), sub = group id.
 * PS2 `.SDB` (SRSC v0x0101): 0x0301 group, 0x0302 descriptor, 0x0304 SPU-ADPCM of the same (id, sub), trailer records
 * 0x0300 / 0x0402 / 0x0307.
 */

export const kPs2SoundDescriptor = 0x302;
export const kPs2SoundSamples = 0x304;
export const kPs2SoundGroup = 0x301;
/** The game requests SDB data in chunks of at most this many bytes (RSRCIOP, "> 0x40800 => error -9"); longer samples stream. */
export const kMaxRequestBytes = 0x40800;

// ---- PC side -----------------------------------------------------------------------------------------------------

export interface PcSound {
    /** SRSC id inside the PC SDB (what class fields reference). */
    id: number;
    /** Group id (SRSC sub). */
    group: number;
    name: string;
    flags: number;
    channels: number;
    bits: number;
    rate: number;
    /** Millibel, 0 = full volume. */
    volume: number;
    dropoff: number;
    priority: number;
    /** Mono 16-bit samples (8-bit / stereo sources are converted on load). */
    pcm: Int16Array;
}

export interface PcSoundBank {
    sounds: PcSound[];
    groups: Map<number, string>;
    warnings: string[];
}

const cstring = (b: Uint8Array, start: number, len: number): string => {
    let end = start;
    const stop = Math.min(b.length, start + len);
    while (end < stop && b[end] !== 0) end++;
    let s = '';
    for (let i = start; i < end; i++) s += String.fromCharCode(b[i]!);
    return s;
};

/** Interleaved little-endian PCM bytes -> mono Int16 (8-bit is unsigned; channels are averaged). */
export function pcmToMono16(raw: Uint8Array, channels: number, bits: number): Int16Array {
    const ch = Math.max(1, channels);
    const bytes = bits === 8 ? 1 : 2;
    const frames = Math.floor(raw.length / (bytes * ch));
    const out = new Int16Array(frames);
    const dv = view(raw);
    for (let i = 0; i < frames; i++) {
        let acc = 0;
        for (let c = 0; c < ch; c++) {
            const o = (i * ch + c) * bytes;
            acc += bits === 8 ? (raw[o]! - 128) << 8 : dv.getInt16(o, true);
        }
        out[i] = Math.round(acc / ch);
    }
    return out;
}

/** Parse a PC `.sdb` (or any SRSC with 0x0302 sound records). Records that cannot be read are skipped with a warning. */
export async function parsePcSounds(data: ArrayBuffer | Uint8Array): Promise<PcSoundBank> {
    const r = await SrscReader.fromBytes(data);
    const bank: PcSoundBank = { sounds: [], groups: new Map(), warnings: [] };
    for (const e of r.entries) {
        const rec = await r.readRaw(e);
        if (e.type === 0x301) {
            const n = rec.length >= 2 ? view(rec).getUint16(0, true) : 0;
            bank.groups.set(e.id, cstring(rec, 2, n));
            continue;
        }
        if (e.type !== 0x302) continue;
        try {
            const dv = view(rec);
            const n = dv.getUint16(0, true);
            const name = cstring(rec, 2, n);
            let o = 2 + n;
            const flags = dv.getUint32(o, true);
            const channels = dv.getUint16(o + 4, true);
            const bits = dv.getUint16(o + 6, true);
            const rate = dv.getUint32(o + 8, true);
            const volume = dv.getInt32(o + 12, true);
            const dropoff = dv.getFloat32(o + 16, true);
            const priority = dv.getUint32(o + 20, true);
            const decompressed = dv.getUint32(o + 24, true);
            const level = dv.getUint32(o + 28, true);
            o += 32;
            let raw: Uint8Array | null;
            if (level > 0) {
                const csize = dv.getUint32(o, true);
                o += 4;
                raw = inflate(rec.subarray(o, o + csize));
            } else {
                raw = rec.subarray(o, o + decompressed);
            }
            if (!raw) {
                bank.warnings.push(`sound ${e.id} (${name}): zlib data does not inflate`);
                continue;
            }
            if (raw.length !== decompressed)
                bank.warnings.push(`sound ${e.id} (${name}): size ${raw.length} != ${decompressed}`);
            bank.sounds.push({
                id: e.id,
                group: e.sub,
                name,
                flags,
                channels,
                bits,
                rate,
                volume,
                dropoff,
                priority,
                pcm: pcmToMono16(raw, channels, bits),
            });
        } catch (err) {
            bank.warnings.push(`sound ${e.id}: ${(err as Error).message}`);
        }
    }
    return bank;
}

// ---- PS-ADPCM encoder --------------------------------------------------------------------------------------------

const F0 = [0, 60, 115, 98, 122];
const F1 = [0, 0, -52, -55, -60];
const MAX_SHIFT = 12;

export interface VagOptions {
    /** Standalone VAG flags: first block 4 (loop start), last block 3 (loop end + repeat). Default: last block 1 (end). */
    loop?: boolean;
}

/** Try one (filter, shift) on a 28-sample block; fills `nib` and returns the squared error and the final history. */
function tryBlock(
    x: ArrayLike<number>,
    base: number,
    count: number,
    pred: number,
    shift: number,
    s1In: number,
    s2In: number,
    nib: Int8Array,
): { err: number; s1: number; s2: number } {
    const f0 = F0[pred]!;
    const f1 = F1[pred]!;
    let s1 = s1In;
    let s2 = s2In;
    let err = 0;
    for (let i = 0; i < 28; i++) {
        const target = i < count ? x[base + i]! : 0;
        const p = ((s1 * f0) >> 6) + ((s2 * f1) >> 6);
        let v = Math.round(((target - p) * (1 << shift)) / 4096);
        v = v > 7 ? 7 : v < -8 ? -8 : v;
        nib[i] = v;
        let s = ((v << 12) >> shift) + p;
        s = s > 32767 ? 32767 : s < -32768 ? -32768 : s;
        const d = target - s;
        err += d * d;
        s2 = s1;
        s1 = s;
    }
    return { err, s1, s2 };
}

/**
 * Encode mono 16-bit PCM as PS2 SPU ADPCM (VAG blocks, 28 samples per 16 bytes). Closed loop: for every block all five
 * filters and the two shifts around the best-fitting range are encoded with the decoder's own arithmetic (the one in
 * `decodeSpuAdpcm`) and the lowest error wins. Pads the last block with silence.
 */
export function encodeVag(pcm: ArrayLike<number>, opts: VagOptions = {}): Uint8Array {
    const blocks = Math.max(1, Math.ceil(pcm.length / 28));
    const out = new Uint8Array(blocks * 16);
    let s1 = 0;
    let s2 = 0;
    const nib = new Int8Array(28);
    const best = new Int8Array(28);
    for (let b = 0; b < blocks; b++) {
        const base = b * 28;
        const count = Math.max(0, Math.min(28, pcm.length - base));
        let bestErr = Infinity;
        let bestPred = 0;
        let bestShift = 0;
        let bs1 = s1;
        let bs2 = s2;
        for (let pred = 0; pred < 5; pred++) {
            // open-loop residual peak (history = the block's own source samples) picks the starting shift
            let peak = 0;
            let h1 = s1;
            let h2 = s2;
            for (let i = 0; i < count; i++) {
                const p = ((h1 * F0[pred]!) >> 6) + ((h2 * F1[pred]!) >> 6);
                const d = Math.abs(pcm[base + i]! - p);
                if (d > peak) peak = d;
                h2 = h1;
                h1 = pcm[base + i]!;
            }
            let sh = MAX_SHIFT;
            while (sh > 0 && (peak * (1 << sh)) / 4096 > 7.4) sh--;
            for (const shift of [sh, Math.max(0, sh - 1)]) {
                const r = tryBlock(pcm, base, count, pred, shift, s1, s2, nib);
                if (r.err < bestErr) {
                    bestErr = r.err;
                    bestPred = pred;
                    bestShift = shift;
                    bs1 = r.s1;
                    bs2 = r.s2;
                    best.set(nib);
                }
                if (sh === 0) break;
            }
            if (bestErr === 0) break;
        }
        const o = b * 16;
        out[o] = bestShift | (bestPred << 4);
        for (let j = 0; j < 14; j++) out[o + 2 + j] = (best[2 * j]! & 15) | ((best[2 * j + 1]! & 15) << 4);
        s1 = bs1;
        s2 = bs2;
    }
    if (opts.loop) {
        out[1] = 4;
        out[(blocks - 1) * 16 + 1] = 3;
    } else {
        out[(blocks - 1) * 16 + 1] = 1;
    }
    return out;
}

/** The disc's 0x0304 layout: one all-zero block, the ADPCM blocks (flag 0), an end block (flag 1, silent), a 0x77 sentinel block. */
export function encodeSdbSamples(pcm: ArrayLike<number>): Uint8Array {
    const vag = encodeVag(pcm);
    const n = vag.length / 16;
    const out = new Uint8Array((n + 3) * 16);
    out.set(vag, 16);
    out[16 + (n - 1) * 16 + 1] = 0;
    out[16 + n * 16 + 1] = 1;
    out.fill(0x77, (n + 2) * 16);
    return out;
}

/** Signal-to-noise ratio in dB of `b` against the reference `a` over the shorter of the two (Infinity when identical). */
export function snrDb(a: ArrayLike<number>, b: ArrayLike<number>): number {
    const n = Math.min(a.length, b.length);
    let sig = 0;
    let noise = 0;
    for (let i = 0; i < n; i++) {
        sig += a[i]! * a[i]!;
        const d = a[i]! - b[i]!;
        noise += d * d;
    }
    if (noise === 0) return Infinity;
    return 10 * Math.log10(sig / noise);
}

/** Decode a 0x0304 sample blob (zero block, data, end block, sentinel) back to PCM. */
export function decodeSdbSamples(b: Uint8Array): Int16Array {
    const pcm = decodeSpuAdpcm(b);
    return pcm.subarray(28, Math.max(28, pcm.length));
}

/** Box-filter decimation / linear interpolation to `toRate` (used to shrink 44.1 kHz effects; PS2 plays any rate). */
export function resamplePcm(pcm: Int16Array, fromRate: number, toRate: number): Int16Array {
    if (fromRate === toRate || pcm.length === 0) return pcm;
    const ratio = fromRate / toRate;
    const n = Math.max(1, Math.floor(pcm.length / ratio));
    const out = new Int16Array(n);
    for (let i = 0; i < n; i++) {
        const a = i * ratio;
        const b = Math.min(pcm.length, (i + 1) * ratio);
        if (ratio > 1) {
            let acc = 0;
            let w = 0;
            for (let k = Math.floor(a); k < Math.ceil(b); k++) {
                const wk = Math.min(k + 1, b) - Math.max(k, a);
                acc += pcm[k]! * wk;
                w += wk;
            }
            out[i] = Math.round(acc / w);
        } else {
            const k = Math.floor(a);
            const f = a - k;
            out[i] = Math.round(pcm[k]! * (1 - f) + pcm[Math.min(pcm.length - 1, k + 1)]! * f);
        }
    }
    return out;
}

// ---- PS2 SDB writer ----------------------------------------------------------------------------------------------

export interface Ps2Sound {
    /** SRSC id (u16, unique within the SDB). */
    id: number;
    /** Group id (SRSC sub of the 0x0302 and 0x0304 records). */
    group: number;
    name: string;
    /** PS2 descriptor flags: 0x8 loop, 0x2 common for effects. */
    flags: number;
    rate: number;
    /** Millibel (<= 0). */
    volume: number;
    dropoff: number;
    /** 0-15; the descriptor class byte is `priority * 0x11` (0x55 on most effects, 0x99 on music). */
    priority: number;
    /** Mono source samples. */
    pcm: Int16Array;
}

export interface Ps2Group {
    id: number;
    /** Parent group id (0 = top level). */
    parent: number;
    name: string;
}

const alignName = (n: number): number => ((2 + n + 3) & ~3) - 2;

const nameBytes = (name: string): Uint8Array => {
    const raw = new Uint8Array(name.length);
    for (let i = 0; i < name.length; i++) raw[i] = name.charCodeAt(i) & 0xff;
    const out = new Uint8Array(2 + alignName(raw.length));
    view(out).setUint16(0, out.length - 2, true);
    out.set(raw, 2);
    return out;
};

export function writePs2Group(g: Ps2Group): Uint8Array {
    return nameBytes(g.name);
}

/** 0x0302 descriptor exactly as the disc writes it (no subtitle text: `u32 2` stands for an empty text area). */
export function writePs2Descriptor(s: Ps2Sound, pcmBytes: number, adpcmBytes: number): Uint8Array {
    const nb = nameBytes(s.name);
    const out = new Uint8Array(nb.length + 48);
    out.set(nb, 0);
    const dv = view(out);
    let o = nb.length;
    dv.setUint32(o, s.flags >>> 0, true);
    dv.setUint32(o + 4, 0x00100001, true); // u16 channels 1, u16 bits 16
    dv.setUint32(o + 8, s.rate, true);
    dv.setInt32(o + 12, Math.min(0, Math.round(s.volume)), true);
    dv.setUint32(o + 16, 0, true);
    dv.setFloat32(o + 20, s.dropoff, true);
    dv.setUint32(o + 24, 0, true);
    const pri = Math.max(0, Math.min(15, Math.round(s.priority)));
    dv.setUint32(o + 28, pri * 0x11, true);
    dv.setUint32(o + 32, 2, true);
    dv.setUint32(o + 36, pcmBytes, true);
    dv.setUint32(o + 40, adpcmBytes, true);
    dv.setUint32(o + 44, 0, true);
    return out;
}

interface Rec {
    type: number;
    id: number;
    sub: number;
    data: Uint8Array;
}

function soundRecords(sounds: readonly Ps2Sound[], groups: readonly Ps2Group[]): Rec[] {
    const recs: Rec[] = groups.map((g) => ({ type: 0x301, id: g.id, sub: g.parent, data: writePs2Group(g) }));
    for (const s of sounds) {
        const adpcm = encodeSdbSamples(s.pcm);
        recs.push({ type: 0x302, id: s.id, sub: s.group, data: writePs2Descriptor(s, s.pcm.length * 2, adpcm.length) });
        recs.push({ type: 0x304, id: s.id, sub: s.group, data: adpcm });
    }
    return recs;
}

function layout(recs: Rec[], start: number): { body: Uint8Array; index: Uint8Array; end: number } {
    const entries: { type: number; id: number; sub: number; off: number; size: number }[] = [];
    let pos = start;
    const chunks: { off: number; data: Uint8Array }[] = [];
    for (const r of recs) {
        pos = (pos + 7) & ~7;
        entries.push({ type: r.type, id: r.id, sub: r.sub, off: pos, size: r.data.length });
        chunks.push({ off: pos, data: r.data });
        pos += r.data.length;
    }
    const body = new Uint8Array(pos - start);
    for (const c of chunks) body.set(c.data, c.off - start);
    const index = new Uint8Array(entries.length * SRSC_ENTRY_SIZE);
    const iv = view(index);
    entries.forEach((e, i) => {
        const o = i * SRSC_ENTRY_SIZE;
        iv.setUint16(o, e.type, true);
        iv.setUint16(o + 2, e.id, true);
        iv.setUint16(o + 4, e.sub, true);
        iv.setUint32(o + 6, e.off, true);
        iv.setUint32(o + 10, e.size, true);
    });
    return { body, index, end: pos };
}

/** Disc order of the three trailer records (index order 0x300, 0x402, 0x307; data last). */
function trailerRecords(entryCount: number, nextId: number): Rec[] {
    const t300 = new Uint8Array(4);
    view(t300).setUint16(0, entryCount & 0xffff, true);
    view(t300).setUint16(2, nextId & 0xffff, true);
    return [
        { type: 0x300, id: 0, sub: 0, data: t300 },
        { type: 0x402, id: 0, sub: 0, data: Uint8Array.of(0x10, 0x01, 0, 0) },
        { type: 0x307, id: 0, sub: 0, data: new Uint8Array(4) },
    ];
}

function srscHeader(indexOffset: number, count: number): Uint8Array {
    const h = new Uint8Array(SRSC_HEADER_SIZE);
    h.set([0x53, 0x52, 0x53, 0x43], 0);
    const dv = view(h);
    dv.setUint16(4, 0x0101, true);
    dv.setUint32(6, indexOffset, true);
    dv.setUint32(10, count, true);
    return h;
}

/** Build a standalone PS2 SDB (SRSC v0x0101) from converted sounds. */
export function writePs2Sdb(sounds: readonly Ps2Sound[], groups: readonly Ps2Group[]): Uint8Array {
    const recs = soundRecords(sounds, groups);
    const maxId = sounds.reduce((m, s) => Math.max(m, s.id), 0);
    const trailer = trailerRecords(recs.length + 3, maxId + 1);
    const all = [...recs, ...trailer];
    const { body, index, end } = layout(all, SRSC_HEADER_SIZE);
    // disc index order: trailer first, then groups and sounds
    const reordered = new Uint8Array(index.length);
    const k = trailer.length * SRSC_ENTRY_SIZE;
    reordered.set(index.subarray(index.length - k), 0);
    reordered.set(index.subarray(0, index.length - k), k);
    const out = new Uint8Array(SRSC_HEADER_SIZE + body.length + reordered.length);
    out.set(srscHeader(end, all.length), 0);
    out.set(body, SRSC_HEADER_SIZE);
    out.set(reordered, SRSC_HEADER_SIZE + body.length);
    return out;
}

/**
 * Add sounds to an existing PS2 SDB (for example the level's own `.SDB`): the old data area is kept byte for byte, the
 * new 0x0301 / 0x0302 / 0x0304 records follow it (8-byte aligned) and the index grows. Ids and group ids must not clash
 * with the existing ones (`nextSdbIds` gives free ones).
 */
export async function appendToPs2Sdb(
    existing: Uint8Array,
    sounds: readonly Ps2Sound[],
    groups: readonly Ps2Group[],
): Promise<Uint8Array> {
    const r = await SrscReader.fromBytes(existing);
    if (r.platform !== 'ps2') throw new Error('not a PS2 SRSC');
    const used = new Set(r.entries.filter((e) => e.type === 0x302).map((e) => e.id));
    for (const s of sounds) if (used.has(s.id)) throw new Error(`sound id ${s.id} already exists`);
    const usedG = new Set(r.entries.filter((e) => e.type === 0x301).map((e) => e.id));
    for (const g of groups) if (usedG.has(g.id)) throw new Error(`group id ${g.id} already exists`);
    const recs = soundRecords(sounds, groups);
    const { body, index, end } = layout(recs, r.indexOffset);
    const oldIndex = existing.subarray(r.indexOffset, r.indexOffset + r.entries.length * SRSC_ENTRY_SIZE);
    const total = r.entries.length + recs.length;
    const out = new Uint8Array(end + oldIndex.length + index.length + r.trailer.length);
    out.set(existing.subarray(0, r.indexOffset), 0);
    out.set(body, r.indexOffset);
    out.set(oldIndex, end);
    out.set(index, end + oldIndex.length);
    out.set(r.trailer, end + oldIndex.length + index.length);
    view(out).setUint32(6, end, true);
    view(out).setUint32(10, total, true);
    return out;
}

/** Free ids in an existing PS2 SDB: first sound id and group id above everything in use. */
export async function nextSdbIds(existing: Uint8Array): Promise<{ sound: number; group: number }> {
    const r = await SrscReader.fromBytes(existing);
    let s = 0;
    let g = 0;
    for (const e of r.entries) {
        if (e.type === 0x302) s = Math.max(s, e.id);
        else if (e.type === 0x301) g = Math.max(g, e.id);
    }
    return { sound: s + 1, group: g + 1 };
}

// ---- PC -> PS2 conversion and id map ----------------------------------------------------------------------------

/** Lower-case SDB stem identifying a PC database, e.g. `common/system/system`; the key space of `SoundMap`. */
export const sdbKey = (path: string): string =>
    path
        .replace(/\\/g, '/')
        .replace(/\.sdb$/i, '')
        .toLowerCase();

export interface SoundConvertOptions {
    /** Resample effects above this rate down to it (default 22050; PS2 effects on the disc are 22050 or 44100). */
    maxRate?: number;
    /** Hard cap on the ADPCM size per sound in bytes (longer sounds are dropped with a warning). Default: none. */
    maxBytes?: number;
    /** Override the descriptor flags (default: 0x2, loop adds 0x8). */
    flags?: (pc: PcSound) => number;
}

export interface ConvertedSound {
    key: string;
    pcId: number;
    sound: Ps2Sound;
}

/** Map from (PC database key, PC sound id) to the PS2 sound reference `(db << 16) | id`. */
export class SoundMap {
    private readonly refs = new Map<string, number>();
    /** PS2 database index placed in the high half of a reference (0 = the level's own SDB). */
    constructor(readonly ps2Db = 0) {}

    set(key: string, pcId: number, ps2Id: number): void {
        this.refs.set(`${key}#${pcId}`, ((this.ps2Db << 16) | ps2Id) >>> 0);
    }

    get(key: string, pcId: number): number | null {
        return this.refs.get(`${key}#${pcId}`) ?? null;
    }

    get size(): number {
        return this.refs.size;
    }

    /**
     * Translate a PC reference field `(db << 16) | id` (db = PC dependency index of the level) to a PS2 reference.
     * `keyOf` returns the sdbKey of that dependency (null when unknown). 0 and unknown sounds give null.
     */
    mapRef(pcRef: number, keyOf: (db: number) => string | null | undefined): number | null {
        if (!pcRef) return null;
        const key = keyOf(pcRef >>> 16);
        return key ? this.get(key, pcRef & 0xffff) : null;
    }
}

export interface SoundConversion {
    map: SoundMap;
    sounds: Ps2Sound[];
    group: Ps2Group;
    /** Reasons sounds were skipped. */
    warnings: string[];
    /** Total ADPCM bytes written (SPU2 RAM is 2 MB; the sounds of one level share it). */
    adpcmBytes: number;
}

/**
 * Convert PC sounds (one entry per PC database) into PS2 sounds with fresh ids starting at `firstId`, all in one new
 * group `groupId`. Identical (db, id) pairs convert once. The result feeds `writePs2Sdb` / `appendToPs2Sdb`, and
 * `map` is the id map for `ConvertOptions`-style hooks and the sequence converter.
 */
export function convertPcSounds(
    banks: ReadonlyMap<string, PcSoundBank>,
    ids: { firstId: number; groupId: number; groupName?: string; ps2Db?: number },
    opts: SoundConvertOptions = {},
): SoundConversion {
    const map = new SoundMap(ids.ps2Db ?? 0);
    const sounds: Ps2Sound[] = [];
    const warnings: string[] = [];
    const maxRate = opts.maxRate ?? 22050;
    let next = ids.firstId;
    let bytes = 0;
    for (const [key, bank] of banks) {
        for (const pc of bank.sounds) {
            if (next > 0xffff) {
                warnings.push('out of ids');
                break;
            }
            let pcm = pc.pcm;
            let rate = pc.rate;
            if (rate > maxRate) {
                pcm = resamplePcm(pcm, rate, maxRate);
                rate = maxRate;
            }
            const size = (Math.ceil(pcm.length / 28) + 3) * 16;
            if (opts.maxBytes && size > opts.maxBytes) {
                warnings.push(`${key}#${pc.id} ${pc.name}: ${size} bytes exceeds the cap`);
                continue;
            }
            const loop = (pc.flags & 8) !== 0;
            const flags = opts.flags ? opts.flags(pc) : loop ? 0xa : 0x2;
            const sound: Ps2Sound = {
                id: next,
                group: ids.groupId,
                name: pc.name || `sound ${pc.id}`,
                flags,
                rate,
                volume: pc.volume,
                dropoff: Number.isFinite(pc.dropoff) ? pc.dropoff : 15,
                priority: Math.min(10, pc.priority),
                pcm,
            };
            sounds.push(sound);
            map.set(key, pc.id, next);
            bytes += size;
            next++;
        }
    }
    return {
        map,
        sounds,
        group: { id: ids.groupId, parent: 0, name: ids.groupName ?? 'Order of the Flame' },
        warnings,
        adpcmBytes: bytes,
    };
}
