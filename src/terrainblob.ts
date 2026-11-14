import { CELL_SIZE, TEX_HOLE, TEX_INVISIBLE } from './terrain.ts';
import type { TerrainLayer } from './terrain.ts';

/**
 * Generator for the PS2 per-layer "inline blob" of LVL 0x0001 (the bytes that follow each layer definition). Structure,
 * evidence and the parts that cannot be derived: docs/reference/level-format.md section 10.1.
 *
 * ```
 * u16 seq, u16 level_tag, u32 pool, u32 x_lo, u32 x_hi, u32 z_lo, u32 z_hi, u32 chunk_count
 *   or u32 0 (no chunks): a layer without one drawn cell
 * chunk_count x {
 *   u32 x0, x1, z0, z1                 // cell range of the chunk (x outer, z inner)
 *   u32 ntex, ntex x u32 ref           // textures drawn in the chunk (id | db << 16)
 *   u32 vw, vh, u32 ntex               // (x1-x0+1), (z1-z0+1), array count
 *   ntex x vw*vh bytes                 // per vertex, per texture: [0x10 near-flag] | adjacent-cell count
 * }
 * flat (layer flag 0x04):  00 00 00 00  00 7f 00 7f
 * otherwise:               00 00 00 00, then per vertex (row-major) i8 nx, ny, nz, 0x7f
 * ```
 */

/** Largest chunk extent in cells: x is split into ceil(w/12) near-equal pieces, z likewise (98% of real layers). */
const MAX_CHUNK = 12;
/**
 * Most textures one chunk may list: 8, the most any chunk of the PAL discs lists. The engine's chunk record is 0x4c bytes with
 * room for 10 texture refs (offsets 0x14..0x3b) and the stream loader (FUN_00165840) does not bounds-check the count, so an
 * 11th ref overwrites the weight-array descriptor and the heap allocator later loops forever
 * (docs/journal/2026-11-01/ootf-texture-limit.md). 10 is not safe either: the draw pages the engine builds from a 10-texture
 * chunk carry only 7 texture groups, the mesh drawer (FUN_00158148) still walks all 10 and sends the empty ones as a VIF UNPACK
 * with NUM = 0, which the VIF reads as 256 and so parses the rest of the packet out of step; the garbage then changes STMOD
 * and every later VU1 batch draws garbage ("VU1 reserved lower", 2 fps; docs/journal/2026-11-07/vu1-reserved-lower.md).
 * Chunk rectangles are free-form in the file, so a crowded chunk is cut into smaller ones, down to single cells; a single cell
 * whose neighbours still bring in more textures keeps its own ones and the neighbours' most used ones.
 */
export const MAX_CHUNK_TEXTURES = 8;
/**
 * Most textures one chunk may list for an exe with wide terrain chunks (`[general] terrain_wide_chunks`, switched on by
 * the pack's `terrain_chunk_textures`): the runtime's function variant reads a 0xa4-byte chunk record with room for 32
 * refs and gives the mesh drawer 64 group flags (runtime/world/include/world/TerrainChunks.h,
 * docs/journal/2026-11-14/ootf-wide-chunks.md). Converted layers then keep the disc's 12 x 12 chunk grid almost
 * everywhere instead of being cut into single cells.
 */
export const WIDE_CHUNK_TEXTURES = 32;
/** Layer definition flag bit: flat layer, no per-vertex normals in the blob. */
export const LAYER_FLAG_FLAT = 0x04;

export interface TerrainBlobOptions {
    /** Streaming group id; real layers that coexist share one. Default 1. */
    seq?: number;
    /** Slot rectangle of this layer inside its group's pool (`planTerrainSlots`); default 0,0 with pool sized to the layer. */
    slot?: { xLo: number; zLo: number; pool: number };
    /** Level-wide constant at bytes 2..3 (0x0c in LEVEL0RO, 0x16 in LEVEL5NE). Default 0x16. */
    levelTag?: number;
    /** Sort key for the texture list of a chunk. The real order is a per-texture property that is not in the layer. */
    textureOrder?: (ref: number) => number;
    /**
     * How cells outside the layer count toward a border vertex. `any` = they match every texture (what isolated layers
     * show), `none` = they never match (what flat layers show). Default: `none` for flat layers, `any` otherwise.
     */
    outside?: 'any' | 'none';
    /** Most textures per chunk before the chunk is split in two (default {@link MAX_CHUNK_TEXTURES}; 0 = never split). */
    maxChunkTextures?: number;
    /** Filled by the writer: chunks that still listed more than the limit and had textures dropped from their blend. */
    stats?: { reducedChunks: number };
    /**
     * Write the empty form (no chunks) even when cells are visible. Water layers (type 2): every one of the 14 PAL levels
     * stores them so (171 of 171 in LEVEL1NA); the engine's water pass draws them from the cells, not from chunks.
     */
    noDrawData?: boolean;
    /**
     * Height at world vertex (`x`, `z`) (cell units) of the ground that continues past the layer's edge from its border
     * vertex (`x0`, `z0`) of height `h0`, or null when none does. A border vertex then takes its slope from both sides like
     * an inner one instead of from half a difference (the clamped neighbour), which lit every layer border as a flatter,
     * brighter line. Without it the clamped rule stays (the disc levels' rewrites keep their normals).
     */
    heightBeyond?: (x0: number, z0: number, h0: number, x: number, z: number) => number | null;
}

/** Cell rectangle of a chunk: x0..x1 and z0..z1 are vertex indices, so the chunk covers cells x0..x1-1 and z0..z1-1. */
interface ChunkRect {
    x0: number;
    x1: number;
    z0: number;
    z1: number;
}

/** Chunk boundaries along one axis: ceil(n/12) pieces of ceil(n/pieces) cells, the last one shorter. */
export function ps2ChunkSplit(n: number): number[] {
    const pieces = Math.max(1, Math.ceil(n / MAX_CHUNK));
    const size = Math.ceil(n / pieces);
    const out: number[] = [];
    for (let o = 0; o < n; o += size) out.push(o);
    out.push(n);
    return out;
}

function isSpecial(ref: number): boolean {
    return ref === TEX_HOLE || ref === TEX_INVISIBLE;
}

class Out {
    private b: number[] = [];
    u8(n: number): void {
        this.b.push(n & 255);
    }
    u16(n: number): void {
        this.b.push(n & 255, (n >>> 8) & 255);
    }
    u32(n: number): void {
        this.b.push(n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255);
    }
    done(): Uint8Array {
        return Uint8Array.from(this.b);
    }
}

function poolSize(hi: number): number {
    let p = 64;
    while (p < hi + 1) p *= 2;
    return p;
}

/**
 * Build the inline blob for one layer (see the module comment). Pure; the layer is not modified.
 *
 * A layer whose every cell is a hole or invisible gets the disc's empty form (`u32 0`, no chunks), as every such layer of the
 * 14 PAL levels has. Chunks that all list no texture make the engine build a terrain section with zero texture pages, which
 * its draw pass still links into the section LRU (`0x4dff60`) while the unload (`FUN_0015c820`) only unlinks sections with
 * pages: after a quick load the list runs through freed memory and the eviction walk (`FUN_0015e5a0`) never returns
 * (docs/journal/2026-11-07/ootf-quickload-lru.md).
 */
export function buildPs2TerrainBlob(layer: TerrainLayer, opts: TerrainBlobOptions = {}): Uint8Array {
    const w = layer.width;
    const h = layer.height;
    const flat = (layer.flags & LAYER_FLAG_FLAT) !== 0;
    const outsideAny = (opts.outside ?? (flat ? 'none' : 'any')) === 'any';
    const o = new Out();
    if (opts.noDrawData || !layer.cellTexLeft.some((t) => !isSpecial(t))) {
        o.u32(0);
        writeNormals(o, layer, flat, opts.heightBeyond);
        return o.done();
    }
    const xHi = 4 * w - 1;
    const zHi = 4 * h - 1;
    o.u16(opts.seq ?? 1);
    o.u16(opts.levelTag ?? 0x16);
    const slot = opts.slot;
    o.u32(slot ? slot.pool : poolSize(Math.max(xHi, zHi)));
    o.u32(slot?.xLo ?? 0);
    o.u32((slot?.xLo ?? 0) + xHi);
    o.u32(slot?.zLo ?? 0);
    o.u32((slot?.zLo ?? 0) + zHi);

    const xs = ps2ChunkSplit(w);
    const zs = ps2ChunkSplit(h);
    const tex = (cx: number, cz: number): number => layer.cellTexLeft[cz * w + cx]!;
    // The chunk's vertices are x0..x1 / z0..z1 inclusive, so it also lists the textures of the cells that touch
    // them from the neighbouring chunks (disc: a chunk of 90219 cells next to 90217 lists both).
    const refsOf = (r: ChunkRect): number[] => {
        const refs: number[] = [];
        for (let z = Math.max(0, r.z0 - 1); z <= Math.min(h - 1, r.z1); z++) {
            for (let x = Math.max(0, r.x0 - 1); x <= Math.min(w - 1, r.x1); x++) {
                const t = tex(x, z);
                if (!isSpecial(t) && !refs.includes(t)) refs.push(t);
            }
        }
        return refs;
    };
    const maxTex = opts.maxChunkTextures ?? MAX_CHUNK_TEXTURES;
    const rects: ChunkRect[] = [];
    // Textures a chunk lists after the limit: its own cells' textures first, then the window's by how many window cells use
    // them (first appearance breaks ties). Only a single cell can still be over the limit (it sees 3x3 cells).
    const keptRefsOf = (r: ChunkRect): number[] => {
        const refs = refsOf(r);
        if (maxTex <= 0 || refs.length <= maxTex) return refs;
        if (opts.stats) opts.stats.reducedChunks++;
        const own = new Set<number>();
        for (let z = r.z0; z < r.z1; z++) for (let x = r.x0; x < r.x1; x++) own.add(tex(x, z));
        const uses = new Map<number, number>();
        for (let z = Math.max(0, r.z0 - 1); z <= Math.min(h - 1, r.z1); z++)
            for (let x = Math.max(0, r.x0 - 1); x <= Math.min(w - 1, r.x1); x++)
                uses.set(tex(x, z), (uses.get(tex(x, z)) ?? 0) + 1);
        const rank = (t: number): number => (own.has(t) ? 1000 : 0) + (uses.get(t) ?? 0);
        const keep = new Set(
            refs
                .map((t, i) => ({ t, i }))
                .sort((p, q) => rank(q.t) - rank(p.t) || p.i - q.i)
                .slice(0, maxTex)
                .map((e) => e.t),
        );
        return refs.filter((t) => keep.has(t));
    };
    const add = (r: ChunkRect): void => {
        // A chunk sees its own cells plus a ring of neighbours (x0-1..x1, z0-1..z1), so a 1x2 chunk can see 12 textures:
        // split down to single cells.
        const dx = r.x1 - r.x0;
        const dz = r.z1 - r.z0;
        if (maxTex > 0 && (dx > 1 || dz > 1) && refsOf(r).length > maxTex) {
            if (dx >= dz) {
                const m = r.x0 + (dx >> 1);
                add({ ...r, x1: m });
                add({ ...r, x0: m });
            } else {
                const m = r.z0 + (dz >> 1);
                add({ ...r, z1: m });
                add({ ...r, z0: m });
            }
            return;
        }
        rects.push(r);
    };
    for (let a = 0; a < xs.length - 1; a++) {
        for (let b = 0; b < zs.length - 1; b++) add({ x0: xs[a]!, x1: xs[a + 1]!, z0: zs[b]!, z1: zs[b + 1]! });
    }
    rects.sort((p, q) => p.x0 - q.x0 || p.z0 - q.z0);
    o.u32(rects.length);
    for (const rect of rects) {
        {
            const { x0, x1, z0, z1 } = rect;
            let refs = keptRefsOf(rect);
            const key = opts.textureOrder;
            if (key) refs = refs.sort((p, q) => key(p) - key(q));
            const vw = x1 - x0 + 1;
            const vh = z1 - z0 + 1;
            o.u32(x0);
            o.u32(x1);
            o.u32(z0);
            o.u32(z1);
            o.u32(refs.length);
            for (const r of refs) o.u32(r);
            o.u32(vw);
            o.u32(vh);
            o.u32(refs.length);
            for (const r of refs) {
                const uses = (cx: number, cz: number): boolean =>
                    cx >= 0 && cx < w && cz >= 0 && cz < h && tex(cx, cz) === r;
                for (let vz = 0; vz < vh; vz++) {
                    for (let vx = 0; vx < vw; vx++) {
                        const gx = x0 + vx;
                        const gz = z0 + vz;
                        let count = 0;
                        for (const [dx, dz] of CORNERS) {
                            const cx = gx + dx;
                            const cz = gz + dz;
                            const outside = cx < 0 || cx >= w || cz < 0 || cz >= h;
                            if (outside ? outsideAny : uses(cx, cz)) count++;
                        }
                        let near = false;
                        if (gx < x1 && gz < z1) {
                            for (let dz = -1; dz <= 1 && !near; dz++) {
                                for (let dx = -1; dx <= 1; dx++) {
                                    if (uses(gx + dx, gz + dz)) {
                                        near = true;
                                        break;
                                    }
                                }
                            }
                        }
                        o.u8(count | (near ? 0x10 : 0));
                    }
                }
            }
        }
    }

    writeNormals(o, layer, flat, opts.heightBeyond);
    return o.done();
}

/** Normals: entry 0 is always zero; a flat layer has one more entry pointing up; others have one per vertex. */
function writeNormals(
    o: Out,
    layer: TerrainLayer,
    flat: boolean,
    beyond?: (x0: number, z0: number, h0: number, x: number, z: number) => number | null,
): void {
    o.u32(0);
    if (flat) {
        o.u8(0);
        o.u8(127);
        o.u8(0);
        o.u8(127);
    } else {
        const sw = layer.width + 1;
        const sh = layer.height + 1;
        const own = (x: number, z: number): number => layer.heights[z * sw + x]!;
        // A neighbour outside the layer: the ground continuing there (`beyond`), else none.
        const at = (x0: number, z0: number, x: number, z: number): number | null =>
            x >= 0 && z >= 0 && x < sw && z < sh
                ? own(x, z)
                : (beyond?.(
                      layer.originX + x0,
                      layer.originZ + z0,
                      own(x0, z0),
                      layer.originX + x,
                      layer.originZ + z,
                  ) ?? null);
        // Slope from both neighbours when both exist, else one-sided; without `beyond` the old clamped rule.
        const slope = (h: number, lo: number | null, hi: number | null, clampLo: number, clampHi: number): number =>
            beyond
                ? lo !== null && hi !== null
                    ? (hi - lo) / (2 * CELL_SIZE)
                    : lo !== null
                      ? (h - lo) / CELL_SIZE
                      : hi !== null
                        ? (hi - h) / CELL_SIZE
                        : 0
                : (clampHi - clampLo) / (2 * CELL_SIZE);
        const clamped = (x: number, z: number): number =>
            own(Math.min(Math.max(x, 0), sw - 1), Math.min(Math.max(z, 0), sh - 1));
        for (let z = 0; z < sh; z++) {
            for (let x = 0; x < sw; x++) {
                const h = own(x, z);
                const dx = slope(h, at(x, z, x - 1, z), at(x, z, x + 1, z), clamped(x - 1, z), clamped(x + 1, z));
                const dz = slope(h, at(x, z, x, z - 1), at(x, z, x, z + 1), clamped(x, z - 1), clamped(x, z + 1));
                const m = Math.hypot(dx, 1, dz);
                o.u8(Math.round((-dx / m) * 127));
                o.u8(Math.round((1 / m) * 127));
                o.u8(Math.round((-dz / m) * 127));
                o.u8(127);
            }
        }
    }
}

/** The four cells around a vertex, as offsets from the vertex's own (down-right) cell. */
const CORNERS: readonly (readonly [number, number])[] = [
    [-1, -1],
    [0, -1],
    [-1, 0],
    [0, 0],
];

/** Group and slot assignment of one layer. */
export interface TerrainSlot {
    seq: number;
    xLo: number;
    zLo: number;
    pool: number;
}

/**
 * Assign every layer a streaming group (`seq`) and a `4w x 4h` slot rectangle inside the group's pool, the way the disc
 * does it (LEVEL1NA seq 1: twelve layers with ranges x 0..11, 12..15, 16..31 / z 0..15, 0..3, ... in a 64 pool; groups hold
 * 1..20 layers and the pool is 64 / 128 / 256). A converted level with 346 layers all in one group on the same
 * rectangle (what `seq` 1 + origin 0 gave) hangs the engine's level load; here neighbouring layers (tiles of 32 cells)
 * share a group until the 256 pool is full (shelf packing), and a layer wider than the pool gets a group of its own.
 * Returns a map from `TerrainLayer.index`.
 */
export function planTerrainSlots(layers: readonly TerrainLayer[], maxPool = 256): Map<number, TerrainSlot> {
    const order = [...layers].sort(
        (a, b) =>
            Math.floor(a.originZ / 32) - Math.floor(b.originZ / 32) ||
            Math.floor(a.originX / 32) - Math.floor(b.originX / 32) ||
            a.index - b.index,
    );
    const out = new Map<number, TerrainSlot>();
    let seq = 0;
    let shelfX = 0;
    let shelfZ = 0;
    let shelfH = 0;
    let open = false;
    const startGroup = (): void => {
        seq++;
        shelfX = 0;
        shelfZ = 0;
        shelfH = 0;
        open = true;
    };
    for (const L of order) {
        const w = 4 * L.width;
        const h = 4 * L.height;
        if (w > maxPool || h > maxPool) {
            seq++;
            open = false;
            out.set(L.index, { seq, xLo: 0, zLo: 0, pool: poolSize(Math.max(w, h) - 1) });
            continue;
        }
        if (!open) startGroup();
        if (shelfX + w > maxPool) {
            shelfZ += shelfH;
            shelfX = 0;
            shelfH = 0;
        }
        if (shelfZ + h > maxPool) {
            startGroup();
        }
        out.set(L.index, { seq, xLo: shelfX, zLo: shelfZ, pool: maxPool });
        shelfX += w;
        shelfH = Math.max(shelfH, h);
    }
    // The pool of a group is the smallest of 64 / 128 / 256 that holds its largest extent.
    const need = new Map<number, number>();
    for (const L of layers) {
        const s = out.get(L.index)!;
        if (s.pool > maxPool) continue;
        need.set(s.seq, Math.max(need.get(s.seq) ?? 0, s.xLo + 4 * L.width, s.zLo + 4 * L.height));
    }
    for (const L of layers) {
        const s = out.get(L.index)!;
        if (s.pool <= maxPool) s.pool = poolSize(need.get(s.seq)! - 1);
    }
    return out;
}
