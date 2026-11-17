/**
 * Authored replacement meshes for converted Order of the Flame characters: a mesh built from scratch in Blender (scripts
 * under `analysis/scripts/blender/`, no game data) replaces a PC character's LOD 0 at convert time, on the PC skeleton, so
 * the PC clips, hit spheres and scene channels keep working.
 *
 * The authored file holds geometry only (positions, triangles, material slots). Everything that comes from the game is
 * taken at convert time from the player's own PC model:
 *
 * - **Placement:** the authored mesh (Blender space: metres, Z up, facing -Y) is turned into PC space ((x, y, z) ->
 *   (x, z, y), a mirror, so the winding needs no change) and scaled and moved onto the PC LOD 0 box (`fit`).
 * - **UVs and textures:** a slot with `texture: 'pc'` projects each authored triangle onto the nearest PC triangle (of the
 *   slot's PC texture entries, if it names some) and takes that triangle's texture and the UVs of its plane. Alpha cards
 *   (hair fringes, wing membranes drawn with a cut-out texture) are only used by a slot that names them.
 * - **Weights:** each authored vertex takes the weights of the closest point on the PC mesh (barycentric mix of the three
 *   corners), capped at 4 joints, unless the file carries its own weights by joint name.
 */

import type { Skeleton } from './ootfanim.ts';
import type { RgbaImage } from './ootftex.ts';
import { type SkinPoly, type VertexWeights, mixWeights, subdivideSkin } from './ootfskinupgrade.ts';

export const AUTHORED_FORMAT = 'drakan-authored-model/1';

export interface AuthoredSlot {
    /** What the slot is (for the report and the Blender material). */
    name: string;
    /**
     * `pc`: UVs and texture projected from the PC model. `image`: the model's own texture (`image`, a PNG beside the file,
     * original art) with the file's own `uvs`.
     */
    texture: 'pc' | 'image';
    /** PC texture list entries the projection may use (default every opaque entry). */
    pcTextures?: readonly number[];
    /** `image` slots: the PNG file name (beside the model file); several slots may share one. */
    image?: string;
}

export interface AuthoredModel {
    format: typeof AUTHORED_FORMAT;
    /** PC model name it replaces (case and surrounding blanks ignored). */
    model: string;
    /** Who it is, for the report. */
    label: string;
    /**
     * How the mesh is placed on the PC model: `height` scales by the height (Y) of the PC LOD 0 box, `extent` by its
     * largest side; both centre X and Z on the PC box and put the lowest point on its floor.
     */
    fit: 'height' | 'extent' | 'joints';
    /**
     * `fit: 'joints'`: where the authored mesh has the PC joints (names), Blender space. The mesh is warped piecewise per
     * axis so each landmark lands on the PC joint's bind position: height along the body, sideways out along the arms (by
     * distance from the middle), depth by the overall scale.
     */
    landmarks?: Record<string, [number, number, number]>;
    /** Blender space, metres: x0, y0, z0, x1 ... */
    positions: number[];
    /** a, b, c, slot per triangle, counter-clockwise seen from outside (Blender). */
    triangles: number[];
    slots: AuthoredSlot[];
    /**
     * Joints (names) whose triangles are projected along rays from the joint onto the PC triangles of the same joint
     * instead of onto the nearest PC triangle (default `head`): a head with fuller hair or another face shape still takes
     * the face where it looks out from the skull.
     */
    radialJoints?: readonly string[];
    /**
     * Joints (names) whose part stays the PC model's, smoothed once (`subdivideSkin`), in place of the authored triangles
     * skinned mostly to them: Delon keeps his 1999 head and face texture on the new body.
     */
    keepPcJoints?: readonly string[];
    /**
     * Per triangle corner UVs (u0, v0, u1, v1, u2, v2 per triangle, Blender convention: v up), needed when a slot is `image`;
     * entries of `pc` slot triangles are ignored.
     */
    uvs?: number[];
    /** Decoded `image` slot pictures by file name; attached by the loader (CLI, editor), not stored in the file. */
    images?: Record<string, RgbaImage>;
    /** Optional own weights: per vertex [joint name, weight, joint name, weight ...]. */
    weights?: (string | number)[][];
}

export interface AuthoredFit {
    positions: Float32Array;
    polygons: SkinPoly[];
    weights: VertexWeights[];
    /** Authored triangles whose slot found no PC triangle (dropped). */
    dropped: number;
    /**
     * The `image` slot pictures the polygons use, in order: a polygon whose texture is `pcTextureCount + k` shows
     * `images[k]` (the caller appends them to the PC texture list).
     */
    images: string[];
}

type V3 = [number, number, number];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const at = (p: ArrayLike<number>, i: number): V3 => [p[i * 3]!, p[i * 3 + 1]!, p[i * 3 + 2]!];

/** Check an authored file's shape; returns the reason it cannot be used, or null. */
export function authoredProblem(m: unknown): string | null {
    const a = m as Partial<AuthoredModel> | null;
    if (!a || typeof a !== 'object') return 'not an object';
    if (a.format !== AUTHORED_FORMAT) return `format is not ${AUTHORED_FORMAT}`;
    if (typeof a.model !== 'string' || !a.model.trim()) return 'no model name';
    if (a.fit !== 'height' && a.fit !== 'extent' && a.fit !== 'joints') return 'fit must be height, extent or joints';
    if (a.fit === 'joints' && Object.keys(a.landmarks ?? {}).length < 3) return 'fit joints needs 3 landmarks or more';
    if (!Array.isArray(a.positions) || a.positions.length % 3 || a.positions.length === 0) return 'bad positions';
    if (!Array.isArray(a.triangles) || a.triangles.length % 4 || a.triangles.length === 0) return 'bad triangles';
    if (!Array.isArray(a.slots) || a.slots.length === 0) return 'no slots';
    for (const sl of a.slots) {
        if (sl.texture !== 'pc' && sl.texture !== 'image') return `slot ${sl.name}: texture must be pc or image`;
        if (sl.texture === 'image' && !sl.image) return `slot ${sl.name}: an image slot needs an image`;
    }
    if (a.slots.some((sl) => sl.texture === 'image') && a.uvs?.length !== (a.triangles.length / 4) * 6)
        return 'image slots need 6 uvs per triangle';
    const nv = a.positions.length / 3;
    for (let i = 0; i < a.triangles.length; i += 4) {
        for (let k = 0; k < 3; k++) {
            const v = a.triangles[i + k]!;
            if (!Number.isInteger(v) || v < 0 || v >= nv) return `triangle ${i / 4} names vertex ${v}`;
        }
        const s = a.triangles[i + 3]!;
        if (!Number.isInteger(s) || s < 0 || s >= a.slots.length) return `triangle ${i / 4} names slot ${s}`;
    }
    if (a.weights && a.weights.length !== nv) return 'weights do not cover every vertex';
    return null;
}

const cross3 = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/** Ray o + t d against triangle abc (Moller-Trumbore): t, or null for a miss. */
function rayTri(o: V3, d: V3, a: V3, b: V3, c: V3): number | null {
    const e1 = sub(b, a);
    const e2 = sub(c, a);
    const p = cross3(d, e2);
    const det = dot(e1, p);
    if (Math.abs(det) < 1e-12) return null;
    const inv = 1 / det;
    const tv = sub(o, a);
    const u = dot(tv, p) * inv;
    if (u < -1e-6 || u > 1 + 1e-6) return null;
    const q = cross3(tv, e1);
    const v = dot(d, q) * inv;
    if (v < -1e-6 || u + v > 1 + 1e-6) return null;
    const t = dot(e2, q) * inv;
    return t > 0 ? t : null;
}

/**
 * Bind position of joint `j`. Its inverse bind is model-to-joint with row vectors (p' = p R + t), so the joint origin
 * (p' = 0) is p = -t R^-1. R is not always a pure rotation: the Boss Blade Dragon's joints carry a uniform scale of
 * about 0.79, where -(t R^T) put them at 62 % of their place.
 */
export function jointOrigin(sk: Pick<Skeleton, 'joints'>, j: number): V3 {
    const x = sk.joints[j]!.xform;
    const [a, b, c, d, e, f, g, h, i] = [x[0]!, x[1]!, x[2]!, x[3]!, x[4]!, x[5]!, x[6]!, x[7]!, x[8]!];
    const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
    if (Math.abs(det) < 1e-20) return [0, 0, 0];
    // inverse of the row-major 3x3 [a b c; d e f; g h i]
    const inv = [
        (e * i - f * h) / det,
        (c * h - b * i) / det,
        (b * f - c * e) / det,
        (f * g - d * i) / det,
        (a * i - c * g) / det,
        (c * d - a * f) / det,
        (d * h - e * g) / det,
        (b * g - a * h) / det,
        (a * e - b * d) / det,
    ];
    const t: V3 = [x[9]!, x[10]!, x[11]!];
    // row vector t times inv
    return [
        -(t[0] * inv[0]! + t[1] * inv[3]! + t[2] * inv[6]!),
        -(t[0] * inv[1]! + t[1] * inv[4]! + t[2] * inv[7]!),
        -(t[0] * inv[2]! + t[1] * inv[5]! + t[2] * inv[8]!),
    ];
}

/** The joint carrying most of the summed weight of some vertices, or -1. */
function dominant(lists: readonly (VertexWeights | undefined)[]): number {
    const acc = new Map<number, number>();
    for (const l of lists) for (const x of l ?? []) acc.set(x.j, (acc.get(x.j) ?? 0) + x.w);
    let best = -1;
    let bw = 0;
    for (const [j, w] of acc)
        if (w > bw) {
            bw = w;
            best = j;
        }
    return best;
}

/** Closest point of triangle abc to p, as barycentric weights (Ericson, Real-Time Collision Detection 5.1.5). */
export function closestBary(p: V3, a: V3, b: V3, c: V3): V3 {
    const ab = sub(b, a);
    const ac = sub(c, a);
    const ap = sub(p, a);
    const d1 = dot(ab, ap);
    const d2 = dot(ac, ap);
    if (d1 <= 0 && d2 <= 0) return [1, 0, 0];
    const bp = sub(p, b);
    const d3 = dot(ab, bp);
    const d4 = dot(ac, bp);
    if (d3 >= 0 && d4 <= d3) return [0, 1, 0];
    const vc = d1 * d4 - d3 * d2;
    if (vc <= 0 && d1 >= 0 && d3 <= 0) {
        const v = d1 / (d1 - d3);
        return [1 - v, v, 0];
    }
    const cp = sub(p, c);
    const d5 = dot(ab, cp);
    const d6 = dot(ac, cp);
    if (d6 >= 0 && d5 <= d6) return [0, 0, 1];
    const vb = d5 * d2 - d1 * d6;
    if (vb <= 0 && d2 >= 0 && d6 <= 0) {
        const w = d2 / (d2 - d6);
        return [1 - w, 0, w];
    }
    const va = d3 * d6 - d5 * d4;
    if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
        const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
        return [0, 1 - w, w];
    }
    const denom = 1 / (va + vb + vc);
    const v = vb * denom;
    const w = vc * denom;
    return [1 - v - w, v, w];
}

/** Barycentric coordinates of p projected onto the plane of abc (may be outside 0..1). */
function planeBary(p: V3, a: V3, b: V3, c: V3): V3 {
    const v0 = sub(b, a);
    const v1 = sub(c, a);
    const v2 = sub(p, a);
    const d00 = dot(v0, v0);
    const d01 = dot(v0, v1);
    const d11 = dot(v1, v1);
    const d20 = dot(v2, v0);
    const d21 = dot(v2, v1);
    const den = d00 * d11 - d01 * d01;
    if (Math.abs(den) < 1e-20) return [1, 0, 0];
    const v = (d11 * d20 - d01 * d21) / den;
    const w = (d00 * d21 - d01 * d20) / den;
    return [1 - v - w, v, w];
}

/** The authored positions in PC space, placed on the PC LOD 0 box. */
/** Piecewise-linear map through sorted (from, to) pairs; outside them, the end pair plus `slope` times the distance. */
export function piecewise(pairs: readonly [number, number][], slope: number): (x: number) => number {
    const sorted = [...pairs].sort((a, b) => a[0] - b[0]);
    const pts: [number, number][] = [];
    for (const [a, b] of sorted) {
        const last = pts[pts.length - 1];
        if (last && Math.abs(a - last[0]) < 1e-6) last[1] = (last[1] + b) / 2;
        else pts.push([a, b]);
    }
    return (x) => {
        if (!pts.length) return x * slope;
        const f = pts[0]!;
        const l = pts[pts.length - 1]!;
        if (x <= f[0]) return f[1] + (x - f[0]) * slope;
        if (x >= l[0]) return l[1] + (x - l[0]) * slope;
        let k = 1;
        while (pts[k]![0] < x) k++;
        const [a0, b0] = pts[k - 1]!;
        const [a1, b1] = pts[k]!;
        return b0 + ((x - a0) / (a1 - a0)) * (b1 - b0);
    };
}

/** Warp PC-space authored positions onto PC joints: `pairs` are (authored PC-space point, PC joint origin). */
function warpToJoints(pcSpace: Float32Array, pairs: readonly [V3, V3][]): void {
    const n = pcSpace.length / 3;
    // overall scale: least squares of the vertical spread
    const ma = pairs.reduce((s, p) => s + p[0][1], 0) / pairs.length;
    const mb = pairs.reduce((s, p) => s + p[1][1], 0) / pairs.length;
    let num = 0;
    let den = 0;
    for (const [a, b] of pairs) {
        num += (a[1] - ma) * (b[1] - mb);
        den += (a[1] - ma) ** 2;
    }
    const s = den > 0 && num > 0 ? num / den : 1;
    const up = piecewise(
        pairs.map(([a, b]) => [a[1], b[1]]),
        s,
    );
    const out = piecewise([[0, 0], ...pairs.map(([a, b]) => [Math.abs(a[0]), Math.abs(b[0])] as [number, number])], s);
    const depth = pairs.reduce((acc, [a, b]) => acc + (b[2] - a[2] * s), 0) / pairs.length;
    for (let i = 0; i < n; i++) {
        const x = pcSpace[i * 3]!;
        pcSpace[i * 3] = Math.sign(x) * out(Math.abs(x));
        pcSpace[i * 3 + 1] = up(pcSpace[i * 3 + 1]!);
        pcSpace[i * 3 + 2] = pcSpace[i * 3 + 2]! * s + depth;
    }
}

export function placeAuthored(
    m: Pick<AuthoredModel, 'positions' | 'fit' | 'landmarks'>,
    pcPositions: ArrayLike<number>,
    joints?: (name: string) => V3 | null,
): Float32Array {
    const n = m.positions.length / 3;
    const pcSpace = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
        pcSpace[i * 3] = m.positions[i * 3]!;
        pcSpace[i * 3 + 1] = m.positions[i * 3 + 2]!;
        pcSpace[i * 3 + 2] = m.positions[i * 3 + 1]!;
    }
    if (m.fit === 'joints' && joints) {
        const pairs: [V3, V3][] = [];
        for (const [name, p] of Object.entries(m.landmarks ?? {})) {
            const j = joints(name);
            if (j) pairs.push([[p[0], p[2], p[1]], j]);
        }
        if (pairs.length >= 3) {
            warpToJoints(pcSpace, pairs);
            return pcSpace;
        }
    }
    const box = (p: ArrayLike<number>) => {
        const lo = [Infinity, Infinity, Infinity];
        const hi = [-Infinity, -Infinity, -Infinity];
        for (let i = 0; i < p.length; i++) {
            lo[i % 3] = Math.min(lo[i % 3]!, p[i]!);
            hi[i % 3] = Math.max(hi[i % 3]!, p[i]!);
        }
        return { lo, hi, size: hi.map((h, k) => h - lo[k]!) };
    };
    const A = box(pcSpace);
    const P = box(pcPositions);
    const s = m.fit !== 'extent' ? P.size[1]! / (A.size[1]! || 1) : Math.max(...P.size) / (Math.max(...A.size) || 1);
    const ax = (A.lo[0]! + A.hi[0]!) / 2;
    const az = (A.lo[2]! + A.hi[2]!) / 2;
    const px = (P.lo[0]! + P.hi[0]!) / 2;
    const pz = (P.lo[2]! + P.hi[2]!) / 2;
    for (let i = 0; i < n; i++) {
        pcSpace[i * 3] = (pcSpace[i * 3]! - ax) * s + px;
        pcSpace[i * 3 + 1] = (pcSpace[i * 3 + 1]! - A.lo[1]!) * s + P.lo[1]!;
        pcSpace[i * 3 + 2] = (pcSpace[i * 3 + 2]! - az) * s + pz;
    }
    return pcSpace;
}

/**
 * Fit an authored mesh onto a PC skinned LOD 0: positions in PC space, polygons with PC texture entries and projected
 * UVs, and per-vertex weights (joint indices of `skeleton`). `alphaTextures`: PC texture entries that are cut-out cards.
 */
export function fitAuthored(
    m: AuthoredModel,
    pc: { positions: ArrayLike<number>; polygons: readonly SkinPoly[]; weights: readonly VertexWeights[] },
    skeleton: Skeleton,
    alphaTextures: ReadonlySet<number> = new Set(),
    pcTextureCount = 0,
): AuthoredFit {
    const images: string[] = [];
    const byName = new Map<string, number>();
    for (const n of skeleton.nodes ?? [])
        if (n.joint >= 0 && n.joint < skeleton.joints.length && !byName.has(n.name.trim().toLowerCase()))
            byName.set(n.name.trim().toLowerCase(), n.joint);
    const positions = placeAuthored(m, pc.positions, (name) => {
        const j = byName.get(name.trim().toLowerCase());
        return j === undefined ? null : jointOrigin(skeleton, j);
    });
    const pcTris: { v: [number, number, number]; uv: number[]; texture: number; flags: number }[] = [];
    for (const p of pc.polygons) {
        // fan-triangulate (PC skinned LODs are triangles; keep quads safe)
        for (let k = 1; k + 1 < p.indices.length; k++)
            pcTris.push({
                v: [p.indices[0]!, p.indices[k]!, p.indices[k + 1]!],
                uv: [
                    p.uvs[0]!,
                    p.uvs[1]!,
                    p.uvs[k * 2]!,
                    p.uvs[k * 2 + 1]!,
                    p.uvs[(k + 1) * 2]!,
                    p.uvs[(k + 1) * 2 + 1]!,
                ],
                texture: p.texture,
                flags: p.flags,
            });
    }
    const corners = pcTris.map((t) => t.v.map((i) => at(pc.positions, i)) as [V3, V3, V3]);
    const nearest = (p: V3, allow: (t: number) => boolean): { t: number; bary: V3 } | null => {
        let best = -1;
        let bestD = Infinity;
        let bestB: V3 = [1, 0, 0];
        for (let t = 0; t < pcTris.length; t++) {
            if (!allow(t)) continue;
            const [a, b, c] = corners[t]!;
            const bb = closestBary(p, a, b, c);
            const q: V3 = [
                a[0] * bb[0] + b[0] * bb[1] + c[0] * bb[2],
                a[1] * bb[0] + b[1] * bb[1] + c[1] * bb[2],
                a[2] * bb[0] + b[2] * bb[1] + c[2] * bb[2],
            ];
            const d = dot(sub(p, q), sub(p, q));
            if (d < bestD) {
                bestD = d;
                best = t;
                bestB = bb;
            }
        }
        return best < 0 ? null : { t: best, bary: bestB };
    };

    // weights
    const nv = positions.length / 3;
    let weights: VertexWeights[];
    if (m.weights) {
        weights = m.weights.map((list) => {
            const acc: VertexWeights = [];
            for (let k = 0; k + 1 < list.length; k += 2) {
                const j = byName.get(String(list[k]).trim().toLowerCase());
                if (j !== undefined) acc.push({ j, w: Number(list[k + 1]) });
            }
            return mixWeights(acc, acc);
        });
    } else {
        weights = [];
        for (let i = 0; i < nv; i++) {
            const hit = nearest(at(positions, i), () => true);
            if (!hit) {
                weights.push([{ j: 0, w: 1 }]);
                continue;
            }
            const [a, b, c] = pcTris[hit.t]!.v;
            const acc = new Map<number, number>();
            [a, b, c].forEach((v, k) => {
                for (const x of pc.weights[v] ?? []) acc.set(x.j, (acc.get(x.j) ?? 0) + x.w * hit.bary[k]!);
            });
            const list = [...acc].map(([j, w]) => ({ j, w }));
            weights.push(mixWeights(list, list));
        }
    }

    // polygons: texture and UVs from the nearest PC triangle of the slot (or along rays from a radial joint), PC winding
    const radial = new Map<number, V3>();
    for (const name of m.radialJoints ?? ['head']) {
        const j = byName.get(name.trim().toLowerCase());
        if (j !== undefined) radial.set(j, jointOrigin(skeleton, j));
    }
    const pcJoint = pcTris.map((t) => dominant(t.v.map((v) => pc.weights[v])));
    const keepJoints = new Set<number>();
    for (const name of m.keepPcJoints ?? []) {
        const j = byName.get(name.trim().toLowerCase());
        if (j !== undefined) keepJoints.add(j);
    }
    const polygons: SkinPoly[] = [];
    let dropped = 0;
    for (let i = 0; i < m.triangles.length; i += 4) {
        const slot = m.slots[m.triangles[i + 3]!]!;
        const named = slot.pcTextures ? new Set(slot.pcTextures) : null;
        const allow = (t: number) => {
            const tex = pcTris[t]!.texture;
            return named ? named.has(tex) : !alphaTextures.has(tex);
        };
        // the y/z swap already mirrors, so Blender's counter-clockwise order is the PC order as it stands
        const ids = [m.triangles[i]!, m.triangles[i + 1]!, m.triangles[i + 2]!];
        const ps = ids.map((v) => at(positions, v));
        const centre: V3 = [
            (ps[0]![0] + ps[1]![0] + ps[2]![0]) / 3,
            (ps[0]![1] + ps[1]![1] + ps[2]![1]) / 3,
            (ps[0]![2] + ps[1]![2] + ps[2]![2]) / 3,
        ];
        const joint = dominant(ids.map((v) => weights[v]));
        // the PC part is kept instead: drop a triangle only when every corner belongs to a kept joint, so the triangles
        // along the seam stay and overlap the kept edge (dropped by their dominant joint they left a hole under the chin)
        if (keepJoints.size && ids.every((v) => keepJoints.has(dominant([weights[v]])))) continue;
        if (slot.texture === 'image') {
            // the model's own texture: its own UVs (Blender v points up, the PC one down)
            let k = images.indexOf(slot.image!);
            if (k < 0) k = images.push(slot.image!) - 1;
            const t = (i / 4) * 6;
            const u = m.uvs!;
            polygons.push({
                flags: 0,
                texture: pcTextureCount + k,
                indices: ids,
                uvs: [u[t]!, 1 - u[t + 1]!, u[t + 2]!, 1 - u[t + 3]!, u[t + 4]!, 1 - u[t + 5]!],
            });
            continue;
        }
        const origin = radial.get(joint);
        let hitT = -1;
        if (origin) {
            const d = sub(centre, origin);
            let best = Infinity;
            for (let t = 0; t < pcTris.length; t++) {
                if (pcJoint[t] !== joint || !allow(t)) continue;
                const [a, b, c] = corners[t]!;
                const r = rayTri(origin, d, a, b, c);
                if (r !== null && Math.abs(r - 1) < best) {
                    best = Math.abs(r - 1);
                    hitT = t;
                }
            }
        }
        const rayHit = hitT >= 0;
        if (!rayHit) {
            const hit = nearest(centre, allow);
            if (!hit) {
                dropped++;
                continue;
            }
            hitT = hit.t;
        }
        const t = pcTris[hitT]!;
        const [a, b, c] = corners[hitT]!;
        const n = cross3(sub(b, a), sub(c, a));
        const uvs: number[] = [];
        for (const p of ps) {
            let q = p;
            if (rayHit && origin) {
                // where the ray from the joint through this corner meets the PC triangle's plane
                const d = sub(p, origin);
                const den = dot(n, d);
                const s2 = Math.abs(den) > 1e-12 ? dot(n, sub(a, origin)) / den : -1;
                if (s2 > 0) q = [origin[0] + d[0] * s2, origin[1] + d[1] * s2, origin[2] + d[2] * s2];
            }
            // the plane's barycentrics, held within 10 % of the triangle: further out the UVs reach neighbouring patches of the
            // texture sheet (the gore patches beside the clothes)
            const raw = planeBary(q, a, b, c);
            const cl = raw.map((x) => Math.min(1.1, Math.max(-0.1, x))) as V3;
            const sum = cl[0] + cl[1] + cl[2] || 1;
            const bb = cl.map((x) => x / sum);
            uvs.push(
                t.uv[0]! * bb[0]! + t.uv[2]! * bb[1]! + t.uv[4]! * bb[2]!,
                t.uv[1]! * bb[0]! + t.uv[3]! * bb[1]! + t.uv[5]! * bb[2]!,
            );
        }
        polygons.push({ flags: t.flags, texture: t.texture, indices: ids, uvs });
    }
    if (!keepJoints.size) return compact({ positions, polygons, weights, dropped, images });
    // The PC triangles of the kept joints (a 1999 head with its face texture and hair cards), one smoothing step, appended
    // with only the vertices they use.
    const kept = pc.polygons.filter((p) => keepJoints.has(dominant(p.indices.map((v) => pc.weights[v]))));
    const smooth = subdivideSkin(
        { positions: Float32Array.from(pc.positions), polygons: kept, weights: pc.weights.slice() },
        { keepTextures: alphaTextures },
    );
    const remap = new Map<number, number>();
    const outPos = Array.from(positions);
    const outW = weights.slice();
    for (const p of smooth.polygons)
        for (const v of p.indices)
            if (!remap.has(v)) {
                remap.set(v, outPos.length / 3);
                outPos.push(smooth.positions[v * 3]!, smooth.positions[v * 3 + 1]!, smooth.positions[v * 3 + 2]!);
                outW.push(smooth.weights[v] ?? [{ j: 0, w: 1 }]);
            }
    for (const p of smooth.polygons) polygons.push({ ...p, indices: p.indices.map((v) => remap.get(v)!) });
    return compact({ positions: Float32Array.from(outPos), polygons, weights: outW, dropped, images });
}

/** Drop vertices no polygon uses (authored parts replaced by kept PC parts). */
function compact(f: AuthoredFit): AuthoredFit {
    const remap = new Map<number, number>();
    const pos: number[] = [];
    const w: VertexWeights[] = [];
    const polygons = f.polygons.map((p) => ({
        ...p,
        indices: p.indices.map((v) => {
            let n = remap.get(v);
            if (n === undefined) {
                n = pos.length / 3;
                remap.set(v, n);
                pos.push(f.positions[v * 3]!, f.positions[v * 3 + 1]!, f.positions[v * 3 + 2]!);
                w.push(f.weights[v]!);
            }
            return n;
        }),
    }));
    return { positions: Float32Array.from(pos), polygons, weights: w, dropped: f.dropped, images: f.images };
}

/** Authored models by PC model name (case and surrounding blanks ignored). */
export function authoredIndex(models: readonly AuthoredModel[]): Map<string, AuthoredModel> {
    return new Map(models.map((m) => [m.model.trim().toLowerCase(), m]));
}
