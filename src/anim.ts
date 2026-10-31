import { type Ps2Anim, parsePs2Anim } from './ootfanim.ts';
import { type Rig, quatToMat12 } from './skeleton.ts';

/**
 * Playback of PS2 ADB animations (0x0501 header, 0x0502 per-joint key tracks; container codec `parsePs2Anim`).
 * Semantics, proven by `editor/scripts/anim-probe.ts` against the PAL disc (docs/reference/level-format.md 11b):
 *
 *  - Time is in seconds, `0 .. duration`; keys carry their own time (key reduced, so spacing is irregular).
 *    The "frames" word of the 0x0501 header is the track count (one track per joint), not a frame count.
 *  - Rotation keys are absolute parent-relative quaternions (x y z w, row-vector matrix = transpose of the textbook one).
 *  - Translation: a track flagged 0x80000000 keys it (32-byte keys); every other track uses the constant `base`, which
 *    equals the joint's local bind translation. The root joint's keyed translation is the model's motion (root motion).
 *  - Header flag bit 0 = does not loop.
 */

export type { Ps2Anim } from './ootfanim.ts';

export function parseClip(info: Uint8Array, data: Uint8Array): Ps2Anim {
    return parsePs2Anim(info, data);
}

/** True when the clip has one track per joint of the rig (the engine pairs clips with models by joint count). */
export const clipFitsRig = (rig: Rig, a: Ps2Anim): boolean => a.tracks.length === rig.jointCount;

export const clipLoops = (a: Ps2Anim): boolean => (a.flags & 1) === 0;

/** Map a playback time to the clip: wraps looping clips, clamps the others. */
export function clipTime(a: Ps2Anim, t: number): number {
    if (a.duration <= 0) return 0;
    if (clipLoops(a)) return ((t % a.duration) + a.duration) % a.duration;
    return Math.min(Math.max(t, 0), a.duration);
}

const q = new Float32Array(4);
const pos = new Float32Array(3);

/** Rotation and translation of track `j` at time `t`: written into the module scratch `q` and `pos`. */
function sampleTrack(a: Ps2Anim, rig: Rig, j: number, t: number): void {
    const tr = a.tracks[j];
    const bind = rig.bindLocal;
    if (!tr || tr.keys.length === 0) {
        // No data: rest pose of that joint.
        q.set([0, 0, 0, 1]);
        pos[0] = bind[j * 12 + 9]!;
        pos[1] = bind[j * 12 + 10]!;
        pos[2] = bind[j * 12 + 11]!;
        return;
    }
    const keys = tr.keys;
    const n = keys.length;
    let i = 0;
    if (n > 1) {
        let lo = 0;
        let hi = n - 1;
        while (lo < hi) {
            const mid = (lo + hi + 1) >> 1;
            if (keys[mid]!.time <= t) lo = mid;
            else hi = mid - 1;
        }
        i = lo;
    }
    const k0 = keys[i]!;
    const k1 = keys[Math.min(i + 1, n - 1)]!;
    const span = k1.time - k0.time;
    const f = span > 1e-9 ? Math.min(Math.max((t - k0.time) / span, 0), 1) : 0;
    // nlerp with the shortest arc (the keys are dense enough for this to match slerp)
    const dot = k0.q[0] * k1.q[0] + k0.q[1] * k1.q[1] + k0.q[2] * k1.q[2] + k0.q[3] * k1.q[3];
    const s = dot < 0 ? -1 : 1;
    let x = k0.q[0] + (s * k1.q[0] - k0.q[0]) * f;
    let y = k0.q[1] + (s * k1.q[1] - k0.q[1]) * f;
    let z = k0.q[2] + (s * k1.q[2] - k0.q[2]) * f;
    let w = k0.q[3] + (s * k1.q[3] - k0.q[3]) * f;
    const l = Math.hypot(x, y, z, w) || 1;
    x /= l;
    y /= l;
    z /= l;
    w /= l;
    q[0] = x;
    q[1] = y;
    q[2] = z;
    q[3] = w;
    if (tr.hasPos && k0.pos && k1.pos) {
        pos[0] = k0.pos[0] + (k1.pos[0] - k0.pos[0]) * f;
        pos[1] = k0.pos[1] + (k1.pos[1] - k0.pos[1]) * f;
        pos[2] = k0.pos[2] + (k1.pos[2] - k0.pos[2]) * f;
    } else {
        pos[0] = tr.base[0];
        pos[1] = tr.base[1];
        pos[2] = tr.base[2];
    }
}

export interface PoseOptions {
    /** Drop the root joint's keyed translation (play in place). */
    inPlace?: boolean;
}

/** Local matrices (12 floats per joint) of a clip at time `t` seconds; `t` is wrapped or clamped by `clipTime`. */
export function sampleClip(
    rig: Rig,
    a: Ps2Anim,
    t: number,
    opt: PoseOptions = {},
    out: Float32Array = new Float32Array(rig.jointCount * 12),
): Float32Array {
    const tt = clipTime(a, t);
    const m = new Float32Array(12);
    for (let j = 0; j < rig.jointCount; j++) {
        sampleTrack(a, rig, j, tt);
        if (opt.inPlace && rig.parents[j] === -1) {
            const first = a.tracks[j]?.keys[0]?.pos;
            if (first) {
                pos[0] = pos[0]! - first[0];
                pos[1] = pos[1]! - first[1];
                pos[2] = pos[2]! - first[2];
            }
        }
        quatToMat12(q, pos, m);
        out.set(m, j * 12);
    }
    return out;
}

/** The rest pose (every joint at its bind transform). */
export function restPose(rig: Rig): Float32Array {
    return Float32Array.from(rig.bindLocal);
}

/** Net displacement of the root joint over one pass of the clip (model units), plus the first and last position. */
export function rootMotion(
    a: Ps2Anim,
    rig: Rig,
): { start: [number, number, number]; end: [number, number, number]; delta: [number, number, number] } {
    let root = rig.parents.indexOf(-1);
    if (root < 0) root = 0;
    const tr = a.tracks[root];
    const b: [number, number, number] = [
        rig.bindLocal[root * 12 + 9]!,
        rig.bindLocal[root * 12 + 10]!,
        rig.bindLocal[root * 12 + 11]!,
    ];
    if (!tr || !tr.hasPos || tr.keys.length === 0) return { start: b, end: b, delta: [0, 0, 0] };
    const s = tr.keys[0]!.pos!;
    const e = tr.keys[tr.keys.length - 1]!.pos!;
    return { start: s, end: e, delta: [e[0] - s[0], e[1] - s[1], e[2] - s[2]] };
}
