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

import {
    FIELD_CLASS,
    FIELD_FLOAT,
    FIELD_INT,
    FIELD_MODEL,
    FIELD_SOUND,
    FIELD_TEXTURE,
    fieldBase,
    fieldIsIndirect,
    type ClassFieldDef,
} from './fields.ts';
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
 * Part of the card's height the fire starts above its lowest point: low enough to burn inside the cages and bowls, high
 * enough that the coal under the card does not hide the base of the fire (Rift Crystal's standing torches).
 */
export const FLAME_FOOT_RISE = 0.2;

/**
 * Foot of a flame card in model units: the centre of its box across (x, z) and `FLAME_FOOT_RISE` of its height above its
 * lowest point (y). Null for no vertices.
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
    return [(min[0]! + max[0]!) / 2, min[1]! + FLAME_FOOT_RISE * (max[1]! - min[1]!), (min[2]! + max[2]!) / 2];
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

/** Particle fields a fire scale multiplies (sizes and rise speed, so the flame grows in width and height alike). */
export const FIRE_SCALED_FIELDS = ['Min Particle Size (wu)', 'Max Particle Size (wu)', 'Release Velocity (lu/s)'];
/** Integer particle fields the scale multiplies (the flame keeps its density at the larger size). */
export const FIRE_SCALED_COUNTS = ['Particles Per Second'];

/**
 * Data of a class copied into another database: every class, model, sound and texture reference (scalar or array) is
 * named from the new database (`move`, null = not reachable there: 0, or left out of an array); with `scale` the particle
 * size, rise speed and rate fields grow by that factor. `data` holds the field dwords followed by the arrays they point at.
 */
export function movedClassData(
    fields: readonly ClassFieldDef[],
    data: readonly number[],
    move: (ref: number) => number | null,
    scale = 1,
): number[] {
    const out = [...data];
    const isRef = (t: number) => [FIELD_CLASS, FIELD_MODEL, FIELD_SOUND, FIELD_TEXTURE].includes(fieldBase(t));
    fields.forEach((f, i) => {
        const v = out[i];
        if (v === undefined) return;
        const name = f.name.trim();
        if (isRef(f.type)) {
            if (fieldIsIndirect(f.type)) {
                const n = v >>> 16;
                const at = v & 0xffff;
                const kept = out
                    .slice(at, at + n)
                    .map((r) => (r ? move(r) : 0))
                    .filter((r): r is number => !!r);
                for (let k = 0; k < n; k++) out[at + k] = kept[k] ?? 0;
                out[i] = ((kept.length << 16) | at) >>> 0;
            } else out[i] = v ? (move(v) ?? 0) : 0;
            return;
        }
        if (scale === 1) return;
        if (fieldBase(f.type) === FIELD_FLOAT && FIRE_SCALED_FIELDS.includes(name)) {
            const dv = new DataView(new ArrayBuffer(4));
            dv.setUint32(0, v >>> 0);
            dv.setFloat32(0, dv.getFloat32(0) * scale);
            out[i] = dv.getUint32(0);
        } else if (fieldBase(f.type) === FIELD_INT && FIRE_SCALED_COUNTS.includes(name))
            out[i] = Math.round((v | 0) * scale);
    });
    return out;
}

/**
 * Polygons of an OotF flame model that stand upright (the flame cards: normal within about 45 degrees of level). The rest
 * lie flat: the glowing embers some flames lay over their torch's coal (the standing torches of the Islands levels); they
 * stay when the cards give way to the Drakan 2 fire.
 */
export function uprightPolygons(
    positions: ArrayLike<number>,
    polygons: readonly { indices: readonly number[] }[],
): Set<number> {
    const up = new Set<number>();
    polygons.forEach((p, i) => {
        const v = (k: number) => [positions[k * 3]!, positions[k * 3 + 1]!, positions[k * 3 + 2]!];
        if (p.indices.length < 3) return up.add(i);
        const [a, b, c] = [v(p.indices[0]!), v(p.indices[1]!), v(p.indices[2]!)] as [number[], number[], number[]];
        const u = [b[0]! - a[0]!, b[1]! - a[1]!, b[2]! - a[2]!];
        const w = [c[0]! - a[0]!, c[1]! - a[1]!, c[2]! - a[2]!];
        const n = [u[1]! * w[2]! - u[2]! * w[1]!, u[2]! * w[0]! - u[0]! * w[2]!, u[0]! * w[1]! - u[1]! * w[0]!];
        const len = Math.hypot(n[0]!, n[1]!, n[2]!);
        if (!(len > 0) || Math.abs(n[1]!) / len < Math.SQRT1_2) up.add(i);
    });
    return up;
}
