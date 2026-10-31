/**
 * Character skeleton (MOD 0x0208) and animation (ADB 0x0501..) codecs for both platforms, plus the PC to PS2 pieces
 * that are verified. Layouts and evidence: docs/journal/2026-10-31/ootf-animation.md.
 *
 * Summary of what is proven against the PAL disc (116 of 116 skeletons in NPCS.MOD + SYSTEM.MOD, 2476 of 2476
 * animations in NPCS.ADB + SYSTEM.ADB parse to the last byte) and against Order of the Flame (49 skeletons, 963 anims):
 *  - PS2 0x0208 = PC 0x0208 with: a u32 total vertex count after the node table, joint matrices stored `t(3), R(3x3)`
 *    instead of `R(3x3), t(3)`, channels without the two matrices, and one flat sphere list of 24-byte spheres with
 *    the centre stored directly (PC: per-LOD lists of 16-byte spheres naming a vertex).
 *  - PS2 ADB = per joint track (`first key offset, key count, flags, base translation`), keys are quaternions.
 *  - NOT solved (so no animation writer here): the exact rotation basis change between PC keys (delta against the bind
 *    pose, in a joint frame) and PS2 keys (absolute parent-relative quaternion). See the journal.
 */
import { latin1, view } from './bytes.ts';

export class AnimError extends Error {}

export type Mat12 = number[]; // 3 rows of the 3x3 then translation (PC order); PS2 stores translation first

export interface SkelNode {
    name: string;
    joint: number;
}
export interface SkelWeight {
    vertex: number;
    weight: number;
}
export interface SkelJoint {
    /** Inverse model-relative transform, rotation rows then translation (PC order, already normalised). */
    xform: Mat12;
    mesh: number;
    firstChild: number;
    nextSibling: number;
    /** Weights per LOD. */
    weights: SkelWeight[][];
}
export interface SkelLod {
    distance: number;
    usage: number;
    node: number;
    firstVertex: number;
    vertexCount: number;
    firstPoly: number;
    polyCount: number;
}
export interface SkelCap {
    values: [number, number, number, number, number];
    weights: SkelWeight[];
}
export interface SkelChannel {
    joint: number;
    caps: SkelCap[];
}
export interface SkelSphere {
    firstChild: number;
    nextSibling: number;
    /** PS2 only: the centre. PC spheres name a vertex instead (`vertex`). */
    centre: [number, number, number] | null;
    vertex: number;
    radius: number;
    channel: number;
    unknown: number;
}
export interface Skeleton {
    platform: 'ps2' | 'pc';
    /** 16 floats: the model bounding info. Kept verbatim. */
    bounds: Uint8Array;
    lodNames: string[];
    nodes: SkelNode[];
    totalVertices: number;
    joints: SkelJoint[];
    lods: SkelLod[];
    animIds: number[];
    channels: SkelChannel[];
    /** PS2: one list. PC: one list per LOD (flattened here to `spheresPerLod`). */
    spheres: SkelSphere[];
    spheresPerLod: SkelSphere[][];
}

class Rd {
    readonly dv: DataView;
    o = 0;
    constructor(readonly b: Uint8Array) {
        this.dv = view(b);
    }
    chk(n: number): void {
        if (this.o + n > this.b.length) throw new AnimError(`read past end at ${this.o}`);
    }
    u16(): number {
        this.chk(2);
        const v = this.dv.getUint16(this.o, true);
        this.o += 2;
        return v;
    }
    u32(): number {
        this.chk(4);
        const v = this.dv.getUint32(this.o, true);
        this.o += 4;
        return v;
    }
    i32(): number {
        this.chk(4);
        const v = this.dv.getInt32(this.o, true);
        this.o += 4;
        return v;
    }
    f32(): number {
        this.chk(4);
        const v = this.dv.getFloat32(this.o, true);
        this.o += 4;
        return v;
    }
    raw(n: number): Uint8Array {
        this.chk(n);
        const v = this.b.subarray(this.o, this.o + n);
        this.o += n;
        return v;
    }
    pstr(): string {
        const n = this.u16();
        const s = this.raw(n);
        const z = s.indexOf(0);
        return latin1(s, 0, z < 0 ? s.length : z);
    }
}

class Wr {
    private parts: number[] = [];
    u8(v: number): void {
        this.parts.push(v & 255);
    }
    u16(v: number): void {
        this.u8(v);
        this.u8(v >> 8);
    }
    u32(v: number): void {
        this.u16(v & 0xffff);
        this.u16(v >>> 16);
    }
    i32(v: number): void {
        this.u32(v >>> 0);
    }
    f32(v: number): void {
        const d = new DataView(new ArrayBuffer(4));
        d.setFloat32(0, v, true);
        for (let i = 0; i < 4; i++) this.u8(d.getUint8(i));
    }
    raw(b: Uint8Array): void {
        for (const x of b) this.u8(x);
    }
    pstr(s: string): void {
        this.u16(s.length); // PS2 0x0501 names carry no terminator
        for (let i = 0; i < s.length; i++) this.u8(s.charCodeAt(i));
    }
    fixed(s: string, n: number): void {
        for (let i = 0; i < n; i++) this.u8(i < s.length && i < n - 1 ? s.charCodeAt(i) : 0);
    }
    bytes(): Uint8Array {
        return Uint8Array.from(this.parts);
    }
}

function readWeights(r: Rd): SkelWeight[] {
    const n = r.u16();
    const out: SkelWeight[] = [];
    for (let i = 0; i < n; i++) out.push({ vertex: r.u32(), weight: r.f32() });
    return out;
}
function writeWeights(w: Wr, ws: SkelWeight[]): void {
    w.u16(ws.length);
    for (const x of ws) {
        w.u32(x.vertex);
        w.f32(x.weight);
    }
}

/** Decode a 0x0208 record of either platform. */
export function parseSkeleton(b: Uint8Array, platform: 'ps2' | 'pc'): Skeleton {
    const r = new Rd(b);
    const bounds = r.raw(64).slice();
    const nl = r.u16();
    if (nl < 1 || nl > 16) throw new AnimError(`bad LOD count ${nl}`);
    const lodNames: string[] = [];
    for (let i = 0; i < nl - 1; i++) lodNames.push(r.pstr());
    const nn = r.u16();
    const nodes: SkelNode[] = [];
    for (let i = 0; i < nn; i++) {
        const s = r.raw(32);
        const z = s.indexOf(0);
        nodes.push({ name: latin1(s, 0, z < 0 ? 32 : z), joint: r.i32() });
    }
    const totalVertices = platform === 'ps2' ? r.u32() : 0;
    const jc = r.u16();
    const joints: SkelJoint[] = [];
    for (let j = 0; j < jc; j++) {
        const f: number[] = [];
        for (let k = 0; k < 12; k++) f.push(r.f32());
        const xform = platform === 'ps2' ? [...f.slice(3), ...f.slice(0, 3)] : f;
        const mesh = r.i32();
        const firstChild = r.i32();
        const nextSibling = r.i32();
        const weights: SkelWeight[][] = [];
        for (let l = 0; l < nl; l++) weights.push(readWeights(r));
        joints.push({ xform, mesh, firstChild, nextSibling, weights });
    }
    const lods: SkelLod[] = [];
    for (let l = 0; l < nl; l++) {
        if (r.u16() !== 1) throw new AnimError('multi-mesh LOD');
        lods.push({
            distance: r.f32(),
            usage: r.u32(),
            node: r.u32(),
            firstVertex: r.u32(),
            vertexCount: r.u32(),
            firstPoly: r.u32(),
            polyCount: r.u32(),
        });
    }
    const na = r.u16();
    const animIds: number[] = [];
    for (let i = 0; i < na; i++) animIds.push(r.u32());
    const nc = r.u16();
    const channels: SkelChannel[] = [];
    for (let i = 0; i < nc; i++) {
        const joint = r.i32();
        if (platform === 'pc') r.raw(96); // xformA, xformB
        const cc = r.u16();
        const caps: SkelCap[] = [];
        for (let k = 0; k < cc; k++) {
            const values: [number, number, number, number, number] = [r.u32(), r.u32(), r.u32(), r.u32(), r.u32()];
            caps.push({ values, weights: readWeights(r) });
        }
        channels.push({ joint, caps });
    }
    const spheresPerLod: SkelSphere[][] = [];
    if (platform === 'ps2') {
        const n = r.u16();
        const list: SkelSphere[] = [];
        for (let i = 0; i < n; i++) {
            const firstChild = r.u16();
            const nextSibling = r.u16();
            const centre: [number, number, number] = [r.f32(), r.f32(), r.f32()];
            list.push({
                firstChild,
                nextSibling,
                centre,
                vertex: -1,
                radius: r.f32(),
                channel: r.u16(),
                unknown: r.u16(),
            });
        }
        spheresPerLod.push(list);
    } else {
        const lc = r.u16();
        for (let l = 0; l < lc; l++) {
            const n = r.u16();
            const list: SkelSphere[] = [];
            for (let i = 0; i < n; i++)
                list.push({
                    firstChild: r.u16(),
                    nextSibling: r.u16(),
                    centre: null,
                    vertex: r.u32(),
                    radius: r.f32(),
                    channel: r.u16(),
                    unknown: r.u16(),
                });
            spheresPerLod.push(list);
        }
    }
    if (r.o !== b.length) throw new AnimError(`0x0208 has ${b.length - r.o} trailing bytes`);
    return {
        platform,
        bounds,
        lodNames,
        nodes,
        totalVertices,
        joints,
        lods,
        animIds,
        channels,
        spheres: spheresPerLod.flat(),
        spheresPerLod,
    };
}

/** Parent joint index per joint from the first-child / next-sibling links (-1 = root). */
export function jointParents(s: Skeleton): number[] {
    const par = new Array<number>(s.joints.length).fill(-1);
    const seen = new Set<number>();
    const walk = (first: number, parent: number): void => {
        for (let j = first; ;) {
            if (seen.has(j) || j < 0 || j >= s.joints.length) throw new AnimError('joint tree loop or out of range');
            seen.add(j);
            par[j] = parent;
            const c = s.joints[j]!.firstChild;
            if (c > 0) walk(c, j);
            const nx = s.joints[j]!.nextSibling;
            if (nx <= 0) break;
            j = nx;
        }
    };
    if (s.joints.length > 0) walk(0, -1);
    return par;
}

/**
 * Write a PS2 0x0208 record from a decoded skeleton (PC or PS2). Conversion rules, all verified on the data:
 * joint matrices go translation-first, channels lose their matrices, the PC per-LOD vertex-id spheres become one list
 * of centre spheres (needs `positions`, the model's xyz floats, to resolve the vertex; spheres of LOD 0 only are kept
 * because PS2 has a single list), the vertex total is the sum of the LOD vertex counts.
 * `channelLimit` (default: keep all) lets a caller trim channels the way the PS2 data does (PS2 spider keeps 4 of 16).
 */
export function writePs2Skeleton(s: Skeleton, positions: Float32Array | null, channelLimit = Infinity): Uint8Array {
    const w = new Wr();
    w.raw(s.bounds);
    w.u16(s.lods.length);
    for (const n of s.lodNames) w.pstr(n);
    w.u16(s.nodes.length);
    for (const n of s.nodes) {
        w.fixed(n.name, 32);
        w.i32(n.joint);
    }
    w.u32(s.lods.reduce((a, l) => a + l.vertexCount, 0));
    w.u16(s.joints.length);
    for (const j of s.joints) {
        for (const v of [...j.xform.slice(9), ...j.xform.slice(0, 9)]) w.f32(v);
        w.i32(j.mesh);
        w.i32(j.firstChild);
        w.i32(j.nextSibling);
        for (let l = 0; l < s.lods.length; l++) writeWeights(w, j.weights[l] ?? []);
    }
    for (const l of s.lods) {
        w.u16(1);
        w.f32(l.distance);
        w.u32(l.usage);
        w.u32(l.node);
        w.u32(l.firstVertex);
        w.u32(l.vertexCount);
        w.u32(l.firstPoly);
        w.u32(l.polyCount);
    }
    w.u16(s.animIds.length);
    for (const a of s.animIds) w.u32(a);
    const chans = s.channels.slice(0, channelLimit);
    w.u16(chans.length);
    for (const c of chans) {
        w.i32(c.joint);
        w.u16(c.caps.length);
        for (const cap of c.caps) {
            for (const v of cap.values) w.u32(v);
            writeWeights(w, cap.weights);
        }
    }
    const src = s.spheresPerLod[0] ?? [];
    w.u16(src.length);
    for (const sp of src) {
        w.u16(sp.firstChild);
        w.u16(sp.nextSibling);
        let c = sp.centre ?? [0, 0, 0];
        if (!sp.centre && positions && sp.vertex >= 0 && sp.vertex * 3 + 2 < positions.length)
            c = [positions[sp.vertex * 3]!, positions[sp.vertex * 3 + 1]!, positions[sp.vertex * 3 + 2]!];
        w.f32(c[0]!);
        w.f32(c[1]!);
        w.f32(c[2]!);
        w.f32(sp.radius);
        w.u16(sp.channel);
        w.u16(sp.unknown);
    }
    return w.bytes();
}

// ---------------------------------------------------------------- animations

export interface PcKey {
    time: number;
    /** 3x3 rotation rows then translation. */
    xform: Mat12;
}
export interface PcAnim {
    name: string;
    duration: number;
    originalFrames: number;
    frames: number;
    flags: number;
    nodes: number;
    channels: number;
    keys: PcKey[];
    /** Per joint `{first, count}` into `keys`. */
    lookup: { first: number; count: number }[];
}

/** PC ADB: 0x0501 info, 0x0502 keys (`u16 n, n x {f32 t, 12 floats}`), 0x0503 lookup (`u16 n, n x {u32 first, u32 count}`). */
export function parsePcAnim(info: Uint8Array, data: Uint8Array, lookup: Uint8Array): PcAnim {
    const r = new Rd(info);
    const name = r.pstr();
    const duration = r.f32();
    const originalFrames = r.u32();
    const frames = r.u32();
    const flags = r.u32();
    const nodes = r.u32();
    const channels = r.u32();
    const d = new Rd(data);
    const n = d.u16();
    const keys: PcKey[] = [];
    for (let i = 0; i < n; i++) {
        const time = d.f32();
        const xform: number[] = [];
        for (let k = 0; k < 12; k++) xform.push(d.f32());
        keys.push({ time, xform });
    }
    const l = new Rd(lookup);
    const m = l.u16();
    const look: { first: number; count: number }[] = [];
    for (let i = 0; i < m; i++) look.push({ first: l.u32(), count: l.u32() });
    return { name, duration, originalFrames, frames, flags, nodes, channels, keys, lookup: look };
}

export interface Ps2Key {
    time: number;
    /** Quaternion x, y, z, w (matrix = transpose of the standard quaternion matrix, i.e. row-vector convention). */
    q: [number, number, number, number];
    /** Present only on tracks flagged 0x80000000. */
    pos: [number, number, number] | null;
}
export interface Ps2Track {
    /** Constant (or, for animated tracks, first-key) translation from the track header. */
    base: [number, number, number];
    hasPos: boolean;
    keys: Ps2Key[];
}
export interface Ps2Anim {
    name: string;
    duration: number;
    /** 1 = does not loop. */
    flags: number;
    frames: number;
    channels: number;
    thresholds: { rotation: number; scale: number; translation: number };
    tracks: Ps2Track[];
}

/**
 * PS2 ADB: 0x0501 `pstr name, f32 duration, u32 flags, u32 tracks, u32 channels, f32 rot, u32 1, f32 scale, u32 0,
 * f32 trans` and 0x0502 `u32 n, n x {u32 offset, u32 keys, u32 flags, f32 xyz}, u32 keyBytes, keys`. Keys are
 * `{f32 t, f32 qx qy qz qw}` (20 bytes) or with `f32 x y z` (32 bytes, flag 0x80000000). One track per joint.
 */
export function parsePs2Anim(info: Uint8Array, data: Uint8Array): Ps2Anim {
    const r = new Rd(info);
    const name = r.pstr();
    const duration = r.f32();
    const flags = r.u32();
    const frames = r.u32();
    const channels = r.u32();
    const rotation = r.f32();
    r.u32();
    const scale = r.f32();
    r.u32();
    const translation = r.f32();
    const d = new Rd(data);
    const n = d.u32();
    if (n !== frames) throw new AnimError('track count differs from 0x0501');
    const heads: { a: number; b: number; c: number; base: [number, number, number] }[] = [];
    for (let i = 0; i < n; i++) heads.push({ a: d.u32(), b: d.u32(), c: d.u32(), base: [d.f32(), d.f32(), d.f32()] });
    const keyBytes = d.u32();
    const start = d.o;
    if (start + keyBytes !== data.length) throw new AnimError('key byte count does not close the record');
    const tracks: Ps2Track[] = [];
    let expect = 0;
    for (const h of heads) {
        const hasPos = h.c === 0x80000000;
        if (h.c !== 0 && !hasPos) throw new AnimError(`unknown track flag ${h.c}`);
        if (h.a !== expect) throw new AnimError('track offsets are not contiguous');
        d.o = start + h.a;
        const keys: Ps2Key[] = [];
        for (let k = 0; k < h.b; k++) {
            const time = d.f32();
            const q: [number, number, number, number] = [d.f32(), d.f32(), d.f32(), d.f32()];
            keys.push({ time, q, pos: hasPos ? [d.f32(), d.f32(), d.f32()] : null });
        }
        expect += h.b * (hasPos ? 32 : 20);
        tracks.push({ base: h.base, hasPos, keys });
    }
    if (expect !== keyBytes) throw new AnimError('tracks do not add up to the key bytes');
    return { name, duration, flags, frames, channels, thresholds: { rotation, scale, translation }, tracks };
}

/** Re-encode a decoded PS2 animation (round-trips parsePs2Anim). Returns the 0x0501 and 0x0502 payloads. */
export function writePs2Anim(a: Ps2Anim): { info: Uint8Array; data: Uint8Array } {
    const i = new Wr();
    i.pstr(a.name);
    i.f32(a.duration);
    i.u32(a.flags);
    i.u32(a.tracks.length);
    i.u32(a.channels);
    i.f32(a.thresholds.rotation);
    i.u32(1);
    i.f32(a.thresholds.scale);
    i.u32(0);
    i.f32(a.thresholds.translation);
    const d = new Wr();
    d.u32(a.tracks.length);
    let off = 0;
    for (const t of a.tracks) {
        d.u32(off);
        d.u32(t.keys.length);
        d.u32(t.hasPos ? 0x80000000 : 0);
        for (const v of t.base) d.f32(v);
        off += t.keys.length * (t.hasPos ? 32 : 20);
    }
    d.u32(off);
    for (const t of a.tracks)
        for (const k of t.keys) {
            d.f32(k.time);
            for (const v of k.q) d.f32(v);
            if (t.hasPos) for (const v of k.pos ?? [0, 0, 0]) d.f32(v);
        }
    return { info: i.bytes(), data: d.bytes() };
}

// ---------------------------------------------------------------- id map

export interface NamedAnim {
    id: number;
    name: string;
}

/**
 * pc animation id -> ps2 animation id by case-insensitive name. In the shipped data the shared creatures keep ids
 * and names (spider ids 590..598 are `normaldeath`, `crawl`, ... in both games), so this is also the retarget
 * map when a PC creature is replaced by the PS2 creature of the same name. Duplicate names pick the lowest id.
 * Animations without a PS2 equivalent are absent from the map.
 */
export function buildAnimMap(pc: NamedAnim[], ps2: NamedAnim[]): Map<number, number> {
    const byName = new Map<string, number>();
    for (const a of [...ps2].sort((x, y) => x.id - y.id)) {
        const k = a.name.toLowerCase();
        if (!byName.has(k)) byName.set(k, a.id);
    }
    const out = new Map<number, number>();
    for (const a of pc) {
        const hit = byName.get(a.name.toLowerCase());
        if (hit !== undefined) out.set(a.id, hit);
    }
    return out;
}

/** Name of an animation from its 0x0501 record (both platforms start with a `u16 length, string`). */
export function animName(info: Uint8Array): string {
    return new Rd(info).pstr();
}
