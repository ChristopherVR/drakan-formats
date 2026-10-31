// Cut scenes: the "Stomp Player" object (runtime class 0x10033) plays the sequences (.SSD 0x311) of its `Sequence List`.
// Placed players carry the list as object parameters (`Sequence List` = sequence ids of the level's own SSD, e.g. [1354]
// or [421, 1022]); the class defaults (Initial State 0/1, Message To Play Next 4) rarely differ.
// Evidence and the proven / inferred split: docs/reference/level-format.md "Cut scenes, conversations and sequences".
// Proven: the sequence id in `Sequence List` is the SRSC id of a 0x311 record of `<level>.SSD` (checked for every placed
// player of LEVEL1NA, 18 of 18). Inferred: `Initial State` 1 = starts at level load, `List Play Order` 0 = in order.

import { messageName } from '../logic.ts';
import type { SsdActor, SsdSequence } from './ssd.ts';
import { actionField, parseActions, type SsdAction } from './ssdactions.ts';

export interface StompPlayerParams {
    sequences: number[];
    playOrder: number;
    initialState: number;
    messageToPlayNext: number;
}

/** Player parameters from an instance's field values by name (`Sequence List` etc.), class defaults filling the gaps. */
export function stompPlayerFromFields(
    fields: ReadonlyMap<string, number | number[]>,
    dflt: Partial<StompPlayerParams> = {},
): StompPlayerParams {
    const list = fields.get('Sequence List');
    const num = (name: string, d: number): number => {
        const v = fields.get(name);
        return typeof v === 'number' ? v : d;
    };
    return {
        sequences: Array.isArray(list) ? list.map((v) => v & 0xffff) : (dflt.sequences ?? []),
        playOrder: num('List Play Order', dflt.playOrder ?? 0),
        initialState: num('Initial State', dflt.initialState ?? 0),
        messageToPlayNext: num('Message To Play Next', dflt.messageToPlayNext ?? 4),
    };
}

export const isCameraActor = (a: Pick<SsdActor, 'name'>): boolean => /^camera$/i.test(a.name.trim());

/** Last action time of a sequence in seconds (0 for an empty one). */
export function sequenceDuration(seq: SsdSequence): number {
    let end = 0;
    for (const a of seq.actors) {
        const list = parseActions(a);
        if (list) for (const x of list) end = Math.max(end, x.time);
    }
    return end;
}

export interface PathKey {
    time: number;
    pos: [number, number, number];
    quat: [number, number, number, number];
}

/** Transform keyframes of one actor in time order (types 0; a hold marker carries no pose). */
export function actorPath(actor: SsdActor): PathKey[] {
    const list = parseActions(actor) ?? [];
    const out: PathKey[] = [];
    for (const x of list) {
        if (x.kind !== 'transform') continue;
        out.push({
            time: x.time,
            pos: [actionField(x, 'x'), actionField(x, 'y'), actionField(x, 'z')],
            quat: [actionField(x, 'qx'), actionField(x, 'qy'), actionField(x, 'qz'), actionField(x, 'qw')],
        });
    }
    return out;
}

/** The camera actor's path (the actor named `Camera`), or the first actor with a path when none has that name. */
export function cameraPath(seq: SsdSequence): { actor: SsdActor | null; keys: PathKey[] } {
    const cam = seq.actors.find(isCameraActor);
    if (cam) return { actor: cam, keys: actorPath(cam) };
    for (const a of seq.actors) {
        const keys = actorPath(a);
        if (keys.length) return { actor: a, keys };
    }
    return { actor: null, keys: [] };
}

function slerp(a: PathKey['quat'], b: PathKey['quat'], t: number): PathKey['quat'] {
    let dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
    const s = dot < 0 ? -1 : 1;
    dot *= s;
    let ka: number;
    let kb: number;
    if (dot > 0.9995) {
        ka = 1 - t;
        kb = t * s;
    } else {
        const th = Math.acos(dot);
        const sn = Math.sin(th);
        ka = Math.sin((1 - t) * th) / sn;
        kb = (Math.sin(t * th) / sn) * s;
    }
    const q: [number, number, number, number] = [
        a[0] * ka + b[0] * kb,
        a[1] * ka + b[1] * kb,
        a[2] * ka + b[2] * kb,
        a[3] * ka + b[3] * kb,
    ];
    const n = Math.hypot(...q) || 1;
    return [q[0] / n, q[1] / n, q[2] / n, q[3] / n];
}

/** Linear position, spherical rotation between keyframes (the engine's interpolation is not decoded; inferred). */
export function samplePath(keys: readonly PathKey[], t: number): PathKey | null {
    if (keys.length === 0) return null;
    if (t <= keys[0]!.time) return keys[0]!;
    const last = keys[keys.length - 1]!;
    if (t >= last.time) return last;
    let i = 1;
    while (keys[i]!.time < t) i++;
    const a = keys[i - 1]!;
    const b = keys[i]!;
    const k = b.time === a.time ? 0 : (t - a.time) / (b.time - a.time);
    return {
        time: t,
        pos: [0, 1, 2].map((j) => a.pos[j]! + (b.pos[j]! - a.pos[j]!) * k) as PathKey['pos'],
        quat: slerp(a.quat, b.quat, k),
    };
}

export interface SoundCue {
    time: number;
    actor: string;
    /** `(db << 16) | id` as stored. */
    ref: number;
    /** The action in the actor's list (for editing). */
    action: SsdAction;
    actorIndex: number;
}

export function soundCues(seq: SsdSequence): SoundCue[] {
    const out: SoundCue[] = [];
    seq.actors.forEach((a, actorIndex) => {
        for (const x of parseActions(a) ?? [])
            if (x.kind === 'sound')
                out.push({ time: x.time, actor: a.name, ref: actionField(x, 'sound'), action: x, actorIndex });
    });
    return out.sort((p, q) => p.time - q.time);
}

export interface MessageCue {
    time: number;
    actor: string;
    message: number;
    param: number;
    action: SsdAction;
    actorIndex: number;
}

export function messageCues(seq: SsdSequence): MessageCue[] {
    const out: MessageCue[] = [];
    seq.actors.forEach((a, actorIndex) => {
        for (const x of parseActions(a) ?? [])
            if (x.kind === 'message')
                out.push({
                    time: x.time,
                    actor: a.name,
                    message: actionField(x, 'message'),
                    param: actionField(x, 'param'),
                    action: x,
                    actorIndex,
                });
    });
    return out.sort((p, q) => p.time - q.time);
}

/**
 * Name of a sequence message number. Inferred: values 0x1000 + n (4097, 4098, ...) are the object message enum of
 * logic.ts (4097 = `On`); 4257 is `Play Sequence` in the OotF STOMP list (not checked on the PS2 build); 4259 / 4263 and the
 * other numbers of the disc are unnamed.
 */
export function describeMessage(n: number): string {
    if (n === 4257) return 'Play sequence (4257)';
    if (n >= 0x1000 && n < 0x1000 + 40) return `${messageName(n - 0x1000)} (${n})`;
    return `Message ${n}`;
}
