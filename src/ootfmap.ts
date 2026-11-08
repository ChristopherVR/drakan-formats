// The level map of a converted Order of the Flame level: the picture, the world-to-picture calibration and the quest markers.
//
// A Drakan 2 level names its map in the "Map Object" field of its Level Properties object: a class of the level's own ODB
// ("Map Surdana") whose fields are the picture (`Map Texture`, a 256 x 256 texture of the level's TXD), the world rectangle in
// level units (`Upper Left / Lower Right Level Corner X / Z (lu)`, 1 lu = one terrain cell = 2048 world units) and the
// rectangle of the picture it covers (`Upper Left / Lower Right Map Corner X / Z (pixels)`). The map screen draws the picture,
// puts Rynn's arrow where her position falls inside the first rectangle, and draws each quest marker at its own
// `Map X / Y Coordinate` (picture pixels). The converted levels kept Surdana's class, so the map showed Surdana's picture with
// Rynn's arrow and the quest markers at Surdana's coordinates.
//
// Order of the Flame has no such class: its level maps are the parchments of `Dragon.rrc` (record type 0x40, ids 4368 to
// 4519, 16 bit textures), five tiles per level (two rows of 256 + 256 + 128 pixels, the right edge strips share the fifth tile)
// that join into one 640 x 480 picture. Which level uses which set is told by its Map Trigger class (`Mission Bitmap ID`
// default, text sheets that sit 5 ids after the tiles), by a short table for the levels without such a class.
// Evidence and measurements: docs/journal/2026-11-08/ootf-level-map.md.

import { view } from './bytes.ts';
import { decodePcTexture, type RgbaImage } from './ootftex.ts';
import type { OdbClass } from './odb.ts';
import { classFieldDefault } from './odb.ts';
import type { PcLevel } from './pc.ts';
import { TEX_HOLE, TEX_INVISIBLE } from './terrain.ts';
import type { SrscReader } from './srsc.ts';

/** Size of a composed Order of the Flame level map. */
export const OOTF_MAP_WIDTH = 640;
export const OOTF_MAP_HEIGHT = 480;
/** The map texture of a Drakan 2 level: 256 x 256 (the native map screen draws it at its own size). */
export const MAP_TEXTURE_SIZE = 256;
/** One level unit (lu) in world units: the size of a terrain cell. */
export const WORLD_UNITS_PER_LU = 2048;

/** Rectangle in level units (`x` east, `z` south, as the terrain cells count). */
export interface LevelRect {
    x0: number;
    z0: number;
    x1: number;
    z1: number;
}

/** Rectangle as fractions of a picture (0 = left / top edge, 1 = right / bottom edge). */
export interface PictureRect {
    x0: number;
    y0: number;
    x1: number;
    y1: number;
}

/** A picture, top row first. */
export interface TopDownImage {
    width: number;
    height: number;
    /** RGBA8, `width * height * 4`. */
    rgba: Uint8Array;
}

/**
 * Everything the converter (or the editor) decides about one level's map: the picture, the world rectangle and the part of
 * the picture it covers.
 */
export interface LevelMapSpec {
    image: TopDownImage;
    world: LevelRect;
    picture: PictureRect;
}

/** What a user may change: any part of the default (a missing picture or rectangle keeps the converter's own). */
export interface LevelMapOverride {
    image?: TopDownImage;
    world?: LevelRect;
    picture?: PictureRect;
}

/** The Dragon.rrc tile set of a level without a Map Trigger class (found by looking at the parchments). */
export const OOTF_MAP_SETS_BY_LEVEL: ReadonlyMap<string, number> = new Map([
    ['mountain world/ruined village/ruined village.lvl', 4416],
    ['mountain world/wartok canyons/wartok canyons.lvl', 4368],
    ['mountain world/grotto/grotto.lvl', 4400],
    ['mountain world/grimstone mines/mines.lvl', 4448],
    ['islands world/islands/islands.lvl', 4384],
    ['islands world/islands night/islands night.lvl', 4384],
    ['islands world/alwarren/alwarren.lvl', 4432],
    ['islands world/rift crystal/rift crystal.lvl', 4464],
    ['islands world/succubus lair/succubus lair.lvl', 4496],
    ['volcanic world/volcano/volcano.lvl', 4512],
]);

/** Tiles per set (tile k is record `base + k`) and the offset of the first text sheet. */
const TILES = 5;

/** The first tile id of a level's parchment set, or null (arenas, the intro, the book levels have no map). */
export function ootfMapSetBase(pc: Pick<PcLevel, 'path' | 'classes'>): number | null {
    for (const table of pc.classes.values())
        for (const c of table.values()) {
            if (c.rflClass !== 104) continue;
            const i = c.fields?.findIndex((f) => f.name === 'Mission Bitmap ID') ?? -1;
            const id = i >= 0 ? Number(classFieldDefault(c, i)) : 0;
            // the text sheet (mission bitmap) sits after the five tiles of its set
            if (id >= TILES && Number.isFinite(id) && id % 16 === TILES) return id - TILES;
        }
    return OOTF_MAP_SETS_BY_LEVEL.get(pc.path.toLowerCase()) ?? null;
}

/**
 * Join the five 256 x 256 tiles of a set into the 640 x 480 parchment. Tiles 0 / 1 are the top row, 2 / 3 the bottom row
 * (224 rows used), tile 4 holds the 128 pixel wide right edge of both rows side by side. Returns null when a tile is missing.
 */
export async function loadOotfMapPicture(rrc: SrscReader, base: number): Promise<TopDownImage | null> {
    const tiles: RgbaImage[] = [];
    for (let k = 0; k < TILES; k++) {
        const e = rrc.entries.find((x) => x.type === 0x40 && x.id === base + k);
        if (!e) return null;
        try {
            tiles.push(decodePcTexture(await rrc.readRaw(e), null).image);
        } catch {
            return null;
        }
    }
    if (tiles.some((t) => t.width !== 256 || t.height !== 256)) return null;
    const out = new Uint8Array(OOTF_MAP_WIDTH * OOTF_MAP_HEIGHT * 4);
    // `tile(k, x, y)` reads a pixel with y counted from the top (the records store the bottom row first).
    const put = (k: number, sx: number, sy: number, w: number, h: number, dx: number, dy: number): void => {
        const t = tiles[k]!;
        for (let y = 0; y < h; y++)
            for (let x = 0; x < w; x++) {
                const s = ((255 - (sy + y)) * 256 + sx + x) * 4;
                const d = ((dy + y) * OOTF_MAP_WIDTH + dx + x) * 4;
                out[d] = t.rgba[s]!;
                out[d + 1] = t.rgba[s + 1]!;
                out[d + 2] = t.rgba[s + 2]!;
                out[d + 3] = 255;
            }
    };
    put(0, 0, 0, 256, 256, 0, 0);
    put(1, 0, 0, 256, 256, 256, 0);
    put(4, 0, 0, 128, 256, 512, 0);
    put(2, 0, 0, 256, 224, 0, 256);
    put(3, 0, 0, 256, 224, 256, 256);
    put(4, 128, 0, 128, 224, 512, 256);
    return { width: OOTF_MAP_WIDTH, height: OOTF_MAP_HEIGHT, rgba: out };
}

/** Bounding box (fractions of the picture) of the lit part of a parchment: everything that is not near black. */
export function pictureContent(img: TopDownImage, threshold = 40): PictureRect {
    let x0 = img.width;
    let y0 = img.height;
    let x1 = -1;
    let y1 = -1;
    const lit = (i: number): boolean =>
        img.rgba[i * 4 + 3]! > 0 &&
        img.rgba[i * 4]! + img.rgba[i * 4 + 1]! + img.rgba[i * 4 + 2]! > threshold * 3;
    // rows / columns need a run of lit pixels, so single stray pixels of a torn edge do not count
    const rowLit = new Array<number>(img.height).fill(0);
    const colLit = new Array<number>(img.width).fill(0);
    for (let y = 0; y < img.height; y++)
        for (let x = 0; x < img.width; x++)
            if (lit(y * img.width + x)) {
                rowLit[y]!++;
                colLit[x]!++;
            }
    for (let y = 0; y < img.height; y++)
        if (rowLit[y]! >= img.width * 0.05) {
            y0 = Math.min(y0, y);
            y1 = Math.max(y1, y);
        }
    for (let x = 0; x < img.width; x++)
        if (colLit[x]! >= img.height * 0.05) {
            x0 = Math.min(x0, x);
            x1 = Math.max(x1, x);
        }
    if (x1 < 0 || y1 < 0) return { x0: 0, y0: 0, x1: 1, y1: 1 };
    return { x0: x0 / img.width, y0: y0 / img.height, x1: (x1 + 1) / img.width, y1: (y1 + 1) / img.height };
}

/**
 * The part of the world a level covers, in level units: the box around the terrain cells that hold ground, ignoring the
 * outermost 0.5 % of cells on every side (Ruined Village has a few stray cells far from its valley).
 */
export function worldRectOfTerrain(
    layers: readonly {
        originX: number;
        originZ: number;
        width: number;
        height: number;
        cellTexLeft: ArrayLike<number>;
        cellTexRight: ArrayLike<number>;
    }[],
): LevelRect | null {
    const xs: number[] = [];
    const zs: number[] = [];
    for (const L of layers)
        for (let j = 0; j < L.height; j++)
            for (let i = 0; i < L.width; i++) {
                const k = j * L.width + i;
                const a = L.cellTexLeft[k]!;
                const b = L.cellTexRight[k]!;
                if ((a === TEX_HOLE || a === TEX_INVISIBLE) && (b === TEX_HOLE || b === TEX_INVISIBLE)) continue;
                xs.push(L.originX + i);
                zs.push(L.originZ + j);
            }
    if (!xs.length) return null;
    xs.sort((p, q) => p - q);
    zs.sort((p, q) => p - q);
    const cut = Math.floor(xs.length * 0.005);
    return { x0: xs[cut]!, z0: zs[cut]!, x1: xs[xs.length - 1 - cut]! + 1, z1: zs[zs.length - 1 - cut]! + 1 };
}

/** The converter's own map of a level: the parchment, the terrain's world rectangle and the parchment's lit part. */
export async function defaultLevelMap(pc: PcLevel, rrc: SrscReader): Promise<LevelMapSpec | null> {
    const base = ootfMapSetBase(pc);
    if (base === null) return null;
    const image = await loadOotfMapPicture(rrc, base);
    const world = worldRectOfTerrain(pc.terrain);
    if (!image || !world) return null;
    return { image, world, picture: pictureContent(image) };
}

/** Apply a user's choices on top of the default. */
export function applyMapOverride(base: LevelMapSpec | null, o: LevelMapOverride | undefined): LevelMapSpec | null {
    if (!o) return base;
    const image = o.image ?? base?.image;
    const world = o.world ?? base?.world;
    if (!image || !world) return base;
    return { image, world, picture: o.picture ?? base?.picture ?? { x0: 0, y0: 0, x1: 1, y1: 1 } };
}

/** The picture a texture is made of: the user's picture stretched to the 256 x 256 square the engine draws. */
export function mapTextureImage(img: TopDownImage): RgbaImage {
    const n = MAP_TEXTURE_SIZE;
    const out = new Uint8Array(n * n * 4);
    for (let y = 0; y < n; y++) {
        // area average over the source rows / columns that fall into the texel (the parchments shrink by 2.5 and 1.9)
        const sy0 = (y * img.height) / n;
        const sy1 = ((y + 1) * img.height) / n;
        for (let x = 0; x < n; x++) {
            const sx0 = (x * img.width) / n;
            const sx1 = ((x + 1) * img.width) / n;
            let r = 0;
            let g = 0;
            let b = 0;
            let a = 0;
            let wsum = 0;
            for (let yy = Math.floor(sy0); yy < Math.ceil(sy1); yy++) {
                const wy = Math.min(yy + 1, sy1) - Math.max(yy, sy0);
                for (let xx = Math.floor(sx0); xx < Math.ceil(sx1); xx++) {
                    const w = wy * (Math.min(xx + 1, sx1) - Math.max(xx, sx0));
                    const s = (yy * img.width + xx) * 4;
                    const al = img.rgba[s + 3]! * w;
                    r += img.rgba[s]! * al;
                    g += img.rgba[s + 1]! * al;
                    b += img.rgba[s + 2]! * al;
                    a += al;
                    wsum += w;
                }
            }
            // the texture rows are stored bottom first
            const d = ((n - 1 - y) * n + x) * 4;
            out[d] = a ? Math.round(r / a) : 0;
            out[d + 1] = a ? Math.round(g / a) : 0;
            out[d + 2] = a ? Math.round(b / a) : 0;
            out[d + 3] = wsum ? Math.round(a / wsum) : 255;
        }
    }
    return { width: n, height: n, rgba: out };
}

/** The values of a Drakan 2 Map class for a spec: the picture rectangle in texture pixels, the world rectangle in lu. */
export function mapClassValues(spec: LevelMapSpec): [string, number][] {
    const n = MAP_TEXTURE_SIZE;
    const r = (v: number): number => Math.round(v);
    return [
        ['Upper Left Level Corner X (lu)', r(spec.world.x0)],
        ['Upper Left Level Corner Z (lu)', r(spec.world.z0)],
        ['Lower Right Level Corner X (lu)', r(spec.world.x1)],
        ['Lower Right Level Corner Z (lu)', r(spec.world.z1)],
        ['Upper Left Map Corner X (pixels)', r(spec.picture.x0 * n)],
        ['Upper Left Map Corner Z (pixels)', r(spec.picture.y0 * n)],
        ['Lower Right Map Corner X (pixels)', r(spec.picture.x1 * n)],
        ['Lower Right Map Corner Z (pixels)', r(spec.picture.y1 * n)],
    ];
}

/**
 * Where a world position falls on the 256 x 256 map texture (what a quest marker's `Map X / Y Coordinate` holds), the same
 * linear map the engine uses for Rynn's arrow; clamped onto the picture.
 */
export function mapPixelOf(spec: Pick<LevelMapSpec, 'world' | 'picture'>, x: number, z: number): [number, number] {
    const n = MAP_TEXTURE_SIZE;
    const lx = x / WORLD_UNITS_PER_LU;
    const lz = z / WORLD_UNITS_PER_LU;
    const w = spec.world;
    const p = spec.picture;
    const u = (lx - w.x0) / Math.max(1e-6, w.x1 - w.x0);
    const v = (lz - w.z0) / Math.max(1e-6, w.z1 - w.z0);
    const px = (p.x0 + u * (p.x1 - p.x0)) * n;
    const py = (p.y0 + v * (p.y1 - p.y0)) * n;
    return [Math.max(0, Math.min(n - 1, Math.round(px))), Math.max(0, Math.min(n - 1, Math.round(py)))];
}

/** The inverse: the world position (lu) under a point of the 256 x 256 texture. */
export function levelPointOfMapPixel(spec: Pick<LevelMapSpec, 'world' | 'picture'>, px: number, py: number): [number, number] {
    const n = MAP_TEXTURE_SIZE;
    const w = spec.world;
    const p = spec.picture;
    const u = (px / n - p.x0) / Math.max(1e-6, p.x1 - p.x0);
    const v = (py / n - p.y0) / Math.max(1e-6, p.y1 - p.y0);
    return [w.x0 + u * (w.x1 - w.x0), w.z0 + v * (w.z1 - w.z0)];
}

/** Field index by name (trimmed, case-insensitive) of a class, -1 when missing. */
export function classFieldIndex(c: Pick<OdbClass, 'fields'>, name: string): number {
    const want = name.trim().toLowerCase();
    return c.fields?.findIndex((f) => f.name.trim().toLowerCase() === want) ?? -1;
}

/** True for the class the engine reads a level map from (`Map Texture` first, then the two rectangles). */
export function isMapClass(c: Pick<OdbClass, 'fields'>): boolean {
    return c.fields?.[0]?.name.trim() === 'Map Texture' && classFieldIndex(c, 'Upper Left Level Corner X (lu)') > 0;
}

/** For tests: the u32 at an offset of a texture body (width). */
export function textureWidthOfBody(body: Uint8Array): number {
    return view(body).getUint32(0, true);
}
