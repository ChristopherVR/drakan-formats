import { view } from './bytes.ts';
import { ootfDebugFlag } from './ootfdebug.ts';
import { type Ps2Entry, ps2String, writePs2Srsc } from './ootfcontainer.ts';
import {
    MOD_BOUNDS,
    MOD_CHARACTER,
    MOD_NAME,
    MOD_POLYGONS,
    MOD_VERTICES,
    ModelError,
    type ModelTextureRef,
    parseModelName,
} from './model.ts';
import type { SrscReader } from './srsc.ts';

/**
 * Order of the Flame (PC) MOD -> PS2 MOD for static models. PC layout: OpenDrakan `doc/riot_database_format.txt` and
 * `src/odCore/db/Model.cpp`; PS2 layout: docs/reference/level-format.md section 11 plus the byte-level checks in
 * docs/journal/2026-10-31/ootf-models.md. Skinned models (0x0208) are not handled here (see ootfanim.ts).
 *
 * Both sides go through one neutral form (`NeutralModel`): a PS2 model read into it and written back reproduces the
 * 0x0200 / 0x0203 / 0x0204 / 0x0207 records byte for byte (checked on the PAL disc, see the journal).
 *
 * NOT produced here: the PS2 strip display list 0x0211 (decoded and encoded in ootfdisplaylist.ts). Tested in game (docs/journal/2026-10-31/ootf-displaylist.md): ordinary
 * static props (level pieces, camp props) draw from 0x0203/0x0204 alone, a converted PC model without 0x0211 renders
 * textured and upright. Exceptions: skinned models and the Birch tree class vanish without 0x0211.
 */

export const MOD_GROUP = 0x0201;
export const MOD_COUNTERS = 0x0202;
export const MOD_VERSION = 0x0402;
export const MOD_VERSION_VALUE = 0x011b;
export const MOD_TEXTURES_PC = 0x0206;
export const MOD_LOD_PC = 0x0209;

export interface NeutralPoly {
    /** PS2 polygon flags (2 double sided, 4 on quads). */
    flags: number;
    /** Index into the model's texture list. */
    texture: number;
    /** 3 or 4 vertex indices. */
    indices: number[];
    /** u, v per corner (2 * indices.length). */
    uvs: number[];
}

export interface NeutralModel {
    name: string;
    /** 0x0200 shading word. */
    shading: number;
    /** The optional f32 after the shading word (present when `shading & 0x20000`). */
    distance: number | null;
    textures: ModelTextureRef[];
    /** x, y, z per vertex. */
    positions: Float32Array;
    /** Signed-byte normals (3 per vertex, about +-127). */
    normals: Int8Array;
    polygons: NeutralPoly[];
    /** Second u32 of 0x0200 (0 on 252 of 265 sampled models, 2 on 13; meaning unknown). */
    reserved?: number;
    /** Fourth byte of each 0x0203 normal (0x7f except 0 on 2877 of 117556 sampled vertices). */
    normalW?: Uint8Array;
    /** Complete PS2 0x0207 body (8 prefix bytes + bounding data), or null to synthesise from the vertices. */
    bounds: Uint8Array | null;
}

// ---------------------------------------------------------------------------------------------------- PS2 side

/** Read a PS2 static model into the neutral form (quads kept). Returns null when `id` is not a model. */
export async function readPs2Neutral(mod: SrscReader, id: number): Promise<NeutralModel | null> {
    const get = async (type: number): Promise<Uint8Array | null> => {
        const e = mod.find(type, id);
        return e ? mod.readRaw(e) : null;
    };
    const n = await get(MOD_NAME);
    if (!n) return null;
    const info = parseModelName(n);
    const vr = await get(MOD_VERTICES);
    const pr = await get(MOD_POLYGONS);
    if (!vr || !pr) throw new ModelError(`model ${id}: missing vertices or polygons`);
    const vdv = view(vr);
    const nv = vdv.getUint16(0, true);
    const positions = new Float32Array(nv * 3);
    const normals = new Int8Array(nv * 3);
    const normalW = new Uint8Array(nv);
    for (let i = 0; i < nv; i++) {
        normalW[i] = vdv.getUint8(2 + nv * 12 + i * 4 + 3);
        for (let k = 0; k < 3; k++) positions[i * 3 + k] = vdv.getFloat32(2 + i * 12 + k * 4, true);
        for (let k = 0; k < 3; k++) normals[i * 3 + k] = vdv.getInt8(2 + nv * 12 + i * 4 + k);
    }
    const pdv = view(pr);
    const count = pdv.getUint16(0, true);
    let o = 2;
    const meta: { flags: number; tex: number; idx: number[] }[] = [];
    let corners = 0;
    for (let i = 0; i < count; i++) {
        const vc = pdv.getUint16(o + 2, true);
        const idx: number[] = [];
        for (let k = 0; k < vc; k++) idx.push(pdv.getUint16(o + 6 + k * 2, true));
        meta.push({ flags: pdv.getUint16(o, true), tex: pdv.getUint16(o + 4, true), idx });
        o += 6 + vc * 2;
        corners += vc;
    }
    if (o % 4 === 2) o += 2;
    if (o + corners * 8 !== pr.length) throw new ModelError(`model ${id}: 0x0204 size mismatch`);
    const polygons: NeutralPoly[] = [];
    let c = 0;
    for (const p of meta) {
        const uvs: number[] = [];
        for (let k = 0; k < p.idx.length; k++) {
            uvs.push(pdv.getFloat32(o + (c + k) * 8, true), pdv.getFloat32(o + (c + k) * 8 + 4, true));
        }
        c += p.idx.length;
        polygons.push({ flags: p.flags, texture: p.tex, indices: p.idx, uvs });
    }
    const bounds = await get(MOD_BOUNDS);
    const ndv = view(n);
    const reserved = ndv.getUint32(2 + ndv.getUint16(0, true) + 4, true);
    return {
        reserved,
        normalW,
        name: info.name,
        shading: info.shading,
        distance: info.distance,
        textures: info.textures,
        positions,
        normals,
        polygons,
        bounds,
    };
}

function f32(dv: DataView, o: number, v: number): void {
    dv.setFloat32(o, v, true);
}

/** PS2 0x0200 body. */
export function writePs2ModelName(m: NeutralModel): Uint8Array {
    const nm = ps2String(m.name);
    const hasDist = (m.shading & 0x20000) !== 0;
    const out = new Uint8Array(nm.length + 8 + (hasDist ? 4 : 0) + 4 + m.textures.length * 4);
    out.set(nm, 0);
    const dv = view(out);
    let o = nm.length;
    dv.setUint32(o, m.shading >>> 0, true);
    dv.setUint32(o + 4, m.reserved ?? 0, true);
    o += 8;
    if (hasDist) {
        f32(dv, o, m.distance ?? 49000);
        o += 4;
    }
    dv.setUint32(o, m.textures.length, true);
    o += 4;
    for (const t of m.textures) {
        dv.setUint16(o, t.id, true);
        dv.setUint16(o + 2, t.db, true);
        o += 4;
    }
    return out;
}

/** PS2 0x0203 body: `u16 n, f32 xyz[n], (i8 nx, ny, nz, 0x7f)[n]`. */
export function writePs2Vertices(m: NeutralModel): Uint8Array {
    const n = m.positions.length / 3;
    if (n > 0xffff) throw new ModelError(`${n} vertices do not fit a PS2 model`);
    const out = new Uint8Array(2 + n * 16);
    const dv = view(out);
    dv.setUint16(0, n, true);
    for (let i = 0; i < n * 3; i++) f32(dv, 2 + i * 4, m.positions[i]!);
    for (let i = 0; i < n; i++) {
        const o = 2 + n * 12 + i * 4;
        dv.setInt8(o, m.normals[i * 3]!);
        dv.setInt8(o + 1, m.normals[i * 3 + 1]!);
        dv.setInt8(o + 2, m.normals[i * 3 + 2]!);
        out[o + 3] = m.normalW?.[i] ?? 0x7f;
    }
    return out;
}

/** PS2 0x0204 body: index-only polygons, `u16 0` pad when they end at 2 mod 4, then the UV block. */
export function writePs2Polygons(m: NeutralModel): Uint8Array {
    let head = 2;
    let corners = 0;
    for (const p of m.polygons) {
        head += 6 + p.indices.length * 2;
        corners += p.indices.length;
    }
    const uvAt = head % 4 === 2 ? head + 2 : head;
    const out = new Uint8Array(uvAt + corners * 8);
    const dv = view(out);
    dv.setUint16(0, m.polygons.length, true);
    let o = 2;
    let c = 0;
    for (const p of m.polygons) {
        dv.setUint16(o, p.flags, true);
        dv.setUint16(o + 2, p.indices.length, true);
        dv.setUint16(o + 4, p.texture, true);
        for (let k = 0; k < p.indices.length; k++) {
            dv.setUint16(o + 6 + k * 2, p.indices[k]!, true);
            f32(dv, uvAt + (c + k) * 8, p.uvs[k * 2]!);
            f32(dv, uvAt + (c + k) * 8 + 4, p.uvs[k * 2 + 1]!);
        }
        o += 6 + p.indices.length * 2;
        c += p.indices.length;
    }
    return out;
}

/** Number of shapes in a structurally valid sphere-only 0x0207 hierarchy, or null for another/invalid layout. */
export function sphereHierarchyCount(bounds: Uint8Array): number | null {
    if (bounds.length < 76) return null;
    const dv = view(bounds);
    const count = dv.getUint16(72, true);
    if (dv.getUint16(74, true) !== 0 || count > 0x7fff || bounds.length !== 76 + count * 20) return null;
    for (let i = 0; i < count * 2; i++) if (dv.getUint16(76 + i * 2, true) >= count) return null;
    for (let i = 0; i < count * 4; i++) {
        const value = dv.getFloat32(76 + count * 4 + i * 4, true);
        if (!Number.isFinite(value) || (i % 4 === 3 && value < 0)) return null;
    }
    return count;
}

/** One shape of an OBB 0x0207 hierarchy: `(first child, next sibling)`, the box (minimum corner, 3 scaled axes), polygons. */
export interface ObbShape {
    child: number;
    sibling: number;
    box: number[];
    polygons: number[];
}

/**
 * Parse an OBB 0x0207 hierarchy (`num_shapes`, `is_obb` 1 at +72): `num_shapes` pairs `(first child, next sibling)`, then
 * per shape the box (12 floats) and `u16 count, u16 polygon[count]`. Every OBB block of the disc and the PC install has this
 * layout (2026-11-06). Null for a sphere hierarchy or anything that does not fit exactly.
 */
export function parseObbHierarchy(bounds: Uint8Array): ObbShape[] | null {
    if (bounds.length < 76) return null;
    const dv = view(bounds);
    const n = dv.getUint16(72, true);
    if (dv.getUint16(74, true) !== 1 || n === 0) return null;
    let o = 76 + n * 4;
    const shapes: ObbShape[] = [];
    for (let i = 0; i < n; i++) {
        if (o + 50 > bounds.length) return null;
        const box = Array.from({ length: 12 }, (_, k) => dv.getFloat32(o + k * 4, true));
        const count = dv.getUint16(o + 48, true);
        o += 50;
        if (o + count * 2 > bounds.length) return null;
        const polygons = Array.from({ length: count }, (_, k) => dv.getUint16(o + k * 2, true));
        o += count * 2;
        const child = dv.getUint16(76 + i * 4, true);
        const sibling = dv.getUint16(78 + i * 4, true);
        if (child >= n || sibling >= n || box.some((v) => !Number.isFinite(v))) return null;
        shapes.push({ child, sibling, box, polygons });
    }
    return o === bounds.length ? shapes : null;
}

/** Where `p` lies in a box's own frame (0..1 on each axis inside); the axes are scaled by the box size. */
function boxCoords(box: readonly number[], p: readonly number[]): number[] {
    const d = [p[0]! - box[0]!, p[1]! - box[1]!, p[2]! - box[2]!];
    return [0, 1, 2].map((k) => {
        const a = box.slice(3 + k * 3, 6 + k * 3);
        const len2 = a[0]! * a[0]! + a[1]! * a[1]! + a[2]! * a[2]!;
        return len2 > 0 ? (d[0]! * a[0]! + d[1]! * a[1]! + d[2]! * a[2]!) / len2 : 0;
    });
}

/** Squared distance (in box units, scaled by the box's longest axis) from `p` to the box; 0 inside. */
function boxDistance2(box: readonly number[], p: readonly number[]): number {
    let s = 0;
    for (let k = 0; k < 3; k++) {
        const a = box.slice(3 + k * 3, 6 + k * 3);
        const len = Math.hypot(a[0]!, a[1]!, a[2]!);
        const t = boxCoords(box, p)[k]!;
        const out = t < 0 ? -t : t > 1 ? t - 1 : 0;
        s += (out * len) ** 2;
    }
    return s;
}

/**
 * Keep a source OBB hierarchy (shapes and boxes) for a model whose polygons were rebuilt (split, reordered, re-indexed for a
 * display list): the polygon lists of the leaf shapes (shapes that listed polygons) are filled again from the new polygons,
 * each going to the leaf whose box holds its centre (else the nearest leaf). Collapsing such a hierarchy into one box made a
 * hollow model solid: Arokh's flight look-ahead counts a hit on any box he is inside, so the Islands arrival tunnel (inside
 * the PC "Warp Gate" model) stopped him dead (docs/journal/2026-11-06/ootf-arokh-flight.md). Null when `bounds` is not an
 * OBB hierarchy with leaves.
 */
export function rebuildObbHierarchy(
    bounds: Uint8Array,
    positions: Float32Array,
    polygons: readonly NeutralPoly[],
): Uint8Array | null {
    const shapes = parseObbHierarchy(bounds);
    if (!shapes) return null;
    // Leaves have no child; only leaves that listed polygons get them again (a leaf without polygons is a plain blocker box).
    const leaves = shapes.flatMap((s, i) => (s.child === 0 && s.polygons.length ? [i] : []));
    if (!leaves.length) return null;
    const lists = new Map<number, number[]>(leaves.map((i) => [i, []]));
    polygons.forEach((p, pi) => {
        const c = [0, 1, 2].map((k) => p.indices.reduce((s, v) => s + positions[v * 3 + k]!, 0) / p.indices.length);
        let best = leaves[0]!;
        let bestD = Infinity;
        for (const i of leaves) {
            const d = boxDistance2(shapes[i]!.box, c);
            if (d < bestD) {
                bestD = d;
                best = i;
                if (d === 0) break;
            }
        }
        lists.get(best)!.push(pi);
    });
    // An inner shape that listed polygons (the PC lists its whole subtree there; the disc's inner shapes list none) lists
    // the union of its leaves again.
    const seen = new Set<number>();
    const subtree = (i: number): number[] => {
        if (seen.has(i)) return [];
        seen.add(i);
        const out = [...(lists.get(i) ?? [])];
        for (let c = shapes[i]!.child; c !== 0 && !seen.has(c); c = shapes[c]!.sibling) out.push(...subtree(c));
        return out;
    };
    const inner = new Map<number, number[]>();
    shapes.forEach((s, i) => {
        if (s.child === 0 || !s.polygons.length) return;
        seen.clear();
        inner.set(
            i,
            [...new Set(subtree(i))].sort((a, b) => a - b),
        );
    });
    for (const [i, l] of inner) lists.set(i, l);
    if (polygons.length > 0xffff) return null;
    const n = shapes.length;
    let size = 76 + n * 4;
    for (let i = 0; i < n; i++) size += 50 + (lists.get(i)?.length ?? 0) * 2;
    const out = new Uint8Array(size);
    out.set(bounds.subarray(0, 76 + n * 4));
    const dv = view(out);
    let o = 76 + n * 4;
    for (let i = 0; i < n; i++) {
        shapes[i]!.box.forEach((v, k) => f32(dv, o + k * 4, v));
        const list = lists.get(i) ?? [];
        dv.setUint16(o + 48, list.length, true);
        list.forEach((pi, k) => dv.setUint16(o + 50 + k * 2, pi, true));
        o += 50 + list.length * 2;
    }
    return out;
}

/**
 * Bounds from the vertices when the source has none: sphere around the box centre, one OBB (`center` = minimum corner,
 * axes scaled by the box size, as the disc models), `num_shapes 1, is_obb 1`, hierarchy (0,0), the box again and the
 * polygon list `u16 count, u16 0..count-1`.
 */
export function synthesizeBounds(positions: Float32Array, polygonCount: number): Uint8Array {
    const mn = [Infinity, Infinity, Infinity];
    const mx = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < positions.length; i += 3)
        for (let k = 0; k < 3; k++) {
            mn[k] = Math.min(mn[k]!, positions[i + k]!);
            mx[k] = Math.max(mx[k]!, positions[i + k]!);
        }
    if (!positions.length) for (let k = 0; k < 3; k++) ((mn[k] = 0), (mx[k] = 0));
    const size = mn.map((v, k) => mx[k]! - v);
    const ctr = mn.map((v, k) => (v + mx[k]!) / 2);
    const radius = Math.hypot(size[0]!, size[1]!, size[2]!) / 2;
    const out = new Uint8Array(8 + 64 + 4 + 4 + 48 + 2 + polygonCount * 2);
    const dv = view(out);
    let o = 8;
    const put = (...v: number[]): void => {
        for (const x of v) {
            f32(dv, o, x);
            o += 4;
        }
    };
    const obb = (): void => put(mn[0]!, mn[1]!, mn[2]!, size[0]!, 0, 0, 0, size[1]!, 0, 0, 0, size[2]!);
    put(ctr[0]!, ctr[1]!, ctr[2]!, radius);
    obb();
    dv.setUint16(o, 1, true);
    dv.setUint16(o + 2, 1, true);
    o += 8; // counts + hierarchy (0, 0)
    obb();
    dv.setUint16(o, polygonCount, true);
    for (let i = 0; i < polygonCount; i++) dv.setUint16(o + 2 + i * 2, i, true);
    return out;
}

/** The PS2 records of one model, in disc order (0x0200, 0x0203, 0x0204, 0x0207). */
export function writePs2ModelRecords(m: NeutralModel): { type: number; data: Uint8Array }[] {
    return [
        { type: MOD_NAME, data: writePs2ModelName(m) },
        { type: MOD_VERTICES, data: writePs2Vertices(m) },
        { type: MOD_POLYGONS, data: writePs2Polygons(m) },
        { type: MOD_BOUNDS, data: m.bounds ?? synthesizeBounds(m.positions, m.polygons.length) },
    ];
}

export interface Ps2ModOptions {
    /** Group name (one 0x0201 record, id 1); default "OotF". */
    group?: string;
}

/**
 * A complete PS2 MOD container: 0x0202 counters, 0x0402 version, the group, then per model 0x0200/0x0203/0x0204/0x0207
 * (same SRSC id, `sub` = group id). Model ids must be unique and >= 2.
 */
export function buildPs2Mod(
    models: readonly { id: number; model: NeutralModel; records?: { type: number; data: Uint8Array }[] }[],
    opt: Ps2ModOptions = {},
): Uint8Array {
    const groupId = 1;
    const seen = new Set<number>();
    let lastModel = groupId;
    for (const { id } of models) {
        if (id <= groupId || id > 0xffff || seen.has(id)) throw new ModelError(`bad or duplicate model id ${id}`);
        seen.add(id);
        lastModel = Math.max(lastModel, id);
    }
    const counters = new Uint8Array(6);
    const cv = view(counters);
    cv.setUint16(0, 1, true);
    cv.setUint16(2, groupId, true);
    cv.setUint16(4, lastModel, true);
    const version = new Uint8Array(4);
    view(version).setUint32(0, MOD_VERSION_VALUE, true);
    const entries: Ps2Entry[] = [
        { type: MOD_COUNTERS, id: 0, sub: 0, data: counters },
        { type: MOD_VERSION, id: 0, sub: 0, data: version },
        { type: MOD_GROUP, id: groupId, sub: 0, data: ps2String(opt.group ?? 'OotF') },
    ];
    for (const { id, model, records } of models)
        for (const r of records ?? writePs2ModelRecords(model))
            entries.push({ type: r.type, id, sub: groupId, data: r.data });
    return writePs2Srsc(entries);
}

// ------------------------------------------------------------------------------------------------------ PC side

export interface PcPolygon {
    /** Raw u16: high byte holds editor/lighting bits (0x8000 always set); Drakan 1's double-sided bit 0x02 never occurs. */
    flags: number;
    texture: number;
    indices: number[];
    uvs: number[];
}

export interface PcModel {
    id: number;
    name: string;
    shading: number;
    textures: ModelTextureRef[];
    positions: Float32Array;
    polygons: PcPolygon[];
    /** 0x0209: lower-detail model links (not converted). */
    lodLinks: { id: number; distance: number }[];
    /** Raw 0x0207 bounding record (PS2 prepends 8 zero bytes), or null. */
    bounds: Uint8Array | null;
    /** True when a 0x0208 character record exists (skinned; handled by ootfanim.ts). */
    character: boolean;
}

function pcString(b: Uint8Array): { s: string; end: number } {
    const dv = view(b);
    const n = dv.getUint16(0, true);
    let e = 2;
    while (e < 2 + n && b[e] !== 0) e++;
    let s = '';
    for (let i = 2; i < e; i++) s += String.fromCharCode(b[i]!);
    return { s, end: 2 + n };
}

/** Parse PC model `id`. Returns null when the container has no such model. */
export async function parsePcModel(mod: SrscReader, id: number): Promise<PcModel | null> {
    const get = async (type: number): Promise<Uint8Array | null> => {
        const e = mod.find(type, id);
        return e ? mod.readRaw(e) : null;
    };
    const n = await get(MOD_NAME);
    if (!n) return null;
    const nm = pcString(n);
    const shading = n.length >= nm.end + 4 ? view(n).getUint32(nm.end, true) : 0;
    const tl = await get(MOD_TEXTURES_PC);
    const textures: ModelTextureRef[] = [];
    if (tl) {
        const dv = view(tl);
        const c = dv.getUint32(0, true);
        if (4 + c * 4 > tl.length) throw new ModelError(`model ${id}: 0x0206 truncated`);
        for (let i = 0; i < c; i++)
            textures.push({ id: dv.getUint16(4 + i * 4, true), db: dv.getUint16(6 + i * 4, true) });
    }
    const vr = await get(MOD_VERTICES);
    const pr = await get(MOD_POLYGONS);
    if (!vr || !pr) throw new ModelError(`model ${id}: missing vertices or polygons`);
    const vdv = view(vr);
    const nv = vdv.getUint16(0, true);
    if (2 + nv * 12 > vr.length) throw new ModelError(`model ${id}: 0x0203 truncated`);
    const positions = new Float32Array(nv * 3);
    for (let i = 0; i < nv * 3; i++) positions[i] = vdv.getFloat32(2 + i * 4, true);
    const pdv = view(pr);
    const count = pdv.getUint16(0, true);
    let o = 2;
    const polygons: PcPolygon[] = [];
    for (let i = 0; i < count; i++) {
        if (o + 6 > pr.length) throw new ModelError(`model ${id}: 0x0204 truncated`);
        const vc = pdv.getUint16(o + 2, true);
        if (vc !== 3 && vc !== 4) throw new ModelError(`model ${id}: polygon ${i} has ${vc} vertices`);
        if (o + 6 + vc * 10 > pr.length) throw new ModelError(`model ${id}: 0x0204 truncated`);
        const indices: number[] = [];
        const uvs: number[] = [];
        for (let k = 0; k < vc; k++) {
            const q = o + 6 + k * 10;
            indices.push(pdv.getUint16(q, true));
            uvs.push(pdv.getFloat32(q + 2, true), pdv.getFloat32(q + 6, true));
        }
        polygons.push({ flags: pdv.getUint16(o, true), texture: pdv.getUint16(o + 4, true), indices, uvs });
        o += 6 + vc * 10;
    }
    if (o !== pr.length) throw new ModelError(`model ${id}: 0x0204 has ${pr.length - o} trailing bytes`);
    const lodLinks: PcModel['lodLinks'] = [];
    for (const e of mod.entries) {
        if (e.type !== MOD_LOD_PC || e.id !== id) continue;
        const b = await mod.readRaw(e);
        if (b.length >= 6) lodLinks.push({ id: view(b).getUint16(0, true), distance: view(b).getFloat32(2, true) });
    }
    return {
        id,
        name: nm.s,
        shading,
        textures,
        positions,
        polygons,
        lodLinks,
        bounds: await get(MOD_BOUNDS),
        character: mod.find(MOD_CHARACTER, id) !== undefined,
    };
}

/** Ids of all PC models (0x0200 records). */
export function listPcModelIds(mod: SrscReader): number[] {
    return mod.entries.filter((e) => e.type === MOD_NAME).map((e) => e.id);
}

/**
 * Per-vertex unit normals as signed bytes: area weighted (Newell) face normals of every polygon that uses the vertex.
 * The PS2 convention is the opposite of a counter-clockwise Newell normal (147064 of 147064 disc vertices that differ
 * in sign), so `flip` defaults to true.
 */
export function computeNormals(
    positions: Float32Array,
    polygons: readonly { indices: number[] }[],
    flip = true,
): Int8Array {
    const nv = positions.length / 3;
    const acc = new Float64Array(nv * 3);
    for (const p of polygons) {
        let nx = 0;
        let ny = 0;
        let nz = 0;
        const k = p.indices.length;
        for (let i = 0; i < k; i++) {
            const a = p.indices[i]! * 3;
            const b = p.indices[(i + 1) % k]! * 3;
            if (a + 2 >= positions.length || b + 2 >= positions.length) continue;
            nx += (positions[a + 1]! - positions[b + 1]!) * (positions[a + 2]! + positions[b + 2]!);
            ny += (positions[a + 2]! - positions[b + 2]!) * (positions[a]! + positions[b]!);
            nz += (positions[a]! - positions[b]!) * (positions[a + 1]! + positions[b + 1]!);
        }
        for (const i of p.indices) {
            if (i >= nv) continue;
            acc[i * 3] = acc[i * 3]! + nx;
            acc[i * 3 + 1] = acc[i * 3 + 1]! + ny;
            acc[i * 3 + 2] = acc[i * 3 + 2]! + nz;
        }
    }
    const out = new Int8Array(nv * 3);
    const s = flip ? -1 : 1;
    for (let i = 0; i < nv; i++) {
        const x = acc[i * 3]!;
        const y = acc[i * 3 + 1]!;
        const z = acc[i * 3 + 2]!;
        const l = Math.hypot(x, y, z);
        if (l < 1e-20) {
            out[i * 3 + 1] = 127; // unused (bounding) vertex: up
            continue;
        }
        out[i * 3] = Math.round((s * x * 127) / l);
        out[i * 3 + 1] = Math.round((s * y * 127) / l);
        out[i * 3 + 2] = Math.round((s * z * 127) / l);
    }
    return out;
}

export interface PcToPs2Options {
    /** Map a PC texture ref (db relative to the model container) to the PS2 ref; null drops the polygons using it. */
    mapTexture?: (ref: ModelTextureRef) => ModelTextureRef | null;
    /** True when the (mapped) PS2 texture has transparency: its polygons are flagged double sided. */
    doubleSided?: (ref: ModelTextureRef) => boolean;
    /** Keep quads instead of splitting them into triangles (default false: PS2 models are almost all triangles). */
    keepQuads?: boolean;
    /** Flat shading (0x01) occurs in no disc model: turn it into smooth (default true). */
    flatToSmooth?: boolean;
    flipNormals?: boolean;
}

export interface PcToPs2Stats {
    polygonsIn: number;
    trianglesOut: number;
    polygonsDropped: number;
    flatToSmooth: boolean;
}

/**
 * Rewrite the polygon lists of an OBB 0x0207 hierarchy through `map` (old polygon index -> the new indices it became): the PC
 * lists name PC polygons, and the conversion splits quads into two triangles and drops polygons of unmapped textures, so the
 * copied lists named the wrong triangles. Volcanic's sanctum central platform (56 quads among 568 polygons) lost the floor of
 * its four bridges: Rynn walking from the sanctum floor onto the platform fell into the pit, so the stair to the Runeblade could
 * not be reached on foot. Shapes and boxes are kept. Null for a sphere hierarchy
 * or anything `parseObbHierarchy` rejects, and when a list names a polygon `map` does not know.
 */
export function remapObbPolygons(bounds: Uint8Array, map: readonly (readonly number[])[]): Uint8Array | null {
    const shapes = parseObbHierarchy(bounds);
    if (!shapes || shapes.some((s) => s.polygons.some((p) => p >= map.length))) return null;
    const lists = shapes.map((s) => s.polygons.flatMap((p) => map[p]!));
    if (lists.some((l) => l.some((p) => p > 0xffff))) return null;
    const n = shapes.length;
    const out = new Uint8Array(76 + n * 4 + lists.reduce((t, l) => t + 50 + l.length * 2, 0));
    out.set(bounds.subarray(0, 76 + n * 4));
    const dv = view(out);
    let o = 76 + n * 4;
    shapes.forEach((s, i) => {
        s.box.forEach((v, k) => f32(dv, o + k * 4, v));
        dv.setUint16(o + 48, lists[i]!.length, true);
        lists[i]!.forEach((p, k) => dv.setUint16(o + 50 + k * 2, p, true));
        o += 50 + lists[i]!.length * 2;
    });
    return out;
}

/** Convert a parsed PC static model to the neutral (PS2) form. */
export function pcToNeutral(pc: PcModel, opt: PcToPs2Options = {}): { model: NeutralModel; stats: PcToPs2Stats } {
    const stats: PcToPs2Stats = {
        polygonsIn: pc.polygons.length,
        trianglesOut: 0,
        polygonsDropped: 0,
        flatToSmooth: false,
    };
    const textures: ModelTextureRef[] = [];
    const slot = new Map<number, number>(); // PC texture index -> PS2 index
    const nv = pc.positions.length / 3;
    const polygons: NeutralPoly[] = [];
    // PC polygon index -> the indices of what it became (none when dropped, two for a split quad), for the bounds lists.
    const polyMap: number[][] = [];
    const split = !(opt.keepQuads ?? false);
    for (const p of pc.polygons) {
        const into: number[] = [];
        polyMap.push(into);
        let idx = slot.get(p.texture);
        if (idx === undefined) {
            const src = pc.textures[p.texture];
            const mapped = src ? (opt.mapTexture ? opt.mapTexture(src) : src) : null;
            if (mapped) {
                idx = textures.length;
                textures.push(mapped);
            } else idx = -1;
            slot.set(p.texture, idx);
        }
        if (idx < 0 || p.indices.some((i) => i >= nv)) {
            stats.polygonsDropped++;
            continue;
        }
        // Bit 1 of the PC polygon flags is "double sided" with the same meaning on the PS2 (29966 disc polygons carry it): fences,
        // banners, thin walls and cards vanish from behind without it. Alpha textures are double sided too.
        const flags = opt.doubleSided?.(textures[idx]!) || (p.flags & 2) !== 0 ? 2 : 0;
        if (p.indices.length === 3 || !split) {
            into.push(polygons.length);
            polygons.push({
                flags: flags | (p.indices.length === 4 ? 4 : 0),
                texture: idx,
                indices: p.indices.slice(),
                uvs: p.uvs.slice(),
            });
            stats.trianglesOut += p.indices.length - 2;
        } else {
            for (const t of [
                [0, 1, 2],
                [0, 2, 3],
            ]) {
                into.push(polygons.length);
                polygons.push({
                    flags,
                    texture: idx,
                    indices: t.map((k) => p.indices[k]!),
                    uvs: t.flatMap((k) => [p.uvs[k * 2]!, p.uvs[k * 2 + 1]!]),
                });
                stats.trianglesOut++;
            }
        }
    }
    let shading = pc.shading;
    if ((opt.flatToSmooth ?? true) && (shading & 3) === 1) {
        shading = (shading & ~3) | 2;
        stats.flatToSmooth = true;
    }
    let bounds: Uint8Array | null = null;
    if (pc.bounds && pc.bounds.length >= 72 && !ootfDebugFlag('OOTF_SYNTH_BOUNDS')) {
        bounds = new Uint8Array(8 + pc.bounds.length);
        bounds.set(pc.bounds, 8);
        bounds = remapObbPolygons(bounds, polyMap) ?? bounds;
    }
    return {
        model: {
            name: pc.name,
            shading,
            distance: null,
            textures,
            positions: pc.positions,
            normals: computeNormals(pc.positions, polygons, opt.flipNormals ?? true),
            polygons,
            bounds,
        },
        stats,
    };
}
