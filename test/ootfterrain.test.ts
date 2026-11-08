// Synthetic fixtures only; no game bytes.
import { describe, expect, it } from 'vitest';
import { SrscReader, decodeTxd } from '../src/index.ts';
import { writePs2Srsc } from '../src/ootfcontainer.ts';
import { buildPs2Txd, encodePs2Texture } from '../src/ootftex.ts';
import {
    TerrainTextureBuilder,
    buildTerrainPoolTxd,
    convertTerrainTextures,
    findSplatDbIndex,
} from '../src/ootfterrain.ts';
import { planTerrainSlots } from '../src/terrainblob.ts';
import type { TerrainLayer } from '../src/terrain.ts';
import type { PcFileSource, PcLevel } from '../src/pc.ts';

const u32 = (n: number): number[] => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];
const u16 = (n: number): number[] => [n & 255, (n >> 8) & 255];

/** 24 bpp PC texture, one flat colour. */
function pcTex24(w: number, h: number, rgb: [number, number, number]): Uint8Array {
    const data: number[] = [];
    for (let i = 0; i < w * h; i++) data.push(...rgb);
    return Uint8Array.from([
        ...u32(w), ...u32(h), ...u32(w * 3), ...u16(24), ...u16(0), 0, 0, ...u32(0xffffffff),
        ...u32(0), ...u32(0), ...u32(0), 10, 0, ...u16(0), ...u32(0), ...u32(1), ...u32(0), ...u32(data.length),
        ...data,
    ]); // prettier-ignore
}

describe('terrain textures', () => {
    const pcTxd = writePs2Srsc([
        { type: 0x40, id: 5, sub: 0, data: pcTex24(32, 32, [200, 10, 10]) },
        { type: 0x40, id: 6, sub: 0, data: pcTex24(32, 32, [10, 200, 10]) },
        { type: 0x40, id: 7, sub: 0, data: pcTex24(32, 32, [12, 190, 12]) },
    ]);
    const src: PcFileSource = {
        read: async (p) => (p.toLowerCase() === 'lvl/lvl.txd' ? pcTxd : null),
        list: async () => [],
    };
    const pc = {
        path: 'Lvl/Lvl.lvl',
        header: { dependencies: [{ dbIndex: 24, path: { text: 'Lvl_splats' } }] },
        terrain: [{ cellTexLeft: new Uint32Array([5, 6, 6, 7, 0xffffffff, 0xfffffffe, 99]) }],
    } as unknown as PcLevel;
    const base = buildPs2Txd([
        { id: 3, body: encodePs2Texture({ width: 8, height: 8, rgba: new Uint8Array(256).fill(255) }).body },
    ]);

    it('appends converted textures to the target TXD under fresh ids', async () => {
        const t = await convertTerrainTextures(pc, src, base, 24, { minSize: 0 });
        expect(t.report.converted).toBe(3);
        expect(t.report.skipped.size).toBe(1); // id 99 does not exist
        const r = await SrscReader.fromBytes(t.txd);
        const ids = r.entries.filter((e) => e.type === 0x40).map((e) => e.id);
        expect(ids[0]).toBe(3);
        expect(new Set(ids).size).toBe(ids.length);
        const m5 = t.mapTexture((0 << 16) | 5, pc)!;
        expect(m5 >>> 16).toBe(24);
        expect(ids).toContain(m5 & 0xffff);
        const body = await r.readRaw(r.find(0x40, m5 & 0xffff)!);
        const img = decodeTxd(body);
        expect(img.bpp).toBe(8);
        expect(img.width).toBe(32);
        expect(Array.from(img.rgba.subarray(0, 3))).toEqual([200, 10, 10]);
        expect(t.mapTexture(99, pc)).toBeNull();
        expect(t.mapTexture(0xffffffff, pc)).toBeNull();
    });

    it('bounds detailed terrain memory while retaining dimensions and an explicit truecolor override', async () => {
        const pixels = pcTex24(32, 32, [0, 0, 0]);
        for (let i = 0; i < 1024; i++) {
            pixels[54 + i * 3] = (i % 32) * 8;
            pixels[55 + i * 3] = Math.floor(i / 32) * 8;
            pixels[56 + i * 3] = (i * 17) % 256;
        }
        const rich = writePs2Srsc([{ type: 0x40, id: 5, sub: 0, data: pixels }]);
        const richSource: PcFileSource = { read: async () => rich, list: async () => [] };
        const indexed = await convertTerrainTextures(pc, richSource, base, 24, { minSize: 0 });
        const indexedReader = await SrscReader.fromBytes(indexed.txd);
        const body = await indexedReader.readRaw(indexedReader.find(0x40, indexed.mapTexture(5, pc)! & 0xffff)!);
        expect(decodeTxd(body).bpp).toBe(8);
        expect(decodeTxd(body).width).toBe(32);
        expect(body.length).toBeLessThan(32 * 32 * 4);
        const t = await convertTerrainTextures(pc, richSource, base, 24, {
            minSize: 0,
            texture: { mode: 'truecolor', maxTruecolorPixels: Infinity },
        });
        const r = await SrscReader.fromBytes(t.txd);
        const ref = t.mapTexture(5, pc)!;
        const img = decodeTxd(await r.readRaw(r.find(0x40, ref & 0xffff)!));
        expect(img.bpp).toBe(32);
        expect(img.width).toBe(32);
        expect(Array.from(img.rgba.subarray(0, 3))).toEqual([0, 248, 224]);
    });

    it('reduces to the most used textures by nearest colour', async () => {
        const t = await convertTerrainTextures(pc, src, base, 24, { maxTextures: 2 });
        expect(t.report.converted).toBe(2);
        expect(t.report.reduced).toBe(1);
        // 7 is nearly 6's colour, so it takes 6's texture
        expect(t.mapTexture(7, pc)).toBe(t.mapTexture(6, pc));
    });

    it('finds the splat dependency', () => {
        expect(findSplatDbIndex(pc.header)).toBe(24);
    });
});

describe('terrain far textures (the level splat TXD)', () => {
    const layer = (index: number, width: number, height: number, originX: number, cells: number[]): TerrainLayer =>
        ({
            index,
            width,
            height,
            originX,
            originZ: 0,
            cellTexLeft: Uint32Array.from(cells),
        }) as unknown as TerrainLayer;
    const colors = new Map<number, [number, number, number]>([
        [(9 << 16) | 1001, [200, 40, 40]],
        [(9 << 16) | 1002, [40, 200, 40]],
    ]);
    const A = (9 << 16) | 1001;
    const B = (9 << 16) | 1002;
    // 3 x 2 cells with a hole, and a 2 x 1 layer beside it: one group, slots shelf-packed side by side.
    const layers = [layer(0, 3, 2, 0, [A, B, A, B, 0xffffffff, A]), layer(1, 2, 1, 3, [B, 0xfffffffe])];

    it('writes one pool texture per group at the blob slots, 4 texels per cell, holes and spare texels in the group mean', async () => {
        const plan = planTerrainSlots(layers);
        const r = await SrscReader.fromBytes(buildTerrainPoolTxd(layers, (ref) => colors.get(ref) ?? null));
        const texs = r.entries.filter((e) => e.type === 0x40);
        expect(texs.map((e) => e.id)).toEqual([...new Set([...plan.values()].map((s) => s.seq))].sort((a, b) => a - b));
        expect(texs.length).toBe(1);
        const body = await r.readRaw(texs[0]!);
        const dv = new DataView(body.buffer, body.byteOffset, body.byteLength);
        const img = decodeTxd(body, { upright: false });
        const pool = plan.get(0)!.pool;
        expect([img.width, img.height, img.bpp]).toEqual([pool, pool, 8]);
        // disc far-texture header: opaque (flags 0), no family number at +40, 256.0 at +44
        expect([dv.getUint32(16, true), dv.getUint32(40, true), dv.getFloat32(44, true)]).toEqual([0, 0, 256]);
        const at = (x: number, z: number): number[] =>
            Array.from(img.rgba.subarray((z * pool + x) * 4, (z * pool + x) * 4 + 3));
        const s0 = plan.get(0)!;
        const s1 = plan.get(1)!;
        // cell (cx, cz) of layer 0 covers texels xLo + 4cx .. +3, zLo + 4cz .. +3 (stored row order)
        expect(at(s0.xLo + 0, s0.zLo + 0)).toEqual([200, 40, 40]);
        expect(at(s0.xLo + 4 + 3, s0.zLo + 3)).toEqual([40, 200, 40]);
        expect(at(s0.xLo + 4 * 2 + 1, s0.zLo + 4 + 2)).toEqual([200, 40, 40]);
        expect(at(s1.xLo + 2, s1.zLo + 1)).toEqual([40, 200, 40]);
        // the hole (layer 0 cell 1,1), the invisible cell (layer 1 cell 1,0) and the unused pool corner: group mean of 6 cells
        const mean = [Math.round((3 * 200 + 3 * 40) / 6), Math.round((3 * 40 + 3 * 200) / 6), 40];
        expect(at(s0.xLo + 4 + 1, s0.zLo + 4 + 1)).toEqual(mean);
        expect(at(s1.xLo + 4 + 1, s1.zLo + 1)).toEqual(mean);
        expect(at(pool - 1, pool - 1)).toEqual(mean);
        for (let i = 0; i < pool * pool; i++) expect(img.rgba[i * 4 + 1]).not.toBe(100); // never the disc's magenta filler
    });

    it('gives the mean colour of converted and template terrain textures by cell ref', async () => {
        const red = new Uint8Array(8 * 8 * 4);
        for (let i = 0; i < 64; i++) red.set([180, 20, 30, 255], i * 4);
        const base = buildPs2Txd([{ id: 3, body: encodePs2Texture({ width: 8, height: 8, rgba: red }).body }]);
        const src: PcFileSource = { read: async () => null, list: async () => [] };
        const b = await TerrainTextureBuilder.create(src, base, 9);
        expect(b.meanOfRef((9 << 16) | 3)).toEqual([180, 20, 30]);
        expect(b.meanOfRef((9 << 16) | 4)).toBeNull();
    });
});
