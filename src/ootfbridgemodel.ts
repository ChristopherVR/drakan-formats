/**
 * Order of the Flame rope bridges drawn in Drakan 2 style (ootfps2model.ts props rows with `bridge`): the OotF walkway, a flat
 * strip with planks painted on it, becomes a row of separate boards with gaps, each board's top on the OotF walkway surface
 * (Rynn walks on the OotF surface, which is still what she collides with) and two rope stringers under the board ends; every
 * flat OotF rope strip becomes a round rope; the other OotF parts (posts, rocks) stay, optionally drawn with the matching
 * Drakan 2 texture. Textures are the Drakan 2 rope bridge's (LEVEL2RE "SusBridge02": its planks, its post wrap and its rope).
 * No game data here: the meshes come from the player's install and disc at convert time.
 */

import type { NeutralModel } from './ootfmodel.ts';

export interface BridgeOptions {
    /** OotF texture-list entries of the walkway (both faces); their up-facing sheets become boards. */
    planks: readonly number[];
    /** OotF texture-list entries of the ropes; every rope strip becomes a round rope. */
    ropes: readonly number[];
    /** Disc texture-list entries: the board texture (boards side by side across it), the rope. */
    plankTexture: number;
    ropeTexture: number;
    /** Kept OotF parts drawn with a disc texture instead: OotF texture-list entry -> disc texture-list entry. */
    retexture?: Readonly<Record<number, number>>;
    /** Boards painted side by side across the board texture (default 4). */
    boardsAcross?: number;
}

type Mesh = Pick<NeutralModel, 'positions' | 'normals' | 'polygons'>;
type V3 = [number, number, number];

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a: V3) => Math.hypot(a[0], a[1], a[2]);
const norm = (a: V3): V3 => {
    const l = len(a);
    return l > 1e-12 ? mul(a, 1 / l) : [0, 1, 0];
};

class Out {
    positions: number[] = [];
    normals: number[] = [];
    polygons: NeutralModel['polygons'] = [];
    vert(p: V3, n: V3): number {
        this.positions.push(p[0], p[1], p[2]);
        const u = norm(n);
        for (const x of u) this.normals.push(Math.max(-127, Math.min(127, Math.round(x * 127))));
        return this.positions.length / 3 - 1;
    }
    /** A quad a b c d (counter-clockwise seen from `n`), flat shaded, both triangles. */
    quad(p: V3[], uv: number[][], n: V3, texture: number, twoSided = false): void {
        const v = p.map((x) => this.vert(x, n));
        const tri = (i: number, j: number, k: number) =>
            this.polygons.push({
                flags: twoSided ? 2 : 0,
                texture,
                indices: [v[i]!, v[j]!, v[k]!],
                uvs: [...uv[i]!, ...uv[j]!, ...uv[k]!],
            });
        tri(0, 1, 2);
        tri(0, 2, 3);
    }
}

/** Triangles of the model with their corner positions. */
function triangles(m: Mesh, textures: ReadonlySet<number>) {
    const P = (i: number): V3 => [m.positions[i * 3]!, m.positions[i * 3 + 1]!, m.positions[i * 3 + 2]!];
    const out: { p: V3[]; idx: number[]; uv: number[]; texture: number; flags: number }[] = [];
    for (const q of m.polygons) {
        if (!textures.has(q.texture)) continue;
        for (let k = 1; k + 1 < q.indices.length; k++) {
            const idx = [q.indices[0]!, q.indices[k]!, q.indices[k + 1]!];
            const uv = [0, k, k + 1].flatMap((c) => [q.uvs[c * 2]!, q.uvs[c * 2 + 1]!]);
            out.push({ p: idx.map(P), idx, uv, texture: q.texture, flags: q.flags });
        }
    }
    return out;
}

const pkey = (p: V3) => p.map((x) => Math.round(x * 2000)).join(',');

/**
 * Connected groups of triangles: sharing a corner position, or with `smooth` sharing an edge and turned within about 8 degrees
 * of each other (a walkway sheet that bends gently stays one sheet, a platform and the ramp that leaves it are two).
 */
function components<T extends { p: V3[] }>(tris: T[], smooth = false): T[][] {
    const parent = tris.map((_, i) => i);
    const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
    const owner = new Map<string, number>();
    const fn = tris.map((t) => norm(cross(sub(t.p[1]!, t.p[0]!), sub(t.p[2]!, t.p[0]!))));
    tris.forEach((t, i) => {
        const keys = smooth
            ? [0, 1, 2].map((e) => [pkey(t.p[e]!), pkey(t.p[(e + 1) % 3]!)].sort().join('|'))
            : t.p.map(pkey);
        for (const k of keys) {
            const o = owner.get(k);
            if (o === undefined) owner.set(k, i);
            else if (!smooth || Math.abs(dot(fn[i]!, fn[o]!)) > 0.99) parent[find(i)] = find(o);
        }
    });
    const groups = new Map<number, T[]>();
    tris.forEach((t, i) => (groups.get(find(i)) ?? groups.set(find(i), []).get(find(i))!).push(t));
    return [...groups.values()];
}

/** Boards over one walkway sheet (a connected group of up-facing walkway triangles). */
function boards(
    out: Out,
    sheet: { p: V3[] }[],
    opt: BridgeOptions,
    texture: number,
    ropeTexture: number,
    along: V3,
    pitch: number,
): void {
    // frame: n = area weighted normal (up), a = the walkway's long axis in this plane, b = across
    let n: V3 = [0, 0, 0];
    const pts: V3[] = [];
    for (const t of sheet) {
        n = add(n, cross(sub(t.p[1]!, t.p[0]!), sub(t.p[2]!, t.p[0]!)));
        pts.push(...t.p);
    }
    if (n[1] < 0) n = mul(n, -1);
    n = norm(n);
    const c = mul(
        pts.reduce((s, p) => add(s, p), [0, 0, 0] as V3),
        1 / pts.length,
    );
    // boards run across the bridge: `along` (the whole walkway's long axis) laid into this sheet's plane
    const a = norm(sub(along, mul(n, dot(along, n))));
    const b = cross(n, a);
    const loc = (p: V3) => [dot(sub(p, c), a), dot(sub(p, c), b), dot(sub(p, c), n)] as const;
    const L = sheet.map((t) => t.p.map(loc));
    let tMin = Infinity,
        tMax = -Infinity;
    for (const t of L)
        for (const q of t) {
            tMin = Math.min(tMin, q[0]);
            tMax = Math.max(tMax, q[0]);
        }
    // across extent and height at t: from the sheet's triangles cut by the line t = const
    const cut = (tc: number): { s0: number; s1: number } | null => {
        let s0 = Infinity,
            s1 = -Infinity;
        for (const t of L)
            for (let e = 0; e < 3; e++) {
                const p = t[e]!,
                    q = t[(e + 1) % 3]!;
                if ((p[0] - tc) * (q[0] - tc) > 0 || p[0] === q[0]) continue;
                const f = (tc - p[0]) / (q[0] - p[0]);
                const s = p[1] + (q[1] - p[1]) * f;
                s0 = Math.min(s0, s);
                s1 = Math.max(s1, s);
            }
        return s1 > s0 ? { s0, s1 } : null;
    };
    const height = (tc: number, sc: number): number | null => {
        let best: number | null = null;
        let bestD = Infinity;
        for (const t of L) {
            const [p, q, r] = t as unknown as [readonly number[], readonly number[], readonly number[]];
            const det = (q[1]! - r[1]!) * (p[0]! - r[0]!) + (r[0]! - q[0]!) * (p[1]! - r[1]!);
            if (Math.abs(det) < 1e-12) continue;
            const w0 = ((q[1]! - r[1]!) * (tc - r[0]!) + (r[0]! - q[0]!) * (sc - r[1]!)) / det;
            const w1 = ((r[1]! - p[1]!) * (tc - r[0]!) + (p[0]! - r[0]!) * (sc - r[1]!)) / det;
            const w2 = 1 - w0 - w1;
            const d = Math.max(0, -w0, -w1, -w2);
            if (d < bestD) {
                bestD = d;
                const k = [Math.max(0, w0), Math.max(0, w1), Math.max(0, w2)];
                const ks = k[0]! + k[1]! + k[2]!;
                best = (k[0]! * p[2]! + k[1]! * q[2]! + k[2]! * r[2]!) / ks;
            }
        }
        return best;
    };
    const mid = cut((tMin + tMax) / 2);
    if (!mid) return;
    const width = mid.s1 - mid.s0;
    const gap = pitch * 0.18;
    const thick = width * 0.06;
    const count = Math.floor((tMax - tMin) / pitch);
    if (count < 1) return;
    const start = tMin + (tMax - tMin - count * pitch) / 2;
    const W = (t: number, s: number, h: number): V3 => add(add(add(c, mul(a, t)), mul(b, s)), mul(n, h));
    const across = opt.boardsAcross ?? 4;
    const ends: { t: number; s0: number; s1: number; h0: number; h1: number }[] = [];
    for (let i = 0; i < count; i++) {
        const t0 = start + i * pitch + gap / 2;
        const t1 = t0 + pitch - gap;
        const r0 = cut(t0 + 1e-6),
            r1 = cut(t1 - 1e-6);
        if (!r0 || !r1) continue;
        const s0 = Math.max(r0.s0, r1.s0),
            s1 = Math.min(r0.s1, r1.s1);
        if (s1 - s0 < width * 0.5) continue;
        const h = [height(t0, s0), height(t1, s0), height(t1, s1), height(t0, s1)];
        if (h.some((x) => x === null)) continue;
        const top = [W(t0, s0, h[0]!), W(t1, s0, h[1]!), W(t1, s1, h[2]!), W(t0, s1, h[3]!)];
        const bot = top.map((p) => sub(p, mul(n, thick)));
        // which painted board of the texture: varied per board, never two neighbours alike
        const k = (i * 7 + 3) % across;
        const u0 = k / across + 0.01,
            u1 = (k + 1) / across - 0.01;
        const vEnd = 1;
        // top (seen from +n), bottom, the two long sides, the two ends
        out.quad(
            [top[0]!, top[1]!, top[2]!, top[3]!],
            [
                [u0, 0],
                [u1, 0],
                [u1, vEnd],
                [u0, vEnd],
            ],
            n,
            texture,
        );
        out.quad(
            [bot[3]!, bot[2]!, bot[1]!, bot[0]!],
            [
                [u0, vEnd],
                [u1, vEnd],
                [u1, 0],
                [u0, 0],
            ],
            mul(n, -1),
            texture,
        );
        const vs = (t1 - t0) / (s1 - s0);
        out.quad(
            [bot[0]!, bot[3]!, top[3]!, top[0]!],
            [
                [u0, 0],
                [u0, vEnd],
                [u0 + 0.02, vEnd],
                [u0 + 0.02, 0],
            ],
            mul(a, -1),
            texture,
        );
        out.quad(
            [bot[2]!, bot[1]!, top[1]!, top[2]!],
            [
                [u1, vEnd],
                [u1, 0],
                [u1 - 0.02, 0],
                [u1 - 0.02, vEnd],
            ],
            a,
            texture,
        );
        out.quad(
            [bot[1]!, bot[0]!, top[0]!, top[1]!],
            [
                [u1, 0],
                [u0, 0],
                [u0, vs * 0.2],
                [u1, vs * 0.2],
            ],
            mul(b, -1),
            texture,
        );
        out.quad(
            [bot[3]!, bot[2]!, top[2]!, top[3]!],
            [
                [u0, vEnd],
                [u1, vEnd],
                [u1, vEnd - vs * 0.2],
                [u0, vEnd - vs * 0.2],
            ],
            b,
            texture,
        );
        ends.push({ t: (t0 + t1) / 2, s0, s1, h0: (h[0]! + h[1]!) / 2, h1: (h[2]! + h[3]!) / 2 });
    }
    // two rope stringers under the board ends
    if (ends.length >= 2)
        for (const side of [0, 1] as const) {
            const line = ends.map((e) => {
                const s = side ? e.s1 - width * 0.08 : e.s0 + width * 0.08;
                return W(e.t, s, (side ? e.h1 : e.h0) - thick * 1.5);
            });
            const first = ends[0]!,
                last = ends[ends.length - 1]!;
            const ext = (e: typeof first, dir: number) =>
                W(
                    e.t + dir * pitch * 0.5,
                    side ? e.s1 - width * 0.08 : e.s0 + width * 0.08,
                    (side ? e.h1 : e.h0) - thick * 1.5,
                );
            rope(out, [ext(first, -1), ...line, ext(last, 1)], thick * 0.55, ropeTexture);
        }
}

/** A round rope along a polyline (`SIDES` sided, smooth normals, the rope texture wound along it). */
const SIDES = 6;
function rope(out: Out, line: V3[], radius: number, texture: number): void {
    if (line.length < 2) return;
    const rings: number[][] = [];
    let vAt = 0;
    let prevSide: V3 | null = null;
    const vs: number[] = [];
    for (let i = 0; i < line.length; i++) {
        const d = norm(sub(line[Math.min(i + 1, line.length - 1)]!, line[Math.max(i - 1, 0)]!));
        let side: V3 = prevSide
            ? norm(sub(prevSide, mul(d, dot(prevSide, d))))
            : norm(cross(d, Math.abs(d[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]));
        if (len(side) < 0.5) side = norm(cross(d, [0, 0, 1]));
        prevSide = side;
        const up = cross(d, side);
        if (i > 0) vAt += len(sub(line[i]!, line[i - 1]!)) / (radius * 2 * Math.PI) / 2;
        vs.push(vAt);
        const ring: number[] = [];
        for (let k = 0; k <= SIDES; k++) {
            const ang = (k / SIDES) * 2 * Math.PI;
            const dir = add(mul(side, Math.cos(ang)), mul(up, Math.sin(ang)));
            ring.push(out.vert(add(line[i]!, mul(dir, radius)), dir));
        }
        rings.push(ring);
    }
    for (let i = 0; i + 1 < rings.length; i++)
        for (let k = 0; k < SIDES; k++) {
            const a = rings[i]![k]!,
                b = rings[i]![k + 1]!,
                c = rings[i + 1]![k + 1]!,
                d = rings[i + 1]![k]!;
            const u0 = k / SIDES,
                u1 = (k + 1) / SIDES;
            out.polygons.push({ flags: 0, texture, indices: [a, c, b], uvs: [u0, vs[i]!, u1, vs[i + 1]!, u1, vs[i]!] });
            out.polygons.push({
                flags: 0,
                texture,
                indices: [a, d, c],
                uvs: [u0, vs[i]!, u0, vs[i + 1]!, u1, vs[i + 1]!],
            });
        }
}

/** Rope centre lines from flat OotF rope strips: each strip quad gives the segment between the middles of its short sides. */
function ropeSegments(tris: { p: V3[] }[]): { a: V3; b: V3; r: number }[] {
    // pair triangles over their longest edge into quads
    const byEdge = new Map<string, number[]>();
    const longest = tris.map((t) => {
        let best = 0,
            bl = -1;
        for (let e = 0; e < 3; e++) {
            const l = len(sub(t.p[(e + 1) % 3]!, t.p[e]!));
            if (l > bl) {
                bl = l;
                best = e;
            }
        }
        return best;
    });
    tris.forEach((t, i) => {
        const e = longest[i]!;
        const k = [pkey(t.p[e]!), pkey(t.p[(e + 1) % 3]!)].sort().join('|');
        (byEdge.get(k) ?? byEdge.set(k, []).get(k)!).push(i);
    });
    const used = new Set<number>();
    const segs: { a: V3; b: V3; r: number }[] = [];
    const seen = new Set<string>();
    const push = (a: V3, b: V3, r: number) => {
        const k = [pkey(a), pkey(b)].sort().join('|');
        if (seen.has(k) || len(sub(a, b)) < 1e-4) return;
        seen.add(k);
        segs.push({ a, b, r });
    };
    tris.forEach((t, i) => {
        if (used.has(i)) return;
        const e = longest[i]!;
        const k = [pkey(t.p[e]!), pkey(t.p[(e + 1) % 3]!)].sort().join('|');
        const j = byEdge.get(k)!.find((x) => x !== i && !used.has(x));
        used.add(i);
        if (j === undefined) {
            // a lone triangle: from the middle of its shortest side to the opposite corner
            let s = 0,
                sl = Infinity;
            for (let f = 0; f < 3; f++) {
                const l = len(sub(t.p[(f + 1) % 3]!, t.p[f]!));
                if (l < sl) {
                    sl = l;
                    s = f;
                }
            }
            push(mul(add(t.p[s]!, t.p[(s + 1) % 3]!), 0.5), t.p[(s + 2) % 3]!, sl / 2);
            return;
        }
        used.add(j);
        const o = tris[j]!;
        const diag = [t.p[e]!, t.p[(e + 1) % 3]!];
        const c1 = t.p[(e + 2) % 3]!;
        const c2 = o.p.find((p) => pkey(p) !== pkey(diag[0]!) && pkey(p) !== pkey(diag[1]!))!;
        // quad corners in order: diag0, c1, diag1, c2; sides diag0-c1 / diag1-c2 and c1-diag1 / c2-diag0
        const s1 = len(sub(c1, diag[0]!)) + len(sub(c2, diag[1]!));
        const s2 = len(sub(diag[1]!, c1)) + len(sub(diag[0]!, c2));
        if (s1 < s2) push(mul(add(diag[0]!, c1), 0.5), mul(add(diag[1]!, c2), 0.5), s1 / 4);
        else push(mul(add(c1, diag[1]!), 0.5), mul(add(c2, diag[0]!), 0.5), s2 / 4);
    });
    return segs;
}

/** The level direction of largest spread of points (power iteration over the xz covariance). */
function longAxis(pts: V3[]): V3 {
    const c = pts.reduce((m, p) => [m[0] + p[0] / pts.length, 0, m[2] + p[2] / pts.length] as V3, [0, 0, 0] as V3);
    let xx = 0,
        xz = 0,
        zz = 0;
    for (const p of pts) {
        const x = p[0] - c[0],
            z = p[2] - c[2];
        xx += x * x;
        xz += x * z;
        zz += z * z;
    }
    const ang = 0.5 * Math.atan2(2 * xz, xx - zz);
    return [Math.cos(ang), 0, Math.sin(ang)];
}

/** The bridge piece drawn in Drakan 2 style (disc texture indices move behind `ootfTextures`). */
export function bridgeMesh(ootf: Mesh, ootfTextures: number, opt: BridgeOptions): Mesh {
    const out = new Out();
    const plankSet = new Set(opt.planks);
    const ropeSet = new Set(opt.ropes);
    const plankTex = ootfTextures + opt.plankTexture;
    const ropeTex = ootfTextures + opt.ropeTexture;
    // kept OotF parts (posts, rock), as they are or with the matching disc texture
    const no = ootf.positions.length / 3;
    for (let i = 0; i < no * 3; i++) {
        out.positions.push(ootf.positions[i]!);
        out.normals.push(ootf.normals[i]!);
    }
    const walk = triangles(ootf, plankSet);
    const unitNormal = (t: { p: V3[] }) => norm(cross(sub(t.p[1]!, t.p[0]!), sub(t.p[2]!, t.p[0]!)));
    const area = (t: { p: V3[] }) => len(cross(sub(t.p[1]!, t.p[0]!), sub(t.p[2]!, t.p[0]!))) / 2;
    // Each connected plank part (the walkway, a broken hanging piece) is redrawn as boards over its broad faces (the faces
    // turned like its largest face, either way); its thin edge faces are left out.
    const sheetTris: { p: V3[] }[] = [];
    for (const part of components(walk.map((t) => ({ ...t, n: unitNormal(t), a: area(t) })))) {
        const big = part.reduce((m, t) => (t.a > m.a ? t : m));
        if (Math.abs(big.n[1]) > 0.8) sheetTris.push(...part.filter((t) => Math.abs(dot(t.n, big.n)) > 0.8));
        else
            // a broken piece hanging down: kept flat, drawn with the matching disc texture
            for (const t of part) {
                const r = opt.retexture?.[t.texture];
                out.polygons.push({
                    flags: t.flags,
                    texture: r === undefined ? t.texture : ootfTextures + r,
                    indices: [...t.idx],
                    uvs: [...t.uv],
                });
            }
    }
    for (const q of ootf.polygons) {
        if (ropeSet.has(q.texture) || plankSet.has(q.texture)) continue;
        const r = opt.retexture?.[q.texture];
        out.polygons.push({
            ...q,
            indices: [...q.indices],
            uvs: [...q.uvs],
            texture: r === undefined ? q.texture : ootfTextures + r,
        });
    }
    // boards: one sheet per connected group of flat walkway triangles; of a top and bottom face pair, the upper one
    const sheets = components(sheetTris, true);
    // the walkway's long axis (level) and the board pitch: a fifth of the walkway width along the longest sheet
    const along = longAxis(sheetTris.flatMap((t) => t.p));
    let pitch = 0;
    let longest = -1;
    for (const g of sheets) {
        const ts = g.flatMap((t) => t.p.map((p) => dot(p, along)));
        const across: V3 = norm(cross([0, 1, 0], along));
        const ss = g.flatMap((t) => t.p.map((p) => dot(p, across)));
        const l = Math.max(...ts) - Math.min(...ts);
        if (l > longest) {
            longest = l;
            pitch = (Math.max(...ss) - Math.min(...ss)) * 0.2;
        }
    }
    const centreY = (g: { p: V3[] }[]) =>
        g.reduce((s, t) => s + t.p[0]![1] + t.p[1]![1] + t.p[2]![1], 0) / (g.length * 3);
    const box = (g: { p: V3[] }[]) => {
        const lo: V3 = [Infinity, Infinity, Infinity],
            hi: V3 = [-Infinity, -Infinity, -Infinity];
        for (const t of g)
            for (const p of t.p)
                for (let k = 0; k < 3; k++) {
                    lo[k] = Math.min(lo[k]!, p[k]!);
                    hi[k] = Math.max(hi[k]!, p[k]!);
                }
        return { lo, hi, c: mul(add(lo, hi), 0.5), d: len(sub(hi, lo)) };
    };
    const kept: { p: V3[] }[][] = [];
    for (const g of sheets) {
        const bg = box(g);
        // the other face of the same board sheet: about the same box
        const twin = kept.findIndex((k) => {
            const bk = box(k);
            return (
                len(sub(bg.c, bk.c)) < 0.15 * Math.max(bg.d, bk.d) &&
                Math.abs(bg.d - bk.d) < 0.15 * Math.max(bg.d, bk.d)
            );
        });
        if (twin < 0) kept.push(g);
        else if (centreY(g) > centreY(kept[twin]!)) kept[twin] = g;
    }
    const firstNew = out.polygons.length;
    if (pitch > 0) for (const g of kept) boards(out, g, opt, plankTex, ropeTex, along, pitch);
    // ropes
    for (const s of ropeSegments(triangles(ootf, ropeSet))) {
        const r = Math.min(Math.max(s.r, 0.004), 0.012);
        const d = norm(sub(s.b, s.a));
        // run a little past both ends so neighbouring segments join
        rope(out, [sub(s.a, mul(d, r * 0.8)), add(s.b, mul(d, r * 0.8))], r, ropeTex);
    }
    // disc winding: a triangle's corners run clockwise seen from the side its normals face
    for (let i = firstNew; i < out.polygons.length; i++) {
        const q = out.polygons[i]!;
        const P = (v: number): V3 => [out.positions[v * 3]!, out.positions[v * 3 + 1]!, out.positions[v * 3 + 2]!];
        const N = (v: number): V3 => [out.normals[v * 3]!, out.normals[v * 3 + 1]!, out.normals[v * 3 + 2]!];
        const [a, b, c] = q.indices as [number, number, number];
        const f = cross(sub(P(b), P(a)), sub(P(c), P(a)));
        if (dot(f, add(add(N(a), N(b)), N(c))) > 0)
            out.polygons[i] = {
                ...q,
                indices: [a, c, b],
                uvs: [q.uvs[0]!, q.uvs[1]!, q.uvs[4]!, q.uvs[5]!, q.uvs[2]!, q.uvs[3]!],
            };
    }
    return {
        positions: Float32Array.from(out.positions),
        normals: Int8Array.from(out.normals),
        polygons: out.polygons,
    };
}
