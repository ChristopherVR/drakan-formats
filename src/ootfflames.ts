// Drakan 2 particle fire for converted Order of the Flame flames (engine class 20; docs/journal/2026-11-14/ootf-flames.md).
//
// A PC flame is a flat animated card standing on a separate torch, sconce or brazier prop. The converter clones its class
// from the disc's RESOURES "Wall Torch", whose record names a light, a fire generator and a sound. The engine's class 20
// object (vtable 0x530678) starts all three together when its object comes within range (tick 0x366828, start 0x3669f0)
// and on the "on" messages, and stops them out of range or on "off". The light lived, the fire did not: "Wall Torch Flame
// Gen" has a life time of 0.3 s (every generator of a placed Drakan 2 torch has 0, forever), so it died at once and the
// tick, which only restarts a flame whose generator handle is empty, never started it again.
//
// With a `flames` row of the Drakan 2 model table on (ootfps2model.ts) a converted flame class names the fire generator of
// the row's Drakan 2 torch class instead (WORLDCON "OTF Wall Torch", Surdana's own Order of the Flame torch), its model
// becomes the disc's invisible particle carrier ("nullparticle", the model disc projectiles carry their particles on), and
// each placed flame moves to the foot of its OotF flame card: the generator, light and sound start at the object's origin,
// and Drakan 2 torches keep their origin where the fire burns. Light, sound, flags, links and messages stay as they were.
// The Drakan 2 fire does not scale with the object: a flame placed smaller than `FLAME_SMALL_SCALE` (Islands' hanging lamps
// at 0.2) names the fire of a Drakan 2 candle in its own parameters instead.

import type { LvlObject } from './lvl.ts';
import { placementYaw } from './ootfpush.ts';
import { CELL_SIZE } from './terrain.ts';

/** Engine class of a flame (PC and PS2). */
export const FLAME_RFL = 20;
/** The class 20 field naming the fire generator. */
export const FLAME_FIRE_FIELD = 'Fire Particles';
/** Disc model (host MOD, a two-triangle card with a fully transparent texture) that converted flames show. */
export const FLAME_CARRIER_MODEL = 'nullparticle';
/** Flames placed smaller than this (largest axis) burn with the candle fire (`FLAME_SMALL_TORCH`). */
export const FLAME_SMALL_SCALE = 0.5;
/** The Drakan 2 class (WORLDCON) whose fire small flames take. */
export const FLAME_SMALL_TORCH = 'Candle01';

/** True when a placed flame is small enough for the candle fire. */
export function isSmallFlame(o: Pick<LvlObject, 'scale'>): boolean {
    return !!o.scale && Math.max(...o.scale) < FLAME_SMALL_SCALE;
}

/**
 * Foot of a flame card in model units: the centre of its box across (x, z) and its lowest point (y). Null for no vertices.
 */
export function flameFoot(positions: ArrayLike<number>): [number, number, number] | null {
    if (positions.length < 3) return null;
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i + 2 < positions.length; i += 3)
        for (let k = 0; k < 3; k++) {
            min[k] = Math.min(min[k]!, positions[i + k]!);
            max[k] = Math.max(max[k]!, positions[i + k]!);
        }
    return [(min[0]! + max[0]!) / 2, min[1]!, (min[2]! + max[2]!) / 2];
}

/**
 * World offset of model point `p` (model units) of a placed object: its scale, then its turn about y as the engine places
 * models (`worldBox` in ootfpush.ts). Null for a tilted placement (no Euler order is known for x / z).
 */
export function placedOffset(
    o: Pick<LvlObject, 'rot' | 'scale'>,
    p: readonly [number, number, number],
): [number, number, number] | null {
    if ((o.rot[0] ?? 0) % 360 !== 0 || (o.rot[2] ?? 0) % 360 !== 0) return null;
    const s = o.scale ?? [1, 1, 1];
    const a = placementYaw(o);
    const c = Math.cos(a);
    const sn = Math.sin(a);
    const lx = p[0] * CELL_SIZE * s[0]!;
    const ly = p[1] * CELL_SIZE * s[1]!;
    const lz = p[2] * CELL_SIZE * s[2]!;
    return [lx * c + lz * sn, ly, -lx * sn + lz * c];
}

/**
 * A class reference (`db << 16 | id`) read in the frame of database `from` rewritten for database `to`: `containerStem`
 * names the database a `.DB` index of `from` stands for (0: `from` itself), `dbIndexIn` the index `to`'s `.DB` gives a
 * database (0: `to` itself, null: not listed). Null when either does not resolve or the reference is empty.
 */
export function moveClassRef(
    ref: number,
    from: string,
    to: string,
    containerStem: (stem: string, db: number) => string | null,
    dbIndexIn: (from: string, to: string) => number | null,
): number | null {
    const id = ref & 0xffff;
    if (!id) return null;
    const stem = containerStem(from, ref >>> 16);
    const db = stem === null ? null : dbIndexIn(to, stem);
    return db === null ? null : ((db << 16) | id) >>> 0;
}

/** Feet closer than this to the origin (model units, about 200 world units) also move on a tilted placement. */
export const FLAME_TILT_REACH = 0.1;

/**
 * Where a placed flame's fire must start, relative to its origin: the foot `foot` placed as the object is. A tilted placement
 * (Succubus Lair's leaning sconces) only knows its turn about y, so its foot moves by that turn alone when it lies within
 * `FLAME_TILT_REACH` of the origin (the error is a few world units); a farther foot of a tilted flame gives null.
 */
export function flameOffset(
    o: Pick<LvlObject, 'rot' | 'scale'>,
    foot: readonly [number, number, number],
): [number, number, number] | null {
    const d = placedOffset(o, foot);
    if (d || Math.hypot(...foot) > FLAME_TILT_REACH) return d;
    return placedOffset({ rot: [0, o.rot[1] ?? 0, 0], scale: o.scale }, foot);
}
