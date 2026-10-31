// Order of the Flame (PC) STOMP sequences -> PS2 `.SSD` records. Evidence and the verified / guessed split:
// docs/journal/2026-10-31/ootf-sequences.md. PC layout follows OpenDrakan (Zalasus, GPL-3.0, commit 6c0d499,
// `doc/riot_database_format.txt` "Sequence (0x0310 - 0x0312)", `src/odCore/db/Sequence.cpp`); PS2 side: story/ssd.ts,
// story/ssdactions.ts.
//
// PC sequence record (0x0311):   string name, u32 flags, u32 modifyRunState, u32 unk2, u32 actorCount, actors
// PC actor:                      string name, u32 id, u32 type (1 = level object), u32 assignedAs, [u32 objectId], u32 n, actions
// PC action = u16 type, f32 time, payload:
//   0 transform 36 (quat xyzw, pos xyz, u32 relativeActor, u32 options)   1 animation 24 (channel, ref, begin, transition, speed, flags)
//   3 sound 12 (ref, f32 duration, u16 volume, u16 flags)                 4 attach 8     5 run/stop AI 4     6 show/hide 4
//   7 message 8 (code, 0)                                                 8 music 16 (musicId, dlsId, fadeIn, fadeOut)
// PS2 record: u16-prefixed name, the SAME four header words (flags, modifyRunState, highest actor id + 1, actor count), then
// actors `name, slot (= PC actor id), ref (= level object id), mode, n` and the PS2 action grammar (ssdactions.ts). The
// conversion keeps PC actor ids as slots, so `attach` targets and transform `relativeActor` need no remapping.

import { latin1, view } from './bytes.ts';
import type { SrscReader } from './srsc.ts';
import { joinActions } from './story/ssdactions.ts';
import { writeSequence, type SsdActor, type SsdSequence } from './story/ssd.ts';

import { SSD_SEQUENCE } from './resources.ts';
export const SSD_FOLDER_TYPE = 0x312;

/** PC action payload sizes (without the 6-byte type + time prefix). */
const PC_PAYLOAD: Readonly<Record<number, number>> = { 0: 36, 1: 24, 3: 12, 4: 8, 5: 4, 6: 4, 7: 8, 8: 16 };

export interface PcAction {
    type: number;
    time: number;
    /** Payload bytes, copied. */
    payload: Uint8Array;
}

export interface PcSeqActor {
    name: string;
    id: number;
    /** 0 null actor, 1 level object, 2 assigned by AI. */
    actorType: number;
    assignedAs: number;
    /** Level object id (actorType 1), else 0. */
    objectId: number;
    actions: PcAction[];
}

export interface PcSequence {
    id: number;
    /** SRSC sub of the record (id of the 0x0312 group). */
    group: number;
    name: string;
    flags: number;
    modifyRunState: number;
    unk2: number;
    actors: PcSeqActor[];
}

export class PcSequenceError extends Error {}

/** Parse one PC 0x0311 body; throws PcSequenceError on an unknown action type or leftover bytes. */
export function parsePcSequence(id: number, group: number, b: Uint8Array): PcSequence {
    const dv = view(b);
    let p = 0;
    const need = (n: number): void => {
        if (p + n > b.length) throw new PcSequenceError(`sequence ${id}: read past end at ${p}`);
    };
    const u16 = (): number => (need(2), ((p += 2), dv.getUint16(p - 2, true)));
    const u32 = (): number => (need(4), ((p += 4), dv.getUint32(p - 4, true)));
    const str = (): string => {
        const n = u16();
        need(n);
        const raw = b.subarray(p, p + n);
        p += n;
        const z = raw.indexOf(0);
        return latin1(raw, 0, z < 0 ? raw.length : z);
    };
    const name = str();
    const flags = u32();
    const modifyRunState = u32();
    const unk2 = u32();
    const n = u32();
    if (n > 4096) throw new PcSequenceError(`sequence ${id}: implausible actor count ${n}`);
    const actors: PcSeqActor[] = [];
    for (let i = 0; i < n; i++) {
        const aname = str();
        const aid = u32();
        const actorType = u32();
        const assignedAs = u32();
        const objectId = actorType === 1 ? u32() : (u32(), 0);
        const count = u32();
        if (count > 65536) throw new PcSequenceError(`sequence ${id}: implausible action count ${count}`);
        const actions: PcAction[] = [];
        for (let k = 0; k < count; k++) {
            const type = u16();
            need(4);
            const time = dv.getFloat32(p, true);
            p += 4;
            const size = PC_PAYLOAD[type];
            if (size === undefined) throw new PcSequenceError(`sequence ${id}: unknown action type ${type}`);
            need(size);
            actions.push({ type, time, payload: b.slice(p, p + size) });
            p += size;
        }
        actors.push({ name: aname, id: aid, actorType, assignedAs, objectId, actions });
    }
    if (p !== b.length) throw new PcSequenceError(`sequence ${id}: ${b.length - p} bytes left over`);
    return { id, group, name, flags, modifyRunState, unk2, actors };
}

// ---------------------------------------------------------------------------------------------------------------
// Lookup tables supplied by the caller (other converters produce them).

/** `get(pcRef)` -> PS2 value, undefined when the resource has no PS2 counterpart. A `Map` fits. */
export type RefLookup = { get(pcRef: number): number | undefined };

export interface SequenceMaps {
    /** PC level object id -> PS2 object id (after convertPcLevel's renumbering; objects that were dropped are absent). */
    objectIdMap: RefLookup;
    /** PC animation ref `(db << 16) | id` (db relative to the PC `.db` of this `.ssd`) -> final PS2 ref word. */
    animMap?: RefLookup;
    /** PC sound ref `(db << 16) | id` -> final PS2 ref word (`(db << 16) | id` in the target SSD's `.DB` frame). */
    soundMap?: RefLookup;
    /** PC music id (first u32 of the music action; 0 = stop) -> PS2 music ref word (`(db << 16) | id`). */
    musicMap?: RefLookup;
}

export interface SequenceConvertOptions {
    maps: SequenceMaps;
    /** db index under which owner classes see this PC `.ssd` (keys of `idMap` are `(pcDbIndex << 16) | pcId`). Default 0. */
    pcDbIndex?: number;
    /** Only convert these PC sequence ids (e.g. the ones a Stomp Player's `Sequence List` names). Default all. */
    only?: Iterable<number>;
    /** Ids already used by any entry of the target PS2 SSD, and by earlier conversions into it (updated in place). */
    usedIds: Set<number>;
    /** SRSC `sub` of the new 0x0311 entries (the 0x0312 group they are listed in). Default: a new group is created. */
    folderId?: number;
    /** Name of the group created when `folderId` is omitted. */
    folderName?: string;
    /** PS2 db word written into `idMap` values (0 = the SSD's own stem, which is what a Stomp Player of that stem resolves). */
    ps2Db?: number;
    /** PS2 object ids standing in for PC actors that are not level objects (matched by actor name). */
    playerObjectId?: number;
    dragonObjectId?: number;
    cameraObjectId?: number;
    /** Field of view (degrees) of the camera-setup action (type 9) inserted at time 0 of camera actors. Default 40. */
    cameraFov?: number;
    /** Keep PC run/stop-AI values of 1 (default false: write 0 like every PS2 action of that type). */
    keepAiResume?: boolean;
    /** Messages 1..4095 are numeric payloads (fader times...), not engine ids. Default keep. */
    smallMessages?: 'keep' | 'drop';
    /** Override the PS2 actor mode (default 0 for objects, 1 for Rynn / dragon). */
    actorMode?: (a: PcSeqActor) => number | undefined;
}

export interface Ps2SsdEntry {
    type: number;
    id: number;
    sub: number;
    data: Uint8Array;
}

export interface SequenceReport {
    sequencesIn: number;
    sequencesOut: number;
    actorsIn: number;
    actorsOut: number;
    actionsIn: number;
    actionsOut: number;
    /** Actors dropped because their level object has no PS2 counterpart: `name -> count`. */
    droppedActors: Map<string, number>;
    /** Actions dropped by kind (`sound`, `animation`, `music`, `message`). */
    droppedActions: Map<string, number>;
    /** Messages passed through that the PS2 data does not contain (value -> count). */
    unverifiedMessages: Map<number, number>;
    warnings: string[];
}

export interface SequenceConversion {
    /** New SSD records: the group (0x0312, when created) first, then the sequences (0x0311). */
    entries: Ps2SsdEntry[];
    /** `(pcDbIndex << 16) | pcId` -> PS2 sequence ref word (`(ps2Db << 16) | newId`). */
    idMap: Map<number, number>;
    report: SequenceReport;
}

/** First unused id, preferring holes below the container's current maximum (new ids above it did not spawn in tests). */
export function allocateId(used: Set<number>, lo = 1): number {
    const max = used.size ? Math.max(...used) : 0;
    for (let i = lo; i <= max; i++) if (!used.has(i)) return reserve(used, i);
    if (max + 1 > 0xffff) throw new PcSequenceError('no free SRSC id left');
    return reserve(used, Math.max(max + 1, lo));
}
const reserve = (used: Set<number>, id: number): number => (used.add(id), id);

/** Ids of every entry of a PS2 SSD (record ids are unique across entry types: sequences and groups share the space). */
export function usedIdsOf(ssd: SrscReader): Set<number> {
    return new Set(ssd.entries.map((e) => e.id));
}

const CAMERA_RE = /^camera$/i;
const RYNN_RE = /^rynn$/i;
const DRAGON_RE = /^(arokh|aroch)$/i;

function pcBytes(type: number, time: number, payloadSize: number): Uint8Array {
    const out = new Uint8Array(6 + payloadSize);
    const dv = view(out);
    dv.setUint16(0, type, true);
    dv.setFloat32(2, time, true);
    return out;
}

function bump<K>(m: Map<K, number>, k: K): void {
    m.set(k, (m.get(k) ?? 0) + 1);
}

/** Folder (0x0312) record body: `u16 length + name`, terminated and padded so that length + 2 is a multiple of 4. */
export function folderBody(name: string): Uint8Array {
    const raw = [...name].map((c) => c.charCodeAt(0) & 0x7f);
    raw.push(0);
    while ((raw.length + 2) % 4) raw.push(0);
    return Uint8Array.from([raw.length & 255, raw.length >> 8, ...raw]);
}

interface ActorOutcome {
    actor: SsdActor | null;
}

/**
 * Convert the sequences of one PC `.ssd` (SrscReader with `platform === 'pc'`) to PS2 0x0311 records. Pure: nothing is
 * written anywhere; `opts.usedIds` is updated with the allocated ids so several levels / files can share one target SSD.
 */
export async function convertPcSequences(pc: SrscReader, opts: SequenceConvertOptions): Promise<SequenceConversion> {
    const report: SequenceReport = {
        sequencesIn: 0,
        sequencesOut: 0,
        actorsIn: 0,
        actorsOut: 0,
        actionsIn: 0,
        actionsOut: 0,
        droppedActors: new Map(),
        droppedActions: new Map(),
        unverifiedMessages: new Map(),
        warnings: [],
    };
    const entries: Ps2SsdEntry[] = [];
    const idMap = new Map<number, number>();
    const only = opts.only ? new Set(opts.only) : null;
    const pcDb = opts.pcDbIndex ?? 0;
    const ps2Db = opts.ps2Db ?? 0;
    let folder = opts.folderId;
    const seqs = pc.entries.filter((e) => e.type === SSD_SEQUENCE && (!only || only.has(e.id)));
    if (folder === undefined && seqs.length) {
        folder = allocateId(opts.usedIds);
        entries.push({
            type: SSD_FOLDER_TYPE,
            id: folder,
            sub: 0,
            data: folderBody(opts.folderName ?? 'Order of the Flame'),
        });
    }
    for (const e of seqs) {
        report.sequencesIn++;
        let seq: PcSequence;
        try {
            seq = parsePcSequence(e.id, e.sub, (await pc.read(e)).data);
        } catch (err) {
            report.warnings.push(`sequence ${e.id} skipped: ${(err as Error).message}`);
            continue;
        }
        const out = convertSequence(seq, opts, report);
        const newId = allocateId(opts.usedIds);
        entries.push({ type: SSD_SEQUENCE, id: newId, sub: folder!, data: out });
        idMap.set(((pcDb << 16) | e.id) >>> 0, ((ps2Db << 16) | newId) >>> 0);
        report.sequencesOut++;
    }
    return { entries, idMap, report };
}

/** Convert one parsed sequence to PS2 0x0311 bytes (counters go to `report`). */
export function convertSequence(seq: PcSequence, opts: SequenceConvertOptions, report: SequenceReport): Uint8Array {
    const actors: SsdActor[] = [];
    for (const a of seq.actors) {
        report.actorsIn++;
        report.actionsIn += a.actions.length;
        const o = convertActor(a, opts, report);
        if (o.actor) {
            actors.push(o.actor);
            report.actorsOut++;
            report.actionsOut += o.actor.actionCount;
        } else bump(report.droppedActors, a.name);
    }
    const slots = actors.reduce((m, a) => Math.max(m, a.slot + 1), 1);
    const s: SsdSequence = {
        id: 0,
        folder: 0,
        name: seq.name,
        nameLen: 0,
        length: seq.flags,
        unknown1: seq.modifyRunState,
        slots,
        actors,
    };
    return writeSequence(s);
}

function resolveObject(
    a: PcSeqActor,
    opts: SequenceConvertOptions,
): { ref: number; special: 'rynn' | 'dragon' | 'camera' | null } | null {
    const special = RYNN_RE.test(a.name)
        ? 'rynn'
        : DRAGON_RE.test(a.name)
          ? 'dragon'
          : CAMERA_RE.test(a.name)
            ? 'camera'
            : null;
    const mapped = a.actorType === 1 ? opts.maps.objectIdMap.get(a.objectId) : undefined;
    if (mapped !== undefined) return { ref: mapped, special };
    const fallback =
        special === 'rynn'
            ? opts.playerObjectId
            : special === 'dragon'
              ? opts.dragonObjectId
              : special === 'camera'
                ? opts.cameraObjectId
                : undefined;
    return fallback === undefined ? null : { ref: fallback, special };
}

function convertActor(a: PcSeqActor, opts: SequenceConvertOptions, report: SequenceReport): ActorOutcome {
    const target = resolveObject(a, opts);
    if (!target) return { actor: null };
    const chunks: Uint8Array[] = [];
    const sorted = a.actions.map((x, i) => ({ x, i })).sort((p, q) => p.x.time - q.x.time || p.i - q.i);
    const isCamera = target.special === 'camera';
    if (isCamera) {
        // PS2-only camera setup (type 9: f32 1.0, u32 field of view); PC sequences carry no field of view.
        const c = pcBytes(9, 0, 8);
        view(c).setFloat32(6, 1, true);
        view(c).setUint32(10, opts.cameraFov ?? 40, true);
        const first = sorted[0];
        // the PS2 camera actors start with the run/stop action (5) and then the setup, both at t = 0
        if (first && first.x.type === 5 && first.x.time === 0) {
            chunks.push(convertAction(first.x, opts, report)!);
            sorted.shift();
        }
        chunks.push(c);
    }
    for (const { x } of sorted) {
        const b = convertAction(x, opts, report);
        if (b) chunks.push(b);
    }
    const j = joinActions(chunks);
    const mode = opts.actorMode?.(a) ?? (target.special === 'rynn' || target.special === 'dragon' ? 1 : 0);
    const actor: SsdActor = {
        name: a.name,
        slot: a.id,
        ref: target.ref,
        mode,
        nameLen: 0,
        actionCount: j.actionCount,
        actions: j.actions,
        keys: [],
    };
    return { actor };
}

const lookup = (m: RefLookup | undefined, k: number): number | undefined => m?.get(k >>> 0);

/** One PC action -> PS2 bytes, or null when a referenced resource has no PS2 counterpart. */
export function convertAction(x: PcAction, opts: SequenceConvertOptions, report: SequenceReport): Uint8Array | null {
    const p = view(x.payload);
    const drop = (kind: string): null => (bump(report.droppedActions, kind), null);
    switch (x.type) {
        case 0: {
            // quat(16) pos(12) relativeActor(4) options(4) -> same bytes, then scale 1,1,1 (PS2 has 12 more bytes)
            const out = pcBytes(0, x.time, 48);
            out.set(x.payload, 6);
            const dv = view(out);
            for (const at of [42, 46, 50]) dv.setFloat32(at, 1, true);
            return out;
        }
        case 1: {
            // channel, ref, begin, transition, speed, flags: the PS2 action is the same six words
            const ref = lookup(opts.maps.animMap, p.getUint32(4, true));
            if (ref === undefined) return drop('animation');
            const out = pcBytes(1, x.time, 24);
            out.set(x.payload, 6);
            view(out).setUint32(10, ref >>> 0, true);
            return out;
        }
        case 3: {
            // PC: ref, f32 duration, u16 volume, u16 flags -> PS2: ref, u32 (volume | flags << 16); the duration is dropped
            const ref = lookup(opts.maps.soundMap, p.getUint32(0, true));
            if (ref === undefined) return drop('sound');
            const out = pcBytes(3, x.time, 8);
            const dv = view(out);
            dv.setUint32(6, ref >>> 0, true);
            dv.setUint16(10, p.getUint16(8, true), true);
            dv.setUint16(12, p.getUint16(10, true), true);
            return out;
        }
        case 4: {
            const out = pcBytes(4, x.time, 8);
            out.set(x.payload, 6);
            return out;
        }
        case 5: {
            const out = pcBytes(5, x.time, 4);
            view(out).setUint32(6, opts.keepAiResume ? p.getUint32(0, true) : 0, true);
            return out;
        }
        case 6: {
            const out = pcBytes(6, x.time, 4);
            out.set(x.payload, 6);
            return out;
        }
        case 7: {
            const code = p.getUint32(0, true);
            if (code !== 0 && code < 4096 && opts.smallMessages === 'drop') return drop('message');
            if (code !== 0 && !KNOWN_PS2_MESSAGES.has(code)) bump(report.unverifiedMessages, code);
            const out = pcBytes(7, x.time, 8);
            out.set(x.payload, 6);
            return out;
        }
        case 8: {
            // music: PC (musicId, dlsId, fadeIn, fadeOut) -> PS2 (ref, 0, fadeIn, fadeOut, 0, 0, 1). Stop (id 0) -> (0, 1, ...).
            const id = p.getUint32(0, true);
            const stop = id === 0;
            const ref = stop ? 0 : lookup(opts.maps.musicMap, id);
            if (ref === undefined) return drop('music');
            const out = pcBytes(8, x.time, 28);
            const dv = view(out);
            dv.setUint32(6, ref >>> 0, true);
            dv.setUint32(10, stop ? 1 : 0, true);
            dv.setFloat32(14, p.getFloat32(8, true), true);
            dv.setFloat32(18, p.getFloat32(12, true), true);
            dv.setUint32(30, 1, true);
            return out;
        }
        default:
            return drop(`type${x.type}`);
    }
}

/** Message numbers that occur in the PAL disc's 202 sequences (journal ootf-sequences.md); others are passed through. */
export const KNOWN_PS2_MESSAGES: ReadonlySet<number> = new Set([
    0, 1259, 4096, 4097, 4098, 4133, 4139, 4162, 4257, 4258, 4259, 4263, 4264, 4308,
]);

/** Sequence-engine message numbers (same on PC and PS2 for the values that occur in both). */
export const SEQUENCE_MESSAGES = {
    on: 4097,
    off: 4098,
    triggered: 4103,
    playSequence: 4257,
    blowUp: 4259,
    lock: 4353,
    unlock: 4354,
} as const;

// ---------------------------------------------------------------------------------------------------------------
// Shipping and object parameters.

/** Mod-pack path of one new SSD entry: `new/<FILE>/<type hex>_<id>_<sub>.bin` (docs/reference/modding.md). */
export function ssdEntryPath(file: string, e: Pick<Ps2SsdEntry, 'type' | 'id' | 'sub'>): string {
    return `new/${file}/${e.type.toString(16).padStart(4, '0')}_${e.id}_${e.sub}.bin`;
}

/** Pack files for a conversion: `file` is the target container (`LEVEL1ON.SSD`), the stem the Stomp Player class resolves. */
export function ssdPackFiles(file: string, entries: readonly Ps2SsdEntry[]): Record<string, Uint8Array> {
    const out: Record<string, Uint8Array> = {};
    for (const e of entries) out[ssdEntryPath(file, e)] = e.data;
    return out;
}

/**
 * Rewrite a `Sequence List` (type 0x100b) or single sequence (0x0b) parameter value from PC refs to PS2 refs. Unmapped
 * elements are dropped from arrays and become 0 for scalars; `dropped` counts them.
 */
export function remapSequenceRefs(
    value: number | readonly number[],
    idMap: ReadonlyMap<number, number>,
    dropped?: { count: number },
): number | number[] {
    const one = (v: number): number | undefined => {
        const r = idMap.get(v >>> 0);
        if (r === undefined && dropped) dropped.count++;
        return r;
    };
    if (typeof value === 'number') return one(value) ?? 0;
    return value.map(one).filter((v): v is number => v !== undefined);
}
