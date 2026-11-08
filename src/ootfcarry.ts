// Order of the Flame scenes that carry a creature on another creature's channel (Ruined Village scene 1.2a: the Wartok
// skewers a villager on its spear tip and raises him). The PC engine keeps the attached actor's offset to the channel from
// the moment of the attach (he stays where the spear met him); the PS2 engine puts the attached actor's origin ON the
// channel joint and ignores later transform keys, which leaves him hanging at the Wartok's hand beside the body. The
// converter therefore replaces the attach pair by world transform keys: the carried actor moves from where the scene placed
// him to the far end of the weapon the carrier holds (the spear tip, found from the carrier's own skeleton and clip, not from
// a channel number of the PS2 rig) and hangs there. Journal: docs/journal/2026-11-09/ootf-opening-cut-and-impale.md.

import { view } from './bytes.ts';
import { bindBasis, convertPcAnimToPs2 } from './ootfcreature.ts';
import type { PcAnim, Skeleton } from './ootfanim.ts';
import type { PcAction, PcSeqActor, PcSequence } from './ootfseq.ts';
import { sampleClip } from './anim.ts';
import { buildRig, localToWorld, mulMat12, quatToMat12, type Mat12, type Rig } from './skeleton.ts';

/** PC model units to world units (the clips key translations in 1/2048 of a model unit). */
const MODEL_SCALE = 2048;
/** Seconds between the keys that replace an attach. */
const STEP = 0.1;
/** Seconds the carried actor takes to move from his placed pose to the weapon's far end. */
const GRAB = 0.5;
/** Distance of a hanging creature's origin (feet) below the weapon tip. */
const HANG = 650;
const OPT_LINEAR = 0x10;

export interface CarrierRig {
    skeleton: Skeleton;
    anims: Map<number, PcAnim>;
}

export interface CarryOptions {
    /** Skeleton and clips of a scene actor's PC model; undefined for props and actors without a skeleton. */
    rigOf(actor: PcSeqActor): CarrierRig | undefined;
    /** Length of a held prop's model from its origin (grip) to its far end along the model z axis, in world units. */
    propReach(actor: PcSeqActor): number | undefined;
}

const SKIP_NAMES = /^(w?rynn|arokh|aroch|camera)$/i;

function lastBefore(actions: readonly PcAction[], type: number, t: number): PcAction | undefined {
    let best: PcAction | undefined;
    for (const x of actions) if (x.type === type && x.time <= t && (!best || x.time >= best.time)) best = x;
    return best;
}

/** World matrix (row vectors, translation last) of a PC transform action's placement. */
function placement(x: PcAction): Mat12 {
    const dv = view(x.payload);
    const q = [0, 4, 8, 12].map((o) => dv.getFloat32(o, true));
    const r = quatToMat12(q, [0, 0, 0]);
    // The scene quaternion turns model space into world space with the transposed row matrix (checked against the spear
    // tip of the Ruined Village scene: only this convention puts the tip at the villager).
    const m = new Float32Array(12);
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) m[i * 3 + j] = r[j * 3 + i]!;
    for (let c = 0; c < 3; c++) m[9 + c] = dv.getFloat32(16 + c * 4, true);
    return m;
}

function quatFromWorld(m: Mat12): [number, number, number, number] {
    // `m` rows are the textbook rotation matrix of the quaternion (see `placement`).
    const m00 = m[0]!;
    const m01 = m[1]!;
    const m02 = m[2]!;
    const m10 = m[3]!;
    const m11 = m[4]!;
    const m12 = m[5]!;
    const m20 = m[6]!;
    const m21 = m[7]!;
    const m22 = m[8]!;
    const tr = m00 + m11 + m22;
    let q: [number, number, number, number];
    if (tr > 0) {
        const s = Math.sqrt(tr + 1) * 2;
        q = [(m21 - m12) / s, (m02 - m20) / s, (m10 - m01) / s, 0.25 * s];
    } else if (m00 > m11 && m00 > m22) {
        const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
        q = [0.25 * s, (m01 + m10) / s, (m02 + m20) / s, (m21 - m12) / s];
    } else if (m11 > m22) {
        const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
        q = [(m01 + m10) / s, 0.25 * s, (m12 + m21) / s, (m02 - m20) / s];
    } else {
        const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
        q = [(m02 + m20) / s, (m12 + m21) / s, 0.25 * s, (m10 - m01) / s];
    }
    const l = Math.hypot(...q) || 1;
    return [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
}

function transformAction(time: number, m: Mat12): PcAction {
    const payload = new Uint8Array(36);
    const dv = view(payload);
    const q = quatFromWorld(m);
    for (let i = 0; i < 4; i++) dv.setFloat32(i * 4, q[i]!, true);
    for (let c = 0; c < 3; c++) dv.setFloat32(16 + c * 4, m[9 + c]!, true);
    dv.setUint32(28, 0, true);
    dv.setUint32(32, OPT_LINEAR, true);
    return { type: 0, time, payload };
}

/** World matrix of the carrier's joint `joint` at time `t`, or undefined when the scene has not placed it yet. */
function jointWorld(carrier: PcSeqActor, rig: Rig, posed: Map<string, ReturnType<typeof convertPcAnimToPs2>>, rec: CarrierRig, joint: number, t: number): Mat12 | undefined {
    const move = lastBefore(carrier.actions, 0, t);
    if (!move) return undefined;
    let local: Float32Array = new Float32Array(rig.jointCount * 12);
    const clip = lastBefore(carrier.actions.filter((x) => x.type === 1 && view(x.payload).getUint32(0, true) === 0), 1, t);
    const pc = clip ? rec.anims.get(view(clip.payload).getUint32(4, true) & 0xffff) : undefined;
    if (clip && pc) {
        const dv = view(clip.payload);
        const key = `${pc.name}`;
        let ps2 = posed.get(key);
        if (!ps2) {
            ps2 = convertPcAnimToPs2(pc, bindBasis(rig));
            posed.set(key, ps2);
        }
        local = sampleClip(rig, ps2, dv.getFloat32(8, true) + (t - clip.time) * dv.getFloat32(16, true));
    } else {
        for (let j = 0; j < rig.jointCount; j++) local.set(rig.bindLocal.subarray(j * 12, j * 12 + 12), j * 12);
    }
    const w = localToWorld(rig, local);
    const jm = new Float32Array(w.subarray(joint * 12, joint * 12 + 12));
    for (let c = 0; c < 3; c++) jm[9 + c] = jm[9 + c]! * MODEL_SCALE;
    return mulMat12(jm, placement(move));
}

/**
 * Replaces each "attach a skinned creature to a creature's channel" pair of a scene by transform keys of the attached actor
 * (every 0.1 s from the attach to the detach) that keep its pose relative to the channel's joint as it was at the attach.
 * Props (swords, spears: no skeleton) and the player, Arokh and the camera keep the native attach.
 */
export function carryCreatures(seq: PcSequence, opt: CarryOptions): PcSequence {
    const end = seq.actors.reduce((m, a) => a.actions.reduce((n, x) => Math.max(n, x.time), m), 0);
    let actors = seq.actors;
    for (const carrier of seq.actors) {
        if (SKIP_NAMES.test(carrier.name.trim())) continue;
        const rec = opt.rigOf(carrier);
        if (!rec) continue;
        const rig = buildRig(rec.skeleton, 0);
        const posed = new Map<string, ReturnType<typeof convertPcAnimToPs2>>();
        const attaches = carrier.actions.filter((x) => x.type === 4);
        const drop = new Set<PcAction>();
        const adds = new Map<number, PcAction[]>();
        for (const at of attaches) {
            const dv = view(at.payload);
            const slot = dv.getUint32(0, true);
            const channel = dv.getUint32(4, true);
            if (slot === 0) continue;
            const carried = actors.find((a) => a.id === slot);
            if (!carried || SKIP_NAMES.test(carried.name.trim()) || !opt.rigOf(carried)) continue;
            const detach = attaches.find((x) => x.time > at.time && view(x.payload).getUint32(4, true) === channel);
            const t1 = detach?.time ?? end;
            const v = lastBefore(carried.actions, 0, at.time);
            if (!v) continue;
            // The weapon the carrier holds on another channel: its joint and the reach of its model.
            const held = attaches.find((x) => {
                const h = view(x.payload);
                const hs = h.getUint32(0, true);
                if (hs === 0 || hs === slot || x.time > at.time) return false;
                const off = attaches.some((y) => y.time > x.time && y.time <= at.time && view(y.payload).getUint32(4, true) === h.getUint32(4, true));
                const prop = actors.find((a) => a.id === hs);
                return !off && !!prop && opt.propReach(prop) !== undefined;
            });
            const hv = held && view(held.payload);
            const prop = hv && actors.find((a) => a.id === hv.getUint32(0, true));
            const reach = prop && opt.propReach(prop);
            const propJoint = hv && rec.skeleton.channels[hv.getUint32(4, true)]?.joint;
            if (reach === undefined || propJoint === undefined) continue;
            const tipAt = (t: number): [number, number, number] | undefined => {
                const j = jointWorld(carrier, rig, posed, rec, propJoint, t);
                if (!j) return undefined;
                // the prop's far end lies on the joint's negative z axis (checked against the Ruined Village spear)
                return [j[9]! - j[6]! * reach, j[10]! - j[7]! * reach - HANG, j[11]! - j[8]! * reach];
            };
            const start = view(v.payload);
            const from: [number, number, number] = [start.getFloat32(16, true), start.getFloat32(20, true), start.getFloat32(24, true)];
            const keys: PcAction[] = [];
            const at0 = (t: number): Mat12 | undefined => {
                const tip = tipAt(t);
                if (!tip) return undefined;
                const f = Math.min(1, (t - at.time) / GRAB);
                const m = placement(v);
                for (let c = 0; c < 3; c++) m[9 + c] = from[c]! + (tip[c]! - from[c]!) * f;
                return m;
            };
            for (let t = at.time; t < t1 - 1e-6; t += STEP) {
                const m = at0(t);
                if (m) keys.push(transformAction(t, m));
            }
            const ml = at0(t1);
            if (ml) keys.push(transformAction(t1, ml));
            drop.add(at);
            if (detach) drop.add(detach);
            adds.set(carried.id, [...(adds.get(carried.id) ?? []), ...keys]);
        }
        if (drop.size === 0) continue;
        actors = actors.map((a) => {
            if (a === carrier) return { ...a, actions: a.actions.filter((x) => !drop.has(x)) };
            const extra = adds.get(a.id);
            return extra ? { ...a, actions: [...a.actions, ...extra] } : a;
        });
    }
    return actors === seq.actors ? seq : { ...seq, actors };
}
