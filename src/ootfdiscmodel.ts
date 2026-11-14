/**
 * Drakan 2 disc models drawn in place of converted Order of the Flame props (ootfps2model.ts, props rows): helpers that combine
 * the two models into one record set. The OotF model keeps its vertices, polygons and bounds, so the engine collides with
 * exactly the OotF shape (walk surfaces, footprints, the polygon lists of its bounds); the disc model's vertices are appended to
 * the vertex record and its strip display list, the only thing the engine draws a rigid prop from (journal
 * 2026-11-08/ootf-ruined-village-ambush-props.md), replaces the OotF one. Display list layout: ootfdisplaylist.ts.
 * No game data here: everything is read from the player's disc and install at convert time.
 */

export class DiscModelError extends Error {}

/** Axis aligned box, model units. */
export interface Box3 {
    min: readonly number[];
    max: readonly number[];
}

const pad4 = (n: number): number => (n + 3) & ~3;

/** Vertex record 0x0203: `u16 count, f32 xyz[count], i8 nx ny nz w [count]`. */
export function readVertexRecord(b: Uint8Array): { positions: Float32Array; normals: Int8Array; w: Uint8Array } {
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    const n = dv.getUint16(0, true);
    if (2 + n * 16 > b.length) throw new DiscModelError('vertex record truncated');
    const positions = new Float32Array(n * 3);
    const normals = new Int8Array(n * 3);
    const w = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
        for (let k = 0; k < 3; k++) positions[i * 3 + k] = dv.getFloat32(2 + i * 12 + k * 4, true);
        for (let k = 0; k < 3; k++) normals[i * 3 + k] = dv.getInt8(2 + n * 12 + i * 4 + k);
        w[i] = dv.getUint8(2 + n * 12 + i * 4 + 3);
    }
    return { positions, normals, w };
}

export function writeVertexRecord(v: { positions: Float32Array; normals: Int8Array; w: Uint8Array }): Uint8Array {
    const n = v.positions.length / 3;
    if (n > 0xffff) throw new DiscModelError('too many vertices');
    const out = new Uint8Array(2 + n * 16);
    const dv = new DataView(out.buffer);
    dv.setUint16(0, n, true);
    for (let i = 0; i < n; i++) {
        for (let k = 0; k < 3; k++) dv.setFloat32(2 + i * 12 + k * 4, v.positions[i * 3 + k]!, true);
        for (let k = 0; k < 3; k++) dv.setInt8(2 + n * 12 + i * 4 + k, v.normals[i * 3 + k]!);
        dv.setUint8(2 + n * 12 + i * 4 + 3, v.w[i]!);
    }
    return out;
}

/** Box of the given vertices (all vertices when `used` is absent). */
export function boxOf(positions: Float32Array, used?: Iterable<number>): Box3 {
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    const each = used ?? Array.from({ length: positions.length / 3 }, (_, i) => i);
    for (const i of each)
        for (let k = 0; k < 3; k++) {
            min[k] = Math.min(min[k]!, positions[i * 3 + k]!);
            max[k] = Math.max(max[k]!, positions[i * 3 + k]!);
        }
    return { min, max };
}

/**
 * Stretch vertices from box `from` onto box `to` axis by axis (a disc model made exactly as large as the OotF one it replaces);
 * normals follow the inverse stretch and are renormalised.
 */
export function fitVertices(v: { positions: Float32Array; normals: Int8Array }, from: Box3, to: Box3): void {
    const s = [0, 1, 2].map((k) => {
        const a = from.max[k]! - from.min[k]!;
        return a > 1e-6 ? (to.max[k]! - to.min[k]!) / a : 1;
    });
    const n = v.positions.length / 3;
    for (let i = 0; i < n; i++) {
        for (let k = 0; k < 3; k++)
            v.positions[i * 3 + k] = to.min[k]! + (v.positions[i * 3 + k]! - from.min[k]!) * s[k]!;
        const nx = v.normals[i * 3]! / s[0]!;
        const ny = v.normals[i * 3 + 1]! / s[1]!;
        const nz = v.normals[i * 3 + 2]! / s[2]!;
        const l = Math.hypot(nx, ny, nz);
        if (l > 0) {
            v.normals[i * 3] = Math.round((nx / l) * 127);
            v.normals[i * 3 + 1] = Math.round((ny / l) * 127);
            v.normals[i * 3 + 2] = Math.round((nz / l) * 127);
        }
    }
}

/**
 * A disc strip display list moved behind `vertexOffset` OotF vertices and `textureOffset` OotF textures: a first vertex group
 * that covers the OotF vertices (never loaded by a batch) is prepended, every group a batch loads is the next one, and every
 * batch texture index is moved past the OotF textures. `vertexOffset` must be a multiple of 4 (groups start padded).
 */
export function shiftDisplayList(b: Uint8Array, vertexOffset: number, textureOffset: number): Uint8Array {
    if (vertexOffset % 4 !== 0) throw new DiscModelError('vertex offset not padded');
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    const u32 = (o: number): number => {
        if (o + 4 > b.length) throw new DiscModelError('display list truncated');
        return dv.getUint32(o, true);
    };
    if (u32(0) !== 1 || u32(8) !== 0) throw new DiscModelError('unsupported display list header');
    const groups = u32(4);
    if (groups < 1 || groups > 254) throw new DiscModelError(`bad group count ${groups}`);
    const words: number[] = [1, groups + 1, 0, vertexOffset, vertexOffset];
    for (let g = 0; g < groups; g++) {
        words.push(u32(12 + g * 8));
        if (g < groups - 1) words.push(u32(16 + g * 8) + vertexOffset);
    }
    // words now: header, then count[0] = vertexOffset (the OotF vertices, padded), cum[0], disc count/cum pairs
    let o = 12 + (2 * groups - 1) * 4;
    const batchCount = u32(o);
    const head = new Uint8Array(words.length * 4 + 8);
    const hv = new DataView(head.buffer);
    words.forEach((w, i) => hv.setUint32(i * 4, w >>> 0, true));
    hv.setUint32(words.length * 4, batchCount, true);
    hv.setUint32(words.length * 4 + 4, u32(o + 4) + textureOffset, true);
    o += 8;
    const body = b.slice(o);
    const bv = new DataView(body.buffer);
    let p = 0;
    for (let k = 0; k < batchCount; k++) {
        const w = bv.getUint32(p, true);
        p += 4;
        for (let i = 0; i < w; i++) {
            const g = body[p]! + 1;
            if (g > 255) throw new DiscModelError('too many vertex groups');
            body[p] = g;
            p += 2;
        }
        const cap = bv.getUint32(p + 4, true);
        p += 8 + cap;
        if (bv.getUint32(p, true) !== cap) throw new DiscModelError(`batch ${k}: UV block size differs`);
        p += 4 + cap * 8;
        const next = bv.getUint32(p, true);
        if (k + 1 < batchCount) bv.setUint32(p, next + textureOffset, true);
        p += 4;
    }
    if (p > body.length) throw new DiscModelError('display list truncated');
    const out = new Uint8Array(head.length + body.length);
    out.set(head, 0);
    out.set(body, head.length);
    return out;
}

/**
 * The combined vertex record and display list: OotF vertices (padded to a multiple of 4 with zero vertices), then the disc
 * vertices, and the disc display list shifted behind them.
 */
export function combineDrawing(
    ootfVertices: Uint8Array,
    discVertices: { positions: Float32Array; normals: Int8Array; w: Uint8Array },
    discDisplayList: Uint8Array,
    ootfTextureCount: number,
): { vertices: Uint8Array; displayList: Uint8Array } {
    const a = readVertexRecord(ootfVertices);
    const na = a.positions.length / 3;
    const off = pad4(na);
    const nd = discVertices.positions.length / 3;
    const positions = new Float32Array((off + nd) * 3);
    const normals = new Int8Array((off + nd) * 3);
    const w = new Uint8Array(off + nd);
    positions.set(a.positions, 0);
    normals.set(a.normals, 0);
    w.set(a.w, 0);
    for (let i = na; i < off; i++) w[i] = 0x7f;
    positions.set(discVertices.positions, off * 3);
    normals.set(discVertices.normals, off * 3);
    w.set(discVertices.w, off);
    return {
        vertices: writeVertexRecord({ positions, normals, w }),
        displayList: shiftDisplayList(discDisplayList, off, ootfTextureCount),
    };
}

/** Model name record 0x0200 with `extra` texture refs (db 0) appended to its texture list (the list ends the record). */
export function appendTextures(name: Uint8Array, extra: readonly number[]): { record: Uint8Array; before: number } {
    const dv = new DataView(name.buffer, name.byteOffset, name.byteLength);
    const nl = dv.getUint16(0, true);
    let o = 2 + nl;
    const shading = dv.getUint32(o, true);
    o += 8;
    if (shading & 0x20000) o += 4;
    const count = dv.getUint32(o, true);
    if (o + 4 + count * 4 !== name.length) throw new DiscModelError('texture list does not end the name record');
    const out = new Uint8Array(name.length + extra.length * 4);
    out.set(name, 0);
    const ov = new DataView(out.buffer);
    ov.setUint32(o, count + extra.length, true);
    extra.forEach((id, i) => {
        ov.setUint16(name.length + i * 4, id, true);
        ov.setUint16(name.length + i * 4 + 2, 0, true);
    });
    return { record: out, before: count };
}

/**
 * How an OotF prop mesh is refined for drawing (`refineMesh`): `normals` = smooth shading normals only (welded across UV
 * seams, hard edges over 60 degrees kept); `pn` = also one curved subdivision step (every triangle split in four, the new
 * edge points on the curved surface the normals describe, as PN triangles; edges along hard creases and open borders stay
 * straight, so no cracks open); `pn2` = two steps; `round` = one step that also rounds edges up to 100 degrees (box-like
 * limbs become rounded).
 */
export type RefineMode = 'normals' | 'pn' | 'pn2' | 'round' | 'palm';

interface RMesh {
    positions: number[];
    normals: number[];
    tris: { v: [number, number, number]; uv: number[]; texture: number; flags: number }[];
}

const sub3 = (a: number[], b: number[]) => [a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!];
const dot3 = (a: number[], b: number[]) => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
const cross3 = (a: number[], b: number[]) => [
    a[1]! * b[2]! - a[2]! * b[1]!,
    a[2]! * b[0]! - a[0]! * b[2]!,
    a[0]! * b[1]! - a[1]! * b[0]!,
];
const unit = (a: number[]) => {
    const l = Math.hypot(a[0]!, a[1]!, a[2]!);
    return l > 0 ? [a[0]! / l, a[1]! / l, a[2]! / l] : [0, 1, 0];
};
const CREASE = Math.cos((60 * Math.PI) / 180);

/** Shading normals per corner, smooth across UV seams and soft edges; a vertex per (position, normal). */
function smoothMesh(m: RMesh, crease = CREASE): RMesh {
    const P = (i: number) => m.positions.slice(i * 3, i * 3 + 3);
    const key = (i: number) =>
        P(i)
            .map((v) => Math.round(v * 1e5))
            .join(',');
    const group = m.positions.length / 3 ? Array.from({ length: m.positions.length / 3 }, (_, i) => key(i)) : [];
    const faceN = m.tris.map((t) => {
        let n = cross3(sub3(P(t.v[1]), P(t.v[0])), sub3(P(t.v[2]), P(t.v[0])));
        const orig = [0, 1, 2].map((k) => t.v.reduce((s, v) => s + m.normals[v * 3 + k]!, 0));
        if (dot3(n, orig) < 0) n = n.map((x) => -x); // follow the converted normals' facing
        return { n, u: unit(n) };
    });
    const byGroup = new Map<string, number[]>();
    m.tris.forEach((t, f) =>
        t.v.forEach((v) => (byGroup.get(group[v]!) ?? byGroup.set(group[v]!, []).get(group[v]!)!).push(f)),
    );
    const out: RMesh = { positions: [], normals: [], tris: [] };
    const vid = new Map<string, number>();
    m.tris.forEach((t, f) => {
        const v = t.v.map((i) => {
            const acc = [0, 0, 0];
            for (const g of byGroup.get(group[i]!)!)
                if (dot3(faceN[g]!.u, faceN[f]!.u) >= crease)
                    for (let k = 0; k < 3; k++) acc[k] = acc[k]! + faceN[g]!.n[k]!;
            const n = unit(acc);
            const k = `${group[i]}|${n.map((x) => Math.round(x * 127)).join(',')}`;
            let id = vid.get(k);
            if (id === undefined) {
                id = out.positions.length / 3;
                vid.set(k, id);
                out.positions.push(...P(i));
                out.normals.push(...n);
            }
            return id;
        }) as [number, number, number];
        out.tris.push({ ...t, v });
    });
    return out;
}

/** One curved subdivision step (PN-triangle edge points on soft edges, straight ones on creases and borders). */
function pnStep(m: RMesh, outward: number): RMesh {
    const P = (i: number) => m.positions.slice(i * 3, i * 3 + 3);
    const N = (i: number) => m.normals.slice(i * 3, i * 3 + 3).map((x) => x * outward);
    const pk = (i: number) =>
        P(i)
            .map((v) => Math.round(v * 1e5))
            .join(',');
    const ek = (a: number, b: number) => [pk(a), pk(b)].sort().join('|');
    // An edge is soft when every triangle on it has the same two corner normals (no crease, not a border).
    const edgeUse = new Map<string, { n: string[]; count: number }>();
    for (const t of m.tris)
        for (let e = 0; e < 3; e++) {
            const a = t.v[e]!,
                b = t.v[(e + 1) % 3]!;
            const k = ek(a, b);
            const sig = [
                pk(a) +
                    N(a)
                        .map((x) => x.toFixed(3))
                        .join(),
                pk(b) +
                    N(b)
                        .map((x) => x.toFixed(3))
                        .join(),
            ]
                .sort()
                .join('/');
            const u = edgeUse.get(k) ?? edgeUse.set(k, { n: [], count: 0 }).get(k)!;
            u.count++;
            if (!u.n.includes(sig)) u.n.push(sig);
        }
    const out: RMesh = { positions: [...m.positions], normals: [...m.normals], tris: [] };
    const mids = new Map<string, number>();
    const mid = (a: number, b: number): number => {
        const k = `${a}-${b}`;
        const known = mids.get(k) ?? mids.get(`${b}-${a}`);
        if (known !== undefined) return known;
        const pa = P(a),
            pb = P(b),
            na = N(a),
            nb = N(b);
        const u = edgeUse.get(ek(a, b))!;
        let p = [0, 1, 2].map((i) => (pa[i]! + pb[i]!) / 2);
        if (u.count === 2 && u.n.length === 1) {
            const d = sub3(pb, pa);
            const wa = dot3(d, na),
                wb = -dot3(d, nb);
            const b1 = [0, 1, 2].map((i) => (2 * pa[i]! + pb[i]! - wa * na[i]!) / 3);
            const b2 = [0, 1, 2].map((i) => (2 * pb[i]! + pa[i]! - wb * nb[i]!) / 3);
            p = [0, 1, 2].map((i) => (pa[i]! + 3 * b1[i]! + 3 * b2[i]! + pb[i]!) / 8);
        }
        const id = out.positions.length / 3;
        out.positions.push(...p);
        out.normals.push(...unit([0, 1, 2].map((i) => (na[i]! + nb[i]!) * outward)));
        mids.set(k, id);
        return id;
    };
    for (const t of m.tris) {
        const [a, b, c] = t.v;
        const ab = mid(a, b),
            bc = mid(b, c),
            ca = mid(c, a);
        const uv = (i: number) => [t.uv[i * 2]!, t.uv[i * 2 + 1]!];
        const avg = (i: number, j: number) => [
            (t.uv[i * 2]! + t.uv[j * 2]!) / 2,
            (t.uv[i * 2 + 1]! + t.uv[j * 2 + 1]!) / 2,
        ];
        const tri = (v: [number, number, number], u: number[][]) =>
            out.tris.push({ v, uv: u.flat(), texture: t.texture, flags: t.flags });
        tri([a, ab, ca], [uv(0), avg(0, 1), avg(2, 0)]);
        tri([ab, b, bc], [avg(0, 1), uv(1), avg(1, 2)]);
        tri([ca, bc, c], [avg(2, 0), avg(1, 2), uv(2)]);
        tri([ab, bc, ca], [avg(0, 1), avg(1, 2), avg(2, 0)]);
    }
    return out;
}

/**
 * A refined copy of a converted (neutral) model for drawing: polygons split into triangles, shading normals smoothed, and
 * for `pn` / `pn2` curved subdivision. UVs are per corner, so the seams of the OotF texture layouts stay where they are.
 */
export function refineMesh<
    M extends {
        positions: Float32Array;
        normals: Int8Array;
        polygons: { flags: number; texture: number; indices: number[]; uvs: number[] }[];
    },
>(m: M, mode: RefineMode): M {
    let r: RMesh = {
        positions: Array.from(m.positions),
        normals: Array.from(m.normals, (x) => x / 127),
        tris: [],
    };
    for (const p of m.polygons)
        for (let k = 1; k + 1 < p.indices.length; k++)
            r.tris.push({
                v: [p.indices[0]!, p.indices[k]!, p.indices[k + 1]!],
                uv: [p.uvs[0]!, p.uvs[1]!, p.uvs[k * 2]!, p.uvs[k * 2 + 1]!, p.uvs[k * 2 + 2]!, p.uvs[k * 2 + 3]!],
                texture: p.texture,
                flags: p.flags,
            });
    r = smoothMesh(r, mode === 'round' ? Math.cos((100 * Math.PI) / 180) : CREASE);
    // The engine's normals may face into the mesh (the converter flips them to the PS2 convention): the curved points must
    // move outwards, so compare the normals with the direction away from the mesh centre.
    const n = r.positions.length / 3;
    const centre = [0, 1, 2].map(
        (k) => r.positions.filter((_, i) => i % 3 === k).reduce((a, b) => a + b, 0) / (n || 1),
    );
    let facing = 0;
    for (let i = 0; i < n; i++)
        facing += dot3(r.normals.slice(i * 3, i * 3 + 3), sub3(r.positions.slice(i * 3, i * 3 + 3), centre));
    const outward = facing < 0 ? -1 : 1;
    for (let s = 0; s < (mode === 'pn2' ? 2 : mode === 'normals' ? 0 : 1); s++) r = pnStep(r, outward);
    return {
        ...m,
        positions: Float32Array.from(r.positions),
        normals: Int8Array.from(r.normals, (x) => Math.max(-127, Math.min(127, Math.round(x * 127)))),
        normalW: undefined,
        polygons: r.tris.map((t) => ({ flags: t.flags, texture: t.texture, indices: [...t.v], uvs: t.uv })),
        bounds: null,
    };
}

/**
 * A disc texture recoloured for an OotF prop at convert time: `green` keeps the picture's brightness and makes it the
 * saturated green of the Order of the Flame crystals (the Drakan 2 crystal is blue-white). Alpha is kept.
 */
export function tintImage(img: { width: number; height: number; rgba: Uint8Array }, tint: 'green') {
    void tint;
    const rgba = new Uint8Array(img.rgba.length);
    for (let i = 0; i < rgba.length; i += 4) {
        const l = 0.3 * img.rgba[i]! + 0.59 * img.rgba[i + 1]! + 0.11 * img.rgba[i + 2]!;
        rgba[i] = Math.min(255, Math.round(l * 0.35));
        rgba[i + 1] = Math.min(255, Math.round(l * 1.0 + 25));
        rgba[i + 2] = Math.min(255, Math.round(l * 0.3));
        rgba[i + 3] = img.rgba[i + 3]!;
    }
    return { width: img.width, height: img.height, rgba };
}

interface PalmPoly {
    flags: number;
    texture: number;
    indices: number[];
    uvs: number[];
}

/**
 * A new palm built at convert time from an OotF palm mesh (no game data in the code): the trunk and other opaque parts are the
 * OotF polygons rounded (`refineMesh` `round`: smooth normals and a curved subdivision step, each band keeping its bark texture
 * and UVs); every frond card (polygons of an alpha texture) becomes a curved card of six segments that rises a little and then
 * droops, keeping the card's own corner UVs (so the OotF frond picture is used as painted) and drawn from both sides.
 * `alpha(texture)` says whether a texture of the model's list has holes.
 */
export function palmMesh<M extends { positions: Float32Array; normals: Int8Array; polygons: PalmPoly[] }>(
    m: M,
    alpha: (texture: number) => boolean,
): M {
    const P = (i: number) => [m.positions[i * 3]!, m.positions[i * 3 + 1]!, m.positions[i * 3 + 2]!];
    const count = new Map<number, number>();
    for (const p of m.polygons) if (!alpha(p.texture)) count.set(p.texture, (count.get(p.texture) ?? 0) + 1);
    const bark = [...count.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    const fronds = m.polygons.filter((p) => alpha(p.texture));
    if (bark === undefined || !fronds.length) throw new DiscModelError('not a palm (no bark or no frond texture)');
    const pos: number[] = [];
    const nrm: number[] = [];
    const polys: PalmPoly[] = [];
    const vert = (p: number[], n: number[]) => {
        pos.push(p[0]!, p[1]!, p[2]!);
        const u = unit(n);
        for (const x of u) nrm.push(Math.max(-127, Math.min(127, Math.round(x * 127))));
        return pos.length / 3 - 1;
    };
    // trunk and every other opaque part: the OotF polygons rounded (`round`), so each bark band keeps its own texture and UVs
    const solid = refineMesh(
        { positions: m.positions, normals: m.normals, polygons: m.polygons.filter((q) => !alpha(q.texture)) },
        'round',
    );
    for (let i = 0; i < solid.positions.length / 3; i++) {
        pos.push(solid.positions[i * 3]!, solid.positions[i * 3 + 1]!, solid.positions[i * 3 + 2]!);
        nrm.push(solid.normals[i * 3]!, solid.normals[i * 3 + 1]!, solid.normals[i * 3 + 2]!);
    }
    for (const q of solid.polygons) polys.push(q);
    // the crown: the top of the bark
    const tv = [...new Set(m.polygons.filter((p) => p.texture === bark).flatMap((p) => p.indices))].map(P);
    const top = Math.max(...tv.map((v) => v[1]!));
    const tops = tv.filter((v) => v[1]! >= top - 1e-4);
    const crown = [0, 1, 2].map((k) => tops.reduce((a, v) => a + v[k]!, 0) / tops.length);
    // fronds: curved cards from each OotF card
    const SEG = 6;
    for (const f of fronds) {
        const n = f.indices.length;
        const pts = f.indices.map(P);
        const uv = (i: number) => [f.uvs[i * 2]!, f.uvs[i * 2 + 1]!];
        // the base edge is the one nearest the crown; the opposite side is the tip
        let best = 0;
        let bestD = Infinity;
        for (let e = 0; e < n; e++) {
            const a = pts[e]!;
            const b = pts[(e + 1) % n]!;
            const d = Math.hypot(
                (a[0]! + b[0]!) / 2 - crown[0]!,
                (a[1]! + b[1]!) / 2 - crown[1]!,
                (a[2]! + b[2]!) / 2 - crown[2]!,
            );
            if (d < bestD) {
                bestD = d;
                best = e;
            }
        }
        const A = best;
        const B = (best + 1) % n;
        const C = (best + 2) % n;
        const D = n === 4 ? (best + 3) % n : C;
        const pa = pts[A]!;
        const pb = pts[B]!;
        const pc = pts[C]!;
        const pd = pts[D]!;
        const len = Math.hypot(
            (pc[0]! + pd[0]! - pa[0]! - pb[0]!) / 2,
            (pc[1]! + pd[1]! - pa[1]! - pb[1]!) / 2,
            (pc[2]! + pd[2]! - pa[2]! - pb[2]!) / 2,
        );
        const grid: number[][] = [];
        const guv: number[][][] = [];
        for (let s = 0; s <= SEG; s++) {
            const t = s / SEG;
            const row: number[] = [];
            const ruv: number[][] = [];
            for (const [p0, p1, q0, q1] of [
                [pa, pd, uv(A), uv(D)],
                [pb, pc, uv(B), uv(C)],
            ] as const) {
                const p = [0, 1, 2].map((k) => p0[k]! + (p1[k]! - p0[k]!) * t);
                p[1] = p[1]! + len * (0.12 * t - 0.32 * t * t);
                row.push(vert(p, [0, 1, 0]));
                ruv.push([q0[0]! + (q1[0]! - q0[0]!) * t, q0[1]! + (q1[1]! - q0[1]!) * t]);
            }
            grid.push(row);
            guv.push(ruv);
        }
        for (let s = 0; s < SEG; s++) {
            const [a, b] = grid[s]!;
            const [d, c] = grid[s + 1]!;
            const [ua, ub] = guv[s]!;
            const [ud, uc] = guv[s + 1]!;
            for (const tri of [
                { v: [a!, d!, c!], u: [ua!, ud!, uc!] },
                { v: [a!, c!, b!], u: [ua!, uc!, ub!] },
            ]) {
                polys.push({ flags: f.flags, texture: f.texture, indices: tri.v, uvs: tri.u.flat() });
                polys.push({
                    flags: f.flags,
                    texture: f.texture,
                    indices: [tri.v[0]!, tri.v[2]!, tri.v[1]!],
                    uvs: [tri.u[0]!, tri.u[2]!, tri.u[1]!].flat(),
                });
            }
        }
    }
    return {
        ...m,
        positions: Float32Array.from(pos),
        normals: Int8Array.from(nrm),
        normalW: undefined,
        polygons: polys,
        bounds: null,
    };
}
