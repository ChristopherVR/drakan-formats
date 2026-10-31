// Synthetic terrain fixtures only; no game bytes.
import { zlibSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import {
    CELL_SIZE,
    TEX_HOLE,
    TerrainError,
    layerHeightAt,
    parsePcTerrain,
    parsePs2Terrain,
    ps2TerrainBlockSize,
    terrainHeightAt,
} from '../src/index.ts';

class W {
    b: number[] = [];
    u16(n: number): this {
        this.b.push(n & 255, (n >> 8) & 255);
        return this;
    }
    u32(n: number): this {
        this.u16(n & 0xffff).u16(n >>> 16);
        return this;
    }
    f32(n: number): this {
        const d = new DataView(new ArrayBuffer(4));
        d.setFloat32(0, n, true);
        for (let i = 0; i < 4; i++) this.b.push(d.getUint8(i));
        return this;
    }
    bytes(a: ArrayLike<number>): this {
        for (let i = 0; i < a.length; i++) this.b.push(a[i]!);
        return this;
    }
    get u8(): Uint8Array {
        return Uint8Array.from(this.b);
    }
}

interface LayerSpec {
    w: number;
    h: number;
    ox: number;
    oz: number;
    wh: number;
    name: string;
    /** raw biased heights, (w+1)*(h+1) */
    raw: number[];
    tex: number[];
    flags: number[];
}

function def(s: LayerSpec, id: number): W {
    const w = new W();
    w.u32(id).u32(s.w).u32(s.h).u32(0).u32(s.ox).u32(s.oz).f32(s.wh);
    const name = Uint8Array.from([...s.name].map((c) => c.charCodeAt(0)).concat([0]));
    w.u16(name.length).bytes(name);
    w.u32(0).f32(0).f32(0).u32(0xffffff).u32(0x808080).u32(0).u32(0); // flags, light dir/asc, colours, dropoff, visible 0
    return w;
}

const UV = [0, 0xffff, 0xffff, 0, 0, 0, 0xffff, 0xffff];

function ps2Block(s: LayerSpec): Uint8Array {
    const w = new W();
    for (const h of s.raw) w.u16(0).u16(15).u16(h);
    for (let c = 0; c < s.w * s.h; c++) {
        w.u16(s.flags[c]!).u32(s.tex[c]!);
        for (const u of UV) w.u16(u);
    }
    return w.u8;
}

function pcBlock(s: LayerSpec): Uint8Array {
    const w = new W();
    for (const h of s.raw) w.bytes([0, 1]).u16(h);
    for (let c = 0; c < s.w * s.h; c++) {
        w.u16(s.flags[c]!)
            .u32(s.tex[c]!)
            .u32(s.tex[c]! + 1);
        for (const u of UV) w.u16(u);
    }
    return w.u8;
}

function ps2File(layers: LayerSpec[], junk: (i: number) => number[]): Uint8Array {
    const w = new W().u32(layers.length);
    layers.forEach((s, i) => w.bytes(def(s, 100 + i).u8).bytes(junk(i)));
    w.u32(1);
    for (const s of layers) {
        const z = zlibSync(ps2Block(s));
        w.u32(z.length).bytes(z);
    }
    return w.u8;
}

const flat = (w: number, h: number, v: number): number[] => new Array((w + 1) * (h + 1)).fill(v);
const L1: LayerSpec = {
    w: 2,
    h: 2,
    ox: 10,
    oz: 20,
    wh: 1000,
    name: 'layer a',
    raw: [0x8000, 0x8000, 0x8000, 0x8000, 0x8100, 0x8000, 0x8000, 0x8000, 0x8000],
    tex: [0x90001, 0x90001, TEX_HOLE, 0x90002],
    flags: [0, 1, 0, 0],
};
const L2: LayerSpec = {
    w: 3,
    h: 1,
    ox: 0,
    oz: 0,
    wh: 0,
    name: 'layer b',
    raw: flat(3, 1, 0x8010),
    tex: [0x90001, 0x90001, 0x90001, 0x90001],
    flags: [0, 0, 0, 0],
};

describe('PS2 terrain', () => {
    it('decodes heights, cells, UVs and finds defs across variable inline data', () => {
        // Different junk lengths between definitions, including bytes that look nothing like a definition.
        const file = ps2File([L1, L2], (i) => new Array(8 + i * 37).fill(0x7f));
        const layers = parsePs2Terrain(file);
        expect(layers).toHaveLength(2);
        const a = layers[0]!;
        expect([a.width, a.height, a.originX, a.originZ, a.worldHeight, a.name]).toEqual([
            2,
            2,
            10,
            20,
            1000,
            'layer a',
        ]);
        expect(a.heights[4]).toBe(1000 + 0x100 * 2);
        expect(a.heights[0]).toBe(1000);
        expect(Array.from(a.cellFlags)).toEqual([0, 1, 0, 0]);
        expect(a.cellTexLeft[2]).toBe(TEX_HOLE);
        expect(Array.from(a.cellUv.subarray(0, 8))).toEqual(UV);
        expect(layers[1]!.heights.every((h) => h === 0x10 * 2)).toBe(true);
        expect(a.source).toBe('ps2');
    });
    it('rejects a payload with no data section', () => {
        expect(() => parsePs2Terrain(new W().u32(1).bytes(def(L2, 1).u8).u8)).toThrow(TerrainError);
    });
    it('block size formula', () => {
        expect(ps2TerrainBlockSize(3, 1)).toBe(8 * 6 + 3 * 22);
        expect(ps2Block(L2).length).toBe(ps2TerrainBlockSize(3, 1));
    });
});

describe('PC terrain (OpenDrakan layout)', () => {
    it('decodes definitions then zlib blocks', () => {
        const w = new W().u32(1).bytes(def(L1, 7).u8).u32(1);
        const z = zlibSync(pcBlock(L1));
        w.u32(z.length).bytes(z);
        const [a] = parsePcTerrain(w.u8);
        expect(a!.heights[4]).toBe(1000 + 0x200);
        expect(a!.cellTexRight[0]).toBe(0x90002);
        expect(a!.source).toBe('pc');
    });
});

describe('height queries', () => {
    const [a] = parsePs2Terrain(ps2File([L1], () => []));
    it('matches vertices at corners and interpolates inside a cell', () => {
        const x = (10 + 1) * CELL_SIZE;
        const z = (20 + 1) * CELL_SIZE;
        expect(layerHeightAt(a!, x, z)).toBeCloseTo(1000 + 0x200, 3); // raised centre vertex
        expect(layerHeightAt(a!, 10 * CELL_SIZE, 20 * CELL_SIZE)).toBeCloseTo(1000);
        // cell 0 is split b-c: the left triangle (a b c) is flat at 1000, the right one (b c d) rises to d = 1512
        expect(layerHeightAt(a!, (10 + 0.25) * CELL_SIZE, (20 + 0.25) * CELL_SIZE)).toBeCloseTo(1000, 3);
        expect(layerHeightAt(a!, (10 + 0.75) * CELL_SIZE, (20 + 0.75) * CELL_SIZE)).toBeCloseTo(1256, 3);
    });
    it('is NaN outside the layer and over holes', () => {
        expect(layerHeightAt(a!, 0, 0)).toBeNaN();
        expect(layerHeightAt(a!, 10.5 * CELL_SIZE, 21.5 * CELL_SIZE)).toBeNaN(); // cell 2 is a hole
    });
    it('picks the surface nearest nearY among stacked layers', () => {
        const hi: LayerSpec = { ...L1, wh: 5000, tex: [1, 1, 1, 1] };
        const layers = parsePs2Terrain(ps2File([L1, hi], () => new Array(8).fill(0)));
        const x = 10.1 * CELL_SIZE;
        const z = 20.1 * CELL_SIZE;
        expect(terrainHeightAt(layers, x, z, 1100)).toBeLessThan(2000);
        expect(terrainHeightAt(layers, x, z, 5200)).toBeGreaterThan(4000);
        expect(terrainHeightAt(layers, x, z)).toBeGreaterThan(4000); // highest floor without a hint
    });
});
