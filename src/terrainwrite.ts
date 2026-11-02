import { zlibSync } from 'fflate';
import { view } from './bytes.ts';
import { encodeString, ps2TerrainBlock, ps2VertexMask } from './convert.ts';
import {
    CELL_SIZE,
    TEX_HOLE,
    TEX_INVISIBLE,
    TerrainError,
    parsePs2Terrain,
    splitPs2Terrain,
    type TerrainLayer,
} from './terrain.ts';
import { LAYER_FLAG_FLAT, MAX_CHUNK_TEXTURES, buildPs2TerrainBlob } from './terrainblob.ts';

/**
 * Writer for edited disc terrain (LVL 0x0001, PS2 layout): the editor's Landscape tools change heights, cell textures or the
 * size of layers, and the level pack carries the rebuilt payload. Facts and in-game evidence: docs/reference/level-format.md
 * section 10 and docs/journal/2026-11-02/terrain-editing-write.md.
 *
 * Strategy: everything that did not change is copied byte for byte from the disc payload (definitions, inline blobs, zlib
 * blocks), because several parts of the inline blob cannot be regenerated from the layer alone (slot ranges of grouped
 * layers, the per-level texture order, border counts next to other layers, baked normals). A changed layer keeps as much of
 * its original blob as the edit allows:
 *
 * * heights only: the chunk tables stay, the normals of the vertices whose 3x3 neighbourhood moved are recomputed;
 * * cell textures: the chunk rectangles stay, texture lists gain/lose refs (new refs placed by the level's texture order),
 *   per-texture bytes are recomputed only around the changed cells;
 * * size (expansion) or a new layer: the blob is regenerated (`buildPs2TerrainBlob`) with the level's tag, a group/slot
 *   that does not collide with the rest of the group, and the level texture order.
 */

// ---------------------------------------------------------------- inline blob read / write

export interface Ps2BlobChunk {
    x0: number;
    x1: number;
    z0: number;
    z1: number;
    refs: number[];
    vw: number;
    vh: number;
    /** One array of `vw*vh` bytes per texture (the stored count; equal to `refs.length` on the disc). */
    arrays: Uint8Array[];
}

export interface Ps2Blob {
    /**
     * Layer without draw data (only collision / invisible cells): the blob header is a single `u32 0` and there are no
     * chunks. 0 cells with a visible texture on the disc (14 levels checked).
     */
    empty: boolean;
    seq: number;
    levelTag: number;
    pool: number;
    xLo: number;
    xHi: number;
    zLo: number;
    zHi: number;
    chunks: Ps2BlobChunk[];
    /** Normal entries after the `u32 0` (entry 0): `i8 nx, ny, nz, 0x7f` each. One entry for a flat layer, else one per vertex. */
    normals: Uint8Array;
}

/** Decode one inline blob (the bytes between a layer definition and the next one). Throws when it does not walk exactly. */
export function readPs2Blob(b: Uint8Array): Ps2Blob {
    const dv = view(b);
    const need = (p: number): void => {
        if (p > b.length) throw new TerrainError('inline blob runs past its end');
    };
    need(4);
    const out: Ps2Blob = {
        empty: dv.getUint32(0, true) === 0,
        seq: 0,
        levelTag: 0,
        pool: 0,
        xLo: 0,
        xHi: 0,
        zLo: 0,
        zHi: 0,
        chunks: [],
        normals: new Uint8Array(0),
    };
    let p = 4;
    if (!out.empty) {
        need(28);
        out.seq = dv.getUint16(0, true);
        out.levelTag = dv.getUint16(2, true);
        out.pool = dv.getUint32(4, true);
        out.xLo = dv.getUint32(8, true);
        out.xHi = dv.getUint32(12, true);
        out.zLo = dv.getUint32(16, true);
        out.zHi = dv.getUint32(20, true);
        const n = dv.getUint32(24, true);
        p = 28;
        for (let c = 0; c < n; c++) {
            need(p + 20);
            const ch: Ps2BlobChunk = {
                x0: dv.getUint32(p, true),
                x1: dv.getUint32(p + 4, true),
                z0: dv.getUint32(p + 8, true),
                z1: dv.getUint32(p + 12, true),
                refs: [],
                vw: 0,
                vh: 0,
                arrays: [],
            };
            const nt = dv.getUint32(p + 16, true);
            p += 20;
            need(p + nt * 4 + 12);
            for (let i = 0; i < nt; i++) ch.refs.push(dv.getUint32(p + i * 4, true));
            p += nt * 4;
            ch.vw = dv.getUint32(p, true);
            ch.vh = dv.getUint32(p + 4, true);
            const na = dv.getUint32(p + 8, true);
            p += 12;
            const sz = ch.vw * ch.vh;
            need(p + na * sz);
            for (let i = 0; i < na; i++) ch.arrays.push(b.slice(p + i * sz, p + (i + 1) * sz));
            p += na * sz;
            out.chunks.push(ch);
        }
    }
    need(p + 4);
    if (dv.getUint32(p, true) !== 0) throw new TerrainError('inline blob: normal entry 0 is not zero');
    out.normals = b.slice(p + 4);
    if (out.normals.length % 4) throw new TerrainError('inline blob: normals are not whole entries');
    return out;
}

/** Inverse of `readPs2Blob` (byte-exact for every disc blob). */
export function writePs2Blob(x: Ps2Blob): Uint8Array {
    let n = 4 + 4 + x.normals.length;
    if (!x.empty) {
        n += 24;
        for (const c of x.chunks) n += 20 + c.refs.length * 4 + 12 + c.arrays.length * c.vw * c.vh;
    }
    const out = new Uint8Array(n);
    const dv = view(out);
    let p = 0;
    if (x.empty) {
        p = 4;
    } else {
        dv.setUint16(0, x.seq, true);
        dv.setUint16(2, x.levelTag, true);
        dv.setUint32(4, x.pool, true);
        dv.setUint32(8, x.xLo, true);
        dv.setUint32(12, x.xHi, true);
        dv.setUint32(16, x.zLo, true);
        dv.setUint32(20, x.zHi, true);
        dv.setUint32(24, x.chunks.length, true);
        p = 28;
        for (const c of x.chunks) {
            dv.setUint32(p, c.x0, true);
            dv.setUint32(p + 4, c.x1, true);
            dv.setUint32(p + 8, c.z0, true);
            dv.setUint32(p + 12, c.z1, true);
            dv.setUint32(p + 16, c.refs.length, true);
            p += 20;
            for (const r of c.refs) {
                dv.setUint32(p, r, true);
                p += 4;
            }
            dv.setUint32(p, c.vw, true);
            dv.setUint32(p + 4, c.vh, true);
            dv.setUint32(p + 8, c.arrays.length, true);
            p += 12;
            for (const a of c.arrays) {
                out.set(a, p);
                p += a.length;
            }
        }
    }
    dv.setUint32(p, 0, true);
    out.set(x.normals, p + 4);
    return out;
}

// ---------------------------------------------------------------- per-vertex rules (see terrainblob.ts)

const isSpecial = (ref: number): boolean => ref === TEX_HOLE || ref === TEX_INVISIBLE;

/** The weight byte of texture `ref` at chunk vertex (gx, gz): `count | near` (level-format.md 10.1). */
function weightByte(
    L: TerrainLayer,
    ref: number,
    gx: number,
    gz: number,
    x1: number,
    z1: number,
    outsideAny: boolean,
): number {
    const w = L.width;
    const h = L.height;
    const uses = (cx: number, cz: number): boolean =>
        cx >= 0 && cx < w && cz >= 0 && cz < h && L.cellTexLeft[cz * w + cx] === ref;
    let count = 0;
    for (let dz = -1; dz <= 0; dz++) {
        for (let dx = -1; dx <= 0; dx++) {
            const cx = gx + dx;
            const cz = gz + dz;
            const outside = cx < 0 || cx >= w || cz < 0 || cz >= h;
            if (outside ? outsideAny : uses(cx, cz)) count++;
        }
    }
    let near = false;
    if (gx < x1 && gz < z1) {
        for (let dz = -1; dz <= 1 && !near; dz++)
            for (let dx = -1; dx <= 1 && !near; dx++) near = uses(gx + dx, gz + dz);
    }
    return count | (near ? 0x10 : 0);
}

/** One normal entry from the heights (central differences, cell 2048, y up): the generator's rule. */
function normalAt(L: TerrainLayer, x: number, z: number): [number, number, number] {
    const sw = L.width + 1;
    const sh = L.height + 1;
    const hAt = (a: number, b: number): number =>
        L.heights[Math.min(Math.max(b, 0), sh - 1) * sw + Math.min(Math.max(a, 0), sw - 1)]!;
    const dx = (hAt(x + 1, z) - hAt(x - 1, z)) / (2 * CELL_SIZE);
    const dz = (hAt(x, z + 1) - hAt(x, z - 1)) / (2 * CELL_SIZE);
    const m = Math.hypot(dx, 1, dz);
    return [Math.round((-dx / m) * 127), Math.round((1 / m) * 127), Math.round((-dz / m) * 127)];
}

function fullNormals(L: TerrainLayer): Uint8Array {
    const sw = L.width + 1;
    const sh = L.height + 1;
    const out = new Uint8Array(sw * sh * 4);
    for (let z = 0; z < sh; z++) {
        for (let x = 0; x < sw; x++) {
            const [a, b, c] = normalAt(L, x, z);
            const o = (z * sw + x) * 4;
            out[o] = a & 255;
            out[o + 1] = b & 255;
            out[o + 2] = c & 255;
            out[o + 3] = 127;
        }
    }
    return out;
}

// ---------------------------------------------------------------- level-wide facts

/**
 * Sort key per texture ref from the chunk lists of a level: the mean relative rank of the ref in every chunk that lists it
 * (0 = first, 1 = last). The disc order is a per-texture priority that is consistent within a level (level-format.md 10.1),
 * so a ref new to a chunk is placed by this key. Refs never seen get 0.5.
 */
export function levelTextureOrder(blobs: readonly Ps2Blob[]): (ref: number) => number {
    const sum = new Map<number, number>();
    const cnt = new Map<number, number>();
    for (const b of blobs) {
        for (const c of b.chunks) {
            const n = c.refs.length;
            c.refs.forEach((r, i) => {
                sum.set(r, (sum.get(r) ?? 0) + (n > 1 ? i / (n - 1) : 0.5));
                cnt.set(r, (cnt.get(r) ?? 0) + 1);
            });
        }
    }
    return (ref) => (cnt.has(ref) ? sum.get(ref)! / cnt.get(ref)! : 0.5);
}

/** Insert the refs of `want` that `keep` lacks into `keep` by `key`, leaving the existing order alone; drops refs not wanted. */
function mergeOrder(keep: readonly number[], want: ReadonlySet<number>, key: (r: number) => number): number[] {
    const out = keep.filter((r) => want.has(r));
    for (const r of want) {
        if (out.includes(r)) continue;
        const k = key(r);
        let at = out.findIndex((q) => key(q) > k);
        if (at < 0) at = out.length;
        out.splice(at, 0, r);
    }
    return out;
}

// ---------------------------------------------------------------- definitions

const DEF_FIXED = 30;

function sameNumbers(a: ArrayLike<number>, b: ArrayLike<number>): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
}

function defFieldsEqual(a: TerrainLayer, b: TerrainLayer): boolean {
    return (
        a.id === b.id &&
        a.width === b.width &&
        a.height === b.height &&
        a.type === b.type &&
        a.originX === b.originX &&
        a.originZ === b.originZ &&
        Math.fround(a.worldHeight) === Math.fround(b.worldHeight) &&
        a.name === b.name &&
        a.flags === b.flags &&
        Math.fround(a.lightDirection) === Math.fround(b.lightDirection) &&
        Math.fround(a.lightAscension) === Math.fround(b.lightAscension) &&
        a.lightColor === b.lightColor &&
        a.ambientColor === b.ambientColor &&
        a.lightDropoff === b.lightDropoff &&
        sameNumbers(a.visible, b.visible)
    );
}

/** Encode a definition; with `orig` (the disc bytes of the same layer) the name bytes and the colours' 4th byte are kept. */
function encodeDef(L: TerrainLayer, orig?: Uint8Array, origName?: string): Uint8Array {
    let name: Uint8Array;
    let hiLight = 0;
    let hiAmb = 0;
    if (orig) {
        const dv = view(orig);
        const sl = dv.getUint16(28, true);
        const p = DEF_FIXED + sl;
        hiLight = dv.getUint32(p + 12, true) & 0xff000000;
        hiAmb = dv.getUint32(p + 16, true) & 0xff000000;
        name = origName === L.name ? orig.subarray(DEF_FIXED, DEF_FIXED + sl) : encodeString(L.name).raw;
    } else {
        name = encodeString(L.name).raw;
    }
    const out = new Uint8Array(DEF_FIXED + name.length + 28 + L.visible.length * 4);
    const dv = view(out);
    dv.setUint32(0, L.id, true);
    dv.setUint32(4, L.width, true);
    dv.setUint32(8, L.height, true);
    dv.setUint32(12, L.type, true);
    dv.setUint32(16, L.originX, true);
    dv.setUint32(20, L.originZ, true);
    dv.setFloat32(24, L.worldHeight, true);
    dv.setUint16(28, name.length, true);
    out.set(name, DEF_FIXED);
    let p = DEF_FIXED + name.length;
    dv.setUint32(p, L.flags, true);
    dv.setFloat32(p + 4, L.lightDirection, true);
    dv.setFloat32(p + 8, L.lightAscension, true);
    dv.setUint32(p + 12, ((L.lightColor & 0xffffff) | hiLight) >>> 0, true);
    dv.setUint32(p + 16, ((L.ambientColor & 0xffffff) | hiAmb) >>> 0, true);
    dv.setUint32(p + 20, L.lightDropoff, true);
    dv.setUint32(p + 24, L.visible.length, true);
    p += 28;
    L.visible.forEach((v, i) => dv.setUint32(p + i * 4, v, true));
    return out;
}

// ---------------------------------------------------------------- slots

interface Rect {
    x0: number;
    z0: number;
    x1: number;
    z1: number;
}
const overlaps = (a: Rect, b: Rect): boolean => a.x0 <= b.x1 && b.x0 <= a.x1 && a.z0 <= b.z1 && b.z0 <= a.z1;

/** A free `w x h` rectangle (inclusive extents w-1 / h-1) inside `pool`, scanning in steps of 4, or null. */
function freeSlot(taken: readonly Rect[], w: number, h: number, pool: number): { x: number; z: number } | null {
    for (let z = 0; z + h <= pool; z += 4) {
        for (let x = 0; x + w <= pool; x += 4) {
            const r = { x0: x, z0: z, x1: x + w - 1, z1: z + h - 1 };
            if (!taken.some((t) => overlaps(t, r))) return { x, z };
        }
    }
    return null;
}

// ---------------------------------------------------------------- the rebuild

export interface TerrainRebuildOptions {
    /** Most textures per chunk before the chunk is split (default `MAX_CHUNK_TEXTURES`, the engine's limit). */
    maxChunkTextures?: number;
    /**
     * Where a resized or new layer's slot goes (a `4w x 4h` rectangle in a group's pool, level-format.md 10.1):
     * `group` (default) = the layer's own corner in its group (resized) when the rectangle stays free, else a free rectangle
     * in its group or the nearest group with room, else the same allowing overlap with members that no `visible` list links
     * to it (the disc never overlaps, but the game drew such a layer; a new group drew nothing); `overlap` = skip the strict
     * pass; `own` = a new group (`seq` past the level's highest), solo (does not draw in game; for experiments).
     */
    slots?: 'group' | 'overlap' | 'own';
}

export interface TerrainRebuildReport {
    /** Layers whose bytes were copied unchanged. */
    unchanged: number;
    /** Per changed layer index: what was rewritten. */
    changed: Map<number, string[]>;
    warnings: string[];
}

export interface TerrainRebuild {
    payload: Uint8Array;
    report: TerrainRebuildReport;
}

function geometryDiff(a: TerrainLayer, b: TerrainLayer): { heights: boolean; cells: boolean; texture: boolean } {
    const heights = !sameNumbers(a.heights, b.heights);
    const texture = !sameNumbers(a.cellTexLeft, b.cellTexLeft);
    const cells =
        texture ||
        !sameNumbers(a.cellFlags, b.cellFlags) ||
        !sameNumbers(a.cellUv, b.cellUv) ||
        !sameNumbers(a.vertexFlags, b.vertexFlags) ||
        !sameNumbers(a.vertexMask, b.vertexMask);
    return { heights, cells, texture };
}

/** Raw heights must fit a u16 around `worldHeight`; returns the layer with `worldHeight` moved when they do not. */
function fitWorldHeight(L: TerrainLayer, warn: (s: string) => void): TerrainLayer {
    let lo = Infinity;
    let hi = -Infinity;
    for (const h of L.heights) {
        lo = Math.min(lo, h);
        hi = Math.max(hi, h);
    }
    const rawLo = (lo - L.worldHeight) / 2 + 0x8000;
    const rawHi = (hi - L.worldHeight) / 2 + 0x8000;
    if (rawLo >= 0 && rawHi <= 0xffff) return L;
    if (hi - lo > 0xffff * 2)
        warn(`layer ${L.index}: height range ${hi - lo} exceeds the format's 131070 units; clamped`);
    return { ...L, worldHeight: Math.round((lo + hi) / 2) };
}

const ADJ_MASK_BITS = 0x0f;

/**
 * `visible` lists as the engine needs them: every disc layer lists itself (483 of 483 in LEVEL1NA, first in 175), and a
 * layer the player stands on draws the layers of its own list. An appended layer that did not list itself hung the game as
 * soon as the player came near it (journal 2026-11-02/terrain-editing-write.md), so an appended layer gets its own index
 * first (duplicates and bad indices dropped), and every layer its list names gets the appended layer in return (links are
 * symmetric for 90 % of disc pairs), so it is drawn from there too. Disc layers that do not list themselves are reported.
 */
export function linkVisibleLists(
    layers: readonly TerrainLayer[],
    baseCount: number,
    warn: (s: string) => void = () => {},
): TerrainLayer[] {
    const out = [...layers];
    const own = new Set<number>();
    const writable = (i: number): TerrainLayer => {
        if (!own.has(i)) {
            out[i] = { ...out[i]!, visible: [...out[i]!.visible] };
            own.add(i);
        }
        return out[i]!;
    };
    for (let i = baseCount; i < out.length; i++) {
        const L = out[i]!;
        const clean = [i, ...new Set(L.visible.filter((v) => v !== i && v >= 0 && v < out.length))];
        if (!sameNumbers(clean, L.visible)) {
            writable(i).visible = clean;
        }
        for (const j of out[i]!.visible) {
            if (j === i || out[j]!.visible.includes(i)) continue;
            writable(j).visible.push(i);
        }
    }
    for (let i = 0; i < Math.min(baseCount, out.length); i++) {
        if (!out[i]!.visible.includes(i)) warn(`layer ${i}: its visible list does not include itself`);
    }
    return out;
}

/**
 * Rebuild a PS2 LVL 0x0001 payload from the disc payload `original` and the edited layer list (`parseTerrain` output, edited
 * in place; layers appended at the end have `index >= original count`). Layers equal to the disc are copied byte for byte, so
 * an unedited list returns `original` unchanged.
 */
export function rebuildPs2Terrain(
    original: Uint8Array,
    input: readonly TerrainLayer[],
    opts: TerrainRebuildOptions = {},
): TerrainRebuild {
    const report: TerrainRebuildReport = { unchanged: 0, changed: new Map(), warnings: [] };
    const warn = (s: string): void => {
        report.warnings.push(s);
    };
    const spans = splitPs2Terrain(original);
    const orig = parsePs2Terrain(original);
    const n0 = orig.length;
    if (input.length < n0) throw new TerrainError(`removing layers is not supported (${input.length} < ${n0})`);
    input.forEach((L, i) => {
        if (L.index !== i) throw new TerrainError(`layer at position ${i} has index ${L.index}`);
        if (L.source !== 'ps2') throw new TerrainError(`layer ${i} is not PS2 terrain`);
    });
    const layers = linkVisibleLists(input, n0, warn);
    const blobs = spans.layers.map((s) => readPs2Blob(original.subarray(s.defEnd, s.blobEnd)));
    const levelTag = blobs.find((b) => !b.empty)?.levelTag ?? 0x18;
    const order = levelTextureOrder(blobs);
    const maxTex = opts.maxChunkTextures ?? MAX_CHUNK_TEXTURES;
    let maxSeq = Math.max(0, ...blobs.map((b) => b.seq));

    // Group slot occupancy (by seq), updated as resized / new layers take slots.
    const groups = new Map<number, { pool: number; rects: Map<number, Rect> }>();
    blobs.forEach((b, i) => {
        if (b.empty) return;
        let g = groups.get(b.seq);
        if (!g) groups.set(b.seq, (g = { pool: b.pool, rects: new Map() }));
        g.pool = Math.max(g.pool, b.pool);
        g.rects.set(i, { x0: b.xLo, x1: b.xHi, z0: b.zLo, z1: b.zHi });
    });
    // No two layers of a group share slot texels on the disc (0 overlapping pairs of 14,000 in 14 levels). `overlap` relaxes
    // that for layers not linked by a `visible` list (experiment, see the option).
    const linked = (L: TerrainLayer, k: number): boolean =>
        L.visible.includes(k) || (layers[k]?.visible.includes(L.index) ?? false);
    const groupDistance = (seq: number, L: TerrainLayer): number => {
        let d = Infinity;
        for (const k of groups.get(seq)!.rects.keys()) {
            const O = layers[k] ?? orig[k];
            if (O) d = Math.min(d, Math.hypot(O.originX - L.originX, O.originZ - L.originZ));
        }
        return d;
    };
    const placeSlot = (
        L: TerrainLayer,
        prefer: number | undefined,
        keepAt?: { x: number; z: number },
    ): { seq: number; xLo: number; zLo: number; pool: number } => {
        const w = 4 * L.width;
        const h = 4 * L.height;
        if (opts.slots !== 'own') {
            const others = [...groups.keys()]
                .filter((q) => q !== prefer)
                .sort((p, q) => groupDistance(p, L) - groupDistance(q, L));
            const order = prefer !== undefined && groups.has(prefer) ? [prefer, ...others] : others;
            const tryGroup = (seq: number, overlap: boolean): ReturnType<typeof placeSlot> | null => {
                const g = groups.get(seq)!;
                const taken = [...g.rects]
                    .filter(([k]) => k !== L.index && (!overlap || linked(L, k)))
                    .map(([, r]) => r);
                const fits = (x: number, z: number): boolean =>
                    x + w <= g.pool &&
                    z + h <= g.pool &&
                    !taken.some((t) => overlaps(t, { x0: x, z0: z, x1: x + w - 1, z1: z + h - 1 }));
                const at =
                    seq === prefer && keepAt && fits(keepAt.x, keepAt.z) ? keepAt : freeSlot(taken, w, h, g.pool);
                if (!at) return null;
                for (const r of groups.values()) r.rects.delete(L.index);
                g.rects.set(L.index, { x0: at.x, z0: at.z, x1: at.x + w - 1, z1: at.z + h - 1 });
                if (overlap)
                    warn(`layer ${L.index}: its slot overlaps layers of group ${seq} that it is never drawn with`);
                return { seq, xLo: at.x, zLo: at.z, pool: g.pool };
            };
            // Strict first (what the disc does), then overlapping members no visible list links to it: a new group drew
            // nothing in game (journal 2026-11-02/terrain-editing-write.md), an overlapping slot in the layer's own group drew.
            if (opts.slots !== 'overlap')
                for (const seq of order) {
                    const r = tryGroup(seq, false);
                    if (r) return r;
                }
            for (const seq of order) {
                const r = tryGroup(seq, true);
                if (r) return r;
            }
        }
        warn(
            `layer ${L.index}: no group has room for its ${w}x${h} slot; it gets a new group, which the game did not draw`,
        );
        maxSeq++;
        let pool = 64;
        while (pool < Math.max(w, h)) pool *= 2;
        groups.set(maxSeq, { pool, rects: new Map([[L.index, { x0: 0, z0: 0, x1: w - 1, z1: h - 1 }]]) });
        return { seq: maxSeq, xLo: 0, zLo: 0, pool };
    };
    const nearestSeq = (L: TerrainLayer): number | undefined => {
        let best: number | undefined;
        let bd = Infinity;
        orig.forEach((O, i) => {
            if (blobs[i]!.empty || O.type !== L.type) return;
            const d = Math.hypot(
                O.originX + O.width / 2 - L.originX - L.width / 2,
                O.originZ + O.height / 2 - L.originZ - L.height / 2,
            );
            if (d < bd) {
                bd = d;
                best = blobs[i]!.seq;
            }
        });
        return best;
    };
    const hasDrawnCells = (L: TerrainLayer): boolean => L.cellTexLeft.some((r) => !isSpecial(r));

    const defs: Uint8Array[] = [];
    const inl: Uint8Array[] = [];
    const blocks: Uint8Array[] = [];
    for (let i = 0; i < layers.length; i++) {
        let L = layers[i]!;
        const what: string[] = [];
        if (i < n0) {
            const O = orig[i]!;
            const s = spans.layers[i]!;
            const sameDims = L.width === O.width && L.height === O.height;
            const g = sameDims ? geometryDiff(O, L) : { heights: true, cells: true, texture: true };
            if (g.heights) {
                const fit = fitWorldHeight(L, warn);
                if (fit !== L) {
                    what.push('world height');
                    L = fit;
                }
            }
            // Raising ground on a layer marked flat: the flag says "no per-vertex normals"; drop it so normals are stored.
            if (g.heights && L.flags & LAYER_FLAG_FLAT && L.heights.some((h) => h !== L.heights[0])) {
                L = { ...L, flags: L.flags & ~LAYER_FLAG_FLAT };
                what.push('flat flag cleared');
            }
            if (!sameDims) {
                L = { ...L, vertexMask: ps2AdjacencyMask(L) };
            }
            const defSame = defFieldsEqual(O, L);
            defs.push(
                defSame
                    ? original.subarray(s.defStart, s.defEnd)
                    : encodeDef(L, original.subarray(s.defStart, s.defEnd), O.name),
            );
            if (!defSame) what.push('definition');
            // Inline blob.
            const b0 = blobs[i]!;
            if (!sameDims) {
                // A layer without draw data on the disc (mostly type 2, "in between") stays without.
                const slot = !b0.empty && hasDrawnCells(L) ? placeSlot(L, b0.seq, { x: b0.xLo, z: b0.zLo }) : undefined;
                inl.push(regenBlob(L, slot, levelTag, order, maxTex));
                what.push(
                    `resized ${O.width}x${O.height} -> ${L.width}x${L.height}`,
                    slot ? `slot seq ${slot.seq} at ${slot.xLo},${slot.zLo}` : 'no draw data',
                );
            } else if (g.heights || g.texture || L.flags !== O.flags) {
                const nb = patchBlob(O, L, b0, { heights: g.heights, texture: g.texture }, order, maxTex);
                inl.push(nb.bytes);
                what.push(...nb.what);
            } else {
                inl.push(original.subarray(s.defEnd, s.blobEnd));
            }
            // Block.
            if (sameDims && !g.heights && !g.cells && Math.fround(L.worldHeight) === Math.fround(O.worldHeight)) {
                blocks.push(original.subarray(s.blockAt, s.blockAt + s.blockLen));
            } else {
                blocks.push(blockRecord(L));
                what.push(g.heights ? 'heights' : 'cells');
                if (g.texture) what.push('cell textures');
            }
        } else {
            L = fitWorldHeight(L, warn);
            L = { ...L, vertexMask: ps2AdjacencyMask(L) };
            // The disc stores no draw data for most type 2 ("in between") layers; a new floor / ceiling with visible cells gets it.
            const slot = L.type !== 2 && hasDrawnCells(L) ? placeSlot(L, nearestSeq(L)) : undefined;
            defs.push(encodeDef(L));
            inl.push(regenBlob(L, slot, levelTag, order, maxTex));
            blocks.push(blockRecord(L));
            what.push('new layer', slot ? `slot seq ${slot.seq} at ${slot.xLo},${slot.zLo}` : 'no draw data');
        }
        if (what.length) report.changed.set(i, what);
        else report.unchanged++;
    }
    if (report.changed.size === 0) return { payload: original, report };
    const parts: Uint8Array[] = [];
    const head = new Uint8Array(4);
    view(head).setUint32(0, layers.length, true);
    parts.push(head);
    for (let i = 0; i < layers.length; i++) parts.push(defs[i]!, inl[i]!);
    const one = new Uint8Array(4);
    view(one).setUint32(0, 1, true);
    parts.push(one, ...blocks);
    return { payload: concat(parts), report };
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of parts) {
        out.set(p, o);
        o += p.length;
    }
    return out;
}

function blockRecord(L: TerrainLayer): Uint8Array {
    const z = zlibSync(ps2TerrainBlock(L), { level: 6 });
    const out = new Uint8Array(4 + z.length);
    view(out).setUint32(0, z.length, true);
    out.set(z, 4);
    return out;
}

/**
 * Per-vertex adjacency nibble (low 4 bits: 8 = cell down-right, 4 down-left, 2 up-right, 1 up-left exists and is not a hole;
 * 98.8 % of LEVEL1NA's vertices, the size-only rule 91 %). The other stored bits are kept when the array already has the size.
 */
export function ps2AdjacencyMask(L: TerrainLayer): Uint8Array {
    const w = L.width;
    const h = L.height;
    const solid = (x: number, z: number): boolean =>
        x >= 0 && z >= 0 && x < w && z < h && L.cellTexLeft[z * w + x] !== TEX_HOLE;
    const keep = L.vertexMask.length === (w + 1) * (h + 1);
    const m = new Uint8Array((w + 1) * (h + 1));
    for (let z = 0; z <= h; z++) {
        for (let x = 0; x <= w; x++) {
            let v = 0;
            if (solid(x, z)) v |= 8;
            if (solid(x - 1, z)) v |= 4;
            if (solid(x, z - 1)) v |= 2;
            if (solid(x - 1, z - 1)) v |= 1;
            const i = z * (w + 1) + x;
            m[i] = (keep ? L.vertexMask[i]! & ~ADJ_MASK_BITS : 0) | v;
        }
    }
    return m;
}

function regenBlob(
    L: TerrainLayer,
    slot: { seq: number; xLo: number; zLo: number; pool: number } | undefined,
    levelTag: number,
    order: (r: number) => number,
    maxTex: number,
): Uint8Array {
    if (!slot) {
        // No visible cell: the disc's empty-header form.
        const flat = (L.flags & LAYER_FLAG_FLAT) !== 0;
        return writePs2Blob({
            empty: true,
            seq: 0,
            levelTag: 0,
            pool: 0,
            xLo: 0,
            xHi: 0,
            zLo: 0,
            zHi: 0,
            chunks: [],
            normals: flat ? Uint8Array.of(0, 127, 0, 127) : fullNormals(L),
        });
    }
    return buildPs2TerrainBlob(L, { seq: slot.seq, levelTag, slot, textureOrder: order, maxChunkTextures: maxTex });
}

/** Same-size edit: keep the blob, update normals around moved vertices and texture data around repainted cells. */
function patchBlob(
    O: TerrainLayer,
    L: TerrainLayer,
    b0: Ps2Blob,
    g: { heights: boolean; texture: boolean },
    order: (r: number) => number,
    maxTex: number,
): { bytes: Uint8Array; what: string[] } {
    const what: string[] = [];
    const w = L.width;
    const h = L.height;
    const sw = w + 1;
    const flat = (L.flags & LAYER_FLAG_FLAT) !== 0;
    const b: Ps2Blob = {
        ...b0,
        chunks: b0.chunks.map((c) => ({ ...c, refs: [...c.refs], arrays: c.arrays.map((a) => a.slice()) })),
    };

    // Normals.
    if (flat) {
        b.normals = Uint8Array.of(0, 127, 0, 127);
    } else if (b0.normals.length !== sw * (h + 1) * 4) {
        b.normals = fullNormals(L);
        what.push('normals (all)');
    } else if (g.heights) {
        b.normals = b0.normals.slice();
        let n = 0;
        for (let z = 0; z <= h; z++) {
            for (let x = 0; x <= w; x++) {
                let moved = false;
                for (let dz = -1; dz <= 1 && !moved; dz++) {
                    for (let dx = -1; dx <= 1 && !moved; dx++) {
                        const xx = Math.min(Math.max(x + dx, 0), w);
                        const zz = Math.min(Math.max(z + dz, 0), h);
                        const v = zz * sw + xx;
                        moved = L.heights[v] !== O.heights[v];
                    }
                }
                if (!moved) continue;
                const [nx, ny, nz] = normalAt(L, x, z);
                const o = (z * sw + x) * 4;
                b.normals[o] = nx & 255;
                b.normals[o + 1] = ny & 255;
                b.normals[o + 2] = nz & 255;
                b.normals[o + 3] = 127;
                n++;
            }
        }
        what.push(`normals (${n} vertices)`);
    }

    if (g.texture) {
        if (b0.empty) {
            // No draw data on the disc (the engine draws such layers some other way, or not at all): nothing to update.
            return { bytes: writePs2Blob(b), what };
        }
        const changed = new Uint8Array(w * h);
        for (let c = 0; c < w * h; c++) changed[c] = L.cellTexLeft[c] !== O.cellTexLeft[c] ? 1 : 0;
        const changedNear = (gx: number, gz: number): boolean => {
            for (let dz = -1; dz <= 1; dz++) {
                for (let dx = -1; dx <= 1; dx++) {
                    const cx = gx + dx;
                    const cz = gz + dz;
                    if (cx >= 0 && cx < w && cz >= 0 && cz < h && changed[cz * w + cx]) return true;
                }
            }
            return false;
        };
        const outsideAny = !flat;
        let split = false;
        for (const c of b.chunks) {
            const want = new Set<number>();
            for (let z = Math.max(0, c.z0 - 1); z <= Math.min(h - 1, c.z1); z++) {
                for (let x = Math.max(0, c.x0 - 1); x <= Math.min(w - 1, c.x1); x++) {
                    const t = L.cellTexLeft[z * w + x]!;
                    if (!isSpecial(t)) want.add(t);
                }
            }
            // Refs that only the disc data had (unstored right-triangle refs, specials) stay while their arrays are untouched.
            let touched = false;
            for (let z = c.z0 - 1; z <= c.z1 && !touched; z++)
                for (let x = c.x0 - 1; x <= c.x1 && !touched; x++) touched = changedNear(x, z);
            if (!touched) continue;
            const before = c.refs;
            const refs = mergeOrder(before, want, order);
            if (refs.length > maxTex && maxTex > 0) split = true;
            const arrays: Uint8Array[] = [];
            for (const r of refs) {
                const k = before.indexOf(r);
                const a = k >= 0 && c.arrays[k] ? c.arrays[k]!.slice() : new Uint8Array(c.vw * c.vh);
                for (let vz = 0; vz < c.vh; vz++) {
                    for (let vx = 0; vx < c.vw; vx++) {
                        const gx = c.x0 + vx;
                        const gz = c.z0 + vz;
                        if (k >= 0 && !changedNear(gx, gz)) continue;
                        a[vz * c.vw + vx] = weightByte(L, r, gx, gz, c.x1, c.z1, outsideAny);
                    }
                }
                arrays.push(a);
            }
            c.refs = refs;
            c.arrays = arrays;
        }
        if (split) {
            // A chunk now lists more textures than the engine can hold: regenerate the chunk cut (header and normals kept).
            const regen = readPs2Blob(
                buildPs2TerrainBlob(L, {
                    seq: b.seq,
                    levelTag: b.levelTag,
                    slot: { xLo: b.xLo, zLo: b.zLo, pool: b.pool },
                    textureOrder: order,
                    maxChunkTextures: maxTex,
                }),
            );
            regen.xHi = b.xHi;
            regen.zHi = b.zHi;
            regen.normals = b.normals;
            what.push('chunks re-cut (texture limit)');
            return { bytes: writePs2Blob(regen), what };
        }
        what.push('texture weights');
    }
    return { bytes: writePs2Blob(b), what };
}

// ---------------------------------------------------------------- helpers for editors

/** Copy of a layer (typed arrays duplicated) for copy-on-write editing. */
export function cloneTerrainLayer(L: TerrainLayer): TerrainLayer {
    return {
        ...L,
        visible: [...L.visible],
        heights: L.heights.slice(),
        vertexFlags: L.vertexFlags.slice(),
        vertexMask: L.vertexMask.slice(),
        cellFlags: L.cellFlags.slice(),
        cellTexLeft: L.cellTexLeft.slice(),
        cellTexRight: L.cellTexRight.slice(),
        cellUv: L.cellUv.slice(),
    };
}

/**
 * Grow a layer by whole cells on any side (`left`/`top` move the origin). New vertices copy the height of the nearest old
 * edge vertex, new cells copy the nearest edge cell (flags, texture, UVs), so the extension continues the edge flat.
 */
export function extendTerrainLayer(
    L: TerrainLayer,
    grow: { left?: number; right?: number; top?: number; bottom?: number },
): TerrainLayer {
    const l = grow.left ?? 0;
    const r = grow.right ?? 0;
    const t = grow.top ?? 0;
    const btm = grow.bottom ?? 0;
    if ([l, r, t, btm].some((v) => v < 0 || !Number.isInteger(v))) throw new TerrainError('grow by whole cells only');
    if (l > L.originX || t > L.originZ) throw new TerrainError('the layer would move past the level origin');
    const w = L.width + l + r;
    const h = L.height + t + btm;
    const sw = w + 1;
    const osw = L.width + 1;
    const nv = sw * (h + 1);
    const out: TerrainLayer = {
        ...L,
        visible: [...L.visible],
        width: w,
        height: h,
        originX: L.originX - l,
        originZ: L.originZ - t,
        heights: new Float32Array(nv),
        vertexFlags: new Uint16Array(nv),
        vertexMask: ps2VertexMask(w, h),
        cellFlags: new Uint16Array(w * h),
        cellTexLeft: new Uint32Array(w * h),
        cellTexRight: new Uint32Array(w * h),
        cellUv: new Uint16Array(w * h * 8),
    };
    const clamp = (v: number, hi: number): number => Math.min(Math.max(v, 0), hi);
    for (let z = 0; z <= h; z++) {
        for (let x = 0; x <= w; x++) {
            const ox = clamp(x - l, L.width);
            const oz = clamp(z - t, L.height);
            const inside = x - l === ox && z - t === oz;
            const v = z * sw + x;
            out.heights[v] = L.heights[oz * osw + ox]!;
            out.vertexFlags[v] = L.vertexFlags[oz * osw + ox]!;
            if (inside) {
                // Old vertices keep their stored high bits; the adjacency nibble follows the new size.
                out.vertexMask[v] = (L.vertexMask[oz * osw + ox]! & ~ADJ_MASK_BITS) | out.vertexMask[v]!;
            }
        }
    }
    for (let z = 0; z < h; z++) {
        for (let x = 0; x < w; x++) {
            const ox = clamp(x - l, L.width - 1);
            const oz = clamp(z - t, L.height - 1);
            const c = z * w + x;
            const oc = oz * L.width + ox;
            out.cellFlags[c] = L.cellFlags[oc]!;
            out.cellTexLeft[c] = L.cellTexLeft[oc]!;
            out.cellTexRight[c] = L.cellTexRight[oc]!;
            out.cellUv.set(L.cellUv.subarray(oc * 8, oc * 8 + 8), c * 8);
        }
    }
    return out;
}
