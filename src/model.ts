import { latin1, view } from './bytes.ts';
import type { SrscReader } from './srsc.ts';

/**
 * PS2 MOD models. One model is a set of SRSC records that share the model id: 0x0200 name/shading/texture list,
 * 0x0203 vertices, 0x0204 polygons (+ UVs), 0x0207 bounds, 0x0208 character data (LODs and skeleton), 0x0211 the
 * PS2 display-list copy (not decoded; everything needed is in 0x0203/0x0204). Layout, evidence and credit:
 * docs/reference/level-format.md section 11. Record names, the character-data walk and the LOD table come from
 * OpenDrakan (Zalasus, GPL-3.0, commit 6c0d499, `doc/riot_database_format.txt`, `src/odCore/db/Model.cpp`).
 * PS2 differences were found against the PAL disc.
 */

export const MOD_NAME = 0x0200;
export const MOD_VERTICES = 0x0203;
export const MOD_POLYGONS = 0x0204;
export const MOD_BOUNDS = 0x0207;
export const MOD_CHARACTER = 0x0208;

export class ModelError extends Error {}

export interface ModelTextureRef {
    id: number;
    /** Dependency index in the `.DB` of the container the model came from; 0 = the container's own TXD. */
    db: number;
}

export interface ModelLod {
    /** Switch distance (squared on load in the original engine). */
    distance: number;
    usage: number;
    node: number;
    /** Polygon vertex indices of this LOD are relative to this vertex. */
    firstVertex: number;
    vertexCount: number;
    firstPoly: number;
    polyCount: number;
}

export interface Model {
    id: number;
    name: string;
    /** 0x0200 shading word (0x01 flat, 0x02 smooth, 0x08 shiny, 0x10 additive, 0x20 environment, 0x8000 always) [D]. */
    shading: number;
    textures: ModelTextureRef[];
    /** x, y, z per vertex, model space (y up). */
    positions: Float32Array;
    /** Unit normals decoded from the signed-byte trailer (3 per vertex) [inf]. */
    normals: Float32Array;
    /** Triangle vertex indices (3 per triangle), absolute into `positions` (LOD vertex offset applied). */
    indices: Uint16Array;
    /** Per triangle: index into `textures`. */
    triTexture: Uint16Array;
    /** Per triangle corner: u, v (6 floats per triangle), `0..1`, v up (GL convention). */
    uvs: Float32Array;
    /** LOD table when 0x0208 is present (LOD 0 first); empty for static models. */
    lods: ModelLod[];
    /** True when 0x0208 (skeleton/skinning) exists; the mesh is then the bind pose. */
    skinned: boolean;
    /** Axis aligned bounds of the vertices that LOD 0 uses. */
    bounds: { min: [number, number, number]; max: [number, number, number] };
    /** The vertex and triangle ranges of LOD 0 inside the full arrays (all arrays hold every LOD; triangles of
     * LOD 0 are `lod0.firstPoly .. +polyCount`). */
    lod0: { firstTri: number; triCount: number };
}

function nul(b: Uint8Array, start: number, end: number): string {
    const z = b.indexOf(0, start);
    return latin1(b, start, z < 0 || z > end ? end : z);
}

/**
 * 0x0200: `string name, u32 shading, u32 0, [f32 distance if shading & 0x20000], u32 texture_count,
 * u32 texture_ref[count]` (ref = u16 id, u16 db). The record ends exactly after the list.
 */
export function parseModelName(b: Uint8Array): {
    name: string;
    shading: number;
    /** The optional f32 (49000.0, 20000.0, ... likely a fade/cull distance [?]); null when absent. */
    distance: number | null;
    textures: ModelTextureRef[];
} {
    if (b.length < 2) throw new ModelError('0x0200 too short');
    const dv = view(b);
    const nl = dv.getUint16(0, true);
    let o = 2 + nl;
    if (o + 12 > b.length) throw new ModelError('0x0200 truncated');
    const name = nul(b, 2, 2 + nl);
    const shading = dv.getUint32(o, true);
    o += 8;
    let distance: number | null = null;
    if (shading & 0x20000) {
        distance = dv.getFloat32(o, true);
        o += 4;
    }
    if (o + 4 > b.length) throw new ModelError('0x0200 truncated');
    const count = dv.getUint32(o, true);
    o += 4;
    if (count > 4096 || o + count * 4 !== b.length) throw new ModelError('0x0200 texture list does not end the record');
    const textures: ModelTextureRef[] = [];
    for (let i = 0; i < count; i++)
        textures.push({ id: dv.getUint16(o + i * 4, true), db: dv.getUint16(o + i * 4 + 2, true) });
    return { name, shading, distance, textures };
}

/** 0x0203: `u16 count, f32 xyz[count], i8 nx ny nz 0x7f [count]` (the trailer is a separate array, not interleaved). */
export function parseModelVertices(b: Uint8Array): { positions: Float32Array; normals: Float32Array } {
    if (b.length < 2) throw new ModelError('0x0203 too short');
    const dv = view(b);
    const n = dv.getUint16(0, true);
    if (2 + n * 16 > b.length) throw new ModelError('0x0203 vertex data out of range');
    const positions = new Float32Array(n * 3);
    const normals = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
        for (let k = 0; k < 3; k++) positions[i * 3 + k] = dv.getFloat32(2 + i * 12 + k * 4, true);
        const t = 2 + n * 12 + i * 4;
        const nx = dv.getInt8(t);
        const ny = dv.getInt8(t + 1);
        const nz = dv.getInt8(t + 2);
        const l = Math.hypot(nx, ny, nz) || 1;
        normals[i * 3] = nx / l;
        normals[i * 3 + 1] = ny / l;
        normals[i * 3 + 2] = nz / l;
    }
    return { positions, normals };
}

/**
 * 0x0204: `u16 count; count x { u16 flags (2 = double sided, 4 on quads, 0 otherwise), u16 vertex_count (3 or 4),
 * u16 texture, u16 index[vertex_count] }`, `u16 0` padding when the polygons end on a 2 mod 4 offset, then
 * `vertex_count x 2 f32` UVs per polygon in the same order (the PC record keeps the UVs inside the polygon; the PS2
 * one stores indices only). Quads are split into the triangles (0,1,2) and (0,2,3).
 */
export function parseModelPolygons(b: Uint8Array): {
    indices: Uint16Array;
    triTexture: Uint16Array;
    uvs: Float32Array;
    /** Per triangle flag word of the source polygon. */
    flags: Uint16Array;
    /** Polygons (before splitting quads). */
    polygons: number;
    quads: number;
} {
    if (b.length < 4) throw new ModelError('0x0204 too short');
    const dv = view(b);
    const n = dv.getUint16(0, true);
    // First pass: sizes.
    let o = 2;
    let tris = 0;
    let corners = 0;
    let quads = 0;
    const meta: { flags: number; n: number; tex: number; at: number }[] = [];
    for (let i = 0; i < n; i++) {
        if (o + 6 > b.length) throw new ModelError('0x0204 polygon table truncated');
        const vc = dv.getUint16(o + 2, true);
        if (vc !== 3 && vc !== 4) throw new ModelError(`polygon ${i} has ${vc} vertices`);
        meta.push({ flags: dv.getUint16(o, true), n: vc, tex: dv.getUint16(o + 4, true), at: o + 6 });
        o += 6 + vc * 2;
        tris += vc - 2;
        corners += vc;
        if (vc === 4) quads++;
    }
    if (o % 4 === 2) o += 2;
    if (o + corners * 8 !== b.length) throw new ModelError(`0x0204 size ${b.length} does not fit ${n} polygons`);
    const indices = new Uint16Array(tris * 3);
    const triTexture = new Uint16Array(tris);
    const flags = new Uint16Array(tris);
    const uvs = new Float32Array(tris * 6);
    let t = 0;
    let c = 0;
    for (const p of meta) {
        const idx: number[] = [];
        const uv: number[] = [];
        for (let k = 0; k < p.n; k++) {
            idx.push(dv.getUint16(p.at + k * 2, true));
            uv.push(dv.getFloat32(o + (c + k) * 8, true), dv.getFloat32(o + (c + k) * 8 + 4, true));
        }
        c += p.n;
        const corners3 =
            p.n === 3
                ? [[0, 1, 2]]
                : [
                      [0, 1, 2],
                      [0, 2, 3],
                  ];
        for (const tri of corners3) {
            for (let k = 0; k < 3; k++) {
                indices[t * 3 + k] = idx[tri[k]!]!;
                uvs[t * 6 + k * 2] = uv[tri[k]! * 2]!;
                uvs[t * 6 + k * 2 + 1] = uv[tri[k]! * 2 + 1]!;
            }
            triTexture[t] = p.tex;
            flags[t] = p.flags;
            t++;
        }
    }
    return { indices, triTexture, uvs, flags, polygons: n, quads };
}

/**
 * LOD table of a 0x0208 record. The OpenDrakan walk (node infos, joint infos) does not hold on PS2 (an extra vertex
 * count and 6 more bytes follow the node infos), so the table is found by its signature instead: `lod_count` entries
 * of `{u16 1, f32 distance, u32 usage, u32 node, u32 firstVertex, u32 vertexCount, u32 firstPoly, u32 polyCount}`
 * (30 bytes) where each LOD starts where the previous one ended and the polygon counts sum to `triangles`.
 * `lod_count` is the u16 at +64 (after the 64-byte bounds). Returns [] when no unique match exists.
 */
export function findCharacterLods(b: Uint8Array, vertices: number, triangles: number): ModelLod[] {
    if (b.length < 66) return [];
    const dv = view(b);
    const count = dv.getUint16(64, true);
    if (count === 0 || count > 16) return [];
    let found: ModelLod[] | null = null;
    for (let o = 66; o + 30 * count <= b.length; o++) {
        const lods: ModelLod[] = [];
        let fv = 0;
        let fp = 0;
        let ok = true;
        for (let l = 0; l < count && ok; l++) {
            const q = o + l * 30;
            if (dv.getUint16(q, true) !== 1) {
                ok = false;
                break;
            }
            const lod: ModelLod = {
                distance: dv.getFloat32(q + 2, true),
                usage: dv.getUint32(q + 6, true),
                node: dv.getUint32(q + 10, true),
                firstVertex: dv.getUint32(q + 14, true),
                vertexCount: dv.getUint32(q + 18, true),
                firstPoly: dv.getUint32(q + 22, true),
                polyCount: dv.getUint32(q + 26, true),
            };
            if (lod.firstVertex !== fv || lod.firstPoly !== fp || !(lod.distance >= 0 && lod.distance < 1e9))
                ok = false;
            fv += lod.vertexCount;
            fp += lod.polyCount;
            lods.push(lod);
        }
        if (!ok || fv > vertices || fp !== triangles) continue;
        if (found) return []; // ambiguous
        found = lods;
    }
    return found ?? [];
}

/**
 * Decode model `id` from a MOD container. Returns null when the container has no such model. A malformed 0x0208 is
 * tolerated (the model is returned as an unskinned single LOD); other malformed records throw ModelError.
 */
export async function parseModel(mod: SrscReader, id: number): Promise<Model | null> {
    const get = async (type: number): Promise<Uint8Array | null> => {
        const e = mod.find(type, id);
        return e ? mod.readRaw(e) : null;
    };
    const nameRec = await get(MOD_NAME);
    if (!nameRec) return null;
    const info = parseModelName(nameRec);
    const vr = await get(MOD_VERTICES);
    const pr = await get(MOD_POLYGONS);
    if (!vr || !pr) throw new ModelError(`model ${id}: missing vertices or polygons`);
    const { positions, normals } = parseModelVertices(vr);
    const poly = parseModelPolygons(pr);
    const nv = positions.length / 3;
    const nt = poly.triTexture.length;
    let lods: ModelLod[] = [];
    let skinned = false;
    const ch = await get(MOD_CHARACTER);
    if (ch) {
        skinned = true;
        try {
            lods = findCharacterLods(ch, nv, nt);
        } catch {
            lods = [];
        }
    }
    const lod0 = lods[0];
    let firstTri = 0;
    let triCount = nt;
    if (lod0 && lod0.firstPoly + lod0.polyCount <= nt && lod0.firstVertex + lod0.vertexCount <= nv) {
        firstTri = lod0.firstPoly;
        triCount = lod0.polyCount;
    }
    // Indices are relative to the LOD's first vertex: make them absolute for every LOD.
    const indices = poly.indices;
    if (lods.length > 0) {
        for (const l of lods) {
            if (l.firstVertex === 0 || l.firstPoly + l.polyCount > nt) continue;
            for (let i = l.firstPoly * 3; i < (l.firstPoly + l.polyCount) * 3; i++)
                indices[i] = indices[i]! + l.firstVertex;
        }
    }
    const min: [number, number, number] = [Infinity, Infinity, Infinity];
    const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
    const used = new Set<number>();
    for (let t = firstTri * 3; t < (firstTri + triCount) * 3; t++) used.add(indices[t]!);
    for (const v of used) {
        if (v >= nv) throw new ModelError(`model ${id}: vertex index ${v} >= ${nv}`);
        for (let k = 0; k < 3; k++) {
            const x = positions[v * 3 + k]!;
            if (x < min[k]!) min[k] = x;
            if (x > max[k]!) max[k] = x;
        }
    }
    if (used.size === 0) for (let k = 0; k < 3; k++) ((min[k] = 0), (max[k] = 0));
    return {
        id,
        name: info.name,
        shading: info.shading,
        textures: info.textures,
        positions,
        normals,
        indices,
        triTexture: poly.triTexture,
        uvs: poly.uvs,
        lods,
        skinned,
        bounds: { min, max },
        lod0: { firstTri, triCount },
    };
}

/** Ids of all models in a container (0x0200 records, in file order). */
export function listModelIds(mod: SrscReader): number[] {
    const out: number[] = [];
    for (const e of mod.entries) if (e.type === MOD_NAME) out.push(e.id);
    return out;
}
