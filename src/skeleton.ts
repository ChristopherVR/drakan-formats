import { type Skeleton, jointParents, parseSkeleton } from './ootfanim.ts';
import type { Model } from './model.ts';

/**
 * Skinning rig built from a decoded PS2 0x0208 record (`parseSkeleton`, layout in docs/reference/level-format.md
 * section 11 and docs/journal/2026-10-31/ootf-animation.md). Everything here is the playback semantics on top of that
 * parse, proven against the PAL disc by `editor/scripts/anim-probe.ts`:
 *
 *  - Matrices are 12 floats, row-vector convention (`v' = v * R + t`): `r00 r01 r02 r10 .. r22 tx ty tz`.
 *  - A joint's stored matrix is the INVERSE of its model-relative bind transform (mesh space to joint space).
 *  - The local bind translation (`bind * inverse(parent bind)`) equals the `base` translation of the ADB track of that
 *    joint, which fixes the convention (checked on every joint of every skinned model).
 *  - Vertex weights are listed per joint and per LOD; the vertex number is relative to the LOD's first vertex.
 *    Vertices with no weight (about 2 percent) ride on the root joint.
 */

export type Mat12 = Float32Array;

export const identityMat12 = (): Mat12 => Float32Array.from([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]);

/** Apply `a` first, then `b` (row vectors). */
export function mulMat12(a: ArrayLike<number>, b: ArrayLike<number>, out: Mat12 = new Float32Array(12)): Mat12 {
    const r = [0, 0, 0, 0, 0, 0, 0, 0, 0];
    for (let i = 0; i < 3; i++)
        for (let j = 0; j < 3; j++)
            r[i * 3 + j] = a[i * 3]! * b[j]! + a[i * 3 + 1]! * b[3 + j]! + a[i * 3 + 2]! * b[6 + j]!;
    const t = [0, 1, 2].map((j) => a[9]! * b[j]! + a[10]! * b[3 + j]! + a[11]! * b[6 + j]! + b[9 + j]!);
    for (let i = 0; i < 9; i++) out[i] = r[i]!;
    for (let i = 0; i < 3; i++) out[9 + i] = t[i]!;
    return out;
}

/** Inverse of a rigid (rotation plus translation) matrix. */
export function invertMat12(x: ArrayLike<number>): Mat12 {
    const o = new Float32Array(12);
    o[0] = x[0]!;
    o[1] = x[3]!;
    o[2] = x[6]!;
    o[3] = x[1]!;
    o[4] = x[4]!;
    o[5] = x[7]!;
    o[6] = x[2]!;
    o[7] = x[5]!;
    o[8] = x[8]!;
    for (let j = 0; j < 3; j++) o[9 + j] = -(x[9]! * o[j]! + x[10]! * o[3 + j]! + x[11]! * o[6 + j]!);
    return o;
}

/** Row-vector rotation matrix of a unit quaternion (x, y, z, w) = transpose of the textbook column matrix. */
export function quatToMat12(q: ArrayLike<number>, t: ArrayLike<number>, out: Mat12 = new Float32Array(12)): Mat12 {
    const x = q[0]!;
    const y = q[1]!;
    const z = q[2]!;
    const w = q[3]!;
    out[0] = 1 - 2 * (y * y + z * z);
    out[3] = 2 * (x * y - z * w);
    out[6] = 2 * (x * z + y * w);
    out[1] = 2 * (x * y + z * w);
    out[4] = 1 - 2 * (x * x + z * z);
    out[7] = 2 * (y * z - x * w);
    out[2] = 2 * (x * z - y * w);
    out[5] = 2 * (y * z + x * w);
    out[8] = 1 - 2 * (x * x + y * y);
    out[9] = t[0]!;
    out[10] = t[1]!;
    out[11] = t[2]!;
    return out;
}

/** Rotation of a Mat12 (row convention) to a unit quaternion (x, y, z, w). */
export function mat12ToQuat(m: ArrayLike<number>): [number, number, number, number] {
    // the textbook (column) matrix is the transpose of the stored rows
    const m00 = m[0]!;
    const m01 = m[3]!;
    const m02 = m[6]!;
    const m10 = m[1]!;
    const m11 = m[4]!;
    const m12 = m[7]!;
    const m20 = m[2]!;
    const m21 = m[5]!;
    const m22 = m[8]!;
    const tr = m00 + m11 + m22;
    let x: number;
    let y: number;
    let z: number;
    let w: number;
    if (tr > 0) {
        const s = Math.sqrt(tr + 1) * 2;
        w = s / 4;
        x = (m21 - m12) / s;
        y = (m02 - m20) / s;
        z = (m10 - m01) / s;
    } else if (m00 > m11 && m00 > m22) {
        const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
        w = (m21 - m12) / s;
        x = s / 4;
        y = (m01 + m10) / s;
        z = (m02 + m20) / s;
    } else if (m11 > m22) {
        const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
        w = (m02 - m20) / s;
        x = (m01 + m10) / s;
        y = s / 4;
        z = (m12 + m21) / s;
    } else {
        const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
        w = (m10 - m01) / s;
        x = (m02 + m20) / s;
        y = (m12 + m21) / s;
        z = s / 4;
    }
    return [x, y, z, w];
}

/** At most this many bones move one vertex (the PAL data peaks at 4). */
export const MAX_INFLUENCES = 4;

export interface Rig {
    jointCount: number;
    /** Parent joint per joint, -1 for the root. A parent always comes before its children in `order`. */
    parents: number[];
    order: number[];
    /** Name of the node that owns each joint (e.g. `torso`, `Lhand`). */
    names: string[];
    /** Inverse bind (mesh space to joint space) per joint, 12 floats each. */
    invBind: Float32Array;
    /** Local bind (joint to parent) per joint: the rest pose. */
    bindLocal: Float32Array;
    /** Per model vertex (all LODs, absolute index): `MAX_INFLUENCES` joint indices and weights (0 = unused slot). */
    jointIndex: Uint16Array;
    jointWeight: Float32Array;
    vertexCount: number;
    /** Vertices that carry more than `MAX_INFLUENCES` joints (their weakest influences were dropped). */
    droppedInfluences: number;
    /** Vertices with no weight at all (bound to the root joint). */
    unweighted: number;
    /** The animation ids the model lists in its 0x0208 record (resolved in the owning ADB). */
    animIds: number[];
}

/** Build the rig of a decoded skeleton; `vertexCount` is the model's total vertex count (all LODs). */
export function buildRig(sk: Skeleton, vertexCount: number): Rig {
    const jc = sk.joints.length;
    const parents = jointParents(sk);
    const order: number[] = [];
    const seen = new Uint8Array(jc);
    const visit = (j: number): void => {
        if (seen[j]) return;
        if (parents[j]! >= 0) visit(parents[j]!);
        seen[j] = 1;
        order.push(j);
    };
    for (let j = 0; j < jc; j++) visit(j);
    const names = new Array<string>(jc).fill('');
    for (const n of sk.nodes) if (n.joint >= 0 && n.joint < jc && !names[n.joint]) names[n.joint] = n.name;
    const invBind = new Float32Array(jc * 12);
    const bindLocal = new Float32Array(jc * 12);
    const bindWorld: Mat12[] = [];
    for (let j = 0; j < jc; j++) {
        invBind.set(sk.joints[j]!.xform, j * 12);
        bindWorld.push(invertMat12(sk.joints[j]!.xform));
    }
    for (let j = 0; j < jc; j++) {
        const p = parents[j]!;
        bindLocal.set(p < 0 ? bindWorld[j]! : mulMat12(bindWorld[j]!, invertMat12(bindWorld[p]!)), j * 12);
    }
    const jointIndex = new Uint16Array(vertexCount * MAX_INFLUENCES);
    const jointWeight = new Float32Array(vertexCount * MAX_INFLUENCES);
    const lists: { j: number; w: number }[][] = Array.from({ length: vertexCount }, () => []);
    sk.lods.forEach((lod, l) => {
        for (let j = 0; j < jc; j++)
            for (const w of sk.joints[j]!.weights[l] ?? []) {
                const v = lod.firstVertex + w.vertex;
                if (w.vertex < lod.vertexCount && v < vertexCount && w.weight > 0) lists[v]!.push({ j, w: w.weight });
            }
    });
    let dropped = 0;
    let unweighted = 0;
    for (let v = 0; v < vertexCount; v++) {
        let l = lists[v]!;
        if (l.length === 0) {
            unweighted++;
            jointWeight[v * MAX_INFLUENCES] = 1;
            continue;
        }
        if (l.length > MAX_INFLUENCES) {
            dropped++;
            l = l.sort((a, b) => b.w - a.w).slice(0, MAX_INFLUENCES);
        }
        let sum = 0;
        for (const e of l) sum += e.w;
        l.forEach((e, k) => {
            jointIndex[v * MAX_INFLUENCES + k] = e.j;
            jointWeight[v * MAX_INFLUENCES + k] = e.w / sum;
        });
    }
    return {
        jointCount: jc,
        parents,
        order,
        names,
        invBind,
        bindLocal,
        jointIndex,
        jointWeight,
        vertexCount,
        droppedInfluences: dropped,
        unweighted,
        animIds: sk.animIds,
    };
}

/** `parseSkeleton` + `buildRig` for a model's 0x0208 record; null when the record does not decode. */
export function rigFromCharacterRecord(record: Uint8Array, model: Pick<Model, 'positions'>): Rig | null {
    try {
        return buildRig(parseSkeleton(record, 'ps2'), model.positions.length / 3);
    } catch {
        return null;
    }
}

/** World (model space) matrices of a pose given local matrices (12 floats per joint). */
export function localToWorld(
    rig: Rig,
    local: Float32Array,
    world: Float32Array = new Float32Array(rig.jointCount * 12),
): Float32Array {
    for (const j of rig.order) {
        const p = rig.parents[j]!;
        const l = local.subarray(j * 12, j * 12 + 12);
        if (p < 0) world.set(l, j * 12);
        else mulMat12(l, world.subarray(p * 12, p * 12 + 12), world.subarray(j * 12, j * 12 + 12));
    }
    return world;
}

/** Skin matrices (bind-space vertex to posed model space) per joint from world matrices. */
export function skinMatrices(
    rig: Rig,
    world: Float32Array,
    out: Float32Array = new Float32Array(rig.jointCount * 12),
): Float32Array {
    for (let j = 0; j < rig.jointCount; j++)
        mulMat12(
            rig.invBind.subarray(j * 12, j * 12 + 12),
            world.subarray(j * 12, j * 12 + 12),
            out.subarray(j * 12, j * 12 + 12),
        );
    return out;
}

/**
 * Linear blend skinning of vertices `[first, first + count)` (absolute indices) into `outPos` / `outNrm`
 * (3 floats per vertex, same indexing as `positions`).
 */
export function skinVertices(
    rig: Rig,
    skin: Float32Array,
    positions: Float32Array,
    normals: Float32Array | null,
    first: number,
    count: number,
    outPos: Float32Array,
    outNrm: Float32Array | null,
): void {
    for (let v = first; v < first + count; v++) {
        const px = positions[v * 3]!;
        const py = positions[v * 3 + 1]!;
        const pz = positions[v * 3 + 2]!;
        const nx = normals ? normals[v * 3]! : 0;
        const ny = normals ? normals[v * 3 + 1]! : 0;
        const nz = normals ? normals[v * 3 + 2]! : 0;
        let ox = 0;
        let oy = 0;
        let oz = 0;
        let mx = 0;
        let my = 0;
        let mz = 0;
        for (let k = 0; k < MAX_INFLUENCES; k++) {
            const w = rig.jointWeight[v * MAX_INFLUENCES + k]!;
            if (w === 0) continue;
            const m = rig.jointIndex[v * MAX_INFLUENCES + k]! * 12;
            ox += w * (px * skin[m]! + py * skin[m + 3]! + pz * skin[m + 6]! + skin[m + 9]!);
            oy += w * (px * skin[m + 1]! + py * skin[m + 4]! + pz * skin[m + 7]! + skin[m + 10]!);
            oz += w * (px * skin[m + 2]! + py * skin[m + 5]! + pz * skin[m + 8]! + skin[m + 11]!);
            if (normals) {
                mx += w * (nx * skin[m]! + ny * skin[m + 3]! + nz * skin[m + 6]!);
                my += w * (nx * skin[m + 1]! + ny * skin[m + 4]! + nz * skin[m + 7]!);
                mz += w * (nx * skin[m + 2]! + ny * skin[m + 5]! + nz * skin[m + 8]!);
            }
        }
        outPos[v * 3] = ox;
        outPos[v * 3 + 1] = oy;
        outPos[v * 3 + 2] = oz;
        if (outNrm) {
            const l = Math.hypot(mx, my, mz) || 1;
            outNrm[v * 3] = mx / l;
            outNrm[v * 3 + 1] = my / l;
            outNrm[v * 3 + 2] = mz / l;
        }
    }
}
