// Synthetic layers only; no game bytes.
import { describe, expect, it } from 'vitest';
import { TEX_HOLE, TEX_INVISIBLE } from '../src/terrain.ts';
import { readPs2Blob, writePs2Blob } from '../src/terrainwrite.ts';
import type { TerrainLayer } from '../src/terrain.ts';
import { limitLayerTextures, ps2BlobBuilder, ps2BlobFor, ps2LevelTag, writePs2Terrain } from '../src/convert.ts';
import { LAYER_FLAG_FLAT, MAX_CHUNK_TEXTURES, buildPs2TerrainBlob, planTerrainSlots, ps2ChunkSplit } from '../src/terrainblob.ts';

function layer(w: number, h: number, flags: number, tex: (x: number, z: number) => number): TerrainLayer {
    const nv = (w + 1) * (h + 1);
    const nc = w * h;
    const L: TerrainLayer = {
        index: 0,
        id: 1,
        width: w,
        height: h,
        type: 0,
        originX: 0,
        originZ: 0,
        worldHeight: 0,
        name: 'synthetic',
        flags,
        lightDirection: 0,
        lightAscension: 0,
        lightColor: 0,
        ambientColor: 0,
        lightDropoff: 0,
        visible: [],
        heights: new Float32Array(nv),
        vertexFlags: new Uint16Array(nv),
        vertexMask: new Uint8Array(nv),
        cellFlags: new Uint16Array(nc),
        cellTexLeft: new Uint32Array(nc),
        cellTexRight: new Uint32Array(nc),
        cellUv: new Uint16Array(nc * 8),
        source: 'ps2',
    };
    for (let z = 0; z < h; z++) {
        for (let x = 0; x < w; x++) {
            L.cellTexLeft[z * w + x] = tex(x, z) >>> 0;
            L.cellTexRight[z * w + x] = tex(x, z) >>> 0;
        }
    }
    return L;
}

const u32 = (b: Uint8Array, o: number): number => new DataView(b.buffer, b.byteOffset, b.length).getUint32(o, true);

describe('ps2ChunkSplit', () => {
    it('splits like the shipped layers', () => {
        expect(ps2ChunkSplit(4)).toEqual([0, 4]);
        expect(ps2ChunkSplit(12)).toEqual([0, 12]);
        expect(ps2ChunkSplit(25)).toEqual([0, 9, 18, 25]);
        expect(ps2ChunkSplit(23)).toEqual([0, 12, 23]);
        expect(ps2ChunkSplit(14)).toEqual([0, 7, 14]);
    });
});

describe('buildPs2TerrainBlob', () => {
    it('writes the flat single-chunk layout', () => {
        const L = layer(4, 5, LAYER_FLAG_FLAT, () => 0x90219);
        const b = buildPs2TerrainBlob(L, { seq: 1, levelTag: 0x0c });
        expect(b.length).toBe(102);
        expect([...b.subarray(0, 4)]).toEqual([1, 0, 0x0c, 0]);
        expect([u32(b, 4), u32(b, 8), u32(b, 12), u32(b, 16), u32(b, 20), u32(b, 24)]).toEqual([0x40, 0, 15, 0, 19, 1]);
        // chunk header: x0 x1 z0 z1 ntex ref vw vh n
        expect([28, 32, 36, 40, 44, 48, 52, 56, 60].map((o) => u32(b, o))).toEqual([0, 4, 0, 5, 1, 0x90219, 5, 6, 1]);
        const rows = [0, 1, 2, 3, 4, 5].map((r) => [...b.subarray(64 + r * 5, 64 + r * 5 + 5)]);
        expect(rows[0]).toEqual([0x11, 0x12, 0x12, 0x12, 0x01]);
        expect(rows[1]).toEqual([0x12, 0x14, 0x14, 0x14, 0x02]);
        expect(rows[4]).toEqual([0x12, 0x14, 0x14, 0x14, 0x02]);
        expect(rows[5]).toEqual([0x01, 0x02, 0x02, 0x02, 0x01]);
        expect([...b.subarray(94)]).toEqual([0, 0, 0, 0, 0, 0x7f, 0, 0x7f]);
    });

    it('splits a 25x25 layer into 9 chunks and adds 4 bytes per vertex of normals', () => {
        const L = layer(25, 25, 0, () => 0x90219);
        const b = buildPs2TerrainBlob(L);
        expect(u32(b, 24)).toBe(9);
        expect(u32(b, 4)).toBe(128);
        // up normals for a flat height field, after the 4 zero bytes
        const tail = b.subarray(b.length - (676 * 4 + 4));
        expect([...tail.subarray(0, 8)]).toEqual([0, 0, 0, 0, 0, 127, 0, 127]);
    });

    it('lists one array per distinct texture and skips holes', () => {
        const A = 0x90001;
        const B = 0x90002;
        const L = layer(3, 3, 0, (x, z) => (x === 1 && z === 1 ? B : x === 2 && z === 2 ? TEX_HOLE : A));
        const sorted = buildPs2TerrainBlob(L, { textureOrder: (r) => -r });
        expect(u32(sorted, 28 + 16)).toBe(2);
        expect([u32(sorted, 28 + 20), u32(sorted, 28 + 24)]).toEqual([B, A]);
        const natural = buildPs2TerrainBlob(L);
        expect([u32(natural, 28 + 20), u32(natural, 28 + 24)]).toEqual([A, B]);
        // vertex (1,1): all four cells around it are A except the down-right one (B)
        const arrA = 28 + 20 + 8 + 12;
        const at = (v: number): number => natural[arrA + v]!;
        expect(at(1 * 4 + 1) & 15).toBe(3);
        expect(at(1 * 4 + 1) & 0x10).toBe(0x10);
    });

    it('cuts a chunk with more than 10 textures into smaller chunks that cover the layer once', () => {
        const L = layer(24, 24, 0, (x, z) => 0x90000 + ((x * 7 + z * 13) % 40));
        const b = buildPs2TerrainBlob(L);
        const n = u32(b, 24);
        let p = 28;
        const rects: number[][] = [];
        for (let i = 0; i < n; i++) {
            const [x0, x1, z0, z1, nt] = [0, 4, 8, 12, 16].map((k) => u32(b, p + k)) as [number, number, number, number, number];
            expect(nt).toBeLessThanOrEqual(MAX_CHUNK_TEXTURES);
            const vw = u32(b, p + 20 + 4 * nt);
            const vh = u32(b, p + 24 + 4 * nt);
            expect([vw, vh]).toEqual([x1 - x0 + 1, z1 - z0 + 1]);
            expect(u32(b, p + 28 + 4 * nt)).toBe(nt);
            rects.push([x0, x1, z0, z1]);
            p += 32 + 4 * nt + nt * vw * vh;
        }
        expect(n).toBeGreaterThan(4);
        const cover = new Uint8Array(24 * 24);
        for (const [x0, x1, z0, z1] of rects as [number, number, number, number][])
            for (let z = z0; z < z1; z++) for (let x = x0; x < x1; x++) cover[z * 24 + x] = (cover[z * 24 + x] ?? 0) + 1;
        expect(cover.every((c) => c === 1)).toBe(true);
        expect(buildPs2TerrainBlob(L, { maxChunkTextures: 0 }).length).toBeLessThan(b.length);
    });

    it('writes a layer without one drawn cell in the empty form, as the disc does', () => {
        // Chunks that all list no texture leave the engine a terrain section with zero texture pages: it is linked into the
        // section LRU but never unlinked, and a quick load later hangs in the eviction walk.
        const holes = layer(25, 25, 0, (x) => (x % 2 ? TEX_HOLE : TEX_INVISIBLE));
        holes.heights.forEach((_, i) => (holes.heights[i] = (i % 7) * 64));
        const b = buildPs2TerrainBlob(holes, { seq: 3, levelTag: 0x18, slot: { xLo: 0, zLo: 0, pool: 128 } });
        const blob = readPs2Blob(b);
        expect(blob.empty).toBe(true);
        expect(blob.chunks).toHaveLength(0);
        expect(blob.normals.length).toBe(26 * 26 * 4);
        expect(writePs2Blob(blob)).toEqual(b);
        // same normals as the drawn form of the same heights
        const drawn = readPs2Blob(buildPs2TerrainBlob({ ...holes, cellTexLeft: holes.cellTexLeft.map(() => 0x90001) }));
        expect(blob.normals).toEqual(drawn.normals);
        const flat = readPs2Blob(ps2BlobBuilder(0x18)(layer(4, 4, LAYER_FLAG_FLAT, () => TEX_HOLE)));
        expect(flat.empty).toBe(true);
        expect([...flat.normals]).toEqual([0, 0x7f, 0, 0x7f]);
        // one drawn cell is enough for the chunked form; its other chunks may list no texture (the disc has such chunks)
        const one = layer(25, 25, 0, (x, z) => (x === 0 && z === 0 ? 0x90001 : TEX_HOLE));
        const c = readPs2Blob(buildPs2TerrainBlob(one));
        expect(c.empty).toBe(false);
        expect(c.chunks.filter((k) => k.refs.length > 0)).toHaveLength(1);
        expect(c.chunks.length).toBe(9);
    });

    it('does not mutate the layer and is deterministic', () => {
        const L = layer(6, 6, 0, (x) => 0x90000 + (x % 2));
        const before = L.cellTexLeft.slice();
        const a = buildPs2TerrainBlob(L);
        expect(buildPs2TerrainBlob(L)).toEqual(a);
        expect(L.cellTexLeft).toEqual(before);
    });

    it('a lone converted layer gets group 1 and the template level tag', () => {
        const A = layer(3, 3, 0, () => 0x90001);
        const B = { ...layer(2, 2, 0, () => 0x90001), index: 5 };
        for (const L of [A, B]) {
            const b = ps2BlobFor(L);
            expect(b[0]! | (b[1]! << 8)).toBe(1);
            expect(b[2]! | (b[3]! << 8)).toBe(0x18);
        }
        const c = ps2BlobBuilder(0x0c)(B);
        expect(c[2]).toBe(0x0c);
    });

    it('planTerrainSlots packs layers into groups of one pool without overlap', () => {
        const layers = Array.from({ length: 40 }, (_, i) => ({ ...layer(12, 12, 0, () => 0x90001), index: i, originX: i % 8, originZ: (i / 8) | 0 }));
        const plan = planTerrainSlots(layers);
        const bySeq = new Map<number, { x0: number; x1: number; z0: number; z1: number }[]>();
        for (const L of layers) {
            const s = plan.get(L.index)!;
            expect(s.xLo + 48).toBeLessThanOrEqual(s.pool);
            expect(s.zLo + 48).toBeLessThanOrEqual(s.pool);
            const list = bySeq.get(s.seq) ?? [];
            for (const r of list) expect(s.xLo >= r.x1 || s.xLo + 48 <= r.x0 || s.zLo >= r.z1 || s.zLo + 48 <= r.z0).toBe(true);
            list.push({ x0: s.xLo, x1: s.xLo + 48, z0: s.zLo, z1: s.zLo + 48 });
            bySeq.set(s.seq, list);
        }
        expect(bySeq.size).toBeGreaterThan(1);
        expect(Math.max(...[...bySeq.values()].map((l) => l.length))).toBeLessThanOrEqual(25);
    });

    it('limitLayerTextures keeps the most used textures and fills the rest from the nearest kept cell', () => {
        const t = new Uint32Array(100);
        for (let i = 0; i < 100; i++) t[i] = 0x90000 + (i % 10) + (i < 50 ? 0 : 0);
        t[3] = TEX_HOLE;
        limitLayerTextures(t, 10, 10, 4);
        expect(new Set([...t].filter((x) => x !== TEX_HOLE)).size).toBeLessThanOrEqual(4);
        expect(t[3]).toBe(TEX_HOLE);
    });

    it('reads the level tag back out of a written layer table', () => {
        const payload = writePs2Terrain([layer(3, 3, 0, () => 0x90001)], ps2BlobBuilder(0x21));
        expect(ps2LevelTag(payload)).toBe(0x21);
    });
});
