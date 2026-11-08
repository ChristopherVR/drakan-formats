// Synthetic data only; no game bytes.
import { describe, expect, it } from 'vitest';
import {
    MAP_TEXTURE_SIZE,
    applyMapOverride,
    levelPointOfMapPixel,
    loadOotfMapPicture,
    mapClassValues,
    mapPixelOf,
    mapTextureImage,
    ootfMapSetBase,
    pictureContent,
    worldRectOfTerrain,
    type LevelMapSpec,
    type TopDownImage,
} from '../src/ootfmap.ts';
import { FIELD_INT } from '../src/fields.ts';
import type { SrscReader } from '../src/srsc.ts';

/** A PC texture record: 54 byte header, 16 bit 5:6:5 pixels, rows stored bottom first. */
function tile(color: (x: number, yFromTop: number) => number): Uint8Array {
    const b = new Uint8Array(54 + 256 * 256 * 2);
    const dv = new DataView(b.buffer);
    dv.setUint32(0, 256, true);
    dv.setUint32(4, 256, true);
    dv.setUint32(8, 512, true);
    dv.setUint16(12, 16, true);
    dv.setUint32(18, 0xffffffff, true);
    for (let row = 0; row < 256; row++)
        for (let x = 0; x < 256; x++) dv.setUint16(54 + (row * 256 + x) * 2, color(x, 255 - row), true);
    return b;
}
const RED = 0xf800;
const GREEN = 0x07e0;
const BLUE = 0x001f;
const WHITE = 0xffff;
const YELLOW = 0xffe0;

function fakeRrc(tiles: Record<number, Uint8Array>): SrscReader {
    const entries = Object.keys(tiles).map((id) => ({ type: 0x40, id: Number(id), sub: 0, offset: 0, size: 0 }));
    return { entries, readRaw: async (e: { id: number }) => tiles[e.id]! } as unknown as SrscReader;
}

describe('loadOotfMapPicture', () => {
    const set = (): SrscReader =>
        fakeRrc({
            4416: tile(() => RED),
            4417: tile(() => GREEN),
            4418: tile(() => BLUE),
            4419: tile(() => WHITE),
            4420: tile((x) => (x < 128 ? YELLOW : 0x07ff)),
        });
    it('joins five tiles into 640 x 480', async () => {
        const img = (await loadOotfMapPicture(set(), 4416))!;
        expect([img.width, img.height]).toEqual([640, 480]);
        const at = (x: number, y: number): number[] => [...img.rgba.subarray((y * 640 + x) * 4, (y * 640 + x) * 4 + 3)];
        expect(at(10, 10)).toEqual([255, 0, 0]); // tile 0, top left
        expect(at(300, 10)).toEqual([0, 255, 0]); // tile 1, top middle
        expect(at(10, 300)).toEqual([0, 0, 255]); // tile 2, bottom left
        expect(at(300, 300)).toEqual([255, 255, 255]); // tile 3, bottom middle
        expect(at(520, 100)[0]).toBe(255); // left half of tile 4: right edge of the top row (yellow)
        expect(at(520, 100)[2]).toBe(0);
        expect(at(600, 300)[2]).toBe(255); // right half of tile 4: right edge of the bottom row (cyan)
        expect(at(600, 300)[0]).toBe(0);
    });
    it('is null when a tile is missing', async () => {
        const t = { 4416: tile(() => RED), 4417: tile(() => RED) };
        expect(await loadOotfMapPicture(fakeRrc(t), 4416)).toBeNull();
    });
});

describe('ootfMapSetBase', () => {
    it('reads the set from the Map Trigger class (text sheet id minus 5)', () => {
        const cls = {
            id: 1,
            name: 'Map Trigger',
            group: 0,
            runtimeClass: 104,
            rflClass: 104,
            fields: [{ name: 'Mission Bitmap ID', type: FIELD_INT }],
            data: [4421],
        };
        const classes = new Map([[2, new Map([[1, cls]])]]);
        expect(ootfMapSetBase({ path: 'Some/Level.lvl', classes })).toBe(4416);
    });
    it('falls back to the table by level path and gives null for arenas', () => {
        const none = new Map<number, Map<number, never>>();
        expect(ootfMapSetBase({ path: 'Islands World/Alwarren/Alwarren.lvl', classes: none as never })).toBe(4432);
        expect(ootfMapSetBase({ path: 'Multiplayer/Ground/Relic/Relic.lvl', classes: none as never })).toBeNull();
    });
});

describe('calibration', () => {
    const spec = { world: { x0: 10, z0: 20, x1: 30, z1: 60 }, picture: { x0: 0.25, y0: 0.5, x1: 0.75, y1: 1 } };
    it('puts the corners of the world on the corners of the picture rectangle', () => {
        expect(mapPixelOf(spec, 10 * 2048, 20 * 2048)).toEqual([64, 128]);
        expect(mapPixelOf(spec, 30 * 2048, 60 * 2048)).toEqual([192, 255]);
        expect(mapPixelOf(spec, 20 * 2048, 40 * 2048)).toEqual([128, 192]);
    });
    it('clamps points outside the world onto the picture', () => {
        expect(mapPixelOf(spec, -1e6, 1e7)).toEqual([0, 255]);
    });
    it('inverts', () => {
        const [x, z] = levelPointOfMapPixel(spec, 128, 192);
        expect([x, z]).toEqual([20, 40]);
    });
    it('writes the class fields in lu and texture pixels', () => {
        const v = Object.fromEntries(mapClassValues({ ...spec, image: { width: 1, height: 1, rgba: new Uint8Array(4) } }));
        expect(v['Upper Left Level Corner X (lu)']).toBe(10);
        expect(v['Lower Right Level Corner Z (lu)']).toBe(60);
        expect(v['Upper Left Map Corner X (pixels)']).toBe(64);
        expect(v['Lower Right Map Corner Z (pixels)']).toBe(MAP_TEXTURE_SIZE);
    });
});

describe('picture helpers', () => {
    it('finds the lit part of a parchment', () => {
        const w = 100;
        const h = 100;
        const rgba = new Uint8Array(w * h * 4);
        for (let y = 20; y < 80; y++) for (let x = 10; x < 90; x++) rgba.set([200, 180, 100, 255], (y * w + x) * 4);
        const r = pictureContent({ width: w, height: h, rgba });
        expect(r).toEqual({ x0: 0.1, y0: 0.2, x1: 0.9, y1: 0.8 });
    });
    it('stretches any picture over the 256 texture, bottom row first', () => {
        const img: TopDownImage = { width: 2, height: 2, rgba: Uint8Array.from([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255]) };
        const t = mapTextureImage(img);
        expect([t.width, t.height]).toEqual([256, 256]);
        const px = (x: number, row: number): number[] => [...t.rgba.subarray((row * 256 + x) * 4, (row * 256 + x) * 4 + 3)];
        expect(px(10, 255)).toEqual([255, 0, 0]); // top left of the picture is the last stored row
        expect(px(200, 255)).toEqual([0, 255, 0]);
        expect(px(10, 0)).toEqual([0, 0, 255]);
    });
    it('keeps the terrain box without stray cells', () => {
        const mk = (x: number, z: number, w: number, h: number) => ({
            originX: x,
            originZ: z,
            width: w,
            height: h,
            cellTexLeft: new Uint32Array(w * h),
            cellTexRight: new Uint32Array(w * h),
        });
        const r = worldRectOfTerrain([mk(100, 100, 100, 100), mk(0, 0, 1, 1)])!;
        expect(r.x0).toBe(100); // the single far cell is under 0.5 % of the cells
        expect(r.x1).toBe(200);
    });
    it('applies an override over the default', () => {
        const base: LevelMapSpec = {
            image: { width: 1, height: 1, rgba: new Uint8Array(4) },
            world: { x0: 0, z0: 0, x1: 10, z1: 10 },
            picture: { x0: 0, y0: 0, x1: 1, y1: 1 },
        };
        const out = applyMapOverride(base, { world: { x0: 1, z0: 1, x1: 5, z1: 5 } })!;
        expect(out.world.x1).toBe(5);
        expect(out.image).toBe(base.image);
        expect(applyMapOverride(base, undefined)).toBe(base);
    });
});
