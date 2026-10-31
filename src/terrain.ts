import { view } from './bytes.ts';
import { inflate } from './inflate.ts';

/**
 * Terrain layers (LVL 0x0001). One layer is a rectangular grid of `width x height` cells with `(width+1)*(height+1)`
 * vertices; layers overlap and stack (floor, ceiling, in-between). Layout, evidence and credit: docs/reference/level-format.md
 * section 10. The layer definition and the PC (zlib) data layout are from OpenDrakan (Zalasus, GPL-3.0, commit 6c0d499,
 * `doc/lvl_format.txt`, `src/odCore/Layer.cpp`); the PS2 packing was found against the PAL disc.
 *
 * Coordinates: a layer origin is in cell units; a cell is `CELL_SIZE` (2048) world units, the same units as object
 * positions. Vertex heights are `worldHeight + (raw - 0x8000) * 2` world units, y up.
 */

export const LVL_TYPE_LAYERS = 0x0001;
export const CELL_SIZE = 2048;
/** Texture reference stored for a hole (no geometry, no collision). */
export const TEX_HOLE = 0xffffffff;
/** Texture reference stored for an invisible (collision only) cell. */
export const TEX_INVISIBLE = 0xfffffffe;
/** Cell flag bit 0: the diagonal runs a (top left) to d (bottom right) ("backslash"); clear = b to c. */
export const CELL_FLAG_BACKSLASH = 0x01;

export class TerrainError extends Error {}

/** Layer definition (identical on PS2 and PC). */
export interface TerrainLayerDef {
    /** Position in the definition table (layer groups and `visible` lists index this). */
    index: number;
    id: number;
    /** Cells. */
    width: number;
    height: number;
    /** 0 floor, 1 ceiling, 2 in between. */
    type: number;
    /** Cell units; 0/0 is the top-left of the level. */
    originX: number;
    originZ: number;
    /** World units. */
    worldHeight: number;
    name: string;
    flags: number;
    lightDirection: number;
    lightAscension: number;
    /** 0xRRGGBB (the stored 4th byte is dropped). */
    lightColor: number;
    ambientColor: number;
    lightDropoff: number;
    /** Indices (into the definition table) of layers visible from this one. */
    visible: number[];
}

export interface TerrainLayer extends TerrainLayerDef {
    /** Absolute vertex heights in world units, row-major, `(width+1)*(height+1)`. */
    heights: Float32Array;
    /** Per vertex: PS2 first u16 (type/flags, meaning [?]); PC type byte. */
    vertexFlags: Uint16Array;
    /** Per vertex, PS2 only: the second u16 (low 4 bits = adjacent cells, 15 inside) [inf]. Zero on PC. */
    vertexMask: Uint8Array;
    /** Per cell, `width*height`: flag word (bit 0 = diagonal, see CELL_FLAG_BACKSLASH; other bits [?]). */
    cellFlags: Uint16Array;
    /** Per cell: texture ref `id | (db << 16)` of the left triangle (`TEX_HOLE`, `TEX_INVISIBLE` are special). */
    cellTexLeft: Uint32Array;
    /** Per cell: right triangle ref. PS2 stores one ref per cell (same as left). */
    cellTexRight: Uint32Array;
    /** Per cell, 8 u16 each, `0xffff` = 1.0: `Uc Ud Ub Ua Vc Vd Vb Va` (corners a b / c d, a = top left). */
    cellUv: Uint16Array;
    source: 'ps2' | 'pc';
}

export function texId(ref: number): number {
    return ref & 0xffff;
}
export function texDb(ref: number): number {
    return ref >>> 16;
}

// ---------------------------------------------------------------- definitions

function defEnd(b: Uint8Array, o: number): number {
    // Returns the offset after the definition at `o`, or -1 when it does not fit.
    if (o + 34 > b.length) return -1;
    const dv = view(b);
    const sl = dv.getUint16(o + 28, true);
    const p = o + 30 + sl + 28;
    if (p > b.length) return -1;
    const vc = dv.getUint32(p - 4, true);
    if (vc > 100000) return -1;
    const end = p + vc * 4;
    return end <= b.length ? end : -1;
}

function readDef(b: Uint8Array, o: number, index: number): { def: TerrainLayerDef; end: number } {
    const end = defEnd(b, o);
    if (end < 0) throw new TerrainError(`layer ${index}: definition runs past the end`);
    const dv = view(b);
    const sl = dv.getUint16(o + 28, true);
    let name = '';
    for (let i = 0; i < sl; i++) {
        const c = b[o + 30 + i]!;
        if (c === 0) break;
        name += String.fromCharCode(c);
    }
    let p = o + 30 + sl;
    const rgb = (v: number): number => v & 0xffffff;
    const def: TerrainLayerDef = {
        index,
        id: dv.getUint32(o, true),
        width: dv.getUint32(o + 4, true),
        height: dv.getUint32(o + 8, true),
        type: dv.getUint32(o + 12, true),
        originX: dv.getUint32(o + 16, true),
        originZ: dv.getUint32(o + 20, true),
        worldHeight: dv.getFloat32(o + 24, true),
        name,
        flags: dv.getUint32(p, true),
        lightDirection: dv.getFloat32(p + 4, true),
        lightAscension: dv.getFloat32(p + 8, true),
        lightColor: rgb(dv.getUint32(p + 12, true)),
        ambientColor: rgb(dv.getUint32(p + 16, true)),
        lightDropoff: dv.getUint32(p + 20, true),
        visible: [],
    };
    const vc = dv.getUint32(p + 24, true);
    p += 28;
    for (let i = 0; i < vc; i++) def.visible.push(dv.getUint32(p + i * 4, true));
    return { def, end };
}

/** Cheap structural check used to resynchronise on the next PS2 definition. */
function plausibleDef(b: Uint8Array, o: number, w: number, h: number): boolean {
    const end = defEnd(b, o);
    if (end < 0) return false;
    const dv = view(b);
    if (dv.getUint32(o + 4, true) !== w || dv.getUint32(o + 8, true) !== h) return false;
    if (dv.getUint32(o + 12, true) > 2) return false;
    if (dv.getUint32(o + 16, true) > 0xffff || dv.getUint32(o + 20, true) > 0xffff) return false;
    const sl = dv.getUint16(o + 28, true);
    if (sl < 1 || sl > 128) return false;
    let n = 0;
    for (; n < sl; n++) {
        const c = b[o + 30 + n]!;
        if (c === 0) break;
        if (c < 32 || c > 126) return false;
    }
    if (n === 0) return false;
    const wh = dv.getFloat32(o + 24, true);
    return Number.isFinite(wh) && Math.abs(wh) < 1e8;
}

// ---------------------------------------------------------------- PS2

const PS2_VERTEX = 6;
const PS2_CELL = 22;

export function ps2TerrainBlockSize(w: number, h: number): number {
    return (w + 1) * (h + 1) * PS2_VERTEX + w * h * PS2_CELL;
}

/**
 * Locate the PS2 data section: `u32 1` followed by `count` blocks of `{u32 size, zlib}` that end exactly at the end of
 * the payload. The inline per-layer data before it is not decoded (see level-format.md section 10).
 */
function findPs2Blocks(b: Uint8Array, count: number): { start: number; blocks: Uint8Array[] } | null {
    const dv = view(b);
    for (let p = 4; p + 10 <= b.length; p++) {
        if (b[p + 8] !== 0x78 || dv.getUint32(p, true) !== 1) continue;
        let q = p + 4;
        const spans: [number, number][] = [];
        for (let i = 0; i < count && q + 4 <= b.length; i++) {
            const cs = dv.getUint32(q, true);
            if (cs < 6 || q + 4 + cs > b.length || b[q + 4] !== 0x78) break;
            spans.push([q + 4, cs]);
            q += 4 + cs;
        }
        if (spans.length !== count || q !== b.length) continue;
        const blocks: Uint8Array[] = [];
        for (const [s, n] of spans) {
            const raw = inflate(b.subarray(s, s + n));
            if (!raw) throw new TerrainError('terrain block is not a valid zlib stream');
            blocks.push(raw);
        }
        return { start: p, blocks };
    }
    return null;
}

function allocLayer(def: TerrainLayerDef, source: 'ps2' | 'pc'): TerrainLayer {
    const nv = (def.width + 1) * (def.height + 1);
    const nc = def.width * def.height;
    return {
        ...def,
        heights: new Float32Array(nv),
        vertexFlags: new Uint16Array(nv),
        vertexMask: new Uint8Array(nv),
        cellFlags: new Uint16Array(nc),
        cellTexLeft: new Uint32Array(nc),
        cellTexRight: new Uint32Array(nc),
        cellUv: new Uint16Array(nc * 8),
        source,
    };
}

function decodePs2Block(def: TerrainLayerDef, raw: Uint8Array): TerrainLayer {
    const L = allocLayer(def, 'ps2');
    const dv = view(raw);
    const nv = L.heights.length;
    for (let v = 0; v < nv; v++) {
        const o = v * PS2_VERTEX;
        L.vertexFlags[v] = dv.getUint16(o, true);
        L.vertexMask[v] = dv.getUint16(o + 2, true) & 0xff;
        L.heights[v] = def.worldHeight + (dv.getUint16(o + 4, true) - 0x8000) * 2;
    }
    const nc = L.cellFlags.length;
    for (let c = 0; c < nc; c++) {
        const o = nv * PS2_VERTEX + c * PS2_CELL;
        L.cellFlags[c] = dv.getUint16(o, true);
        const ref = dv.getUint32(o + 2, true);
        L.cellTexLeft[c] = ref;
        L.cellTexRight[c] = ref;
        for (let k = 0; k < 8; k++) L.cellUv[c * 8 + k] = dv.getUint16(o + 6 + k * 2, true);
    }
    return L;
}

/** Decode a PS2 LVL 0x0001 payload. */
export function parsePs2Terrain(data: Uint8Array): TerrainLayer[] {
    if (data.length < 4) throw new TerrainError('layer table is empty');
    const count = view(data).getUint32(0, true);
    if (count > 100000) throw new TerrainError(`implausible layer count ${count}`);
    const found = findPs2Blocks(data, count);
    if (!found) throw new TerrainError('PS2 terrain data section not found');
    const { blocks, start } = found;
    const out: TerrainLayer[] = [];
    let o = 4;
    for (let i = 0; i < count; i++) {
        const { def, end } = readDef(data, o, i);
        if (ps2TerrainBlockSize(def.width, def.height) !== blocks[i]!.length) {
            throw new TerrainError(
                `layer ${i}: block is ${blocks[i]!.length} bytes, ${def.width}x${def.height} needs more`,
            );
        }
        out.push(decodePs2Block(def, blocks[i]!));
        if (i === count - 1) break;
        // The inline data between this definition and the next is variable length and not decoded: find the next
        // definition whose dimensions match the next block.
        const next = blocks[i + 1]!.length;
        let p = end + 8;
        let found2 = -1;
        for (; p < start; p++) {
            if (!plausibleDefForBlock(data, p, next)) continue;
            found2 = p;
            break;
        }
        if (found2 < 0) throw new TerrainError(`layer ${i + 1}: definition not found`);
        o = found2;
    }
    return out;
}

function plausibleDefForBlock(b: Uint8Array, o: number, blockSize: number): boolean {
    if (o + 34 > b.length) return false;
    const dv = view(b);
    const w = dv.getUint32(o + 4, true);
    const h = dv.getUint32(o + 8, true);
    if (w < 1 || h < 1 || w > 4096 || h > 4096 || ps2TerrainBlockSize(w, h) !== blockSize) return false;
    return plausibleDef(b, o, w, h);
}

// ---------------------------------------------------------------- PC (OpenDrakan layout, used as a cross-check)

const PC_VERTEX = 4;
const PC_CELL = 26;

/** Decode a PC / Order of the Flame LVL 0x0001 payload (definitions, `u32 1`, one zlib block per layer). */
export function parsePcTerrain(data: Uint8Array): TerrainLayer[] {
    const dv = view(data);
    const count = dv.getUint32(0, true);
    const defs: TerrainLayerDef[] = [];
    let o = 4;
    for (let i = 0; i < count; i++) {
        const r = readDef(data, o, i);
        defs.push(r.def);
        o = r.end;
    }
    if (dv.getUint32(o, true) !== 1) throw new TerrainError('missing layer data marker');
    o += 4;
    const out: TerrainLayer[] = [];
    for (const def of defs) {
        const cs = dv.getUint32(o, true);
        const raw = inflate(data.subarray(o + 4, o + 4 + cs));
        o += 4 + cs;
        const nv = (def.width + 1) * (def.height + 1);
        const nc = def.width * def.height;
        if (!raw || raw.length !== nv * PC_VERTEX + nc * PC_CELL)
            throw new TerrainError(`layer ${def.index}: bad block`);
        const L = allocLayer(def, 'pc');
        const bv = view(raw);
        for (let v = 0; v < nv; v++) {
            L.vertexFlags[v] = raw[v * PC_VERTEX]!;
            L.heights[v] = def.worldHeight + (bv.getUint16(v * PC_VERTEX + 2, true) - 0x8000) * 2;
        }
        for (let c = 0; c < nc; c++) {
            const p = nv * PC_VERTEX + c * PC_CELL;
            L.cellFlags[c] = bv.getUint16(p, true);
            L.cellTexLeft[c] = bv.getUint32(p + 2, true);
            L.cellTexRight[c] = bv.getUint32(p + 6, true);
            for (let k = 0; k < 8; k++) L.cellUv[c * 8 + k] = bv.getUint16(p + 10 + k * 2, true);
        }
        out.push(L);
    }
    return out;
}

/** Decode either layout (PC when the data section is a plain `u32 1` + zlib chain right after the definitions). */
export function parseTerrain(data: Uint8Array, platform: 'ps2' | 'pc' = 'ps2'): TerrainLayer[] {
    return platform === 'pc' ? parsePcTerrain(data) : parsePs2Terrain(data);
}

// ---------------------------------------------------------------- height queries

/** True when (x, z) in world units lies inside the layer's footprint. */
export function layerContains(L: TerrainLayerDef, x: number, z: number): boolean {
    const cx = x / CELL_SIZE - L.originX;
    const cz = z / CELL_SIZE - L.originZ;
    return cx >= 0 && cz >= 0 && cx <= L.width && cz <= L.height;
}

/** Terrain height (world units) of one layer at (x, z), or NaN outside it or over a hole. Same planes as OpenDrakan. */
export function layerHeightAt(L: TerrainLayer, x: number, z: number): number {
    const rx = x / CELL_SIZE - L.originX;
    const rz = z / CELL_SIZE - L.originZ;
    if (!(rx >= 0 && rz >= 0 && rx <= L.width && rz <= L.height)) return NaN;
    const cx = Math.min(Math.floor(rx), L.width - 1);
    const cz = Math.min(Math.floor(rz), L.height - 1);
    const fx = rx - cx;
    const fz = rz - cz;
    const cell = cz * L.width + cx;
    const stride = L.width + 1;
    const ya = L.heights[cz * stride + cx]!;
    const yb = L.heights[cz * stride + cx + 1]!;
    const yc = L.heights[(cz + 1) * stride + cx]!;
    const yd = L.heights[(cz + 1) * stride + cx + 1]!;
    const backslash = (L.cellFlags[cell]! & CELL_FLAG_BACKSLASH) !== 0;
    const left = backslash ? fx < fz : 1 - fx > fz;
    const tex = left ? L.cellTexLeft[cell]! : L.cellTexRight[cell]!;
    if (tex === TEX_HOLE) return NaN;
    if (backslash) {
        return left ? yc + fx * (yd - yc) + (1 - fz) * (ya - yc) : yb + (1 - fx) * (ya - yb) + fz * (yd - yb);
    }
    return left ? ya + fx * (yb - ya) + fz * (yc - ya) : yd + (1 - fx) * (yc - yd) + (1 - fz) * (yb - yd);
}

/**
 * Height of the terrain at (x, z) among all layers. With `nearY` the layer surface closest to it wins (layers stack:
 * floors, ceilings, in-between); without it the highest floor-type (0) surface, falling back to any layer.
 */
export function terrainHeightAt(layers: readonly TerrainLayer[], x: number, z: number, nearY?: number): number {
    let best = NaN;
    let bestScore = Infinity;
    for (const L of layers) {
        const h = layerHeightAt(L, x, z);
        if (Number.isNaN(h)) continue;
        const score = nearY === undefined ? -h + (L.type === 0 ? 0 : 1e9) : Math.abs(h - nearY);
        if (score < bestScore) {
            bestScore = score;
            best = h;
        }
    }
    return best;
}
