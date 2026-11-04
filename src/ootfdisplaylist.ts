import { view } from './bytes.ts';
import type { Skeleton, SkelWeight } from './ootfanim.ts';
import type { NeutralModel, NeutralPoly } from './ootfmodel.ts';

/**
 * PS2 model record 0x0211, the strip display list the engine draws skinned models and the Birch tree class from.
 * Decoded from the PAL disc (LEVEL1ON, WORLDCON, RESOURES, SYSTEM: every model whose list has no extra tail section,
 * 62 + 422 single-group and 196 + 192 + 7 + 332 multi-group models, reproduces its 0x0204 triangle set exactly).
 * Notes: docs/journal/2026-11-01/ootf-displaylist-decoded.md, docs/reference/level-format.md section 11.
 *
 * Layout (little endian, no alignment):
 *
 *     u32 1, u32 V, u32 0,
 *     V vertex groups:  count[0], cum[0], count[1], cum[1], ... count[V-1]   (2V-1 u32; cum = start of the next group,
 *                                                                             padded up to a multiple of 4)
 *     u32 batchCount, u32 texture of the first batch
 *     per batch:
 *         u32 W, W x { u8 group, u8 slot }   vertex groups to load into the vertex window before the batch
 *         u32 triangles                      sum over strips of (length - 2), degenerates included
 *         u32 cap, cap x u8                  strip stream: 1-based window slot per element, 0 ends a strip
 *         u32 cap, cap x (f32 u, f32 v)      one UV per stream element (the 0 terminators carry (0, 0))
 *         u32 texture of the next batch      (0 after the last one)
 *
 * `cap` is the element count (terminators included) rounded up to a multiple of 64; unused bytes are zero. A group is a
 * contiguous range of the model's 0x0203 vertices (range start = the padded sum of the previous counts) and is copied to
 * window slot `slot`; stream value s then means window slot s - 1. Several batches can follow one load (W = 0). The vertex
 * count of 0x0203 is the padded total, the pad vertices are zero. The window held at most 225 slots on the disc.
 *
 * Not produced, not understood: some larger models carry a second section after the last batch (on the two-LOD Rynn
 * models it is the second LOD, 7014 bytes for 3877; others 540 to 17486 bytes of u32 words, many counting down), the leading
 * word is 2 on those, and 0x0214 on the big skinned models is kept as is.
 *
 * Encoder rules chosen here: a model that fits one window (and `maxJoints`) is one group in the original vertex order. Bigger
 * models without joint information (trees) are split into chunks of at most `maxWindow` distinct vertices, each chunk its own
 * group with copied vertices (`DisplayListLayout.source`). Skinned models (`vertexJoints` given) use the disc's scheme: every
 * vertex exists once, vertices are grouped by primary joint into small groups (default 48 vertices, 16 joints), a batch loads
 * every group its triangles touch packed from slot 0 (disc Rynn: 24 groups, 10 batches, up to 7 loads each); `source` is then a
 * permutation plus pad vertices and the 0x0204 polygons keep their shape. Strips are built greedily; orientation follows the
 * majority on the disc (strip parity corrected, opposite to the 0x0204 winding). Strips have at most 30 elements,
 * and zero/UV padding keeps each strip and its terminator inside one 64-element block, matching the native lists.
 */

export class DisplayListError extends Error {}

export const DL_MAX_WINDOW = 225;
const MAX_BATCH_ELEMENTS = 448;
// All 139,353 strips in 1,593 audited PAL models contain at most 30 elements.
// Longer imported strips produce missing wedges in both the native VU interpreter and AOT path.
const MAX_STRIP_ELEMENTS = 30;
const STRIP_BLOCK_ELEMENTS = 64;

const stripStart = (at: number, length: number): number =>
    (at % STRIP_BLOCK_ELEMENTS) + length + 1 > STRIP_BLOCK_ELEMENTS
        ? Math.ceil(at / STRIP_BLOCK_ELEMENTS) * STRIP_BLOCK_ELEMENTS
        : at;

export interface DlStrip {
    /** Window slots (0-based), one per element. */
    slots: number[];
    u: number[];
    v: number[];
}
export interface DlBatch {
    texture: number;
    loads: { group: number; slot: number }[];
    triangles: number;
    strips: DlStrip[];
}
export interface DlGroup {
    count: number;
    /** First 0x0203 vertex of the group. */
    start: number;
}
export interface DecodedDisplayList {
    groups: DlGroup[];
    batches: DlBatch[];
    /** Bytes after the last batch (the unexplained tail section on some models). */
    tail: number;
}

const pad4 = (n: number): number => (n + 3) & ~3;

/** Decode a 0x0211 record. Throws `DisplayListError` when it does not follow the layout above. */
export function decodeDisplayList(b: Uint8Array): DecodedDisplayList {
    const dv = view(b);
    const u32 = (o: number): number => {
        if (o + 4 > b.length) throw new DisplayListError(`display list truncated at ${o}`);
        return dv.getUint32(o, true);
    };
    if ((u32(0) !== 1 && u32(0) !== 2) || u32(8) !== 0) throw new DisplayListError('bad display list header');
    const v = u32(4);
    if (v < 1 || v > 1024) throw new DisplayListError(`bad group count ${v}`);
    const counts: number[] = [];
    const starts: number[] = [0];
    for (let g = 0; g < v; g++) {
        counts.push(u32(12 + g * 8));
        if (g < v - 1) starts.push(u32(16 + g * 8));
    }
    let o = 12 + (2 * v - 1) * 4;
    const batchCount = u32(o);
    let texture = u32(o + 4);
    o += 8;
    const batches: DlBatch[] = [];
    for (let k = 0; k < batchCount; k++) {
        const w = u32(o);
        o += 4;
        const loads: { group: number; slot: number }[] = [];
        for (let i = 0; i < w; i++) {
            if (o + 2 > b.length) throw new DisplayListError('display list truncated');
            loads.push({ group: dv.getUint8(o), slot: dv.getUint8(o + 1) });
            o += 2;
        }
        const triangles = u32(o);
        const cap = u32(o + 4);
        o += 8;
        if (cap % 64 !== 0 || cap === 0 || o + cap + 4 + cap * 8 + 4 > b.length) {
            throw new DisplayListError(`bad batch ${k}: cap ${cap}`);
        }
        const stream = b.subarray(o, o + cap);
        o += cap;
        if (u32(o) !== cap) throw new DisplayListError(`batch ${k}: UV block size differs`);
        o += 4;
        const strips: DlStrip[] = [];
        let cur: DlStrip = { slots: [], u: [], v: [] };
        for (let i = 0; i < cap; i++) {
            if (stream[i] === 0) {
                if (cur.slots.length) strips.push(cur);
                cur = { slots: [], u: [], v: [] };
            } else {
                cur.slots.push(stream[i]! - 1);
                cur.u.push(dv.getFloat32(o + i * 8, true));
                cur.v.push(dv.getFloat32(o + i * 8 + 4, true));
            }
        }
        if (cur.slots.length) strips.push(cur);
        o += cap * 8;
        batches.push({ texture, loads, triangles, strips });
        texture = u32(o);
        o += 4;
    }
    return { groups: counts.map((count, g) => ({ count, start: starts[g]! })), batches, tail: b.length - o };
}

export interface DlTriangle {
    /** Global 0x0203 vertex indices in the winding the strip draws (parity corrected). */
    vertices: [number, number, number];
    texture: number;
    u: [number, number, number];
    v: [number, number, number];
}

/** All non-degenerate triangles of a decoded list, with window slots resolved to 0x0203 vertex numbers. */
export function expandTriangles(dl: DecodedDisplayList): DlTriangle[] {
    const out: DlTriangle[] = [];
    const window = new Map<number, number>();
    for (const b of dl.batches) {
        for (const l of b.loads) {
            const g = dl.groups[l.group];
            if (!g) throw new DisplayListError(`load of missing group ${l.group}`);
            for (let k = 0; k < g.count; k++) window.set(l.slot + k, g.start + k);
        }
        for (const s of b.strips) {
            for (let i = 0; i + 2 < s.slots.length; i++) {
                const idx = [i, i + 1, i + 2];
                const order = i % 2 === 0 ? idx : [i + 1, i, i + 2];
                const vs = order.map((j) => window.get(s.slots[j]!));
                if (vs.some((x) => x === undefined)) throw new DisplayListError('stream names an unloaded slot');
                if (new Set(vs).size < 3) continue;
                out.push({
                    vertices: vs as [number, number, number],
                    texture: b.texture,
                    u: order.map((j) => s.u[j]) as [number, number, number],
                    v: order.map((j) => s.v[j]) as [number, number, number],
                });
            }
        }
    }
    return out;
}

// ---------------------------------------------------------------------------------------------------- encoder

export interface DisplayListOptions {
    /** Largest number of vertices one group may hold (default and disc maximum 225). */
    maxWindow?: number;
    /** Wind strips like the 0x0204 polygons instead of opposite to them (default; the disc has both). */
    sameWinding?: boolean;
    /**
     * Skinned models: the joints that weight vertex v, heaviest first. Groups are then limited to `maxJoints` distinct
     * joints (the disc groups hold at most 31, usually under 15) and triangles are clustered by joint before chunking.
     */
    vertexJoints?: (vertex: number) => readonly number[];
    /** Joint limit per group when `vertexJoints` is given (default 16). */
    maxJoints?: number;
    /** Skinned layout: vertices per group (default 48). */
    maxGroup?: number;
}

export interface DisplayListLayout {
    /** The record body (0x0211). */
    record: Uint8Array;
    /**
     * New vertex layout the 0x0203 / 0x0204 / 0x0208 records must use: `source[i]` = vertex of the input model that new
     * vertex i copies, or -1 for a zero pad vertex. Identity (plus pad) when the model fits one group.
     */
    source: Int32Array;
    /** Input polygons re-indexed into the new vertex layout (same order, same flags, textures and UVs). */
    polygons: NeutralPoly[];
    /** Number of groups written. */
    groups: number;
    batches: number;
}

interface Tri {
    v: [number, number, number]; // vertex numbers, polygon winding
    u: [number, number, number];
    w: [number, number, number];
    texture: number;
    /** Polygon of the input this triangle came from. */
    poly: number;
}

function polygonTriangles(polys: readonly NeutralPoly[]): Tri[] {
    const out: Tri[] = [];
    polys.forEach((p, poly) => {
        const n = p.indices.length;
        for (let k = 1; k + 1 < n; k++) {
            const ix = [0, k, k + 1];
            out.push({
                v: ix.map((i) => p.indices[i]) as [number, number, number],
                u: ix.map((i) => p.uvs[i * 2]) as [number, number, number],
                w: ix.map((i) => p.uvs[i * 2 + 1]) as [number, number, number],
                texture: p.texture,
                poly,
            });
        }
    });
    return out;
}

interface Elem {
    vertex: number;
    u: number;
    v: number;
}

/**
 * Greedy strips over triangles that share one vertex numbering. Strip triangle k is drawn (e0, e1, e2) for even k and
 * (e1, e0, e2) for odd k; the encoder makes that the reverse of the polygon winding. A shared vertex keeps one UV per
 * strip, so a triangle only joins a strip when its UVs at the shared corners equal the strip's.
 */
function stripify(tris: readonly Tri[], same: boolean): Elem[][] {
    const used = new Uint8Array(tris.length);
    const edge = new Map<number, number[]>(); // directed polygon edge a -> b
    const key = (a: number, b: number): number => a * 1048576 + b;
    tris.forEach((t, i) => {
        for (let k = 0; k < 3; k++) {
            const kk = key(t.v[k]!, t.v[(k + 1) % 3]!);
            const l = edge.get(kk);
            if (l) l.push(i);
            else edge.set(kk, [i]);
        }
    });
    const corner = (t: Tri, v: number): Elem => {
        const k = t.v.indexOf(v);
        return { vertex: v, u: t.u[k]!, v: t.w[k]! };
    };
    const find = (a: number, b: number): number => {
        const l = edge.get(key(a, b));
        if (!l) return -1;
        for (const i of l) if (!used[i]) return i;
        return -1;
    };
    const grow = (first: number, rot: number, commit: boolean): Elem[] => {
        const t = tris[first]!;
        const rev = (same ? [t.v[0], t.v[1], t.v[2]] : [t.v[2], t.v[1], t.v[0]]) as number[];
        const s: Elem[] = [0, 1, 2].map((k) => corner(t, rev[(rot + k) % 3]!));
        const taken = [first];
        used[first] = 1;
        for (;;) {
            const n = s.length;
            const p = s[n - 2]!;
            const q = s[n - 1]!;
            // even triangle (p, q, w) needs T with directed edge q -> p, odd (q, p, w) needs p -> q
            const i = ((n - 2) % 2 === 0) !== same ? find(q.vertex, p.vertex) : find(p.vertex, q.vertex);
            if (i < 0) break;
            const T = tris[i]!;
            const w = T.v.find((x) => x !== p.vertex && x !== q.vertex);
            if (w === undefined) break;
            const cp = corner(T, p.vertex);
            const cq = corner(T, q.vertex);
            if (cp.u !== p.u || cp.v !== p.v || cq.u !== q.u || cq.v !== q.v) break;
            s.push(corner(T, w));
            used[i] = 1;
            taken.push(i);
        }
        if (!commit) for (const i of taken) used[i] = 0;
        return s;
    };
    const strips: Elem[][] = [];
    for (let i = 0; i < tris.length; i++) {
        if (used[i]) continue;
        let best = 0;
        let bestLen = -1;
        for (let r = 0; r < 3; r++) {
            const len = grow(i, r, false).length;
            if (len > bestLen) {
                bestLen = len;
                best = r;
            }
        }
        strips.push(grow(i, best, true));
    }
    return strips;
}

/** Split triangles into chunks that use at most `limit` distinct vertices (and `maxJoints` joints when known). */
function chunkTriangles(
    tris: readonly Tri[],
    limit: number,
    vj: ((v: number) => readonly number[]) | undefined,
    maxJoints: number,
): Tri[][] {
    const chunks: Tri[][] = [];
    let cur: Tri[] = [];
    let set = new Set<number>();
    let joints = new Set<number>();
    for (const t of tris) {
        const fresh = new Set(t.v.filter((v) => !set.has(v))).size;
        const newJoints = vj ? new Set(t.v.flatMap((v) => vj(v)).filter((j) => !joints.has(j))).size : 0;
        if ((set.size + fresh > limit || joints.size + newJoints > maxJoints) && cur.length) {
            chunks.push(cur);
            cur = [];
            set = new Set();
            joints = new Set();
        }
        cur.push(t);
        for (const v of t.v) {
            set.add(v);
            if (vj) for (const j of vj(v)) joints.add(j);
        }
    }
    if (cur.length) chunks.push(cur);
    return chunks;
}

class Out {
    b: number[] = [];
    u8(n: number): void {
        this.b.push(n & 255);
    }
    u32(n: number): void {
        for (let i = 0; i < 4; i++) this.b.push((n >>> (i * 8)) & 255);
    }
    f32(n: number): void {
        const d = new DataView(new ArrayBuffer(4));
        d.setFloat32(0, n, true);
        for (let i = 0; i < 4; i++) this.b.push(d.getUint8(i));
    }
}

interface BatchPlan {
    /** Groups to copy into the window before the first batch of this plan entry (empty: keep what is loaded). */
    loads: { group: number; slot: number }[];
    texture: number;
    /** Triangles numbered inside the group (0-based slots). */
    tris: Tri[];
}

/**
 * Build the 0x0211 record of a (skinned or tree) model. `model.polygons` indices must address `model.positions`.
 * Returns the record together with the vertex layout the other records have to adopt (see `DisplayListLayout`).
 */
export function buildDisplayList(
    model: Pick<NeutralModel, 'positions' | 'polygons'>,
    opt: DisplayListOptions = {},
): DisplayListLayout {
    const limit = opt.maxWindow ?? DL_MAX_WINDOW;
    const nv = model.positions.length / 3;
    const tris = polygonTriangles(model.polygons);
    for (const t of tris) {
        for (const v of t.v) if (v < 0 || v >= nv) throw new DisplayListError(`vertex ${v} out of range`);
    }
    if (tris.length === 0) throw new DisplayListError('model has no triangles');
    const textures = [...new Set(tris.map((t) => t.texture))].sort((a, b) => a - b);

    const source: number[] = [];
    const groupCounts: number[] = [];
    const groupStarts: number[] = [];
    const plan: BatchPlan[] = [];
    let polygons: NeutralPoly[];
    const vj = opt.vertexJoints;
    const maxJoints = opt.maxJoints ?? 16;
    let order = tris;
    let fits = nv <= limit;
    if (vj) {
        const all = new Set<number>();
        for (const t of tris) for (const v of t.v) for (const j of vj(v)) all.add(j);
        fits = fits && all.size <= maxJoints;
        const key = (t: Tri): number => vj(t.v[0])[0] ?? -1;
        order = tris
            .map((t, i) => ({ t, i }))
            .sort((a, b) => key(a.t) - key(b.t) || a.i - b.i)
            .map((x) => x.t);
    }
    if (!fits && vj) {
        // Disc style: every vertex exists once, vertices are grouped by joint, a batch loads all groups it touches.
        const maxGroup = opt.maxGroup ?? 48;
        const sorted = [...Array(nv).keys()].sort((a, b) => (vj(a)[0] ?? -1) - (vj(b)[0] ?? -1) || a - b);
        const groupOf = new Int32Array(nv);
        const localOf = new Int32Array(nv);
        let members: number[] = [];
        let gj = new Set<number>();
        const cut = (): void => {
            if (!members.length) return;
            const start = pad4(source.length);
            while (source.length < start) source.push(-1);
            members.forEach((v, k) => {
                groupOf[v] = groupCounts.length;
                localOf[v] = k;
                source.push(v);
            });
            groupCounts.push(members.length);
            groupStarts.push(start);
            members = [];
            gj = new Set();
        };
        for (const v of sorted) {
            const js = vj(v);
            if (
                members.length &&
                (members.length >= maxGroup || gj.size + js.filter((j) => !gj.has(j)).length > maxJoints)
            )
                cut();
            members.push(v);
            for (const j of js) gj.add(j);
        }
        cut();
        const newIndex = new Int32Array(nv);
        source.forEach((old, i) => {
            if (old >= 0) newIndex[old] = i;
        });
        const groupsOf = (t: Tri): number[] => [...new Set(t.v.map((v) => groupOf[v]!))];
        const ordered = tris
            .map((t, i) => ({ t, i, k: Math.min(...groupsOf(t)) }))
            .sort((a, b) => a.k - b.k || a.i - b.i)
            .map((x) => x.t);
        // chunk by the union of groups a chunk needs
        const chunks: { tris: Tri[]; groups: number[] }[] = [];
        let cur: Tri[] = [];
        let cg = new Set<number>();
        let size = 0;
        for (const t of ordered) {
            const add = groupsOf(t).filter((g) => !cg.has(g));
            const addSize = add.reduce((a, g) => a + groupCounts[g]!, 0);
            if (cur.length && size + addSize > limit) {
                chunks.push({ tris: cur, groups: [...cg].sort((a, b) => a - b) });
                cur = [];
                cg = new Set();
                size = 0;
                add.length = 0;
                for (const g of groupsOf(t)) add.push(g);
            }
            cur.push(t);
            for (const g of add) {
                if (!cg.has(g)) {
                    cg.add(g);
                    size += groupCounts[g]!;
                }
            }
        }
        if (cur.length) chunks.push({ tris: cur, groups: [...cg].sort((a, b) => a - b) });
        for (const ch of chunks) {
            const slotOf = new Map<number, number>();
            let slot = 0;
            for (const g of ch.groups) {
                slotOf.set(g, slot);
                slot += groupCounts[g]!;
            }
            const loads = ch.groups.map((g) => ({ group: g, slot: slotOf.get(g)! }));
            let first = true;
            for (const tex of textures) {
                const own = ch.tris.filter((t) => t.texture === tex);
                if (!own.length) continue;
                const local = own.map((t) => ({
                    ...t,
                    v: t.v.map((v) => slotOf.get(groupOf[v]!)! + localOf[v]!) as [number, number, number],
                }));
                plan.push({ loads: first ? loads : [], texture: tex, tris: local });
                first = false;
            }
        }
        polygons = model.polygons.map((p) => ({ ...p, indices: p.indices.map((v) => newIndex[v]!), uvs: [...p.uvs] }));
    } else if (fits) {
        for (let i = 0; i < nv; i++) source.push(i);
        groupCounts.push(nv);
        groupStarts.push(0);
        textures.forEach((tex, k) =>
            plan.push({
                loads: k === 0 ? [{ group: 0, slot: 0 }] : [],
                texture: tex,
                tris: tris.filter((t) => t.texture === tex),
            }),
        );
        polygons = model.polygons.map((p) => ({ ...p, indices: [...p.indices], uvs: [...p.uvs] }));
    } else {
        // Every chunk becomes a group with its own copies of the vertices; polygons become single triangles.
        polygons = [];
        for (const chunk of chunkTriangles(order, limit, vj, maxJoints)) {
            const start = pad4(source.length);
            while (source.length < start) source.push(-1);
            const map = new Map<number, number>();
            for (const t of chunk) {
                for (const v of t.v) {
                    if (!map.has(v)) {
                        map.set(v, source.length - start);
                        source.push(v);
                    }
                }
            }
            const g = groupCounts.length;
            groupCounts.push(map.size);
            groupStarts.push(start);
            let first = true;
            for (const tex of textures) {
                const own = chunk.filter((t) => t.texture === tex);
                if (!own.length) continue;
                const local = own.map((t) => ({ ...t, v: t.v.map((v) => map.get(v)!) as [number, number, number] }));
                plan.push({ loads: first ? [{ group: g, slot: 0 }] : [], texture: tex, tris: local });
                first = false;
                for (const t of own) {
                    polygons.push({
                        flags: model.polygons[t.poly]!.flags & ~4,
                        texture: tex,
                        indices: t.v.map((v) => start + map.get(v)!),
                        uvs: [t.u[0], t.w[0], t.u[1], t.w[1], t.u[2], t.w[2]],
                    });
                }
            }
        }
    }
    while (source.length < pad4(source.length)) source.push(-1);

    interface Batch {
        plan: BatchPlan;
        loads: { group: number; slot: number }[];
        strips: Elem[][];
        triangles: number;
    }
    const batches: Batch[] = [];
    for (const bp of plan) {
        const strips = stripify(bp.tris, opt.sameWinding === true).flatMap((s) => {
            const parts: Elem[][] = [];
            // Carry the last two vertices into each continuation. Advancing by 28 triangles is even,
            // so restarting strip parity preserves winding, corner UVs and the exact triangle set.
            for (let start = 0; start + 2 < s.length; start += MAX_STRIP_ELEMENTS - 2)
                parts.push(s.slice(start, start + MAX_STRIP_ELEMENTS));
            return parts;
        });
        let cur: Elem[][] = [];
        let el = 0;
        let first = true;
        const flush = (): void => {
            if (!cur.length) return;
            batches.push({
                plan: bp,
                loads: first ? bp.loads : [],
                strips: cur,
                triangles: cur.reduce((a, s) => a + s.length - 2, 0),
            });
            first = false;
            cur = [];
            el = 0;
        };
        for (const s of strips) {
            if (stripStart(el, s.length) + s.length + 1 > MAX_BATCH_ELEMENTS) flush();
            cur.push(s);
            el = stripStart(el, s.length) + s.length + 1;
        }
        flush();
    }

    const o = new Out();
    o.u32(1);
    o.u32(groupCounts.length);
    o.u32(0);
    groupCounts.forEach((c, g) => {
        o.u32(c);
        if (g < groupCounts.length - 1) o.u32(groupStarts[g + 1]!);
    });
    o.u32(batches.length);
    o.u32(batches[0]!.plan.texture);
    batches.forEach((b, k) => {
        o.u32(b.loads.length);
        for (const l of b.loads) {
            o.u8(l.group);
            o.u8(l.slot);
        }
        o.u32(b.triangles);
        const elements = b.strips.reduce((a, s) => stripStart(a, s.length) + s.length + 1, 0);
        const cap = Math.ceil(elements / 64) * 64;
        o.u32(cap);
        const stream: number[] = [];
        const uv: number[] = [];
        for (const s of b.strips) {
            // The native consumer processes 64-element blocks independently. A strip and its terminator
            // must stay inside one block; mirror the disc's zero/UV padding before crossing that boundary.
            const start = stripStart(stream.length, s.length);
            while (stream.length < start) {
                stream.push(0);
                uv.push(0, 0);
            }
            for (const e of s) {
                if (e.vertex + 1 > 255) throw new DisplayListError('window slot above 254');
                stream.push(e.vertex + 1);
                uv.push(e.u, e.v);
            }
            stream.push(0);
            uv.push(0, 0);
        }
        while (stream.length < cap) {
            stream.push(0);
            uv.push(0, 0);
        }
        for (const x of stream) o.u8(x);
        o.u32(cap);
        for (const x of uv) o.f32(x);
        o.u32(k + 1 < batches.length ? batches[k + 1]!.plan.texture : 0);
    });
    return {
        record: Uint8Array.from(o.b),
        source: Int32Array.from(source),
        polygons,
        groups: groupCounts.length,
        batches: batches.length,
    };
}

/**
 * Convenience for static or tree models: build the display list and return the model rewritten in the vertex layout it needs
 * (vertices copied or padded per `source`, polygons re-indexed). Skinned models must apply `source` to their 0x0208 weight
 * lists as well (a copied vertex needs the weights of the vertex it copies, pad vertices need none).
 */
export function withDisplayList(
    m: NeutralModel,
    opt: DisplayListOptions = {},
): { model: NeutralModel; record: Uint8Array; layout: DisplayListLayout } {
    const layout = buildDisplayList(m, opt);
    const n = layout.source.length;
    const positions = new Float32Array(n * 3);
    const normals = new Int8Array(n * 3);
    const normalW = new Uint8Array(n);
    layout.source.forEach((s, i) => {
        if (s < 0) return;
        for (let k = 0; k < 3; k++) {
            positions[i * 3 + k] = m.positions[s * 3 + k]!;
            normals[i * 3 + k] = m.normals[s * 3 + k]!;
        }
        normalW[i] = m.normalW ? m.normalW[s]! : 0x7f;
    });
    return {
        model: { ...m, positions, normals, normalW, polygons: layout.polygons, bounds: null },
        record: layout.record,
        layout,
    };
}

/**
 * Apply a `DisplayListLayout.source` vertex layout to a parsed skeleton: every copy of a vertex gets the weights of the vertex
 * it copies (joint weights and channel cap weights), pad vertices get none, and each LOD that covered the old vertices
 * covers the new total. `polygonCount` is the new 0x0204 polygon count (LOD table `polyCount`). Single LOD models only.
 */
export function remapSkeletonVertices(s: Skeleton, source: Int32Array, polygonCount: number): Skeleton {
    const copies = new Map<number, number[]>();
    source.forEach((old, i) => {
        if (old < 0) return;
        const l = copies.get(old);
        if (l) l.push(i);
        else copies.set(old, [i]);
    });
    const remap = (list: SkelWeight[]): SkelWeight[] =>
        list
            .flatMap((w) => (copies.get(w.vertex) ?? []).map((vertex) => ({ vertex, weight: w.weight })))
            .sort((a, b) => a.vertex - b.vertex); // the disc lists are (mostly) ascending
    return {
        ...s,
        totalVertices: source.length,
        joints: s.joints.map((j) => ({ ...j, weights: j.weights.map(remap) })),
        channels: s.channels.map((c) => ({ ...c, caps: c.caps.map((k) => ({ ...k, weights: remap(k.weights) })) })),
        lods: s.lods.map((l, i) =>
            i === 0 ? { ...l, firstVertex: 0, vertexCount: source.length, polyCount: polygonCount } : l,
        ),
    };
}
