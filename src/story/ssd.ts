// `.SSD` cut scene sequences ("STOMP"), SRSC type 0x311 (record), 0x312 (folder names), 0x310 (file header).
// Evidence and the proven / inferred split: docs/reference/level-format.md "Cut scenes, conversations and sequences".
//
// Proven (every 0x311 record of the PAL disc parses, see story-editing.md): record = `u16 length + name`, four u32
// header words, then `actors` actor records. An actor is `u16 length + name`, u32 slot, u32 ref, u32 0, u32
// actionCount, then the action bytes. Inferred: header word 0 is the length (60 = the default of an empty sequence),
// word 2 is the highest slot + 1, word 3 the actor count. Not decoded: the action grammar. The actions are kept as
// opaque bytes (the action count is exact; the next actor is found by scanning for its header), so a rewrite is
// byte-exact apart from the fields above.

import { latin1, view } from '../bytes.ts';

export const SSD_FILE_HEADER = 0x310;
export const SSD_FOLDER = 0x312;

export interface SsdActor {
    name: string;
    /** Slot number, 1-based, ascending inside the sequence. */
    slot: number;
    /** Level object id (large) or class id (Rynn / Camera, ~900); inferred. */
    ref: number;
    /** The u32 between `ref` and the action count: 0 on most actors, 1 and 7 seen on others (meaning unknown). */
    mode: number;
    /** The name field's stored length, so that a rewrite keeps the disc padding. */
    nameLen: number;
    actionCount: number;
    /** The action bytes up to the next actor, opaque. */
    actions: Uint8Array;
    /** Camera / actor keyframes found by scanning `actions` (inferred). */
    keys: SsdKey[];
}

/** A keyframe-looking block: unit quaternion (x y z w) followed by a position (inferred from the data). */
export interface SsdKey {
    /** Byte offset in `actions`. */
    offset: number;
    quat: [number, number, number, number];
    pos: [number, number, number];
}

export interface SsdSequence {
    id: number;
    /** SRSC sub: id of the 0x312 folder the sequence is listed in. */
    folder: number;
    name: string;
    nameLen: number;
    /** Header word 0: 60 for an empty one, up to a few hundred for scenes (inferred: length). */
    length: number;
    unknown1: number;
    slots: number;
    actors: SsdActor[];
}

function readName(b: Uint8Array, at: number): { name: string; end: number; len: number } | null {
    if (at + 2 > b.length) return null;
    const n = view(b).getUint16(at, true);
    if (n < 1 || n > 96 || at + 2 + n > b.length) return null;
    const raw = b.subarray(at + 2, at + 2 + n);
    let z = raw.indexOf(0);
    if (z < 0) z = raw.length;
    for (let i = 0; i < z; i++) if (raw[i]! < 0x20 || raw[i]! > 0x7e) return null;
    for (let i = z; i < raw.length; i++) if (raw[i] !== 0) return null;
    return { name: latin1(raw, 0, z), end: at + 2 + n, len: n };
}

/** An actor record header at `at`: name, slot, ref, 0, count. */
function actorHeader(b: Uint8Array, at: number, maxSlot: number): { a: SsdActor; end: number } | null {
    const nm = readName(b, at);
    if (!nm || nm.name === '' || nm.end + 16 > b.length) return null;
    const dv = view(b);
    const slot = dv.getUint32(nm.end, true);
    const count = dv.getUint32(nm.end + 12, true);
    if (slot < 1 || slot >= maxSlot || dv.getUint32(nm.end + 8, true) > 0xffff || count > 4096) return null;
    return {
        a: {
            name: nm.name,
            slot,
            ref: dv.getUint32(nm.end + 4, true),
            mode: dv.getUint32(nm.end + 8, true),
            nameLen: nm.len,
            actionCount: count,
            actions: new Uint8Array(0),
            keys: [],
        },
        end: nm.end + 16,
    };
}

/** Unit-quaternion + large-position blocks in an action byte run (inferred keyframes). */
export function scanKeys(b: Uint8Array): SsdKey[] {
    const out: SsdKey[] = [];
    const dv = view(b);
    for (let o = 0; o + 28 <= b.length; o++) {
        const q = [0, 1, 2, 3].map((i) => dv.getFloat32(o + i * 4, true));
        if (!(Math.abs(Math.hypot(q[0]!, q[1]!, q[2]!, q[3]!) - 1) < 0.01)) continue;
        const p = [0, 1, 2].map((i) => dv.getFloat32(o + 16 + i * 4, true));
        if (!p.every((v) => Number.isFinite(v) && Math.abs(v) > 1000 && Math.abs(v) < 2e7)) continue;
        out.push({ offset: o, quat: q as SsdKey['quat'], pos: p as SsdKey['pos'] });
        o += 27;
    }
    return out;
}

/** Parse one 0x311 record; null when it does not follow the layout (the editor then keeps it as raw bytes). */
export function parseSequence(id: number, folder: number, b: Uint8Array): SsdSequence | null {
    const nm = readName(b, 0);
    if (!nm || nm.end + 16 > b.length) return null;
    const dv = view(b);
    const slots = dv.getUint32(nm.end + 8, true);
    const count = dv.getUint32(nm.end + 12, true);
    const seq: SsdSequence = {
        id,
        folder,
        name: nm.name,
        nameLen: nm.len,
        length: dv.getUint32(nm.end, true),
        unknown1: dv.getUint32(nm.end + 4, true),
        slots,
        actors: [],
    };
    let p = nm.end + 16;
    const heads: { a: SsdActor; start: number; end: number }[] = [];
    for (let i = 0; i < count; i++) {
        let found: { a: SsdActor; end: number } | null = null;
        let at = p;
        if (i === 0) found = actorHeader(b, p, slots + 1);
        else {
            for (at = p; at + 18 <= b.length; at++) {
                const h = actorHeader(b, at, slots + 1);
                if (h && h.a.slot > heads[i - 1]!.a.slot) {
                    found = h;
                    break;
                }
            }
        }
        if (!found) return null;
        if (i > 0) heads[i - 1]!.end = at;
        heads.push({ a: found.a, start: found.end, end: b.length });
        p = found.end;
    }
    if (count === 0 && p !== b.length) return null;
    for (const h of heads) {
        h.a.actions = b.subarray(h.start, h.end);
        h.a.keys = scanKeys(h.a.actions);
        seq.actors.push(h.a);
    }
    return seq;
}

function nameBytes(s: string, len: number): number[] {
    const raw = [...s].map((c) => c.charCodeAt(0) & 0xff);
    // keep the stored length when the (possibly edited) name still fits with a terminator, else pad like the disc
    if (raw.length <= len) while (raw.length < len) raw.push(0);
    else {
        raw.push(0);
        while ((raw.length + 2) % 4) raw.push(0);
    }
    return [raw.length & 255, raw.length >> 8, ...raw];
}

/** Serialise (name padding follows the disc: length + 2 is a multiple of 4 whenever the name has a terminator). */
export function writeSequence(s: SsdSequence): Uint8Array {
    const out: number[] = [...nameBytes(s.name, s.nameLen)];
    const w32 = (v: number): void => void out.push(v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255);
    w32(s.length);
    w32(s.unknown1);
    w32(s.slots);
    w32(s.actors.length);
    for (const a of s.actors) {
        out.push(...nameBytes(a.name, a.nameLen));
        w32(a.slot);
        w32(a.ref);
        w32(a.mode);
        w32(a.actionCount);
        for (const x of a.actions) out.push(x);
    }
    return Uint8Array.from(out);
}

/** Folder record (0x312): `u16 length + name`; the SRSC `sub` is the parent folder id. */
export function parseFolderName(b: Uint8Array): string {
    return readName(b, 0)?.name ?? '';
}

// ---- creating sequences -----------------------------------------------------------------------------------------------

/** A free sequence id above every used one (the runtime resolves `Sequence List` entries by SRSC id). */
export function freeSequenceId(used: ReadonlySet<number>): number {
    let max = 0;
    for (const id of used) max = Math.max(max, id);
    return max + 1;
}

/** Stored name length for a new name: with a terminator, padded so that `2 + length` is a multiple of 4 (disc rule). */
export function sequenceNameLen(name: string): number {
    let n = name.length + 1;
    while ((n + 2) % 4) n++;
    return n;
}

/** An empty sequence (header only, `length` 60 like the disc's empty default) in folder `folder`. */
export function newSequence(id: number, folder: number, name: string, length = 60): SsdSequence {
    return { id, folder, name, nameLen: sequenceNameLen(name), length, unknown1: 0, slots: 1, actors: [] };
}

/** Add an actor with no actions to `seq` (slot = next free, `slots` kept at highest slot + 1); returns it. */
export function addActor(seq: SsdSequence, name: string, ref: number, mode = 0): SsdActor {
    const slot = seq.actors.reduce((m, a) => Math.max(m, a.slot), 0) + 1;
    const a: SsdActor = {
        name,
        slot,
        ref,
        mode,
        nameLen: sequenceNameLen(name),
        actionCount: 0,
        actions: new Uint8Array(0),
        keys: [],
    };
    seq.actors.push(a);
    seq.slots = slot + 1;
    return a;
}
