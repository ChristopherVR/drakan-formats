// The actions of a sequence actor (`SsdActor.actions`). Proven on the PAL disc: every actor of every English .SSD (1188 of
// them, all 202 sequences of 14 files) is consumed exactly by this grammar, `actionCount` actions, no byte left over:
//
//   u16 type, f32 time (seconds from the start of the sequence), then a payload that depends on the type
//   type 0  transform keyframe  54 bytes   quat xyzw (4 f32), position (3 f32), 8 bytes (zero), scale (3 f32)
//   type 1  animation           30 bytes   u32 mode, u32 animation id, u32 0, f32 offset, f32 speed, u32 flags
//   type 3  sound               14 bytes   u32 sound ref (db << 16 | id), u32 params (low 16 = 10000 volume-like)
//   type 4  (unknown)           14 bytes   u32 a, u32 b (b equals the animation `flags` of a nearby type 1)
//   type 5  marker              10 bytes   u32 0 (347 of 347 on the disc)
//   type 6  (unknown)           10 bytes   u32 0 or 1
//   type 9  camera setup        14 bytes   f32 (1.0 on all) and u32 (40, 50, 55 seen: field of view?); first action of camera actors
//   type 8  (unknown)           34 bytes   u32, u32, 4 x f32 (3.0 3.0 seen), u32 1; 9 on the disc, in camera actors
//   type 10 hold                6 bytes    nothing after the time (51 on the disc, always followed by a type 0 or 9 at the same time)
//   type 7  message             14 bytes   u32 message number (4097 / 4098 on / off, 4259, 4263, 4257 play sequence...), u32 param
//
// Proven: sizes, the time at +2 (ascending inside an actor), the sound ref (resolves to the subtitled speech of the level's
// SDB in 600+ cases, see story-editing.md), the transform layout (positions land inside the level, quaternions are unit
// length). Inferred: the names of types 1, 4, 5, 6 and 7 and the animation / message fields.

import { view } from '../bytes.ts';
import type { SsdActor } from './ssd.ts';

export type ActionFieldKind = 'f32' | 'u32';

export interface ActionField {
    name: string;
    /** Byte offset inside the action. */
    at: number;
    kind: ActionFieldKind;
    value: number;
}

export type ActionKind =
    'transform' | 'animation' | 'sound' | 'type4' | 'marker' | 'type6' | 'message' | 'camera' | 'type8' | 'hold';

export interface SsdAction {
    type: number;
    kind: ActionKind;
    time: number;
    /** Byte offset inside the actor's action bytes. */
    offset: number;
    size: number;
    fields: ActionField[];
}

interface TypeInfo {
    kind: ActionKind;
    size: number;
    fields: [string, number, ActionFieldKind][];
}

export const ACTION_TYPES: Readonly<Record<number, TypeInfo>> = {
    0: {
        kind: 'transform',
        size: 54,
        fields: [
            ['qx', 6, 'f32'],
            ['qy', 10, 'f32'],
            ['qz', 14, 'f32'],
            ['qw', 18, 'f32'],
            ['x', 22, 'f32'],
            ['y', 26, 'f32'],
            ['z', 30, 'f32'],
            ['sx', 42, 'f32'],
            ['sy', 46, 'f32'],
            ['sz', 50, 'f32'],
        ],
    },
    1: {
        kind: 'animation',
        size: 30,
        fields: [
            ['mode', 6, 'u32'],
            ['animation', 10, 'u32'],
            ['offset', 18, 'f32'],
            ['speed', 22, 'f32'],
            ['flags', 26, 'u32'],
        ],
    },
    3: {
        kind: 'sound',
        size: 14,
        fields: [
            ['sound', 6, 'u32'],
            ['params', 10, 'u32'],
        ],
    },
    4: {
        kind: 'type4',
        size: 14,
        fields: [
            ['a', 6, 'u32'],
            ['b', 10, 'u32'],
        ],
    },
    5: { kind: 'marker', size: 10, fields: [['value', 6, 'u32']] },
    6: { kind: 'type6', size: 10, fields: [['value', 6, 'u32']] },
    8: {
        kind: 'type8',
        size: 34,
        fields: [
            ['a', 6, 'u32'],
            ['b', 10, 'u32'],
            ['c', 14, 'f32'],
            ['d', 18, 'f32'],
            ['e', 22, 'f32'],
            ['f', 26, 'f32'],
            ['g', 30, 'u32'],
        ],
    },
    10: { kind: 'hold', size: 6, fields: [] },
    9: {
        kind: 'camera',
        size: 14,
        fields: [
            ['a', 6, 'f32'],
            ['b', 10, 'u32'],
        ],
    },
    7: {
        kind: 'message',
        size: 14,
        fields: [
            ['message', 6, 'u32'],
            ['param', 10, 'u32'],
        ],
    },
};

/** Split an actor's action bytes into typed actions; null when the bytes do not follow the grammar. */
export function parseActions(a: Pick<SsdActor, 'actions' | 'actionCount'>): SsdAction[] | null {
    const b = a.actions;
    const dv = view(b);
    const out: SsdAction[] = [];
    let p = 0;
    for (let i = 0; i < a.actionCount; i++) {
        if (p + 6 > b.length) return null;
        const type = dv.getUint16(p, true);
        const info = ACTION_TYPES[type];
        if (!info || p + info.size > b.length) return null;
        out.push({
            type,
            kind: info.kind,
            time: dv.getFloat32(p + 2, true),
            offset: p,
            size: info.size,
            fields: info.fields.map(([name, at, kind]) => ({
                name,
                at,
                kind,
                value: kind === 'f32' ? dv.getFloat32(p + at, true) : dv.getUint32(p + at, true),
            })),
        });
        p += info.size;
    }
    return p === b.length ? out : null;
}

export const actionField = (a: SsdAction, name: string): number => a.fields.find((f) => f.name === name)?.value ?? 0;

/** Copy of the actor's action bytes with one field of one action replaced. */
export function setActionField(actor: SsdActor, action: SsdAction, name: string, value: number): Uint8Array {
    const f = action.fields.find((x) => x.name === name);
    if (!f) throw new Error(`action type ${action.type} has no field ${name}`);
    const out = actor.actions.slice();
    const dv = view(out);
    if (f.kind === 'f32') dv.setFloat32(action.offset + f.at, value, true);
    else dv.setUint32(action.offset + f.at, value >>> 0, true);
    return out;
}

/** Copy of the action bytes with the time of one action changed. */
export function setActionTime(actor: SsdActor, action: SsdAction, time: number): Uint8Array {
    const out = actor.actions.slice();
    view(out).setFloat32(action.offset + 2, time, true);
    return out;
}

/** A fresh action of `type` at `time`; `values` set payload fields by name. Other payload bytes are zero (scale 1). */
export function newActionBytes(type: number, time: number, values: Record<string, number> = {}): Uint8Array {
    const info = ACTION_TYPES[type];
    if (!info) throw new Error(`unknown action type ${type}`);
    const out = new Uint8Array(info.size);
    const dv = view(out);
    dv.setUint16(0, type, true);
    dv.setFloat32(2, time, true);
    if (type === 0) {
        dv.setFloat32(18, 1, true); // identity quaternion w
        for (const at of [42, 46, 50]) dv.setFloat32(at, 1, true);
    }
    if (type === 1) dv.setFloat32(22, 1, true);
    for (const [name, v] of Object.entries(values)) {
        const f = info.fields.find(([n]) => n === name);
        if (!f) throw new Error(`action type ${type} has no field ${name}`);
        if (f[2] === 'f32') dv.setFloat32(f[1], v, true);
        else dv.setUint32(f[1], v >>> 0, true);
    }
    return out;
}

/** Replace the action list of an actor (actions in time order); returns the actor fields to store. */
export function joinActions(chunks: readonly Uint8Array[]): { actions: Uint8Array; actionCount: number } {
    const total = chunks.reduce((s, c) => s + c.length, 0);
    const actions = new Uint8Array(total);
    let o = 0;
    for (const c of chunks) {
        actions.set(c, o);
        o += c.length;
    }
    return { actions, actionCount: chunks.length };
}

/** Insert an action at its time position (after equal times), returning the new action bytes and count. */
export function insertAction(actor: SsdActor, bytes: Uint8Array): { actions: Uint8Array; actionCount: number } {
    const list = parseActions(actor) ?? [];
    const time = view(bytes).getFloat32(2, true);
    const chunks = list.map((a) => actor.actions.subarray(a.offset, a.offset + a.size));
    let at = list.length;
    for (let i = 0; i < list.length; i++)
        if (list[i]!.time > time) {
            at = i;
            break;
        }
    chunks.splice(at, 0, bytes);
    return joinActions(chunks);
}

export function removeAction(actor: SsdActor, index: number): { actions: Uint8Array; actionCount: number } {
    const list = parseActions(actor) ?? [];
    const chunks = list.filter((_, i) => i !== index).map((a) => actor.actions.subarray(a.offset, a.offset + a.size));
    return joinActions(chunks);
}
