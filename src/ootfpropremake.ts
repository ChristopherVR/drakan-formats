/**
 * New PS2-style drawings for Order of the Flame props that have no Drakan 2 model (ootfps2model.ts, props rows with
 * `refine: 'smooth'`, `'module'` or `'beam'`), built at convert time from the OotF mesh itself; no game data here. The
 * engine still collides with the converted OotF model (`OotfAssetBuilder.refineDrawing` keeps its vertex, polygon and bounds
 * records).
 *
 * - `smoothSubdivide`: Loop subdivision with sharp creases. Unlike the PN step of `refineMesh` (which keeps every original
 *   corner where it is, so box-like props barely change), Loop moves the corners too: an octagonal pillar becomes round, a
 *   faceted horn becomes a smooth curve. Edges sharper than the crease angle, open borders and the borders of parts that are
 *   kept flat stay sharp, so steps, rims and the flat base stay where they are; with `fixBorders` open borders do not
 *   move at all, so a corridor module still meets its neighbours without gaps. UVs are subdivided linearly per triangle, so
 *   the OotF texture layout is kept.
 * - `lightBeamMesh`: the light beam over a Multiplayer pick-up pad redrawn as two nested soft shafts of 32 sides (the OotF
 *   beam and a wider halo that tapers to the beam's radius at the top), with the beam's own texture and UVs.
 */

export class PropRemakeError extends Error {}

export interface RemakePoly {
    flags: number;
    texture: number;
    indices: number[];
    uvs: number[];
}

interface RemakeModel {
    positions: Float32Array;
    normals: Int8Array;
    polygons: RemakePoly[];
}

type V3 = [number, number, number];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a: V3) => Math.hypot(a[0], a[1], a[2]);
const unit = (a: V3): V3 => {
    const l = len(a);
    return l > 0 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 1, 0];
};

interface Tri {
    v: [number, number, number];
    uv: number[];
    texture: number;
    flags: number;
    /** Subdivided (smooth) or kept as it is (a flat base, a bowl, chains). */
    smooth: boolean;
    /** +1 when the engine's normals follow the triangle's winding, -1 when they face the other way. */
    facing: number;
}

export interface SmoothOptions {
    /** Subdivision steps (1 or 2; every step splits each triangle in four). */
    steps?: number;
    /** Edges whose faces meet at more than this many degrees stay sharp (default 50). */
    creaseDegrees?: number;
    /** Texture list entries whose polygons are kept as they are (split flat, never moved). */
    keepTextures?: readonly number[];
    /**
     * Open borders do not move at all (split straight): for modules that join others (corridor pieces), so a remade piece
     * meets its neighbours, remade or not, without a gap. Otherwise borders follow the crease rule (a horn's open back edge
     * curves with the horn) and only their corners stay.
     */
    fixBorders?: boolean;
}

const faceNormal = (P: V3[], t: Tri): V3 => cross(sub(P[t.v[1]]!, P[t.v[0]]!), sub(P[t.v[2]]!, P[t.v[0]]!));
const edgeKey = (a: number, b: number) => (a < b ? `${a},${b}` : `${b},${a}`);

/** One Loop step over welded positions; kept triangles are split linearly and their corners never move. */
function loopStep(P: V3[], tris: Tri[], cosCrease: number, fixBorders: boolean): { P: V3[]; tris: Tri[] } {
    const edges = new Map<string, number[]>();
    tris.forEach((t, f) => {
        for (let e = 0; e < 3; e++) {
            const k = edgeKey(t.v[e]!, t.v[(e + 1) % 3]!);
            (edges.get(k) ?? edges.set(k, []).get(k)!).push(f);
        }
    });
    const fn = tris.map((t) => unit(faceNormal(P, t)));
    const sharp = new Map<string, boolean>();
    for (const [k, fs] of edges) {
        let s = fs.length !== 2;
        if (!s) {
            const [a, b] = fs as [number, number];
            const ta = tris[a]!,
                tb = tris[b]!;
            s =
                !ta.smooth ||
                !tb.smooth ||
                ta.facing !== tb.facing ||
                dot(scale(fn[a]!, ta.facing), scale(fn[b]!, tb.facing)) < cosCrease;
        }
        sharp.set(k, s);
    }
    const nV = P.length;
    const nbr: Set<number>[] = Array.from({ length: nV }, () => new Set());
    const sharpNbr: number[][] = Array.from({ length: nV }, () => []);
    const fixed = new Array<boolean>(nV).fill(false);
    for (const t of tris) if (!t.smooth) for (const v of t.v) fixed[v] = true;
    // open borders stay exactly where they are (split straight), so a remade module still meets the next one, remade or not
    if (fixBorders)
        for (const [k, fs] of edges) if (fs.length === 1) for (const v of k.split(',').map(Number)) fixed[v] = true;
    for (const k of edges.keys()) {
        const [a, b] = k.split(',').map(Number) as [number, number];
        nbr[a]!.add(b);
        nbr[b]!.add(a);
        if (sharp.get(k)) {
            sharpNbr[a]!.push(b);
            sharpNbr[b]!.push(a);
        }
    }
    const NP: V3[] = P.map((p, i) => {
        if (fixed[i]) return p;
        const s = sharpNbr[i]!;
        if (s.length > 2) return p; // corner
        if (s.length === 2) {
            // an open border that turns at this corner (a base slab's corner, where the next module joins) stays put; a
            // crease inside the surface follows the crease rule even where it turns, or the surface beside it kinks
            const a = unit(sub(P[s[0]!]!, p)),
                b = unit(sub(p, P[s[1]!]!));
            const border = s.every((j) => edges.get(edgeKey(i, j))!.length === 1);
            if (border && dot(a, b) < cosCrease) return p;
            return add(scale(p, 0.75), scale(add(P[s[0]!]!, P[s[1]!]!), 0.125));
        }
        const n = nbr[i]!.size;
        if (n < 3) return p;
        const beta = n === 3 ? 3 / 16 : 3 / (8 * n);
        let acc: V3 = [0, 0, 0];
        for (const j of nbr[i]!) acc = add(acc, P[j]!);
        return add(scale(p, 1 - n * beta), scale(acc, beta));
    });
    const mid = new Map<string, number>();
    const edgePoint = (a: number, b: number): number => {
        const k = edgeKey(a, b);
        const known = mid.get(k);
        if (known !== undefined) return known;
        const fs = edges.get(k)!;
        let p: V3 = scale(add(P[a]!, P[b]!), 0.5);
        if (!sharp.get(k) && fs.length === 2) {
            const opp = fs.map((f) => tris[f]!.v.find((v) => v !== a && v !== b)!);
            p = add(scale(add(P[a]!, P[b]!), 3 / 8), scale(add(P[opp[0]!]!, P[opp[1]!]!), 1 / 8));
        }
        const id = NP.length;
        NP.push(p);
        mid.set(k, id);
        return id;
    };
    const out: Tri[] = [];
    for (const t of tris) {
        const [a, b, c] = t.v;
        const ab = edgePoint(a, b),
            bc = edgePoint(b, c),
            ca = edgePoint(c, a);
        const uv = (i: number) => [t.uv[i * 2]!, t.uv[i * 2 + 1]!];
        const avg = (i: number, j: number) => [
            (t.uv[i * 2]! + t.uv[j * 2]!) / 2,
            (t.uv[i * 2 + 1]! + t.uv[j * 2 + 1]!) / 2,
        ];
        const push = (v: [number, number, number], u: number[][]) => out.push({ ...t, v, uv: u.flat() });
        push([a, ab, ca], [uv(0), avg(0, 1), avg(2, 0)]);
        push([ab, b, bc], [avg(0, 1), uv(1), avg(1, 2)]);
        push([ca, bc, c], [avg(2, 0), avg(1, 2), uv(2)]);
        push([ab, bc, ca], [avg(0, 1), avg(1, 2), avg(2, 0)]);
    }
    return { P: NP, tris: out };
}

/** Shading normals per corner (faces meeting at less than the crease angle shared), one output vertex per position + normal. */
function finish<M extends RemakeModel>(m: M, P: V3[], tris: Tri[], cosCrease: number): M {
    const fn = tris.map((t) => scale(faceNormal(P, t), t.facing));
    const fu = fn.map(unit);
    const byV = new Map<number, number[]>();
    tris.forEach((t, f) => t.v.forEach((v) => (byV.get(v) ?? byV.set(v, []).get(v)!).push(f)));
    const positions: number[] = [];
    const normals: number[] = [];
    const ids = new Map<string, number>();
    const polygons: RemakePoly[] = tris.map((t, f) => ({
        flags: t.flags,
        texture: t.texture,
        uvs: t.uv,
        indices: t.v.map((v) => {
            let acc: V3 = [0, 0, 0];
            for (const g of byV.get(v)!)
                if (tris[g]!.smooth === t.smooth && dot(fu[g]!, fu[f]!) >= cosCrease) acc = add(acc, fn[g]!);
            const n = unit(acc);
            const q = n.map((x) => Math.max(-127, Math.min(127, Math.round(x * 127))));
            const k = `${v}|${q.join(',')}`;
            let id = ids.get(k);
            if (id === undefined) {
                id = positions.length / 3;
                ids.set(k, id);
                positions.push(...P[v]!);
                normals.push(...q);
            }
            return id;
        }),
    }));
    return {
        ...m,
        positions: Float32Array.from(positions),
        normals: Int8Array.from(normals),
        normalW: undefined,
        polygons,
        bounds: null,
    };
}

/** Triangles over positions welded by place, each with the facing of the engine's normals at its corners. */
function weld(m: RemakeModel, keep: ReadonlySet<number>): { P: V3[]; tris: Tri[] } {
    const P: V3[] = [];
    const ids = new Map<string, number>();
    const remap: number[] = [];
    for (let i = 0; i < m.positions.length / 3; i++) {
        const p: V3 = [m.positions[i * 3]!, m.positions[i * 3 + 1]!, m.positions[i * 3 + 2]!];
        const k = p.map((x) => Math.round(x * 1e5)).join(',');
        let id = ids.get(k);
        if (id === undefined) {
            id = P.length;
            ids.set(k, id);
            P.push(p);
        }
        remap.push(id);
    }
    const tris: Tri[] = [];
    for (const q of m.polygons)
        for (let k = 1; k + 1 < q.indices.length; k++) {
            const c = [0, k, k + 1];
            const v = c.map((i) => remap[q.indices[i]!]!) as [number, number, number];
            if (v[0] === v[1] || v[1] === v[2] || v[0] === v[2]) continue;
            const t: Tri = {
                v,
                uv: c.flatMap((i) => [q.uvs[i * 2]!, q.uvs[i * 2 + 1]!]),
                texture: q.texture,
                flags: q.flags,
                smooth: !keep.has(q.texture),
                facing: 1,
            };
            const orig = c.reduce<V3>(
                (s, i) => {
                    const j = q.indices[i]!;
                    return add(s, [m.normals[j * 3]!, m.normals[j * 3 + 1]!, m.normals[j * 3 + 2]!]);
                },
                [0, 0, 0],
            );
            if (dot(faceNormal(P, t), orig) < 0) t.facing = -1;
            tris.push(t);
        }
    if (!tris.length) throw new PropRemakeError('no polygons');
    return { P, tris };
}

/** A smoothed, denser copy of a converted model for drawing (see the file comment). */
export function smoothSubdivide<M extends RemakeModel>(m: M, o: SmoothOptions = {}): M {
    const cosCrease = Math.cos(((o.creaseDegrees ?? 50) * Math.PI) / 180);
    let { P, tris } = weld(m, new Set(o.keepTextures ?? []));
    if (!tris.some((t) => t.smooth)) throw new PropRemakeError('nothing to smooth');
    for (let s = 0; s < Math.max(1, Math.min(2, o.steps ?? 2)); s++)
        ({ P, tris } = loopStep(P, tris, cosCrease, o.fixBorders === true));
    return finish(m, P, tris, cosCrease);
}

/** Sides of the rebuilt light beam. */
const BEAM_SIDES = 32;

/**
 * The OotF light beam (an open tube of translucent cards with a vertical gradient texture) redrawn as two nested shafts of
 * `BEAM_SIDES` sides: the beam itself and a halo at 150 % of its radius that narrows to the beam's radius at the top. Both
 * use the beam's texture with the U and V range its cards use. Throws when the mesh is not a tall tube round the Y axis.
 */
export function lightBeamMesh<M extends RemakeModel>(m: M): M {
    const n = m.positions.length / 3;
    if (!n || !m.polygons.length) throw new PropRemakeError('empty beam');
    let y0 = Infinity,
        y1 = -Infinity,
        cx = 0,
        cz = 0;
    for (let i = 0; i < n; i++) {
        y0 = Math.min(y0, m.positions[i * 3 + 1]!);
        y1 = Math.max(y1, m.positions[i * 3 + 1]!);
        cx += m.positions[i * 3]! / n;
        cz += m.positions[i * 3 + 2]! / n;
    }
    let r = 0;
    for (let i = 0; i < n; i++) r += Math.hypot(m.positions[i * 3]! - cx, m.positions[i * 3 + 2]! - cz) / n;
    if (!(y1 - y0 > 2 * r) || !(r > 0)) throw new PropRemakeError('not a beam (no tall tube round the Y axis)');
    const q = m.polygons[0]!;
    const us = m.polygons.flatMap((p) => p.uvs.filter((_, i) => i % 2 === 0));
    const vs = m.polygons.flatMap((p) => p.uvs.filter((_, i) => i % 2 === 1));
    const u0 = Math.min(...us),
        u1 = Math.max(...us),
        vLo = Math.min(...vs),
        vHi = Math.max(...vs);
    // which V end of the texture sits at the bottom of the beam (the cards map their lower corners to one end)
    let vBottom = vHi;
    for (const p of m.polygons)
        p.indices.forEach((ix, k) => {
            if (Math.abs(m.positions[ix * 3 + 1]! - y0) < 1e-4) vBottom = p.uvs[k * 2 + 1]!;
        });
    const vTop = Math.abs(vBottom - vHi) < 1e-6 ? vLo : vHi;
    const positions: number[] = [];
    const normals: number[] = [];
    const polygons: RemakePoly[] = [];
    const rings = 6;
    const shaft = (rBottom: number, rTop: number) => {
        const base = positions.length / 3;
        for (let j = 0; j <= rings; j++) {
            const t = j / rings;
            const y = y0 + (y1 - y0) * t;
            const rr = rBottom + (rTop - rBottom) * t;
            for (let s = 0; s <= BEAM_SIDES; s++) {
                const a = (s / BEAM_SIDES) * Math.PI * 2;
                positions.push(cx + Math.sin(a) * rr, y, cz + Math.cos(a) * rr);
                normals.push(Math.round(Math.sin(a) * 127), 0, Math.round(Math.cos(a) * 127));
            }
        }
        const row = BEAM_SIDES + 1;
        for (let j = 0; j < rings; j++)
            for (let s = 0; s < BEAM_SIDES; s++) {
                const a = base + j * row + s;
                const uA = u0 + ((u1 - u0) * s) / BEAM_SIDES;
                const uB = u0 + ((u1 - u0) * (s + 1)) / BEAM_SIDES;
                const vA = vBottom + ((vTop - vBottom) * j) / rings;
                const vB = vBottom + ((vTop - vBottom) * (j + 1)) / rings;
                // one side only: the PS2 draws both sides of every polygon, as it drew the OotF cards
                polygons.push({
                    flags: q.flags,
                    texture: q.texture,
                    indices: [a, a + 1, a + row + 1, a + row],
                    uvs: [uA, vA, uB, vA, uB, vB, uA, vB],
                });
            }
    };
    shaft(r, r);
    shaft(r * 1.5, r);
    return {
        ...m,
        positions: Float32Array.from(positions),
        normals: Int8Array.from(normals),
        normalW: undefined,
        polygons,
        bounds: null,
    };
}

/** The engine class of a particle emitter (a fountain of fire, smoke, sparks). */
export const EMITTER_RFL = 43;

/**
 * PC objects of an emitter class that a row shows harmless (ootfps2model.ts `harmlessShow`): those that start on
 * (`initialState` 1) and that no object of the level links to, so nothing can switch them; the others keep the PC flags.
 */
export function unswitchedEmitters(
    objects: readonly { id: number; links: readonly number[] }[],
    candidates: readonly { id: number; initialState: number | undefined }[],
): Set<number> {
    const linked = new Set<number>();
    for (const o of objects) for (const to of o.links) linked.add(to);
    return new Set(candidates.filter((c) => c.initialState === 1 && !linked.has(c.id)).map((c) => c.id));
}
