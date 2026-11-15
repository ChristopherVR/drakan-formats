/**
 * Model upgrade for converted Order of the Flame skinned models (characters): the 1999 meshes (about 500 triangles for a
 * human) are refined at convert time, from the player's own data, towards the density of the Drakan 2 characters (1,900 to
 * 2,300 triangles at LOD 0 on the disc). No game data here; journal 2026-11-16/ootf-model-upgrade.md.
 *
 * - `subdivideSkin`: one interpolating subdivision step (every triangle split in four). The original vertices stay where
 *   they are (no shrinking of thin limbs, fingers or noses, unlike Loop), and each new edge point lies on the curved
 *   surface the smooth normals describe (PN triangles). Edges sharper than the crease angle, open borders and the edges of
 *   kept parts (alpha cards such as hair fringes) are split straight, so no cracks open and cards stay flat. UVs are split
 *   linearly per triangle, so texture seams stay. A new vertex is skinned with the mean of its edge's two vertices'
 *   weights, capped at `maxInfluences` joints (4 on the disc) and renormalised. Vertex indices of the input are kept, so
 *   the PC bounding spheres that name vertices still find them.
 * - `addJaw`: a synthetic jaw joint (child of the head joint, at a hinge point under the ears) with the chin and lower lip
 *   re-weighted to it, chosen geometrically in the bind pose: below the mouth line and in front of the hinge. A skeleton
 *   channel names the jaw so a converted scene can play a jaw clip on it (`jawClip`).
 */

import type { OotfMat12, Ps2Anim, Ps2Track, Skeleton, SkelJoint } from './ootfanim.ts';
import { buildRig, invertMat12, mat12ToQuat, mulMat12, quatToMat12 } from './skeleton.ts';

export interface SkinPoly {
    flags: number;
    texture: number;
    indices: number[];
    uvs: number[];
}

/** Joint influences of one vertex. */
export type VertexWeights = { j: number; w: number }[];

export interface SkinMesh {
    positions: Float32Array;
    polygons: SkinPoly[];
    weights: VertexWeights[];
}

export interface SubdivideOptions {
    /** Edges whose faces meet at more than this many degrees stay straight (default 55). */
    creaseDegrees?: number;
    /** Texture list entries whose polygons are split flat and whose edges stay straight (alpha cards). */
    keepTextures?: ReadonlySet<number>;
    /** Joint influences per vertex after the split (default 4, the disc's maximum). */
    maxInfluences?: number;
    /** A curved edge point moves at most this fraction of its edge's length off the straight midpoint (default 0.2). */
    maxBulge?: number;
}

type V3 = [number, number, number];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a: V3) => Math.hypot(a[0], a[1], a[2]);
const unit = (a: V3): V3 => {
    const l = len(a);
    return l > 0 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0];
};

/** Mean of two influence lists, capped at `max` joints and renormalised. */
export function mixWeights(a: VertexWeights, b: VertexWeights, max = 4): VertexWeights {
    const acc = new Map<number, number>();
    for (const x of a) acc.set(x.j, (acc.get(x.j) ?? 0) + x.w / 2);
    for (const x of b) acc.set(x.j, (acc.get(x.j) ?? 0) + x.w / 2);
    const list = [...acc]
        .map(([j, w]) => ({ j, w }))
        .filter((x) => x.w > 1e-6)
        .sort((p, q) => q.w - p.w || p.j - q.j)
        .slice(0, max);
    const total = list.reduce((s, x) => s + x.w, 0);
    return total > 0 ? list.map((x) => ({ j: x.j, w: x.w / total })) : list;
}

interface Tri {
    v: [number, number, number];
    uv: number[];
    texture: number;
    flags: number;
    keep: boolean;
}

/** One interpolating curved subdivision step of a skinned mesh (see the file comment). */
export function subdivideSkin(m: SkinMesh, o: SubdivideOptions = {}): SkinMesh {
    const cosCrease = Math.cos(((o.creaseDegrees ?? 55) * Math.PI) / 180);
    const maxInf = o.maxInfluences ?? 4;
    const maxBulge = o.maxBulge ?? 0.2;
    const nv = m.positions.length / 3;
    const P = (i: number): V3 => [m.positions[i * 3]!, m.positions[i * 3 + 1]!, m.positions[i * 3 + 2]!];
    // Welded position groups: the topology (and the normals) ignore duplicate vertices at one place.
    const groupOf = new Int32Array(nv);
    const byKey = new Map<string, number>();
    for (let i = 0; i < nv; i++) {
        const k = P(i)
            .map((x) => Math.round(x * 1e6))
            .join(',');
        let g = byKey.get(k);
        if (g === undefined) byKey.set(k, (g = byKey.size));
        groupOf[i] = g;
    }
    const tris: Tri[] = [];
    for (const p of m.polygons)
        for (let k = 1; k + 1 < p.indices.length; k++)
            tris.push({
                v: [p.indices[0]!, p.indices[k]!, p.indices[k + 1]!],
                uv: [p.uvs[0]!, p.uvs[1]!, p.uvs[k * 2]!, p.uvs[k * 2 + 1]!, p.uvs[k * 2 + 2]!, p.uvs[k * 2 + 3]!],
                texture: p.texture,
                flags: p.flags,
                keep: o.keepTextures?.has(p.texture) ?? false,
            });
    const faceN = tris.map((t) => cross(sub(P(t.v[1]), P(t.v[0])), sub(P(t.v[2]), P(t.v[0]))));
    const faceU = faceN.map(unit);
    // Welded edges and the faces on them; one winding sign per edge use to tell a consistently wound neighbour.
    const gkey = (a: number, b: number) => {
        const x = groupOf[a]!,
            y = groupOf[b]!;
        return x < y ? `${x},${y}` : `${y},${x}`;
    };
    const edgeFaces = new Map<string, number[]>();
    tris.forEach((t, f) => {
        for (let e = 0; e < 3; e++) {
            const k = gkey(t.v[e]!, t.v[(e + 1) % 3]!);
            (edgeFaces.get(k) ?? edgeFaces.set(k, []).get(k)!).push(f);
        }
    });
    // Smooth normal per welded group over the faces that are not kept (area weighted; faces of the other winding flipped
    // to the majority of the group so a mirrored piece does not cancel out).
    const gN: V3[] = Array.from({ length: byKey.size }, () => [0, 0, 0] as V3);
    tris.forEach((t, f) => {
        if (t.keep) return;
        for (const v of t.v) {
            const g = groupOf[v]!;
            const n = faceN[f]!;
            const s = dot(gN[g]!, n) < 0 ? -1 : 1;
            gN[g] = [gN[g]![0] + s * n[0], gN[g]![1] + s * n[1], gN[g]![2] + s * n[2]];
        }
    });
    const gU = gN.map(unit);
    const soft = (a: number, b: number): boolean => {
        const fs = edgeFaces.get(gkey(a, b))!;
        if (fs.length !== 2) return false;
        const [f, g] = fs as [number, number];
        if (tris[f]!.keep || tris[g]!.keep) return false;
        return Math.abs(dot(faceU[f]!, faceU[g]!)) >= cosCrease;
    };
    const positions: number[] = Array.from(m.positions);
    const weights: VertexWeights[] = m.weights.map((w) => w.slice());
    const mids = new Map<string, number>();
    const mid = (a: number, b: number): number => {
        const k = a < b ? `${a},${b}` : `${b},${a}`;
        const known = mids.get(k);
        if (known !== undefined) return known;
        const pa = P(a),
            pb = P(b);
        let p: V3 = [(pa[0] + pb[0]) / 2, (pa[1] + pb[1]) / 2, (pa[2] + pb[2]) / 2];
        if (soft(a, b)) {
            // Cubic PN edge midpoint: (a + b) / 2 - ((b - a).na na + (a - b).nb nb) / 8; independent of the normals' sign
            // as long as both ends agree, so the winding convention does not matter.
            const na = gU[groupOf[a]!]!;
            let nb = gU[groupOf[b]!]!;
            if (dot(na, nb) < 0) nb = [-nb[0], -nb[1], -nb[2]];
            const d = sub(pb, pa);
            const wa = dot(d, na),
                wb = -dot(d, nb);
            let off: V3 = [
                -(wa * na[0] + wb * nb[0]) / 8,
                -(wa * na[1] + wb * nb[1]) / 8,
                -(wa * na[2] + wb * nb[2]) / 8,
            ];
            const lim = maxBulge * len(d);
            const ol = len(off);
            if (ol > lim) off = [(off[0] * lim) / ol, (off[1] * lim) / ol, (off[2] * lim) / ol];
            p = [p[0] + off[0], p[1] + off[1], p[2] + off[2]];
        }
        const id = positions.length / 3;
        positions.push(...p);
        weights.push(mixWeights(m.weights[a] ?? [], m.weights[b] ?? [], maxInf));
        mids.set(k, id);
        return id;
    };
    const polygons: SkinPoly[] = [];
    for (const t of tris) {
        const [a, b, c] = t.v;
        const ab = mid(a, b),
            bc = mid(b, c),
            ca = mid(c, a);
        const uv = (i: number) => [t.uv[i * 2]!, t.uv[i * 2 + 1]!];
        const avg = (i: number, j: number) => [
            (t.uv[i * 2]! + t.uv[j * 2]!) / 2,
            (t.uv[i * 2 + 1]! + t.uv[j * 2 + 1]!) / 2,
        ];
        const tri = (v: number[], u: number[][]) =>
            polygons.push({ flags: t.flags, texture: t.texture, indices: v, uvs: u.flat() });
        tri([a, ab, ca], [uv(0), avg(0, 1), avg(2, 0)]);
        tri([ab, b, bc], [avg(0, 1), uv(1), avg(1, 2)]);
        tri([ca, bc, c], [avg(2, 0), avg(1, 2), uv(2)]);
        tri([ab, bc, ca], [avg(0, 1), avg(1, 2), avg(2, 0)]);
    }
    return { positions: Float32Array.from(positions), polygons, weights };
}

// ---------------------------------------------------------------------------------------------------- weights <-> skeleton

/** Per-vertex influences of LOD 0 (`vertexCount` vertices) from the joints' weight lists. */
export function vertexWeights(sk: Pick<Skeleton, 'joints'>, vertexCount: number): VertexWeights[] {
    const per: VertexWeights[] = Array.from({ length: vertexCount }, () => []);
    sk.joints.forEach((j, ji) => {
        for (const w of j.weights[0] ?? []) if (w.vertex < vertexCount) per[w.vertex]!.push({ j: ji, w: w.weight });
    });
    return per;
}

/**
 * The skeleton with its LOD 0 weight lists rebuilt from per-vertex influences (`vertexWeights`' inverse). Every old LOD 0
 * weight is replaced, also those of the PC bounding-sphere vertices after the LOD's own: new vertices take those indices,
 * and the converted spheres keep their centres from the unsliced PC positions instead.
 */
export function withVertexWeights(sk: Skeleton, weights: readonly VertexWeights[]): Skeleton {
    const lists: { vertex: number; weight: number }[][] = sk.joints.map(() => []);
    weights.forEach((ws, v) => {
        for (const x of ws) lists[x.j]?.push({ vertex: v, weight: x.w });
    });
    return {
        ...sk,
        joints: sk.joints.map((j, ji) => ({
            ...j,
            weights: [lists[ji]!.sort((a, b) => a.vertex - b.vertex), ...j.weights.slice(1)],
        })),
    };
}

// ---------------------------------------------------------------------------------------------------- jaw

export interface JawOptions {
    /** Name of the head joint's node (default `head`, case ignored). */
    head?: string;
    /** Name of the new joint's node (default `jaw`). */
    name?: string;
}

export interface JawResult {
    skeleton: Skeleton;
    weights: VertexWeights[];
    /** Index of the new joint (the last one). */
    joint: number;
    /** Index of the new skeleton channel (the last one). */
    channel: number;
    /** Hinge axis in model space (unit, the model's left-right axis) and the hinge point. */
    axis: V3;
    hinge: V3;
    /** Vertices that follow the jaw (weight > 0). */
    moved: number;
}

const AXES: V3[] = [
    [1, 0, 0],
    [-1, 0, 0],
    [0, 0, 1],
    [0, 0, -1],
];

/** Forward from the feet: the horizontal axis along which foot vertices lie ahead of their ankle joints. */
function footForward(sk: Skeleton, positions: Float32Array, weights: readonly VertexWeights[]): V3 | null {
    const feet = new Set(sk.nodes.filter((n) => n.joint >= 0 && /foot/i.test(n.name)).map((n) => n.joint));
    if (!feet.size) return null;
    const acc: V3 = [0, 0, 0];
    let n = 0;
    for (const f of feet) {
        const o = invertMat12(sk.joints[f]!.xform);
        weights.forEach((ws, v) => {
            if ((ws.find((x) => x.j === f)?.w ?? 0) < 0.5) return;
            acc[0] += positions[v * 3]! - o[9]!;
            acc[2] += positions[v * 3 + 2]! - o[11]!;
            n++;
        });
    }
    if (n < 3) return null;
    let best: V3 | null = null;
    let score = 0;
    for (const a of AXES) {
        const d = acc[0] * a[0] + acc[2] * a[2];
        if (d > score) {
            score = d;
            best = a;
        }
    }
    return best;
}

/** Forward from the head alone: the side whose extreme point at mid height (the nose) lies furthest out. */
function noseForward(head: number[], P: (i: number) => V3, c: V3, lo: number, height: number): V3 {
    const bandLo = lo + height * 0.3,
        bandHi = lo + height * 0.7;
    let best: { dir: V3; score: number } | null = null;
    for (const dir of AXES) {
        let far = -Infinity;
        for (const v of head) {
            const p = P(v);
            if (p[1] < bandLo || p[1] > bandHi) continue;
            far = Math.max(far, (p[0] - c[0]) * dir[0] + (p[2] - c[2]) * dir[2]);
        }
        if (!best || far > best.score + 1e-9) best = { dir, score: far };
    }
    return best!.dir;
}

/**
 * Add a jaw joint to a skinned model in its bind pose. The face direction and the mouth line come from the head's own
 * vertices (rigidly or mostly on the head joint): up is the model's +Y, the face looks along the horizontal direction in
 * which the feet point (else the side of the nose), the mouth line lies 40 % of the way from the nose tip down to the chin
 * and the hinge sits 45 % of the head's depth behind the front, at the mouth line raised by a tenth of the head height. Vertices of the head in front of the hinge plane and below the mouth line move to
 * the jaw, fading over a band so the cheeks stretch instead of tearing. Returns null when the model has no such head.
 */
export function addJaw(
    sk: Skeleton,
    positions: Float32Array,
    weights: readonly VertexWeights[],
    o: JawOptions = {},
): JawResult | null {
    const headName = (o.head ?? 'head').toLowerCase();
    const node = sk.nodes.find((n) => n.name.trim().toLowerCase() === headName && n.joint >= 0);
    if (!node) return null;
    if (sk.nodes.some((n) => /jaw/i.test(n.name) && n.joint >= 0)) return null; // has one already
    const hj = node.joint;
    const nv = weights.length;
    const P = (i: number): V3 => [positions[i * 3]!, positions[i * 3 + 1]!, positions[i * 3 + 2]!];
    const head: number[] = [];
    for (let v = 0; v < nv; v++) {
        const w = weights[v]!.find((x) => x.j === hj)?.w ?? 0;
        if (w >= 0.5) head.push(v);
    }
    if (head.length < 8) return null;
    let lo = Infinity,
        hi = -Infinity;
    const c: V3 = [0, 0, 0];
    for (const v of head) {
        const p = P(v);
        lo = Math.min(lo, p[1]);
        hi = Math.max(hi, p[1]);
        c[0] += p[0] / head.length;
        c[2] += p[2] / head.length;
    }
    const height = hi - lo;
    if (!(height > 0)) return null;
    // Face direction: the feet point forward. The mean horizontal offset of the foot vertices from their ankle joints
    // gives it; without feet, the side of the head whose extreme point (the nose) lies furthest out.
    const fwd = footForward(sk, positions, weights) ?? noseForward(head, P, c, lo, height);
    let front = -Infinity,
        back = Infinity;
    for (const v of head) {
        const p = P(v);
        const d = (p[0] - c[0]) * fwd[0] + (p[2] - c[2]) * fwd[2];
        front = Math.max(front, d);
        back = Math.min(back, d);
    }
    const depth = front - back;
    // The nose tip is the front-most head vertex in the middle band of the head, the chin the lowest vertex in the front
    // quarter; the mouth line lies 40 % of the way from the nose tip down to the chin (in game, a line through the nose's
    // underside dragged the nose open with the jaw).
    let noseY = hi - height * 0.6,
        noseD = -Infinity,
        chinY = Infinity;
    for (const v of head) {
        const p = P(v);
        const d = (p[0] - c[0]) * fwd[0] + (p[2] - c[2]) * fwd[2];
        if (p[1] >= lo + height * 0.2 && p[1] <= lo + height * 0.75 && d > noseD) {
            noseD = d;
            noseY = p[1];
        }
        if (d >= front - depth * 0.25) chinY = Math.min(chinY, p[1]);
    }
    if (!(chinY < noseY)) chinY = lo;
    const mouthY = noseY - (noseY - chinY) * 0.4;
    const hingeD = front - depth * 0.45;
    const hinge: V3 = [c[0] + fwd[0] * hingeD, mouthY + height * 0.1, c[2] + fwd[2] * hingeD];
    // left-right axis: up x forward
    const axis = unit(cross([0, 1, 0], fwd));
    const band = Math.max(1e-6, (noseY - chinY) * 0.12);
    const out = weights.map((w) => w.slice());
    let moved = 0;
    const jaw = sk.joints.length;
    for (const v of head) {
        const p = P(v);
        const d = (p[0] - c[0]) * fwd[0] + (p[2] - c[2]) * fwd[2];
        const below = (mouthY - p[1]) / band; // > 0 below the mouth line
        const ahead = (d - hingeD) / (depth * 0.15);
        const f = Math.max(0, Math.min(1, 0.5 + below)) * Math.max(0, Math.min(1, ahead));
        if (f <= 0) continue;
        const ws = out[v]!;
        const h = ws.find((x) => x.j === hj);
        if (!h) continue;
        const take = h.w * f;
        h.w -= take;
        ws.push({ j: jaw, w: take });
        out[v] = ws.filter((x) => x.w > 1e-6);
        moved++;
    }
    if (!moved) return null;
    // Joint: the head's orientation, origin at the hinge. xform is the inverse model-relative transform.
    // Row-vector matrices (skeleton.ts): the world transform's translation is the joint's origin in model space.
    const headWorld = invertMat12(sk.joints[hj]!.xform);
    const jawX: OotfMat12 = Array.from(invertMat12([...headWorld.slice(0, 9), ...hinge]));
    const joints: SkelJoint[] = sk.joints.map((j) => ({ ...j }));
    // Append as the last child of the head (siblings are linked by nextSibling).
    // A leaf: 0 ends the child and sibling lists in the data (no joint links back to the root), and the engine's walk follows
    // any other value, so -1 sent it into memory before the joint table (a frozen Ruined Village opening, 3 of 4 runs).
    const newJoint: SkelJoint = { xform: jawX, mesh: -1, firstChild: 0, nextSibling: 0, weights: [[]] };
    // 0 and -1 both end a list (joint 0 is the root and never a child), as in `jointParents`.
    if (joints[hj]!.firstChild <= 0) joints[hj] = { ...joints[hj]!, firstChild: jaw };
    else {
        let k = joints[hj]!.firstChild;
        while (joints[k]!.nextSibling > 0) k = joints[k]!.nextSibling;
        joints[k] = { ...joints[k]!, nextSibling: jaw };
    }
    joints.push({ ...newJoint, mesh: sk.joints[hj]!.mesh });
    const skeleton: Skeleton = {
        ...sk,
        joints,
        nodes: [...sk.nodes, { name: o.name ?? 'jaw', joint: jaw }],
        channels: [...sk.channels, { joint: jaw, caps: [] }],
    };
    return { skeleton, weights: out, joint: jaw, channel: sk.channels.length, axis, hinge, moved };
}

// ---------------------------------------------------------------------------------------------------- jaw clips

/** What a converted jaw needs at clip time: its joint and channel and the rig's rest pose. */
export interface JawRig {
    joint: number;
    channel: number;
    jointCount: number;
    channelCount: number;
    /** Rest pose per joint: local rotation (x, y, z, w) and translation. */
    restQ: [number, number, number, number][];
    restT: [number, number, number][];
    /** Hinge axis in model space (unit). */
    axis: [number, number, number];
    /** Parent (head) of the jaw. */
    parent: number;
    /** Model-space bind rotation (row-vector 3x3 + zero translation) of the jaw. */
    world: number[];
}

/** Rig data for `jawClip` / `withJawTrack` from a skeleton that `addJaw` returned. */
export function jawRig(jaw: Pick<JawResult, 'skeleton' | 'joint' | 'channel' | 'axis'>): JawRig {
    const rig = buildRig(jaw.skeleton, 0);
    const restQ: [number, number, number, number][] = [];
    const restT: [number, number, number][] = [];
    for (let j = 0; j < rig.jointCount; j++) {
        const l = rig.bindLocal.subarray(j * 12, j * 12 + 12);
        restQ.push(mat12ToQuat(l));
        restT.push([l[9]!, l[10]!, l[11]!]);
    }
    const w = invertMat12(jaw.skeleton.joints[jaw.joint]!.xform);
    return {
        joint: jaw.joint,
        channel: jaw.channel,
        jointCount: rig.jointCount,
        channelCount: jaw.skeleton.channels.length,
        restQ,
        restT,
        axis: [jaw.axis[0], jaw.axis[1], jaw.axis[2]],
        parent: rig.parents[jaw.joint]!,
        world: [...w.slice(0, 9), 0, 0, 0],
    };
}

/** Local rotation of the jaw opened by `angle` radians (positive opens: the chin moves down and back). */
export function jawRotation(r: JawRig, angle: number): [number, number, number, number] {
    // world' = world * Rm (row vectors, Rm about the model-space axis), local = world' * inverse(head world); the jaw's
    // bind rotation equals the head's, so local = W Rm W^T.
    const h = angle / 2; // about the left-right axis (up x forward); checked: the chin moves down and back
    const s = Math.sin(h);
    const rm = quatToMat12([r.axis[0] * s, r.axis[1] * s, r.axis[2] * s, Math.cos(h)], [0, 0, 0]);
    const wt = invertMat12(r.world);
    return mat12ToQuat(mulMat12(mulMat12(r.world, rm), wt));
}

/** A converted clip of the model before the jaw was added, with a resting jaw track appended. */
export function withJawTrack(a: Ps2Anim, r: JawRig): Ps2Anim {
    if (a.tracks.length !== r.joint) return a;
    const track: Ps2Track = {
        base: r.restT[r.joint]!,
        hasPos: false,
        keys: [{ time: 0, q: r.restQ[r.joint]!, pos: null }],
    };
    return { ...a, tracks: [...a.tracks, track], frames: a.tracks.length + 1, channels: r.channelCount };
}

/** Mouth opening per 1/25 s frame (0 closed .. 1 = `maxAngle`) of a lip-sync track's peaks (`lipSyncPeaks`). */
export const JAW_FRAME = 1 / 25;

/**
 * A clip that plays on the jaw channel: every other joint rests, the jaw follows `openings` (one value per 1/25 s, 0..1)
 * up to `maxAngle` radians and closes at the end. Keys the jaw does not need (within 0.3 degrees of a straight line) are
 * dropped. The clip plays once and holds its closed last frame.
 */
export function jawClip(
    r: JawRig,
    openings: readonly number[],
    name: string,
    maxAngle = (14 * Math.PI) / 180,
): Ps2Anim {
    const tracks: Ps2Track[] = [];
    for (let j = 0; j < r.jointCount; j++) {
        if (j === r.joint) continue;
        const root = j === 0;
        tracks.push({
            base: r.restT[j]!,
            hasPos: root,
            keys: [{ time: 0, q: r.restQ[j]!, pos: root ? r.restT[j]! : null }],
        });
    }
    const vals = [...openings.map((x) => Math.max(0, Math.min(1, x))), 0];
    const keys: { time: number; v: number }[] = vals.map((v, i) => ({ time: i * JAW_FRAME, v }));
    // drop keys a straight line between the kept neighbours reproduces
    const keep = keys.filter((k, i) => {
        if (i === 0 || i === keys.length - 1) return true;
        const a = keys[i - 1]!,
            b = keys[i + 1]!;
        return Math.abs(k.v - (a.v + b.v) / 2) * maxAngle > (0.3 * Math.PI) / 180;
    });
    const jawTrack: Ps2Track = {
        base: r.restT[r.joint]!,
        hasPos: false,
        keys: keep.map((k) => ({ time: k.time, q: jawRotation(r, k.v * maxAngle), pos: null })),
    };
    tracks.splice(r.joint, 0, jawTrack);
    return {
        name,
        duration: Math.max(JAW_FRAME, (vals.length - 1) * JAW_FRAME),
        flags: 1,
        frames: tracks.length,
        channels: r.channelCount,
        thresholds: { rotation: 0.2, scale: 1, translation: 1 },
        tracks,
    };
}

/**
 * Mouth openings (0..1, one per 1/25 s) of a speech sample: the peak |sample| of the first half of each frame, as the
 * disc's 0x0305 tracks (`encodeLipSync`), scaled so the 90th percentile opens 80 % and quiet frames stay shut.
 */
export function speechOpenings(pcm: ArrayLike<number>, rate: number): number[] {
    const step = Math.max(1, Math.round(rate / 25));
    const half = Math.max(1, step >> 1);
    const n = Math.ceil(pcm.length / step);
    const peaks: number[] = [];
    for (let i = 0; i < n; i++) {
        let p = 0;
        for (let k = i * step; k < Math.min(pcm.length, i * step + half); k++) p = Math.max(p, Math.abs(pcm[k]!));
        peaks.push(p);
    }
    const sorted = [...peaks].sort((a, b) => a - b);
    const p90 = sorted[Math.floor(sorted.length * 0.9)] ?? 0;
    if (p90 <= 0) return peaks.map(() => 0);
    return peaks.map((p) => {
        const x = (p / p90) * 0.8;
        return x < 0.08 ? 0 : Math.min(1, x);
    });
}

// ---------------------------------------------------------------------------------------------------- which models

export interface SkinUpgradeRow {
    /** PC model name (case and surrounding blanks ignored). */
    model: string;
    /** Who it is, for the report. */
    label: string;
    /** One curved subdivision step (`subdivideSkin`). */
    smooth: boolean;
    /** Add a jaw joint and channel (`addJaw`); converted scenes then move it while the character speaks. */
    jaw: boolean;
    /**
     * The jaw only when asked for by name (`DRAKAN_MODEL_UPGRADE=<regex>` naming the PC model): rows whose jaw placement was
     * not looked at in game. The smoother mesh is on either way.
     */
    jawAskOnly?: boolean;
}

/**
 * The Order of the Flame characters that still ship as their PC model (no Drakan 2 counterpart, ootfps2model.ts) and get the
 * upgrade, ranked by how much they are seen (journal 2026-11-16/ootf-model-upgrade.md). Names only, no game data.
 */
const speaker = (model: string, label: string, seen = false): SkinUpgradeRow => ({
    model,
    label,
    smooth: true,
    jaw: true,
    ...(seen ? {} : { jawAskOnly: true }),
});
const extra = (model: string, label: string): SkinUpgradeRow => ({ model, label, smooth: true, jaw: false });
export const DEFAULT_SKIN_UPGRADES: readonly SkinUpgradeRow[] = [
    // scene speakers (lines in converted scenes)
    speaker('Delon(h)', 'Delon (Ruined Village)', true),
    speaker('julian (h)', 'Julian (Ruined Village)', true),
    speaker('farmer', 'the magic farmer (Wartok Canyons)'),
    speaker('warrior2', 'the warrior (Wartok Canyons)'),
    speaker('tuiri (h)', 'Tuiri (Alwarren)'),
    speaker('tuiri(h)', 'Tuiri (Alwarren)'),
    speaker('Rimril', 'Rimril (Islands)'),
    speaker('hider', 'the hiding slave (Grimstone Mines)'),
    speaker('the queen(shaun)', 'Shillah (Succubus Lair, Volcanic)'),
    speaker('Succubus', 'the succubi (Islands, Volcanic)'),
    // seen in scenes and around the villages, no lines of their own (or a jaw the geometry rule does not place surely)
    extra('mvillager', 'villager'),
    extra('mvillage2', 'villager'),
    extra('fvillager', 'village woman'),
    extra('fvillage2', 'village woman'),
    extra('VillageDude', 'villager (Wartok Canyons)'),
    extra('VillageChick', 'village woman (Wartok Canyons)'),
    extra('slaveM (h)', 'mine slave'),
    extra('slaveM 02 (h)', 'mine slave'),
    extra('slaveM 03 (h)', 'mine slave'),
    extra('slaveM (brown shirt and black h', 'mine slave (Ruined Village)'),
    extra('wounded wizard', 'the wounded wizard'),
    extra('rackboy', 'the boy on the rack (Grimstone Mines)'),
    extra('rackvictim', 'rack victim'),
    extra('TGyroVictim01', 'gyro victim (Grimstone Mines)'),
];

/** The row for a PC model name, or null; without `asked` a row's `jawAskOnly` jaw is left out. */
export function skinUpgradeFor(
    name: string,
    rows: readonly SkinUpgradeRow[] = DEFAULT_SKIN_UPGRADES,
    asked = false,
): SkinUpgradeRow | null {
    const n = name.trim().toLowerCase();
    const row = rows.find((r) => r.model.trim().toLowerCase() === n) ?? null;
    return row && row.jawAskOnly && !asked ? { ...row, jaw: false } : row;
}

export interface UpgradedSkin {
    positions: Float32Array;
    polygons: SkinPoly[];
    skeleton: Skeleton;
    jaw: JawRig | null;
    /** Joint count before the jaw (the PC clips' track count). */
    pcJoints: number;
}

/**
 * Apply a row to a skinned LOD (positions and polygons of LOD 0, the PC skeleton with its LOD 0 weights). `keepTextures`
 * are the texture list entries drawn with alpha (cards, kept flat).
 */
export function upgradeSkin(
    input: { positions: Float32Array; polygons: readonly SkinPoly[]; skeleton: Skeleton },
    row: Pick<SkinUpgradeRow, 'smooth' | 'jaw'>,
    keepTextures: ReadonlySet<number>,
): UpgradedSkin {
    const nv = input.positions.length / 3;
    let mesh: SkinMesh = {
        positions: input.positions,
        polygons: input.polygons.map((p) => ({ ...p, indices: p.indices.slice(), uvs: p.uvs.slice() })),
        weights: vertexWeights(input.skeleton, nv),
    };
    if (row.smooth) mesh = subdivideSkin(mesh, { keepTextures });
    let skeleton = input.skeleton;
    let jaw: JawRig | null = null;
    if (row.jaw) {
        const j = addJaw(skeleton, mesh.positions, mesh.weights);
        if (j) {
            skeleton = j.skeleton;
            mesh = { ...mesh, weights: j.weights };
            jaw = jawRig(j);
        }
    }
    skeleton = withVertexWeights(skeleton, mesh.weights);
    return {
        positions: mesh.positions,
        polygons: mesh.polygons,
        skeleton,
        jaw,
        pcJoints: input.skeleton.joints.length,
    };
}
