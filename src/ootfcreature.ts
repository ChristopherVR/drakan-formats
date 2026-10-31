/**
 * Order of the Flame (PC) characters and creatures -> PS2 engine: animation conversion and the retarget strategy.
 * Evidence and numbers: docs/journal/2026-10-31/ootf-animation.md.
 *
 * Rotation basis (solved on spider 3228, whose PC and PS2 skeletons are identical, 2.3 k key samples over the nine
 * shared animations, mean residual 0.02 Frobenius = 1 degree, which is the PS2 key reduction):
 *
 *     Q_j = B_j * Wp * K * Wp^T          (row-vector convention, 3x3 rotations)
 *
 * with K the PC key rotation (a delta against the bind pose), B_j the joint's local bind rotation (identical on both
 * platforms), Wp the bind rotation of the parent in model space (product of the bind locals root..parent, identity for a
 * root) and Q_j the PS2 absolute parent-relative rotation. In words: the PC key is a model-axes rotation applied in the
 * parent's bind frame, after the bind rotation. Translation: PS2 keys position on the root only (`hasPos` track,
 * position = PC translation minus the first key's), non-root PC translations are dropped (PS2 tracks use the bind
 * translation; they are bone squash noise of at most 0.2 units on the spider).
 */
import {
    type NamedAnim,
    type Ps2Anim,
    type Ps2Key,
    type Ps2Track,
    type PcAnim,
    type Skeleton,
    buildAnimMap,
    jointParents,
    parsePs2Anim,
    writePs2Anim,
    writePs2Skeleton,
} from './ootfanim.ts';
import { buildRig, mat12ToQuat, quatToMat12, type Rig } from './skeleton.ts';

// ------------------------------------------------------------------------------------------------ 3x3 helpers (row-major, row vectors)

type M3 = number[];
const mul3 = (a: M3, b: M3): M3 => {
    const o = new Array<number>(9).fill(0);
    for (let i = 0; i < 3; i++)
        for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) o[i * 3 + j]! += a[i * 3 + k]! * b[k * 3 + j]!;
    return o;
};
const tr3 = (a: M3): M3 => [a[0]!, a[3]!, a[6]!, a[1]!, a[4]!, a[7]!, a[2]!, a[5]!, a[8]!];
const ID3: M3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
const sub3 = (m: ArrayLike<number>, o: number): M3 => [0, 1, 2, 3, 4, 5, 6, 7, 8].map((i) => m[o + i]!);

type Quat = [number, number, number, number];

/** Quaternion (x, y, z, w; matrix = transpose of the standard one) of a row-vector rotation, orthonormalising first. */
function toQuat(r: M3): Quat {
    const m12 = Float32Array.from([...r, 0, 0, 0]);
    // Gram-Schmidt: PC keys are float32 matrices that drift a little from orthonormal.
    let a: number[] = [m12[0]!, m12[1]!, m12[2]!];
    let b: number[] = [m12[3]!, m12[4]!, m12[5]!];
    const norm = (v: number[]): number[] => {
        const l = Math.hypot(v[0]!, v[1]!, v[2]!) || 1;
        return v.map((x) => x / l);
    };
    a = norm(a);
    const d = a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
    b = norm(b.map((x, i) => x - d * a[i]!));
    const c = [a[1]! * b[2]! - a[2]! * b[1]!, a[2]! * b[0]! - a[0]! * b[2]!, a[0]! * b[1]! - a[1]! * b[0]!];
    const q = mat12ToQuat([...a, ...b, ...c, 0, 0, 0]);
    const l = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
    return [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
}

function slerp(a: Quat, b: Quat, t: number): Quat {
    let d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
    const s = d < 0 ? -1 : 1;
    d *= s;
    let s0 = 1 - t;
    let s1 = t * s;
    if (d < 0.9995) {
        const th = Math.acos(Math.min(1, d));
        const sn = Math.sin(th);
        s0 = Math.sin((1 - t) * th) / sn;
        s1 = (Math.sin(t * th) / sn) * s;
    }
    const o: Quat = [s0 * a[0] + s1 * b[0], s0 * a[1] + s1 * b[1], s0 * a[2] + s1 * b[2], s0 * a[3] + s1 * b[3]];
    const l = Math.hypot(...o) || 1;
    return [o[0] / l, o[1] / l, o[2] / l, o[3] / l];
}

/** Angle in radians between two rotations. */
export function quatAngle(a: ArrayLike<number>, b: ArrayLike<number>): number {
    const d = Math.abs(a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]! + a[3]! * b[3]!);
    return 2 * Math.acos(Math.min(1, d));
}

// ------------------------------------------------------------------------------------------------ basis conversion

/** Per-joint constants of the conversion: local bind rotation and the parent's model-space bind rotation. */
export interface BindBasis {
    parents: number[];
    /** 3x3 local bind rotation per joint. */
    local: M3[];
    /** 3x3 model-space bind rotation of the PARENT per joint (identity for roots). */
    parentWorld: M3[];
    /** Local bind translation per joint. */
    translation: [number, number, number][];
}

export function bindBasis(rig: Pick<Rig, 'parents' | 'order' | 'bindLocal' | 'jointCount'>): BindBasis {
    const local: M3[] = [];
    const translation: [number, number, number][] = [];
    for (let j = 0; j < rig.jointCount; j++) {
        local.push(sub3(rig.bindLocal, j * 12));
        translation.push([rig.bindLocal[j * 12 + 9]!, rig.bindLocal[j * 12 + 10]!, rig.bindLocal[j * 12 + 11]!]);
    }
    const world: M3[] = new Array<M3>(rig.jointCount);
    const parentWorld: M3[] = new Array<M3>(rig.jointCount);
    for (const j of rig.order) {
        const p = rig.parents[j]!;
        parentWorld[j] = p < 0 ? ID3 : world[p]!;
        world[j] = p < 0 ? local[j]! : mul3(local[j]!, world[p]!);
    }
    return { parents: rig.parents, local, parentWorld, translation };
}

/** The PS2 absolute parent-relative rotation for PC key rotation `k` (3x3 rows) of joint `j`. */
export function pcKeyToPs2Rotation(basis: BindBasis, j: number, k: ArrayLike<number>): Quat {
    const wp = basis.parentWorld[j]!;
    const d = mul3(mul3(wp, sub3(k, 0)), tr3(wp));
    return toQuat(mul3(basis.local[j]!, d));
}

// ------------------------------------------------------------------------------------------------ key reduction

/** Greedy Douglas-Peucker style reduction: drop keys the slerp of the kept neighbours reproduces within `maxRad`. */
export function reduceQuatKeys(keys: { time: number; q: Quat }[], maxRad: number): { time: number; q: Quat }[] {
    if (keys.length <= 2) return keys;
    const keep = new Uint8Array(keys.length);
    keep[0] = 1;
    keep[keys.length - 1] = 1;
    const rec = (a: number, b: number): void => {
        let worst = -1;
        let we = maxRad;
        const ka = keys[a]!;
        const kb = keys[b]!;
        for (let i = a + 1; i < b; i++) {
            const span = kb.time - ka.time;
            const f = span > 1e-9 ? (keys[i]!.time - ka.time) / span : 0;
            const e = quatAngle(slerp(ka.q, kb.q, f), keys[i]!.q);
            if (e > we) {
                we = e;
                worst = i;
            }
        }
        if (worst < 0) return;
        keep[worst] = 1;
        rec(a, worst);
        rec(worst, b);
    };
    rec(0, keys.length - 1);
    return keys.filter((_, i) => keep[i]);
}

export interface ConvertAnimOptions {
    /** Maximum rotation error of the key reduction, degrees. Default 0.35 (the PS2 tool's own threshold is 0.2). */
    toleranceDeg?: number;
    /** Name for the result (default: the PC name). */
    name?: string;
    /** Channel count to write to the 0x0501 header (the target skeleton's channel count). Default: the PC value. */
    channels?: number;
}

/**
 * PC animation -> PS2 animation for a skeleton whose joint list matches the PC animation's tracks (same joint count and
 * tree). `bind` is the TARGET skeleton's basis (PS2 or PC; the bind rotations are identical for shared creatures).
 * Throws when the track counts differ (the engine pairs animations with models by joint count).
 */
export function convertPcAnimToPs2(pc: PcAnim, bind: BindBasis, opt: ConvertAnimOptions = {}): Ps2Anim {
    const jc = bind.local.length;
    if (pc.lookup.length !== jc) throw new Error(`animation has ${pc.lookup.length} tracks, skeleton ${jc} joints`);
    const tol = ((opt.toleranceDeg ?? 0.35) * Math.PI) / 180;
    const tracks: Ps2Track[] = [];
    for (let j = 0; j < jc; j++) {
        const { first, count } = pc.lookup[j]!;
        const src = pc.keys.slice(first, first + count);
        const root = bind.parents[j]! < 0;
        let qs = src.map((k) => ({ time: k.time, q: pcKeyToPs2Rotation(bind, j, k.xform) }));
        // keep neighbouring quaternions on one hemisphere so the slerp takes the short way
        for (let i = 1; i < qs.length; i++) {
            const a = qs[i - 1]!.q;
            const b = qs[i]!.q;
            if (a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3] < 0)
                qs[i] = { time: qs[i]!.time, q: [-b[0], -b[1], -b[2], -b[3]] };
        }
        if (qs.length === 0) qs = [{ time: 0, q: toQuat(bind.local[j]!) }];
        const k0 = src[0];
        if (root && k0) {
            // Root: rotation and translation are both kept; a root key carries every PC key (pos varies per key).
            const posKeys: Ps2Key[] = src.map((k, i) => ({
                time: k.time,
                q: qs[i]!.q,
                pos: [k.xform[9]! - k0.xform[9]!, k.xform[10]! - k0.xform[10]!, k.xform[11]! - k0.xform[11]!],
            }));
            tracks.push({ base: bind.translation[j]!, hasPos: true, keys: reduceRootKeys(posKeys, tol) });
            continue;
        }
        const reduced = reduceQuatKeys(qs, tol);
        const constant = reduced.every((k) => quatAngle(k.q, reduced[0]!.q) < 1e-5);
        const keys: Ps2Key[] = (constant ? [reduced[0]!] : reduced).map((k) => ({
            time: constant ? 0 : k.time,
            q: k.q,
            pos: null,
        }));
        tracks.push({ base: bind.translation[j]!, hasPos: false, keys });
    }
    return {
        name: opt.name ?? pc.name,
        duration: pc.duration,
        flags: pc.flags & 1,
        frames: tracks.length,
        channels: opt.channels ?? pc.channels,
        thresholds: { rotation: 0.2, scale: 1, translation: 1 },
        tracks,
    };
}

function reduceRootKeys(keys: Ps2Key[], tol: number): Ps2Key[] {
    if (keys.length <= 2) return keys;
    const keep = new Uint8Array(keys.length);
    keep[0] = 1;
    keep[keys.length - 1] = 1;
    const rec = (a: number, b: number): void => {
        let worst = -1;
        let we = 0;
        const ka = keys[a]!;
        const kb = keys[b]!;
        for (let i = a + 1; i < b; i++) {
            const span = kb.time - ka.time;
            const f = span > 1e-9 ? (keys[i]!.time - ka.time) / span : 0;
            const eq = quatAngle(slerp(ka.q, kb.q, f), keys[i]!.q);
            let ep = 0;
            for (let c = 0; c < 3; c++)
                ep = Math.max(ep, Math.abs(ka.pos![c]! + (kb.pos![c]! - ka.pos![c]!) * f - keys[i]!.pos![c]!));
            const e = Math.max(eq / tol, ep / 0.002);
            if (e > 1 && e > we) {
                we = e;
                worst = i;
            }
        }
        if (worst < 0) return;
        keep[worst] = 1;
        rec(a, worst);
        rec(worst, b);
    };
    rec(0, keys.length - 1);
    return keys.filter((_, i) => keep[i]);
}

// ------------------------------------------------------------------------------------------------ validation

export interface AnimDiff {
    /** Mean / max angle (radians) over joints and samples between the local rotations. */
    meanAngle: number;
    maxAngle: number;
    perJoint: number[];
    /** Same, for the model-space joint positions of the posed rig (model units). */
    meanPos: number;
    maxPos: number;
}

function sampleQ(keys: Ps2Key[], t: number): Quat {
    if (keys.length === 0) return [0, 0, 0, 1];
    if (t <= keys[0]!.time) return keys[0]!.q;
    for (let i = 1; i < keys.length; i++)
        if (t <= keys[i]!.time) {
            const a = keys[i - 1]!;
            const b = keys[i]!;
            return slerp(a.q, b.q, (t - a.time) / Math.max(1e-9, b.time - a.time));
        }
    return keys[keys.length - 1]!.q;
}

/** Pose joint model-space positions of `a` at `t` (rotation-only joints plus the root's keyed position). */
function jointPositions(rig: Rig, a: Ps2Anim, t: number): Float32Array {
    const jc = rig.jointCount;
    const local = new Float32Array(jc * 12);
    for (let j = 0; j < jc; j++) {
        const tk = a.tracks[j]!;
        const q = sampleQ(tk.keys, t);
        const p = tk.hasPos && tk.keys.length ? lerpPos(tk.keys, t) : tk.base;
        quatToMat12(q, p, local.subarray(j * 12, j * 12 + 12));
    }
    const world = new Float32Array(jc * 12);
    for (const j of rig.order) {
        const p = rig.parents[j]!;
        const l = local.subarray(j * 12, j * 12 + 12);
        const w = world.subarray(j * 12, j * 12 + 12);
        if (p < 0) w.set(l);
        else {
            const pw = world.subarray(p * 12, p * 12 + 12);
            for (let r = 0; r < 3; r++)
                for (let c = 0; c < 3; c++)
                    w[r * 3 + c] = l[r * 3]! * pw[c]! + l[r * 3 + 1]! * pw[3 + c]! + l[r * 3 + 2]! * pw[6 + c]!;
            for (let c = 0; c < 3; c++)
                w[9 + c] = l[9]! * pw[c]! + l[10]! * pw[3 + c]! + l[11]! * pw[6 + c]! + pw[9 + c]!;
        }
    }
    const out = new Float32Array(jc * 3);
    for (let j = 0; j < jc; j++) out.set(world.subarray(j * 12 + 9, j * 12 + 12), j * 3);
    return out;
}

function lerpPos(keys: Ps2Key[], t: number): [number, number, number] {
    if (t <= keys[0]!.time) return keys[0]!.pos!;
    for (let i = 1; i < keys.length; i++)
        if (t <= keys[i]!.time) {
            const a = keys[i - 1]!;
            const b = keys[i]!;
            const f = (t - a.time) / Math.max(1e-9, b.time - a.time);
            return [0, 1, 2].map((c) => a.pos![c]! + (b.pos![c]! - a.pos![c]!) * f) as [number, number, number];
        }
    return keys[keys.length - 1]!.pos!;
}

/** Compare two PS2 animations of the same skeleton by local rotation and by posed joint positions. */
export function compareAnims(rig: Rig, a: Ps2Anim, b: Ps2Anim, samples = 40): AnimDiff {
    const jc = rig.jointCount;
    const perJoint = new Array<number>(jc).fill(0);
    let sum = 0;
    let max = 0;
    let psum = 0;
    let pmax = 0;
    const dur = Math.min(a.duration, b.duration);
    for (let s = 0; s < samples; s++) {
        const t = (dur * s) / samples;
        for (let j = 0; j < jc; j++) {
            const ang = quatAngle(sampleQ(a.tracks[j]!.keys, t), sampleQ(b.tracks[j]!.keys, t));
            perJoint[j]! += ang / samples;
            sum += ang;
            max = Math.max(max, ang);
        }
        const pa = jointPositions(rig, a, t);
        const pb = jointPositions(rig, b, t);
        for (let j = 0; j < jc; j++) {
            // the root's keyed position is relative to its own first key in both clips: compare it unchanged
            const d = Math.hypot(
                pa[j * 3]! - pb[j * 3]!,
                pa[j * 3 + 1]! - pb[j * 3 + 1]!,
                pa[j * 3 + 2]! - pb[j * 3 + 2]!,
            );
            psum += d;
            pmax = Math.max(pmax, d);
        }
    }
    return {
        meanAngle: sum / (samples * jc),
        maxAngle: max,
        perJoint,
        meanPos: psum / (samples * jc),
        maxPos: pmax,
    };
}

// ------------------------------------------------------------------------------------------------ retarget strategy

export type RetargetMode =
    /** Same joint tree on both platforms: keep the PS2 model and skeleton, convert the PC animations onto it. */
    | 'reuse-ps2'
    /** Not on PS2 (or re-authored): convert the skinned model and skeleton too. */
    | 'convert'
    /** Cannot be done; `reason` says why. */
    | 'fail';

export interface CreatureInput {
    /** PC skeleton (0x0208 decoded with `parseSkeleton(.., 'pc')`). */
    pcSkeleton: Skeleton;
    /** PC animations of the model, by id (decoded with `parsePcAnim`). */
    pcAnims: Map<number, PcAnim>;
    /** The PS2 skeleton with the same model id/name when the disc has it; null when the creature is OotF-only. */
    ps2Skeleton?: Skeleton | null;
    /** The PS2 animations of that model by id (decoded with `parsePs2Anim`). */
    ps2Anims?: Map<number, Ps2Anim>;
    /** Per-vertex model positions (all LODs) of the PC model; only for the `convert` mode (sphere centres). */
    pcPositions?: Float32Array | null;
}

export interface CreatureResult {
    mode: RetargetMode;
    reason: string;
    /** 0x0208 payload to ship (convert mode); null for reuse-ps2 (use the disc's own). */
    skeletonRecord: Uint8Array | null;
    /** New animations to add to the ADB (id -> payloads). reuse-ps2: only the ones the disc lacks. */
    anims: { id: number; name: string; info: Uint8Array; data: Uint8Array; converted: boolean }[];
    /** pc anim id -> id to use on the PS2 side (identity when the id exists in the PS2 set or was converted). */
    animIdMap: Map<number, number>;
    /** Full animation id list for the model's 0x0208 record. */
    animIds: number[];
    /** PC animations that could not be converted or mapped, with the reason. */
    skipped: { id: number; name: string; why: string }[];
}

/** True when two skeletons have the same joint count, parents, node names and (within `tol`) bind rotations. */
export function sameJointTree(a: Skeleton, b: Skeleton, tol = 0.02): { same: boolean; why: string } {
    if (a.joints.length !== b.joints.length)
        return { same: false, why: `joint count ${a.joints.length} vs ${b.joints.length}` };
    const pa = jointParents(a);
    const pb = jointParents(b);
    for (let j = 0; j < pa.length; j++)
        if (pa[j] !== pb[j]) return { same: false, why: `parent of joint ${j} differs` };
    const ra = buildRig(a, 0);
    const rb = buildRig(b, 0);
    for (let j = 0; j < ra.names.length; j++)
        if (ra.names[j] !== rb.names[j])
            return { same: false, why: `joint ${j} name ${ra.names[j]} vs ${rb.names[j]}` };
    let worst = 0;
    for (let j = 0; j < a.joints.length; j++)
        for (let i = 0; i < 12; i++)
            worst = Math.max(worst, Math.abs(ra.bindLocal[j * 12 + i]! - rb.bindLocal[j * 12 + i]!));
    if (worst > tol) return { same: false, why: `bind pose differs by ${worst.toFixed(3)}` };
    return { same: true, why: '' };
}

/**
 * Decide and execute the retarget of one OotF character.
 *
 *  1. PS2 counterpart with an identical joint tree and bind pose (spider, goblin/orc, Rynn, most NPCs): `reuse-ps2`.
 *     Every PC animation whose id the PS2 model already has is mapped to it by id or name (`buildAnimMap`); the others
 *     are CONVERTED with the verified basis change and appended. Nothing about the model is shipped.
 *  2. No counterpart, or re-authored (joint count / bind pose differ): `convert`. The skeleton is written with
 *     `writePs2Skeleton` and every animation is converted. The skinned geometry (0x0200/0x0203/0x0204 with the vertex
 *     weights already inside the skeleton record) must come from the model converter; this function does not write it.
 *  3. `fail`: no PC animation fits the skeleton (track count mismatch on all of them), or the skeleton has no joints.
 *
 * What always fails: the PS2 display list copy 0x0211 of a new skinned mesh is not generated (see ootf-models.md), so
 * `convert` mode yields data the engine may or may not draw; verify in game before relying on it.
 */
export function convertCreatureAssets(input: CreatureInput, opt: ConvertAnimOptions = {}): CreatureResult {
    const { pcSkeleton: pcS, pcAnims } = input;
    const empty = (mode: RetargetMode, reason: string): CreatureResult => ({
        mode,
        reason,
        skeletonRecord: null,
        anims: [],
        animIdMap: new Map(),
        animIds: [],
        skipped: [],
    });
    if (pcS.joints.length === 0) return empty('fail', 'skeleton has no joints');
    const ps2 = input.ps2Skeleton ?? null;
    let mode: RetargetMode = 'convert';
    let reason = ps2 ? '' : 'not on the PS2 disc';
    if (ps2) {
        const t = sameJointTree(pcS, ps2);
        if (t.same) mode = 'reuse-ps2';
        else reason = `re-authored on PS2: ${t.why}`;
    }
    const target = mode === 'reuse-ps2' ? ps2! : pcS;
    const rig = buildRig(target, 0);
    const basis = bindBasis(rig);
    const channels = mode === 'reuse-ps2' ? target.channels.length : Math.min(target.channels.length, 4);
    const ps2Anims = input.ps2Anims ?? new Map<number, Ps2Anim>();
    const ps2Named: NamedAnim[] = [...ps2Anims].map(([id, a]) => ({ id, name: a.name }));
    const pcNamed: NamedAnim[] = [...pcAnims].map(([id, a]) => ({ id, name: a.name }));
    const byName = mode === 'reuse-ps2' ? buildAnimMap(pcNamed, ps2Named) : new Map<number, number>();
    const res = empty(mode, reason);
    const ids = new Set<number>(mode === 'reuse-ps2' && ps2 ? ps2.animIds : []);
    const fitting = [...pcAnims.values()].filter((a) => a.lookup.length === rig.jointCount).length;
    if (fitting === 0 && pcAnims.size > 0) return empty('fail', 'no PC animation has one track per joint');
    for (const [id, a] of pcAnims) {
        if (mode === 'reuse-ps2' && ps2Anims.has(id)) {
            // The disc already has an animation under this id with this name: keep the disc's (authored, verified).
            if (byName.get(id) !== undefined) {
                res.animIdMap.set(id, id);
                continue;
            }
        }
        try {
            const c = convertPcAnimToPs2(a, basis, { ...opt, channels });
            const w = writePs2Anim(c);
            res.anims.push({ id, name: a.name, info: w.info, data: w.data, converted: true });
            res.animIdMap.set(id, id);
            ids.add(id);
        } catch (e) {
            res.skipped.push({ id, name: a.name, why: e instanceof Error ? e.message : String(e) });
        }
    }
    res.animIds = [...ids].sort((x, y) => x - y);
    if (mode === 'convert') {
        const sk: Skeleton = { ...pcS, animIds: res.animIds };
        res.skeletonRecord = writePs2Skeleton(sk, input.pcPositions ?? null, 4);
    }
    return res;
}

export { parsePs2Anim };
