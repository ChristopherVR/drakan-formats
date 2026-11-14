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
