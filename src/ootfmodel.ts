import { view } from './bytes.ts';
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
 * NOT produced: the PS2 display-list copy 0x0211 (GS packets; layout only partly understood). Whether the engine draws
 * a model without it is untested; see the journal.
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
    models: readonly { id: number; model: NeutralModel }[],
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
    for (const { id, model } of models)
        for (const r of writePs2ModelRecords(model)) entries.push({ type: r.type, id, sub: groupId, data: r.data });
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
    const split = !(opt.keepQuads ?? false);
    for (const p of pc.polygons) {
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
        const flags = opt.doubleSided?.(textures[idx]!) ? 2 : 0;
        if (p.indices.length === 3 || !split) {
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
    if (pc.bounds && pc.bounds.length >= 72) {
        bounds = new Uint8Array(8 + pc.bounds.length);
        bounds.set(pc.bounds, 8);
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
