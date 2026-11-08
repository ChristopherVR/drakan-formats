// Synthetic fixtures only; no game bytes.
import { zlibSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { SrscReader, decodeTxd, parseModel } from '../src/index.ts';
import { type NeutralModel, writePs2ModelRecords } from '../src/ootfmodel.ts';
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
    setExactSink,
    upgradeIndexedSquareTexture,
    PC_TEX_NEXT_FRAME,
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

    it('hands the lossless pixels of a quantised texture to the exact sink (and only those)', () => {
        const got: Array<{ n: number; w: number }> = [];
        setExactSink((body, exact) => got.push({ n: body.length, w: exact.width }));
        try {
            const many = img(32, 32, (x, y) => [x * 8, y * 8, (x * y) & 255, 255]); // > 256 colours, 1024 px: forced 8 bpp below
            const q = encodePs2Texture(many, { mode: 'indexed' });
            expect(q.lossy).toBe(true);
            expect(q.exact?.rgba).toEqual(many.rgba);
            const flat = encodePs2Texture(
                img(8, 8, () => [1, 2, 3, 255]),
                { mode: 'indexed' },
            );
            expect(flat.lossy).toBe(false);
            expect(flat.exact).toBeUndefined();
        } finally {
            setExactSink(null);
        }
        expect(got).toHaveLength(1);
        expect(got[0]!.w).toBe(32);
    });

    it('enlarges an opaque texture to minSize with a smooth, tileable filter and keeps cut-outs hard', () => {
        const ramp = img(8, 8, (x) => [x * 30, 100, 50, 255]);
        const t = encodePs2Texture(ramp, { minSize: 16 });
        expect([t.width, t.height]).toEqual([16, 16]);
        const d = decodeTxd(t.body, { upright: false });
        const mid = d.rgba[(8 * 16 + 5) * 4]!; // between the 3rd and 4th source columns
        expect(mid).toBeGreaterThan(60);
        expect(mid).toBeLessThan(90);
        const cut = img(8, 8, (x) => (x === 0 ? [0, 0, 0, 0] : [1, 2, 3, 255]));
        expect(encodePs2Texture(cut, { minSize: 16 }).width).toBe(8);
    });

    it('square makes a non-square texture square (creature bodies vanish with 256x128 textures)', () => {
        const src = img(16, 8, (x) => [x * 10, 20, 30, x < 3 ? 0 : 255]);
        expect([encodePs2Texture(src).width, encodePs2Texture(src).height]).toEqual([16, 8]);
        const t = encodePs2Texture(src, { square: true });
        expect([t.width, t.height]).toEqual([16, 16]);
    });

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

    it('gives an 8 bpp cut-out the alpha-test selector (flags word 1) and its holes the edge colour', () => {
        // Flags word 0 turns texture alpha off in the engine: a cut-out (leaves, grate, fence) drew its holes solid.
        const leaf = img(8, 8, (x) => (x < 3 ? [0, 0, 0, 0] : [40, 120, 30, 255]));
        const t = encodePs2Texture(leaf);
        expect(t).toMatchObject({ bpp: 8, hasAlpha: true, lossy: false });
        const d = decodeTxd(t.body, { upright: false });
        expect(d.flags).toBe(1);
        expect(t.body[37]).toBe(2);
        expect(Array.from(d.rgba.slice(0, 4))).toEqual([40, 120, 30, 0]); // hole: edge colour, alpha 0
        expect(Array.from(d.rgba.slice(3 * 4, 3 * 4 + 4))).toEqual([40, 120, 30, 254]);
        // forced 8 bpp (skinned models, fast-draw weapons) and a quantised cut-out take the same selector
        expect(decodeTxd(encodePs2Texture(leaf, { mode: 'indexed', square: true }).body).flags).toBe(1);
        const many = img(32, 32, (x, y) => (x < 4 ? [0, 0, 0, 0] : [x * 8, y * 8, (x * y) & 255, 255]));
        const q = encodePs2Texture(many, { mode: 'indexed' });
        expect(q).toMatchObject({ bpp: 8, lossy: true });
        expect(decodeTxd(q.body).flags).toBe(1);
        // a 16 bpp cut-out upgraded to a square 8 bpp texture keeps a nonzero selector
        const t16 = encodePs2Texture(many, { mode: 'auto', maxSize: 32 });
        expect([t16.bpp, decodeTxd(t16.body).flags]).toEqual([16, 1]);
        const up = upgradeIndexedSquareTexture(t16.body)!;
        expect([up.bpp, decodeTxd(up.body).flags, up.body[37]]).toEqual([8, 1, 2]);
        // graded alpha keeps the blend selector 8, opaque textures stay 0
        expect(decodeTxd(encodePs2Texture(img(8, 8, (x) => [9, 9, 9, x ? 255 : 100])).body).flags).toBe(8);
        expect(decodeTxd(encodePs2Texture(img(8, 8, () => [9, 9, 9, 255])).body).flags).toBe(0);
    });

    it('writes a wholly transparent texture like the disc invisiblewall (16 bpp, flags word 1), 8 bpp flags 8 when forced', () => {
        const clear = img(16, 16, () => [0, 0, 0, 0]);
        const t = encodePs2Texture(clear);
        expect(t).toMatchObject({ width: 16, height: 16, bpp: 16, hasAlpha: true, lossy: false });
        const d = decodeTxd(t.body, { upright: false });
        expect(d).toMatchObject({ bpp: 16, flags: 1 });
        expect([t.body[37], t.body[38]]).toEqual([2, 0x80]);
        for (let i = 3; i < d.rgba.length; i += 4) expect(d.rgba[i]).toBe(0);
        const forced = encodePs2Texture(clear, { mode: 'indexed', square: true });
        expect(forced).toMatchObject({ bpp: 8, hasAlpha: true });
        const fd = decodeTxd(forced.body, { upright: false });
        expect(fd.flags).toBe(8);
        for (let i = 3; i < fd.rgba.length; i += 4) expect(fd.rgba[i]).toBe(0);
        // a cut-out with opaque pixels keeps the 8 bpp palette form
        expect(encodePs2Texture(img(8, 8, (x) => (x === 0 ? [0, 0, 0, 0] : [1, 2, 3, 255]))).bpp).toBe(8);
    });

    it('uses 16 bpp for photo-like images and 8 bpp with graded alpha otherwise', () => {
        const photo = img(32, 32, (x, y) => [x * 8, y * 8, (x * y) & 255, 255]);
        const t = encodePs2Texture(photo, { mode: 'auto' });
        expect(t.bpp).toBe(16);
        const d = decodeTxd(t.body, { upright: false });
        expect(d.flags).toBe(1);
        expect(d.rgba[0]).toBe(0);
        expect(d.rgba[(5 + 3 * 32) * 4]).toBe(Math.floor((((5 * 8) >> 3) * 255) / 31));
        const soft = img(32, 32, (x, y) => [x * 8, y * 8, 0, 40 + x * 6]);
        const s = encodePs2Texture(soft, { mode: 'auto' });
        expect(s).toMatchObject({ bpp: 8, hasAlpha: true, lossy: true });
        expect(decodeTxd(s.body).flags).toBe(8);
        expect(encodePs2Texture(photo, { mode: 'indexed' }).bpp).toBe(8);
    });

    it('truecolor mode writes 32 bpp without quantising or 5-bit reduction', () => {
        const photo = img(32, 32, (x, y) => [x * 8 + 1, y * 8 + 3, (x * y) & 255, 40 + x * 6]);
        const t = encodePs2Texture(photo, { mode: 'truecolor' });
        expect(t).toMatchObject({ bpp: 32, lossy: false, hasAlpha: true });
        const d = decodeTxd(t.body, { upright: false });
        expect(d.rgba[(5 + 3 * 32) * 4]).toBe(5 * 8 + 1);
        expect(d.rgba[(5 + 3 * 32) * 4 + 1]).toBe(3 * 8 + 3);
        expect(
            encodePs2Texture(
                img(8, 8, () => [1, 2, 3, 255]),
                { mode: 'truecolor' },
            ).bpp,
        ).toBe(8);
    });

    it('truecolor mode keeps big textures 32 bpp unless a pixel budget is set', () => {
        const big = img(256, 256, (x, y) => [x, y, (x * y) & 255, 255]);
        expect(encodePs2Texture(big, { mode: 'truecolor' })).toMatchObject({ width: 256, height: 256, bpp: 32 });
        expect(encodePs2Texture(big, { mode: 'truecolor', maxTruecolorPixels: 128 * 128 })).toMatchObject({
            bpp: 8,
            lossy: true,
        });
        const small = img(64, 64, (x, y) => [x, y, (x * y) & 255, 255]);
        expect(encodePs2Texture(small, { mode: 'truecolor', minSize: 128 })).toMatchObject({ width: 128, bpp: 32 });
    });

    it('writes a large truecolor texture 8 bpp only when the palette keeps it close (issue 5 cache budget)', () => {
        // Gentle shading with ~1,500 colours: the refined palette is visually exact.
        const shade = (x: number, y: number): number[] => [90 + (x >> 2), 70 + (y >> 2), 50 + ((x + y) >> 5), 255];
        for (const size of [128, 256]) {
            const src = img(size, size, shade);
            const t = encodePs2Texture(src, { mode: 'truecolor' });
            expect(t).toMatchObject({ width: size, height: size, bpp: 8, lossy: true, hasAlpha: false });
            const d = decodeTxd(t.body, { upright: false });
            let worst = 0;
            for (let i = 0; i < size * size * 4; i++)
                if (i % 4 !== 3) worst = Math.max(worst, Math.abs(d.rgba[i]! - src.rgba[i]!));
            expect(worst).toBeLessThanOrEqual(4);
            expect(t.body.length).toBe(0x40 + 16 + 1024 + size * size);
        }
        // Below 128 x 128 the texture stays exact; `indexedFromPixels: Infinity` turns the rule off.
        expect(
            encodePs2Texture(
                img(64, 64, (x, y) => [x * 2, y * 2, 50, 255]),
                { mode: 'truecolor' },
            ).bpp,
        ).toBe(32);
        expect(encodePs2Texture(img(128, 128, shade), { mode: 'truecolor', indexedFromPixels: Infinity }).bpp).toBe(32);
        // Noise has too many distinct colours for 256 entries: it stays 32 bpp.
        let seed = 7;
        const rnd = (): number => (seed = (seed * 1103515245 + 12345) >>> 0) >>> 24;
        expect(
            encodePs2Texture(
                img(128, 128, () => [rnd(), rnd(), rnd(), 255]),
                { mode: 'truecolor' },
            ).bpp,
        ).toBe(32);
    });

    it('respects alpha when it writes a large texture 8 bpp', () => {
        const shade = (x: number, y: number): number[] => [90 + (x >> 1), 70 + (y >> 1), 50, 255];
        // A cut-out: transparent holes stay exactly transparent, opaque pixels stay opaque.
        const cut = img(128, 128, (x, y) => ((x >> 4) % 2 === 0 && (y >> 4) % 2 === 0 ? [0, 0, 0, 0] : shade(x, y)));
        const t = encodePs2Texture(cut, { mode: 'truecolor' });
        expect(t).toMatchObject({ bpp: 8, hasAlpha: true, lossy: true });
        const d = decodeTxd(t.body, { upright: false });
        for (let i = 0; i < 128 * 128; i++) expect(d.rgba[i * 4 + 3]! === 0).toBe(cut.rgba[i * 4 + 3]! === 0);
        // The holes carry the edge colour (filtering at the edge does not darken), not black.
        expect(d.rgba[0]).toBeGreaterThan(80);
        expect(d.rgba[1]).toBeGreaterThan(60);
        // Many alpha levels mixed with many colours: the palette cannot keep both, so it stays 32 bpp.
        let seed = 3;
        const rnd = (): number => (seed = (seed * 1103515245 + 12345) >>> 0) >>> 24;
        const soft = img(128, 128, (x, y) => [90 + (x >> 2), 70 + (y >> 2), rnd() >> 2, rnd()]);
        expect(encodePs2Texture(soft, { mode: 'truecolor' }).bpp).toBe(32);
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

describe('native item texture representation upgrades', () => {
    it.each([1, 2])('resizes only the index plane and preserves palette kind %i and metadata verbatim', (kind) => {
        const encoded = encodePs2Texture(
            {
                width: 16,
                height: 8,
                rgba: Uint8Array.from({ length: 16 * 8 * 4 }, (_, i) => (i % 4 === 3 ? 255 : (i * 7) & 255)),
            },
            { mode: 'indexed', fps: 13, slot: 77 },
        );
        const paletteBytes = kind === 1 ? 1024 : 512,
            planeAt = 80 + paletteBytes;
        let body = encoded.body;
        if (kind === 2) {
            const next = new Uint8Array(planeAt + 128);
            next.set(body.subarray(0, 80));
            const dv = new DataView(next.buffer);
            dv.setUint32(64, 2, true);
            for (let i = 0; i < 256; i++) dv.setUint16(80 + i * 2, i | (i % 2 ? 0x8000 : 0), true);
            next.set(body.subarray(1104), planeAt);
            body = next;
        } else {
            for (let i = 0; i < 4; i++) body[83 + i * 4] = [0, 64, 127, 128][i]!;
        }
        body[37] = 2 | PC_TEX_NEXT_FRAME;
        new DataView(body.buffer).setFloat32(44, 1.75, true);
        const frozen = body.slice(),
            original = decodeTxd(body, { upright: false });
        const upgraded = upgradeIndexedSquareTexture(body)!;
        expect(body).toEqual(frozen);
        expect([upgraded.width, upgraded.height, upgraded.bpp]).toEqual([16, 16, 8]);
        expect(upgraded.lossy).toBe(false);
        expect(upgraded.body.slice(16, planeAt)).toEqual(body.slice(16, planeAt));
        const image = decodeTxd(upgraded.body, { upright: false });
        const expected = new Uint8Array(image.rgba.length);
        for (let y = 0; y < 16; y++)
            expected.set(original.rgba.subarray(Math.floor(y / 2) * 64, Math.floor(y / 2) * 64 + 64), y * 64);
        expect(image.rgba).toEqual(expected);
        expect(upgradeIndexedSquareTexture(upgraded.body)).toBeNull();
    });

    it('emits lossy exact images only after final opaque/animation metadata is applied', () => {
        const rgba = Uint8Array.from({ length: 32 * 16 * 4 }, (_, i) => {
            const pixel = Math.floor(i / 4),
                x = pixel % 32,
                y = Math.floor(pixel / 32);
            return [x * 7, y * 13, (x ^ y) * 5, 255][i % 4]!;
        });
        const original = encodePs2Texture({ width: 32, height: 16, rgba }, { mode: 'truecolor', fps: 17, slot: 91 });
        expect(original.bpp).toBe(32);
        original.body[37] = PC_TEX_NEXT_FRAME;
        new DataView(original.body.buffer).setFloat32(44, 2.5, true);
        const emitted: Uint8Array[] = [];
        try {
            setExactSink((body, exact) => {
                emitted.push(body.slice());
                expect([exact.width, exact.height]).toEqual([32, 32]);
            });
            const next = upgradeIndexedSquareTexture(original.body)!;
            expect(next.lossy).toBe(true);
            expect(next.bpp).toBe(8);
            expect(next.body[37]).toBe(PC_TEX_NEXT_FRAME); // decoded opaque alpha254 must not enable blending
            expect(next.body[38]).toBe(0);
            expect(next.body.slice(40, 64)).toEqual(original.body.slice(40, 64));
            expect(new DataView(next.body.buffer).getUint32(16, true)).toBe(0);
            expect(emitted).toEqual([next.body]); // the HD hash sees final bytes, never the pre-metadata encoding
        } finally {
            setExactSink(null);
        }
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
    const model = (
        id: number,
        texRefs: number[][],
        character = false,
        offset = 0,
        bounds?: Uint8Array,
        drawable = true,
    ): Uint8Array => {
        const rec = (type: number, data: number[]) => ({ type, id, sub: 0, data: Uint8Array.from(data) });
        const verts = [...u16(3)];
        for (const v of [0, 0, 0, 1, 0, 0, 0, 0, 1])
            verts.push(...new Uint8Array(new Float32Array([v + offset]).buffer));
        const poly = [...u16(1), ...u16(0), ...u16(3), ...u16(1)]; // one triangle, texture list entry 1
        for (const [i, u, v] of [
            [0, 0, 0],
            [1, 1, 0],
            [2, 0, 1],
        ] as const)
            poly.push(...u16(i), ...new Uint8Array(new Float32Array([u, v]).buffer));
        const name = [...u16(4), 0x6d, 0x6f, 0x64, 0x31, ...u32(2)];
        const tl = [...u32(texRefs.length), ...texRefs.flatMap(([i, d]) => [...u16(i!), ...u16(d!)])];
        const recs = [rec(0x200, name), rec(0x206, tl), rec(0x203, verts), rec(0x204, drawable ? poly : [0, 0])];
        if (character) recs.push(rec(0x208, new Array(70).fill(0)));
        if (bounds) recs.push(rec(0x207, [...bounds]));
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
        expect([...b.report.skipped.values()].some((v) => /skeleton|skinned/.test(v))).toBe(true);
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

    it('keeps the polygons, draw list and collision of an invisible wall and writes its texture wholly transparent', async () => {
        // The PC "invisiblewall" (Volcanic's Arrow Detect Object 2366) is a box whose only texture is fully transparent; the
        // arrow must still hit it, so only the texture form changes (black box in game with an 8 bpp flags-word-0 texture).
        const bounds = new Uint8Array(72);
        [0, 0, 0, 2, 0, 0, 0, 2, 0, 0, 0, 2, 0, 0, 0, 2].forEach((v, i) =>
            new DataView(bounds.buffer).setFloat32(i * 4, v, true),
        );
        const clearTxd = writePs2Srsc([
            { type: 0x30, id: 0, sub: 0, data: palette([[0, 0, 0]]) },
            { type: 0x40, id: 3, sub: 0, data: pcTex({ w: 4, h: 4, bpp: 8, key: 0, data: new Array(16).fill(0) }) },
        ]);
        const local: PcFileSource = {
            ...src,
            read: async (p) =>
                p.toLowerCase() === 'lvl/lvl.mod'
                    ? model(
                          5,
                          [
                              [4, 0],
                              [3, 0],
                          ],
                          false,
                          0,
                          bounds,
                      )
                    : p.toLowerCase() === 'lvl/lvl.txd'
                      ? clearTxd
                      : src.read(p),
        };
        const b = new OotfAssetBuilder(local);
        expect(await b.addModelRef('Lvl/Lvl', 0, 5, true)).toBe(2);
        const out = b.build('out', 'test').files;
        const mod = await SrscReader.fromBytes(out['out/TEST.MOD']!);
        expect(mod.find(0x211, 2)).toBeDefined();
        expect(mod.find(0x207, 2)).toBeDefined();
        const m = (await parseModel(mod, 2))!;
        expect(m.indices.length).toBe(3);
        const tx = await SrscReader.fromBytes(out['out/TEST.TXD']!);
        const d = decodeTxd(await tx.readRaw(tx.find(0x40, m.textures[0]!.id)!));
        expect([d.bpp, d.flags]).toEqual([16, 1]);
        for (let i = 3; i < d.rgba.length; i += 4) expect(d.rgba[i]).toBe(0);
    });

    it('gives a Morph Plug frame one collision shape that lists every polygon, keeping pad vertices out of the box', async () => {
        // A PC hierarchy of a root and a leaf box (Volcanic's IceCover01 has nine boxes, its other frames one): the plug copies
        // each frame's shapes into its own instance, so every frame gets the disc's layout of one shape.
        const pcBounds = new Uint8Array(68 + 2 * 4 + 50 + 52);
        const dv = new DataView(pcBounds.buffer);
        dv.setUint16(64, 2, true);
        dv.setUint16(66, 1, true);
        dv.setUint16(68, 1, true); // shape 0: first child 1
        dv.setUint16(76 + 50 + 48, 1, true); // shape 1, a leaf: polygon 0
        const local: PcFileSource = {
            ...src,
            read: async (p) =>
                p.toLowerCase() === 'lvl/lvl.mod'
                    ? model(
                          5,
                          [
                              [3, 0],
                              [8, 1],
                          ],
                          false,
                          5,
                          pcBounds,
                      )
                    : src.read(p),
        };
        const b = new OotfAssetBuilder(local);
        expect(await b.addModelRef('Lvl/Lvl', 0, 5, true)).toBe(2);
        const kept = await (
            await SrscReader.fromBytes(b.build('out', 'test').files['out/TEST.MOD']!)
        ).readRaw((await SrscReader.fromBytes(b.build('out', 'test').files['out/TEST.MOD']!)).find(0x207, 2)!);
        expect(new DataView(kept.buffer, kept.byteOffset).getUint16(72, true)).toBe(2); // the authored hierarchy
        expect(b.singleShapeBounds(2)).toBe(true);
        expect(b.singleShapeBounds(99)).toBe(false);
        const mod = await SrscReader.fromBytes(b.build('out', 'test').files['out/TEST.MOD']!);
        const m = (await parseModel(mod, 2))!;
        const raw = await mod.readRaw(mod.find(0x207, 2)!);
        const bv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
        const polygons = m.indices.length / 3;
        expect([bv.getUint16(72, true), bv.getUint16(74, true)]).toEqual([1, 1]);
        expect(bv.getUint16(128, true)).toBe(polygons);
        expect(raw.length).toBe(130 + polygons * 2);
        // the triangle spans (5,5,5)..(6,5,6); the display list's pad vertex at the origin is not in the box
        expect([80, 84, 88, 92, 112, 124].map((i) => bv.getFloat32(i, true))).toEqual([5, 5, 5, 1, 0, 1]);
        expect(m.positions.slice(-3)).toEqual(new Float32Array([0, 0, 0]));
    });

    it.each([
        [false, true, false],
        [true, false, false],
        [false, true, true],
        [true, false, true],
    ])(
        'retains a shared rigid model id when display-list requirements arrive in order %s/%s (authored bounds %s)',
        async (first, second, authored) => {
            const bounds = new Uint8Array(72).fill(0xab);
            const conservative = [6, 6, 6, 20, -4, -4, -4, 20, 0, 0, 0, 20, 0, 0, 0, 20];
            conservative.forEach((v, i) => new DataView(bounds.buffer).setFloat32(i * 4, v, true));
            const local: PcFileSource = {
                ...src,
                read: async (p) =>
                    p.toLowerCase() === 'lvl/lvl.mod'
                        ? model(
                              5,
                              [
                                  [3, 0],
                                  [8, 1],
                              ],
                              false,
                              5,
                              authored ? bounds : undefined,
                          )
                        : src.read(p),
            };
            const ordinary = new OotfAssetBuilder(local);
            await ordinary.addModelRef('Lvl/Lvl', 0, 5);
            const ordinaryMod = await SrscReader.fromBytes(ordinary.build('out', 'test').files['out/TEST.MOD']!);
            expect(ordinaryMod.find(0x211, 2)).toBeUndefined();
            const before = (await parseModel(ordinaryMod, 2))!;
            const b = new OotfAssetBuilder(local);
            expect(await b.addModelRef('Lvl/Lvl', 0, 5, first)).toBe(2);
            expect(await b.addModelRef('Lvl/Lvl', 0, 5, second)).toBe(2);
            const built = b.build('out', 'test').files['out/TEST.MOD']!;
            expect(await b.addModelRef('Lvl/Lvl', 0, 5, true)).toBe(2);
            expect(b.build('out', 'test').files['out/TEST.MOD']).toEqual(built);
            expect(b.report.models.converted).toBe(1);
            expect(b.report.models.triangles).toBe(1);
            const mod = await SrscReader.fromBytes(built);
            expect(mod.entries.filter((e) => e.type === 0x211).map((e) => e.id)).toEqual([2]);
            const after = (await parseModel(mod, 2))!;
            const beforeBounds = await ordinaryMod.readRaw(ordinaryMod.find(0x207, 2)!);
            const afterBounds = await mod.readRaw(mod.find(0x207, 2)!);
            expect(afterBounds.slice(0, 72)).toEqual(beforeBounds.slice(0, 72));
            // The source hierarchy may reference old polygons. Rebuild it and list each new polygon once.
            const bv = new DataView(afterBounds.buffer, afterBounds.byteOffset, afterBounds.byteLength);
            expect(afterBounds.length).toBe(130 + (after.indices.length / 3) * 2);
            expect(bv.getUint16(128, true)).toBe(after.indices.length / 3);
            expect(Array.from({ length: after.indices.length / 3 }, (_, i) => bv.getUint16(130 + i * 2, true))).toEqual(
                Array.from({ length: after.indices.length / 3 }, (_, i) => i),
            );
            expect([80, 84, 88].map((i) => bv.getFloat32(i, true))).toEqual([5, 5, 5]);
            expect(after.positions.slice(-3)).toEqual(new Float32Array([0, 0, 0]));
            expect(after.textures).toEqual(before.textures);
            expect(after.indices).toEqual(before.indices);
            expect(after.uvs).toEqual(before.uvs);
            expect(after.positions.slice(0, before.positions.length)).toEqual(before.positions);
            expect(b.mapModelRef(0, 5, 'Lvl/Lvl')).toBe(2);
        },
    );

    it.each([
        [false, true],
        [true, false],
    ])('keeps legacy named display-list bounds byte-identical in order %s/%s', async (first, second) => {
        const options = { displayList: /mod1/ };
        const ordinary = new OotfAssetBuilder(src, options);
        await ordinary.addModelRef('Lvl/Lvl', 0, 5);
        const baseline = ordinary.build('out', 'test').files['out/TEST.MOD'];
        const b = new OotfAssetBuilder(src, options);
        expect(await b.addModelRef('Lvl/Lvl', 0, 5, first)).toBe(2);
        expect(await b.addModelRef('Lvl/Lvl', 0, 5, second)).toBe(2);
        expect(b.build('out', 'test').files['out/TEST.MOD']).toEqual(baseline);
    });

    it.each([
        [false, true],
        [true, false],
    ])('retains bounds-only helper models without a draw list in order %s/%s', async (first, second) => {
        const local: PcFileSource = {
            ...src,
            read: async (p) =>
                p.toLowerCase() === 'lvl/lvl.mod'
                    ? model(
                          5,
                          [
                              [3, 0],
                              [8, 1],
                          ],
                          false,
                          5,
                          undefined,
                          false,
                      )
                    : p.toLowerCase() === 'lvl/other.mod'
                      ? model(6, [
                            [3, 0],
                            [8, 0],
                        ])
                      : p.toLowerCase() === 'lvl/other.txd'
                        ? txd([8])
                        : src.read(p),
        };
        const ordinary = new OotfAssetBuilder(local);
        await ordinary.addModelRef('Lvl/Lvl', 0, 5);
        expect(await ordinary.addModel('Lvl/Other', 6)).toBe(3);
        const b = new OotfAssetBuilder(local);
        expect(await b.addModelRef('Lvl/Lvl', 0, 5, first)).toBe(2);
        expect(await b.addModelRef('Lvl/Lvl', 0, 5, second)).toBe(2);
        expect(await b.addModel('Lvl/Other', 6)).toBe(3);
        expect(b.build('out', 'test').files['out/TEST.MOD']).toEqual(
            ordinary.build('out', 'test').files['out/TEST.MOD'],
        );
        expect(b.report.models.converted).toBe(2);
        expect(b.report.models.triangles).toBe(1);
        expect(b.report.skipped.size).toBe(0);
    });

    it('rejects a drawable model whose textures are missing even when a display list is required', async () => {
        const missing: PcFileSource = {
            ...src,
            read: async (p) => (p.toLowerCase().endsWith('.txd') ? null : src.read(p)),
        };
        const b = new OotfAssetBuilder(missing);
        expect(await b.addModelRef('Lvl/Lvl', 0, 5, true)).toBeNull();
        expect(b.mapModelRef(0, 5, 'Lvl/Lvl')).toBeNull();
        expect([...b.report.skipped.values()]).toContain('no polygon left (textures missing)');
        expect(b.report.models.converted).toBe(0);
    });

    it('leaves original model ids and imported skeletal records untouched by rigid upgrade requests', async () => {
        const b = new OotfAssetBuilder(src);
        await b.addModelRef('Lvl/Lvl', 0, 5);
        const imported = (
            b as unknown as { models: { model: NeutralModel; records?: { type: number; data: Uint8Array }[] }[] }
        ).models[0]!;
        // Synthetic imported skeletal state deliberately lacking its list: the rigid API must not discard its records.
        imported.records = [...writePs2ModelRecords(imported.model), { type: 0x208, data: new Uint8Array([7, 8, 9]) }];
        const before = b.build('out', 'test').files['out/TEST.MOD'];
        expect(b.requireDisplayList(5941)).toBe(false); // original native/template id, not owned by this builder
        expect(b.requireDisplayList(2)).toBe(false);
        expect(b.build('out', 'test').files['out/TEST.MOD']).toEqual(before);
    });

    it.each([false, true])(
        'preserves a full authored sphere hierarchy through padded multi-window draw conversion (required first %s)',
        async (first) => {
            const spheres = new Uint8Array(64 + 4 + 2 * 20);
            const sd = new DataView(spheres.buffer);
            sd.setFloat32(0, 100, true);
            sd.setFloat32(12, 250, true);
            sd.setUint16(64, 2, true);
            sd.setUint16(68, 1, true);
            for (let i = 0; i < 2; i++) {
                sd.setFloat32(76 + i * 16, 50 + i * 100, true);
                sd.setFloat32(88 + i * 16, 100, true);
            }
            const source = await SrscReader.fromBytes(
                model(
                    5,
                    [
                        [3, 0],
                        [8, 1],
                    ],
                    false,
                    0,
                    spheres,
                ),
            );
            const vertices = new Uint8Array(2 + 300 * 12),
                vd = new DataView(vertices.buffer);
            vd.setUint16(0, 300, true);
            const polygons = new Uint8Array(2 + 100 * 36),
                pd = new DataView(polygons.buffer);
            pd.setUint16(0, 100, true);
            for (let i = 0; i < 100; i++) {
                const o = 2 + i * 36;
                pd.setUint16(o + 2, 3, true);
                pd.setUint16(o + 4, i % 2, true);
                for (let k = 0; k < 3; k++) {
                    const v = i * 3 + k;
                    vd.setFloat32(2 + v * 12, 5 + i * 2 + (k === 1 ? 1 : 0), true);
                    vd.setFloat32(2 + v * 12 + 4, 5, true);
                    vd.setFloat32(2 + v * 12 + 8, 5 + (k === 2 ? 1 : 0), true);
                    pd.setUint16(o + 6 + k * 10, v, true);
                    pd.setFloat32(o + 8 + k * 10, k === 1 ? 1 : 0, true);
                    pd.setFloat32(o + 12 + k * 10, k === 2 ? 1 : 0, true);
                }
            }
            const records = [];
            for (const e of source.entries)
                records.push({
                    type: e.type,
                    id: e.id,
                    sub: e.sub,
                    data: e.type === 0x203 ? vertices : e.type === 0x204 ? polygons : await source.readRaw(e),
                });
            const bytes = writePs2Srsc(records);
            const local: PcFileSource = {
                ...src,
                read: async (p) => (p.toLowerCase() === 'lvl/lvl.mod' ? bytes : src.read(p)),
            };
            const ordinary = new OotfAssetBuilder(local);
            await ordinary.addModelRef('Lvl/Lvl', 0, 5);
            const before = await SrscReader.fromBytes(ordinary.build('out', 'test').files['out/TEST.MOD']!);
            const b = new OotfAssetBuilder(local);
            await b.addModelRef('Lvl/Lvl', 0, 5, first);
            expect(b.requireRigidWeaponDisplayList(2)).toBe(true);
            await b.addModelRef('Lvl/Lvl', 0, 5, true);
            const after = await SrscReader.fromBytes(b.build('out', 'test').files['out/TEST.MOD']!);
            expect(await after.readRaw(after.find(0x207, 2)!)).toEqual(await before.readRaw(before.find(0x207, 2)!));
            const old = (await parseModel(before, 2))!,
                next = (await parseModel(after, 2))!;
            const triangles = (m: typeof old) =>
                Array.from({ length: m.indices.length / 3 }, (_, t) => {
                    const corners = [0, 1, 2].map((k) => [
                        ...m.positions.slice(m.indices[t * 3 + k]! * 3, m.indices[t * 3 + k]! * 3 + 3),
                        ...m.uvs.slice(t * 6 + k * 2, t * 6 + k * 2 + 2),
                    ]);
                    return JSON.stringify([
                        m.triTexture[t],
                        corners.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
                    ]);
                });
            expect(next.positions.length).toBeGreaterThan(old.positions.length);
            expect(triangles(next)).not.toEqual(triangles(old));
            expect(triangles(next).sort()).toEqual(triangles(old).sort());
        },
    );

    it('diagnoses unsupported melee bounds without synthesizing a sphere chain or adding a draw list', async () => {
        const b = new OotfAssetBuilder(src);
        await b.addModelRef('Lvl/Lvl', 0, 5);
        const before = b.build('out', 'test').files['out/TEST.MOD'];
        expect(b.requireRigidWeaponDisplayList(5941)).toBe(false);
        expect(b.requireRigidWeaponDisplayList(2)).toBe(false);
        expect(b.requireRigidWeaponDisplayList(2)).toBe(false);
        expect(b.build('out', 'test').files['out/TEST.MOD']).toEqual(before);
        expect(b.report.warnings).toEqual([
            'model lvl/lvl#5: native rigid weapon requires a nonempty authored sphere hierarchy; draw upgrade skipped',
        ]);
    });

    it.each([false, true])(
        'upgrades shared animated weapon textures without allocating ids (weapon first %s)',
        async (weaponFirst) => {
            const sphere = new Uint8Array(88),
                sd = new DataView(sphere.buffer);
            sd.setUint16(64, 1, true);
            sd.setFloat32(84, 2, true);
            const meshes = [];
            for (const id of [5, 6]) {
                const r = await SrscReader.fromBytes(
                    model(
                        id,
                        [
                            [3, 0],
                            [8, 1],
                        ],
                        false,
                        0,
                        sphere,
                    ),
                );
                for (const e of r.entries)
                    meshes.push({ type: e.type, id: e.id, sub: e.sub, data: await r.readRaw(e) });
            }
            const textureRecords = [];
            for (let frame = 0; frame < 3; frame++) {
                const data = Array.from({ length: 32 * 16 * 3 }, (_, i) => {
                    const p = Math.floor(i / 3),
                        x = p % 32,
                        y = Math.floor(p / 32);
                    return [x * 7, y * 13, ((x ^ y) * 5 + frame * 11) & 255][i % 3]!;
                });
                textureRecords.push({
                    type: 0x40,
                    id: 8 + frame,
                    sub: 0,
                    data: pcTex({ w: 32, h: 16, bpp: 24, data, flags: frame ? PC_TEX_NEXT_FRAME : 0 }),
                });
            }
            const meshBytes = writePs2Srsc(meshes),
                textureBytes = writePs2Srsc(textureRecords);
            const local: PcFileSource = {
                ...src,
                read: async (p) =>
                    p.toLowerCase() === 'lvl/lvl.mod'
                        ? meshBytes
                        : p.toLowerCase() === 'common/c/c.txd'
                          ? textureBytes
                          : src.read(p),
            };
            const b = new OotfAssetBuilder(local, { texture: { mode: 'truecolor', fps: 17, slot: 91 } });
            const first = weaponFirst ? 5 : 6,
                second = weaponFirst ? 6 : 5;
            expect(await b.addModelRef('Lvl/Lvl', 0, first)).toBe(2);
            if (weaponFirst) expect(b.requireRigidWeaponDisplayList(2)).toBe(true);
            expect(await b.addModelRef('Lvl/Lvl', 0, second)).toBe(3);
            const weaponId = weaponFirst ? 2 : 3;
            expect(b.requireRigidWeaponDisplayList(weaponId)).toBe(true);
            expect(await b.addTexture('Lvl/Lvl', 3)).toBe(4); // no :i alias or hidden extra texture ids
            const built = b.build('out', 'test');
            expect(b.requireRigidWeaponDisplayList(weaponId)).toBe(true);
            expect(b.build('out', 'test').files).toEqual(built.files);
            expect(b.report.textures.converted).toBe(4);
            expect(b.report.textures.byBpp).toEqual({ 8: 4 });
            expect(b.report.textures.lossy).toBe(3);
            const txd = await SrscReader.fromBytes(built.files['out/TEST.TXD']!);
            expect(txd.entries.filter((e) => e.type === 0x40).map((e) => e.id)).toEqual([1, 2, 3, 4]);
            for (let frame = 0; frame < 3; frame++) {
                const body = await txd.readRaw(txd.find(0x40, 1 + frame)!),
                    image = decodeTxd(body);
                expect([image.width, image.height, image.bpp]).toEqual([32, 32, 8]);
                expect(body[36]).toBe(17);
                expect(body[37]).toBe(frame ? PC_TEX_NEXT_FRAME : 0);
                expect(new DataView(body.buffer, body.byteOffset, body.byteLength).getUint32(40, true)).toBe(91);
            }
            const mod = await SrscReader.fromBytes(built.files['out/TEST.MOD']!);
            // Every frame of the animated texture is listed after the first (the disc convention; frame 0 only draws still).
            for (const id of [2, 3])
                expect((await parseModel(mod, id))!.textures).toEqual([
                    { id: 1, db: 0 },
                    { id: 2, db: 0 },
                    { id: 3, db: 0 },
                ]);
            const size = (
                await Promise.all(txd.entries.filter((e) => e.type === 0x40).map((e) => txd.readRaw(e)))
            ).reduce((n, r) => n + r.length, 0);
            expect(b.report.textures.bytes).toBe(size);
        },
    );

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
