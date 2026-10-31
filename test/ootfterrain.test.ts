// Synthetic fixtures only; no game bytes.
import { describe, expect, it } from 'vitest';
import { SrscReader, decodeTxd } from '../src/index.ts';
import { writePs2Srsc } from '../src/ootfcontainer.ts';
import { buildPs2Txd, encodePs2Texture } from '../src/ootftex.ts';
import { convertTerrainTextures, findSplatDbIndex } from '../src/ootfterrain.ts';
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
    const base = buildPs2Txd([{ id: 3, body: encodePs2Texture({ width: 8, height: 8, rgba: new Uint8Array(256).fill(255) }).body }]);

    it('appends converted textures to the target TXD under fresh ids', async () => {
        const t = await convertTerrainTextures(pc, src, base, 24);
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
        expect(img.width).toBe(32);
        expect(Array.from(img.rgba.subarray(0, 3))).toEqual([200, 10, 10]);
        expect(t.mapTexture(99, pc)).toBeNull();
        expect(t.mapTexture(0xffffffff, pc)).toBeNull();
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
