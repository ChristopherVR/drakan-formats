// Synthetic layers only; no game bytes.
import { describe, expect, it } from 'vitest';
import { TEX_HOLE } from '../src/terrain.ts';
import type { TerrainLayer } from '../src/terrain.ts';
import { LAYER_FLAG_FLAT, buildPs2TerrainBlob, ps2ChunkSplit } from '../src/terrainblob.ts';

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

    it('does not mutate the layer and is deterministic', () => {
        const L = layer(6, 6, 0, (x) => 0x90000 + (x % 2));
        const before = L.cellTexLeft.slice();
        const a = buildPs2TerrainBlob(L);
        expect(buildPs2TerrainBlob(L)).toEqual(a);
        expect(L.cellTexLeft).toEqual(before);
    });
});
