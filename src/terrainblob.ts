import { CELL_SIZE, TEX_HOLE, TEX_INVISIBLE } from './terrain.ts';
import type { TerrainLayer } from './terrain.ts';

/**
 * Generator for the PS2 per-layer "inline blob" of LVL 0x0001 (the bytes that follow each layer definition). Structure,
 * evidence and the parts that cannot be derived: docs/reference/level-format.md section 10.1.
 *
 * ```
 * u16 seq, u16 level_tag, u32 pool, u32 x_lo, u32 x_hi, u32 z_lo, u32 z_hi, u32 chunk_count
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
/** Layer definition flag bit: flat layer, no per-vertex normals in the blob. */
export const LAYER_FLAG_FLAT = 0x04;

export interface TerrainBlobOptions {
    /** Streaming group id; real layers that coexist share one. Default 1. */
    seq?: number;
    /** Level-wide constant at bytes 2..3 (0x0c in LEVEL0RO, 0x16 in LEVEL5NE). Default 0x16. */
    levelTag?: number;
    /** Sort key for the texture list of a chunk. The real order is a per-texture property that is not in the layer. */
    textureOrder?: (ref: number) => number;
    /**
     * How cells outside the layer count toward a border vertex. `any` = they match every texture (what isolated layers
     * show), `none` = they never match (what flat layers show). Default: `none` for flat layers, `any` otherwise.
     */
    outside?: 'any' | 'none';
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

/** Build the inline blob for one layer (see the module comment). Pure; the layer is not modified. */
export function buildPs2TerrainBlob(layer: TerrainLayer, opts: TerrainBlobOptions = {}): Uint8Array {
    const w = layer.width;
    const h = layer.height;
    const flat = (layer.flags & LAYER_FLAG_FLAT) !== 0;
    const outsideAny = (opts.outside ?? (flat ? 'none' : 'any')) === 'any';
    const o = new Out();
    const xHi = 4 * w - 1;
    const zHi = 4 * h - 1;
    o.u16(opts.seq ?? 1);
    o.u16(opts.levelTag ?? 0x16);
    o.u32(poolSize(Math.max(xHi, zHi)));
    o.u32(0);
    o.u32(xHi);
    o.u32(0);
    o.u32(zHi);

    const xs = ps2ChunkSplit(w);
    const zs = ps2ChunkSplit(h);
    o.u32((xs.length - 1) * (zs.length - 1));
    const tex = (cx: number, cz: number): number => layer.cellTexLeft[cz * w + cx]!;
    for (let a = 0; a < xs.length - 1; a++) {
        for (let b = 0; b < zs.length - 1; b++) {
            const x0 = xs[a]!;
            const x1 = xs[a + 1]!;
            const z0 = zs[b]!;
            const z1 = zs[b + 1]!;
            let refs: number[] = [];
            for (let z = z0; z < z1; z++) {
                for (let x = x0; x < x1; x++) {
                    const t = tex(x, z);
                    if (!isSpecial(t) && !refs.includes(t)) refs.push(t);
                }
            }
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

    // Normals: entry 0 is always zero; a flat layer has one more entry pointing up; others have one per vertex.
    o.u32(0);
    if (flat) {
        o.u8(0);
        o.u8(127);
        o.u8(0);
        o.u8(127);
    } else {
        const sw = w + 1;
        const sh = h + 1;
        const hAt = (x: number, z: number): number =>
            layer.heights[Math.min(Math.max(z, 0), sh - 1) * sw + Math.min(Math.max(x, 0), sw - 1)]!;
        for (let z = 0; z < sh; z++) {
            for (let x = 0; x < sw; x++) {
                const dx = (hAt(x + 1, z) - hAt(x - 1, z)) / (2 * CELL_SIZE);
                const dz = (hAt(x, z + 1) - hAt(x, z - 1)) / (2 * CELL_SIZE);
                const m = Math.hypot(dx, 1, dz);
                o.u8(Math.round((-dx / m) * 127));
                o.u8(Math.round((1 / m) * 127));
                o.u8(Math.round((-dz / m) * 127));
                o.u8(127);
            }
        }
    }
    return o.done();
}

/** The four cells around a vertex, as offsets from the vertex's own (down-right) cell. */
const CORNERS: readonly (readonly [number, number])[] = [
    [-1, -1],
    [0, -1],
    [-1, 0],
    [0, 0],
];
