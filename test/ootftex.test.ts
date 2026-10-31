// Synthetic fixtures only; no game bytes.
import { zlibSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { SrscReader, decodeTxd, parseModel } from '../src/index.ts';
import { OotfAssetBuilder } from '../src/ootfassets.ts';
import { buildDbText, parseDbText, writePs2Srsc } from '../src/ootfcontainer.ts';
import {
    OotfTextureError,
    buildPs2Txd,
    decodePcTexture,
    encodePs2Texture,
    parsePcPalette,
    quantizeRgba,
    resampleNearest,
} from '../src/ootftex.ts';
import type { PcFileSource, PcLevel } from '../src/pc.ts';

function u32(n: number): number[] {
    return [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];
}
function u16(n: number): number[] {
    return [n & 255, (n >> 8) & 255];
}

/** PC texture record (54-byte header as OpenDrakan Texture.cpp, verified on the OotF install). */
function pcTex(o: {
    w: number;
    h: number;
    bpp: number;
    data: number[];
    alphaBpp?: number;
    flags?: number;
    key?: number;
    zlib?: boolean;
}): Uint8Array {
    const payload = o.zlib ? Array.from(zlibSync(Uint8Array.from(o.data))) : o.data;
    return Uint8Array.from([
        ...u32(o.w),
        ...u32(o.h),
        ...u32((o.w * o.bpp) >> 3),
        ...u16(o.bpp),
        ...u16(o.alphaBpp ?? 0),
        0,
        0,
        ...u32(o.key ?? 0xffffffff),
        ...u32(0), // mip
        ...u32(0), // alternate
        ...u32(0), // bump
        10, // fps
        o.flags ?? 0,
        ...u16(0),
        ...u32(0), // material
        ...u32(1), // usage
        ...u32(o.zlib ? 1 : 0),
        ...u32(payload.length),
        ...payload,
    ]);
}

const palette = (cols: number[][]): Uint8Array =>
    Uint8Array.from([...u16(cols.length), ...cols.flatMap(([r, g, b]) => [r!, g!, b!, 0])]);

describe('PC texture decode', () => {
    it('decodes 8 bpp with a palette, a colour key and zlib', () => {
        const pal = parsePcPalette(
            palette([
                [0, 0, 0],
                [255, 0, 255],
                [10, 20, 30],
            ]),
        );
        const rec = pcTex({ w: 2, h: 2, bpp: 8, data: [0, 1, 2, 2], key: 0xff00ff, zlib: true });
        const { info, image } = decodePcTexture(rec, pal);
        expect(info).toMatchObject({ width: 2, height: 2, bpp: 8, colorKey: 0xff00ff, compression: 1 });
        expect(Array.from(image.rgba)).toEqual([0, 0, 0, 255, 255, 0, 255, 0, 10, 20, 30, 255, 10, 20, 30, 255]);
    });

    it('decodes the 16 bpp variants', () => {
        // 565: pure red RRRRRGGG GGGBBBBB = 0xF800
        const a = decodePcTexture(pcTex({ w: 1, h: 1, bpp: 16, data: u16(0xf800) }), null).image.rgba;
        expect(Array.from(a)).toEqual([255, 0, 0, 255]);
        // 1:5:5:5 with alpha: A RRRRR GGGGG BBBBB, green + alpha set
        const b = decodePcTexture(pcTex({ w: 1, h: 1, bpp: 16, data: u16(0x83e0), alphaBpp: 1, flags: 2 }), null).image
            .rgba;
        expect(Array.from(b)).toEqual([0, 255, 0, 255]);
        // 4:4:4:4: AAAA RRRR GGGG BBBB
        const c = decodePcTexture(pcTex({ w: 1, h: 1, bpp: 16, data: u16(0x8f00), alphaBpp: 4, flags: 2 }), null).image
            .rgba;
        expect(Array.from(c)).toEqual([255, 0, 0, 136]);
    });

    it('rejects what it cannot read', () => {
        expect(() => decodePcTexture(pcTex({ w: 1, h: 1, bpp: 8, data: [0] }), null)).toThrow(OotfTextureError);
        expect(() => decodePcTexture(pcTex({ w: 1, h: 1, bpp: 8, data: [0], flags: 1 }), new Uint8Array(3))).toThrow(
            /alpha map/,
        );
        expect(() => decodePcTexture(new Uint8Array(10), null)).toThrow(OotfTextureError);
    });
});

describe('PS2 texture encode', () => {
    const img = (w: number, h: number, f: (x: number, y: number) => number[]) => {
        const rgba = new Uint8Array(w * h * 4);
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) rgba.set(f(x, y), (y * w + x) * 4);
        return { width: w, height: h, rgba };
    };

    it('writes few-colour images as 8 bpp the PS2 decoder reads back exactly', () => {
        const src = img(16, 8, (x) => (x < 8 ? [200, 10, 10, 255] : [0, 90, 255, 255]));
        const t = encodePs2Texture(src);
        expect(t).toMatchObject({ width: 16, height: 8, bpp: 8, hasAlpha: false, lossy: false });
        const d = decodeTxd(t.body, { upright: false });
        expect(d).toMatchObject({ width: 16, height: 8, bpp: 8, paletteKind: 1, flags: 0 });
        // palette alpha 0x7f decodes to 254 (the disc value)
        expect(Array.from(d.rgba.slice(0, 4))).toEqual([200, 10, 10, 254]);
        expect(Array.from(d.rgba.slice(8 * 4, 8 * 4 + 3))).toEqual([0, 90, 255]);
    });

    it('keeps a colour-key hole transparent in an 8 bpp palette', () => {
        const t = encodePs2Texture(img(8, 8, (x) => (x === 0 ? [0, 0, 0, 0] : [1, 2, 3, 255])));
        expect(t.hasAlpha).toBe(true);
        const d = decodeTxd(t.body, { upright: false });
        expect(d.rgba[3]).toBe(0);
        expect(d.rgba[7]).toBe(254);
        expect(t.body[37]).toBe(2); // alpha flag byte
    });

    it('uses 16 bpp for photo-like images and 8 bpp with graded alpha otherwise', () => {
        const photo = img(32, 32, (x, y) => [x * 8, y * 8, (x * y) & 255, 255]);
        const t = encodePs2Texture(photo);
        expect(t.bpp).toBe(16);
        const d = decodeTxd(t.body, { upright: false });
        expect(d.flags).toBe(1);
        expect(d.rgba[0]).toBe(0);
        expect(d.rgba[(5 + 3 * 32) * 4]).toBe(Math.floor((((5 * 8) >> 3) * 255) / 31));
        const soft = img(32, 32, (x, y) => [x * 8, y * 8, 0, 40 + x * 6]);
        const s = encodePs2Texture(soft);
        expect(s).toMatchObject({ bpp: 8, hasAlpha: true, lossy: true });
        expect(decodeTxd(s.body).flags).toBe(8);
        expect(encodePs2Texture(photo, { mode: 'indexed' }).bpp).toBe(8);
    });

    it('rounds odd sizes to powers of two and clamps to the maximum', () => {
        expect(encodePs2Texture(img(40, 20, () => [1, 2, 3, 255]))).toMatchObject({ width: 64, height: 32 });
        expect(
            encodePs2Texture(
                img(512, 64, () => [1, 2, 3, 255]),
                { maxSize: 256 },
            ),
        ).toMatchObject({ width: 256, height: 64 });
        const r = resampleNearest(
            img(2, 1, (x) => [x * 100, 0, 0, 255]),
            4,
            1,
        );
        expect(Array.from(r.rgba).filter((_, i) => i % 4 === 0)).toEqual([0, 0, 100, 100]);
    });

    it('median cut keeps distinct dark and bright colours apart', () => {
        const m = new Map<number, number>();
        for (let i = 0; i < 300; i++) m.set((255 << 24) | (i << 8) | (i & 255), 1);
        const q = quantizeRgba(m, 4);
        expect(q.palette.length).toBe(16);
        expect(new Set(q.map.values()).size).toBe(4);
    });

    it('builds a TXD container with a version record', async () => {
        const t = encodePs2Texture(img(8, 8, () => [1, 2, 3, 255]));
        const r = await SrscReader.fromBytes(buildPs2Txd([{ id: 1, body: t.body }]));
        expect(r.find(0x402, 0)).toBeDefined();
        expect(r.find(0x40, 1)!.size).toBe(t.body.length);
        expect(() => buildPs2Txd([{ id: 0, body: t.body }])).toThrow();
    });
});

describe('containers and the asset builder', () => {
    it('round-trips .DB text', () => {
        const t = buildDbText([{ index: 1, path: '../Common/System/System' }]);
        expect(t).toBe('version 1\r\ndependencies 1\r\n1 ..\\Common\\System\\System\r\n');
        expect([...parseDbText(t)]).toEqual([[1, '..\\Common\\System\\System']]);
    });

    // A level folder "Lvl/Lvl" with its own model + texture container and a shared "Common/C/C".
    const files = new Map<string, Uint8Array>();
    const w = (name: string, data: Uint8Array) => files.set(name.toLowerCase(), data);
    const model = (id: number, texRefs: number[][], character = false): Uint8Array => {
        const rec = (type: number, data: number[]) => ({ type, id, sub: 0, data: Uint8Array.from(data) });
        const verts = [...u16(3)];
        for (const v of [0, 0, 0, 1, 0, 0, 0, 0, 1]) verts.push(...new Uint8Array(new Float32Array([v]).buffer));
        const poly = [...u16(1), ...u16(0), ...u16(3), ...u16(1)]; // one triangle, texture list entry 1
        for (const [i, u, v] of [
            [0, 0, 0],
            [1, 1, 0],
            [2, 0, 1],
        ] as const)
            poly.push(...u16(i), ...new Uint8Array(new Float32Array([u, v]).buffer));
        const name = [...u16(4), 0x6d, 0x6f, 0x64, 0x31, ...u32(2)];
        const tl = [...u32(texRefs.length), ...texRefs.flatMap(([i, d]) => [...u16(i!), ...u16(d!)])];
        const recs = [rec(0x200, name), rec(0x206, tl), rec(0x203, verts), rec(0x204, poly)];
        if (character) recs.push(rec(0x208, new Array(70).fill(0)));
        return writePs2Srsc(recs);
    };
    const txd = (ids: number[]): Uint8Array =>
        writePs2Srsc([
            {
                type: 0x30,
                id: 0,
                sub: 0,
                data: palette([
                    [0, 0, 0],
                    [200, 100, 50],
                ]),
            },
            ...ids.map((id) => ({
                type: 0x40,
                id,
                sub: 0,
                data: pcTex({ w: 4, h: 4, bpp: 8, data: new Array(16).fill(1) }),
            })),
        ]);
    w(
        'Lvl/Lvl.db',
        Uint8Array.from([...'version 1\r\ndependencies 1\r\n1 ..\\Common\\C\\C\r\n'].map((c) => c.charCodeAt(0))),
    );
    w(
        'Lvl/Lvl.mod',
        model(5, [
            [3, 0],
            [8, 1],
        ]),
    );
    w('Lvl/Lvl.txd', txd([3]));
    w('Common/C/C.txd', txd([8]));
    w('Common/C/C.mod', model(9, [[8, 0]], true));
    const src: PcFileSource = {
        read: async (p) => files.get(p.toLowerCase()) ?? null,
        list: async () => [...files.keys()],
    };

    it('converts models with their textures and maps references', async () => {
        const b = new OotfAssetBuilder(src);
        await b.registerOwner('Lvl/Lvl');
        expect(await b.addModelRef('Lvl/Lvl', 0, 5)).toBe(2);
        expect(await b.addModelRef('Lvl/Lvl', 0, 5)).toBe(2); // deduplicated
        expect(b.mapModelRef(0, 5, 'Lvl/Lvl')).toBe(2);
        expect(b.mapModelRef(0, 6, 'Lvl/Lvl')).toBeNull();
        // skinned models are reported, not converted
        expect(await b.addModelRef('Lvl/Lvl', 1, 9)).toBeNull();
        expect([...b.report.skipped.values()].some((v) => /skinned/.test(v))).toBe(true);
        expect(await b.addModelRef('Lvl/Lvl', 7, 9)).toBeNull(); // db not in the .db
        const out = b.build('files/ENGLISH/LEVELS/LEVEL9AB', 'level9ab');
        expect(Object.keys(out.files).sort()).toEqual([
            'files/ENGLISH/LEVELS/LEVEL9AB/LEVEL9AB.DB',
            'files/ENGLISH/LEVELS/LEVEL9AB/LEVEL9AB.MOD',
            'files/ENGLISH/LEVELS/LEVEL9AB/LEVEL9AB.TXD',
        ]);
        const mod = await SrscReader.fromBytes(out.files['files/ENGLISH/LEVELS/LEVEL9AB/LEVEL9AB.MOD']!);
        const m = (await parseModel(mod, 2))!;
        // list entry 1 lives in the common TXD (db 1) and is copied into the level TXD; unused entry 0 is not converted
        expect(m.textures).toEqual([{ id: 1, db: 0 }]);
        expect(m.indices.length).toBe(3);
        const tx = await SrscReader.fromBytes(out.files['files/ENGLISH/LEVELS/LEVEL9AB/LEVEL9AB.TXD']!);
        expect(tx.entries.filter((e) => e.type === 0x40).map((e) => e.id)).toEqual([1]);
        expect(decodeTxd(await tx.readRaw(tx.find(0x40, 1)!)).rgba.slice(0, 3)).toEqual(
            Uint8Array.from([200, 100, 50]),
        );
        expect(b.report.textures.converted).toBe(1);
    });

    it('answers terrain texture refs through the level dependency table', async () => {
        const b = new OotfAssetBuilder(src);
        const pc = {
            path: 'Lvl/Lvl.lvl',
            header: { dependencies: [{ dbIndex: 1, path: { text: '..\\Common\\C\\C' } }] },
            terrain: [{ cellTexLeft: new Uint32Array([3, (1 << 16) | 8, 0xffffffff, 0xfffffffe, (1 << 16) | 77]) }],
        } as unknown as PcLevel;
        await b.prepareLevelTextures(pc);
        expect(b.mapTexture(3, pc)).toBe(1); // db 0: the level's own TXD
        expect(b.mapTexture((1 << 16) | 8, pc)).toBe(2);
        expect(b.mapTexture((1 << 16) | 77, pc)).toBeNull(); // no such texture
        expect(b.mapTexture(0xffffffff, pc)).toBeNull();
    });
});
