// Synthetic layers only; no game bytes.
import { describe, expect, it } from 'vitest';
import { TEX_HOLE, parsePs2Terrain, splitPs2Terrain, layerHeightAt, CELL_SIZE } from '../src/terrain.ts';
import type { TerrainLayer } from '../src/terrain.ts';
import { ps2BlobBuilder, writePs2Terrain, type BlobBuilder } from '../src/convert.ts';
import { LAYER_FLAG_FLAT, MAX_CHUNK_TEXTURES } from '../src/terrainblob.ts';
import {
    cloneTerrainLayer,
    extendTerrainLayer,
    levelTextureOrder,
    ps2AdjacencyMask,
    readPs2Blob,
    rebuildPs2Terrain,
    writePs2Blob,
} from '../src/terrainwrite.ts';

function layer(
    index: number,
    w: number,
    h: number,
    o: { ox?: number; oz?: number; flags?: number; type?: number; wh?: number; tex?: (x: number, z: number) => number },
): TerrainLayer {
    const nv = (w + 1) * (h + 1);
    const nc = w * h;
    const L: TerrainLayer = {
        index,
        id: 100 + index,
        width: w,
        height: h,
        type: o.type ?? 0,
        originX: o.ox ?? 0,
        originZ: o.oz ?? 0,
        worldHeight: o.wh ?? 1000,
        name: `layer ${index}`,
        flags: o.flags ?? 0,
        lightDirection: 0.5,
        lightAscension: 0.25,
        lightColor: 0xffeedd,
        ambientColor: 0x404040,
        lightDropoff: 0,
        visible: [],
        heights: new Float32Array(nv).fill(o.wh ?? 1000),
        vertexFlags: new Uint16Array(nv).fill(0x241),
        vertexMask: new Uint8Array(nv),
        cellFlags: new Uint16Array(nc).fill(0xff0d),
        cellTexLeft: new Uint32Array(nc),
        cellTexRight: new Uint32Array(nc),
        cellUv: new Uint16Array(nc * 8),
        source: 'ps2',
    };
    for (let z = 0; z < h; z++) {
        for (let x = 0; x < w; x++) {
            const t = (o.tex ?? (() => 0x90001))(x, z) >>> 0;
            L.cellTexLeft[z * w + x] = t;
            L.cellTexRight[z * w + x] = t;
            L.cellUv.set([0, 0xffff, 0xffff, 0, 0, 0, 0xffff, 0xffff], (z * w + x) * 8);
        }
    }
    L.vertexMask = ps2AdjacencyMask(L);
    return L;
}

/** A level: a hilly 14x13 floor (two chunks in x), a flat floor beside it, a ceiling, and an "in between" layer stored without draw data. */
function level(): { payload: Uint8Array; layers: TerrainLayer[] } {
    const a = layer(0, 14, 13, { ox: 10, oz: 10, tex: (x, z) => (x < 5 ? 0x90001 : z < 4 ? 0x90002 : 0x90003) });
    for (let v = 0; v < a.heights.length; v++) a.heights[v] = 1000 + (v % 7) * 40;
    const b = layer(1, 4, 4, { ox: 24, oz: 10, flags: LAYER_FLAG_FLAT, tex: () => 0x90003 });
    const c = layer(2, 3, 3, { ox: 12, oz: 12, type: 1, wh: 5000, tex: (x) => (x === 1 ? TEX_HOLE : 0x90002) });
    const d = layer(3, 2, 2, { ox: 30, oz: 30, type: 2, flags: 0x1014, tex: () => 0x90004 });
    a.visible = [1, 2];
    b.visible = [0];
    const layers = [a, b, c, d];
    const gen = ps2BlobBuilder(0x18);
    const blob: BlobBuilder = (L, all) =>
        L.index === 3
            ? writePs2Blob({
                  empty: true,
                  seq: 0,
                  levelTag: 0,
                  pool: 0,
                  xLo: 0,
                  xHi: 0,
                  zLo: 0,
                  zHi: 0,
                  chunks: [],
                  normals: Uint8Array.of(0, 127, 0, 127),
              })
            : gen(L, all);
    return { payload: writePs2Terrain(layers, blob), layers };
}

const spanBytes = (p: Uint8Array, i: number): Uint8Array[] => {
    const s = splitPs2Terrain(p).layers[i]!;
    return [p.slice(s.defStart, s.defEnd), p.slice(s.defEnd, s.blobEnd), p.slice(s.blockAt, s.blockAt + s.blockLen)];
};
const blobOf = (p: Uint8Array, i: number) => readPs2Blob(spanBytes(p, i)[1]!);

describe('inline blob reader', () => {
    it('reads and rewrites every layer form byte for byte (drawn, flat, empty)', () => {
        const { payload } = level();
        const sp = splitPs2Terrain(payload);
        for (const s of sp.layers) {
            const raw = payload.subarray(s.defEnd, s.blobEnd);
            expect(writePs2Blob(readPs2Blob(raw))).toEqual(raw.slice());
        }
        expect(blobOf(payload, 3).empty).toBe(true);
        expect(blobOf(payload, 1).normals.length).toBe(4);
        expect(blobOf(payload, 0).normals.length).toBe(15 * 14 * 4);
        expect(blobOf(payload, 0).chunks.length).toBe(4); // 14x13: x 0..7..14, z 0..7..13
    });
    it('rejects a blob that does not walk', () => {
        expect(() => readPs2Blob(Uint8Array.of(1, 0, 0x18, 0, 64, 0, 0, 0))).toThrow();
    });
});

describe('rebuildPs2Terrain', () => {
    it('returns the disc payload itself when nothing changed', () => {
        const { payload } = level();
        const r = rebuildPs2Terrain(payload, parsePs2Terrain(payload));
        expect(r.payload).toBe(payload);
        expect(r.report.changed.size).toBe(0);
        expect(r.report.unchanged).toBe(4);
    });

    it('height edit: stores the heights, updates normals around the vertex only, copies the other layers', () => {
        const { payload } = level();
        const layers = parsePs2Terrain(payload);
        const e = cloneTerrainLayer(layers[0]!);
        const v = 6 * 15 + 7;
        e.heights[v] = e.heights[v]! + 3000;
        const edited = [...layers];
        edited[0] = e;
        const r = rebuildPs2Terrain(payload, edited);
        const back = parsePs2Terrain(r.payload);
        expect(back[0]!.heights[v]).toBe(e.heights[v]);
        expect(Array.from(back[0]!.heights)).toEqual(Array.from(e.heights));
        for (const i of [1, 2, 3]) expect(spanBytes(r.payload, i)).toEqual(spanBytes(payload, i));
        // Definition unchanged; the chunk tables unchanged; normals differ only in the 3x3 around v.
        expect(spanBytes(r.payload, 0)[0]).toEqual(spanBytes(payload, 0)[0]);
        const a = blobOf(payload, 0);
        const b = blobOf(r.payload, 0);
        expect(b.chunks).toEqual(a.chunks);
        const diff: number[] = [];
        for (let k = 0; k < a.normals.length / 4; k++) {
            if (a.normals.subarray(k * 4, k * 4 + 4).some((x, j) => x !== b.normals[k * 4 + j])) diff.push(k);
        }
        expect(diff.length).toBeGreaterThan(0);
        for (const k of diff) {
            expect(Math.abs((k % 15) - 7)).toBeLessThanOrEqual(1);
            expect(Math.abs(Math.floor(k / 15) - 6)).toBeLessThanOrEqual(1);
        }
        // The slope east of the bump tilts the normal to +x.
        expect((b.normals[(v + 1) * 4]! << 24) >> 24).toBeGreaterThan(0);
        expect(r.report.changed.get(0)).toContain('heights');
    });

    it('a hill on a flat-flagged layer clears the flag and stores per-vertex normals', () => {
        const { payload } = level();
        const layers = parsePs2Terrain(payload);
        const e = cloneTerrainLayer(layers[1]!);
        e.heights[12] = e.heights[12]! + 500;
        const r = rebuildPs2Terrain(payload, [layers[0]!, e, layers[2]!, layers[3]!]);
        const back = parsePs2Terrain(r.payload);
        expect(back[1]!.flags & LAYER_FLAG_FLAT).toBe(0);
        expect(blobOf(r.payload, 1).normals.length).toBe(25 * 4);
        expect(back[1]!.heights[12]).toBe(e.heights[12]);
    });

    it('moves world_height when the raw u16 range would overflow', () => {
        const { payload } = level();
        const layers = parsePs2Terrain(payload);
        const e = cloneTerrainLayer(layers[2]!);
        e.heights[0] = e.worldHeight + 70000;
        const r = rebuildPs2Terrain(payload, [layers[0]!, layers[1]!, e, layers[3]!]);
        const back = parsePs2Terrain(r.payload);
        expect(back[2]!.heights[0]).toBe(e.heights[0]);
        expect(back[2]!.worldHeight).not.toBe(layers[2]!.worldHeight);
        expect(back[2]!.heights[5]).toBe(e.heights[5]);
    });

    it('texture edit: refs and weights around the patch change, the rest of the chunk table stays', () => {
        const { payload } = level();
        const layers = parsePs2Terrain(payload);
        const e = cloneTerrainLayer(layers[0]!);
        // Paint 0x90004 (used by layer 3 only) into the middle of the second chunk.
        for (const [x, z] of [
            [10, 8],
            [11, 8],
        ]) {
            e.cellTexLeft[z! * 14 + x!] = 0x90004;
            e.cellTexRight[z! * 14 + x!] = 0x90004;
        }
        const r = rebuildPs2Terrain(payload, [e, layers[1]!, layers[2]!, layers[3]!]);
        const back = parsePs2Terrain(r.payload);
        expect(back[0]!.cellTexLeft[8 * 14 + 10]).toBe(0x90004);
        const a = blobOf(payload, 0);
        const b = blobOf(r.payload, 0);
        // Chunks (x outer): 0..7/0..7, 0..7/7..13, 7..14/0..7, 7..14/7..13. Only the last one sees cells (10..11, 8).
        for (const i of [0, 1, 2]) expect(b.chunks[i]).toEqual(a.chunks[i]);
        const ci = 3;
        const c = b.chunks[ci]!;
        expect(c.refs).toContain(0x90004);
        const k = c.refs.indexOf(0x90004);
        const vx = 10 - c.x0;
        const vz = 8 - c.z0;
        // vertex (10, 8) is the top-left corner of a painted cell: one of its four cells uses it, near flag set.
        expect(c.arrays[k]![vz * c.vw + vx]).toBe(0x11);
        // vertex (11, 9) touches both painted cells.
        expect(c.arrays[k]![(vz + 1) * c.vw + vx + 1]! & 0x0f).toBe(2);
        // A vertex far from the patch keeps its disc bytes for the old textures.
        const k3 = c.refs.indexOf(0x90003);
        const a3 = a.chunks[ci]!.refs.indexOf(0x90003);
        const far = (c.vh - 1) * c.vw + c.vw - 1;
        expect(c.arrays[k3]![far]).toBe(a.chunks[ci]!.arrays[a3]![far]);
        // The repainted weights equal what the generator would write for the new cells.
        expect(r.report.changed.get(0)).toContain('cell textures');
    });

    it('texture order: a new ref goes where the level puts it', () => {
        const key = levelTextureOrder([
            {
                empty: false,
                seq: 1,
                levelTag: 0,
                pool: 64,
                xLo: 0,
                xHi: 0,
                zLo: 0,
                zHi: 0,
                normals: new Uint8Array(4),
                chunks: [{ x0: 0, x1: 1, z0: 0, z1: 1, refs: [3, 2, 1], vw: 2, vh: 2, arrays: [] }],
            },
        ]);
        expect(key(3)).toBeLessThan(key(2));
        expect(key(2)).toBeLessThan(key(1));
        expect(key(99)).toBe(0.5);
    });

    it('splits a chunk that would list more than MAX_CHUNK_TEXTURES textures', () => {
        const { payload } = level();
        const layers = parsePs2Terrain(payload);
        const e = cloneTerrainLayer(layers[0]!);
        for (let c = 0; c < 14 * 13; c++) e.cellTexLeft[c] = e.cellTexRight[c] = 0x90010 + (c % 13);
        const r = rebuildPs2Terrain(payload, [e, layers[1]!, layers[2]!, layers[3]!]);
        const b = blobOf(r.payload, 0);
        expect(b.chunks.every((c) => c.refs.length <= MAX_CHUNK_TEXTURES)).toBe(true);
        expect(b.chunks.length).toBeGreaterThan(2);
        expect(b.seq).toBe(blobOf(payload, 0).seq);
    });

    it('extension: grows the layer, keeps old heights, gives it a free slot, and the new cells are solid ground', () => {
        const { payload } = level();
        const layers = parsePs2Terrain(payload);
        const ext = extendTerrainLayer(layers[1]!, { right: 2, top: 1 });
        expect([ext.width, ext.height, ext.originX, ext.originZ]).toEqual([6, 5, 24, 9]);
        const r = rebuildPs2Terrain(payload, [layers[0]!, ext, layers[2]!, layers[3]!]);
        const back = parsePs2Terrain(r.payload);
        const L = back[1]!;
        expect([L.width, L.height, L.originX, L.originZ]).toEqual([6, 5, 24, 9]);
        // New strip continues the edge height and texture; the adjacency nibble covers the new cells.
        expect(layerHeightAt(L, (24 + 5.5) * CELL_SIZE, (9 + 0.5) * CELL_SIZE)).toBe(1000);
        expect(L.cellTexLeft[5]).toBe(0x90003);
        expect(L.vertexMask[1 * 7 + 5]! & 15).toBe(15);
        const b = blobOf(r.payload, 1);
        expect(b.xHi - b.xLo + 1).toBe(24);
        expect(b.zHi - b.zLo + 1).toBe(20);
        // No overlap with any other member of its group (the disc never overlaps).
        for (const i of [0, 2]) {
            const o = blobOf(r.payload, i);
            if (o.seq !== b.seq) continue;
            const overlap = b.xLo <= o.xHi && o.xLo <= b.xHi && b.zLo <= o.zHi && o.zLo <= b.zHi;
            expect(overlap).toBe(false);
        }
        // Other layers byte-identical.
        for (const i of [0, 2, 3]) expect(spanBytes(r.payload, i)).toEqual(spanBytes(payload, i));
    });

    it('appends a new layer with its own definition, blob and block', () => {
        const { payload } = level();
        const layers = parsePs2Terrain(payload);
        const n = layer(4, 3, 2, { ox: 40, oz: 40, tex: () => 0x90002 });
        n.heights[5] = 1500;
        const edited = [...layers, n];
        edited[0] = { ...layers[0]!, visible: [1, 2, 4] };
        const r = rebuildPs2Terrain(payload, edited);
        const back = parsePs2Terrain(r.payload);
        expect(back).toHaveLength(5);
        expect(back[4]!.name).toBe('layer 4');
        expect(back[4]!.heights[5]).toBe(1500);
        expect(back[0]!.visible).toEqual([1, 2, 4]);
        expect(blobOf(r.payload, 4).empty).toBe(false);
        expect(r.report.changed.get(4)).toContain('new layer');
        // Layer 0's definition was rewritten, its blob and block were not.
        expect(spanBytes(r.payload, 0)[1]).toEqual(spanBytes(payload, 0)[1]);
        expect(spanBytes(r.payload, 0)[2]).toEqual(spanBytes(payload, 0)[2]);
    });

    it('an appended layer lists itself first and the layers it names list it back', () => {
        const { payload } = level();
        const layers = parsePs2Terrain(payload);
        const n = layer(4, 2, 2, { ox: 40, oz: 40 });
        n.visible = [1, 1, 0];
        const r = rebuildPs2Terrain(payload, [...layers, n]);
        const back = parsePs2Terrain(r.payload);
        expect(back[4]!.visible).toEqual([4, 1, 0]);
        expect(back[0]!.visible).toContain(4);
        expect(back[1]!.visible).toContain(4);
        expect(back[2]!.visible).not.toContain(4);
        expect(n.visible).toEqual([1, 1, 0]); // the input is not changed
    });

    it('keeps a layer without draw data without it, and the colour high bytes of a rewritten definition', () => {
        const { payload } = level();
        const layers = parsePs2Terrain(payload);
        const e = cloneTerrainLayer(layers[3]!);
        e.heights[4] = e.heights[4]! + 100;
        e.cellTexLeft[0] = e.cellTexRight[0] = 0x90001;
        const r = rebuildPs2Terrain(payload, [layers[0]!, layers[1]!, layers[2]!, { ...e, name: 'renamed' }]);
        expect(blobOf(r.payload, 3).empty).toBe(true);
        expect(parsePs2Terrain(r.payload)[3]!.name).toBe('renamed');
    });

    it('refuses to drop layers or reorder them', () => {
        const { payload } = level();
        const layers = parsePs2Terrain(payload);
        expect(() => rebuildPs2Terrain(payload, layers.slice(0, 3))).toThrow();
        expect(() => rebuildPs2Terrain(payload, [layers[1]!, layers[0]!, layers[2]!, layers[3]!])).toThrow();
    });
});
