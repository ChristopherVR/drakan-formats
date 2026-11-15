/**
 * Ground snap: Order of the Flame objects that stand on the ground but float over it (or hang under it) in the converted
 * levels (journal 2026-11-15/ootf-ground-placement.md, 2026-11-16/ootf-ground-snap-and-rock.md).
 *
 * * Trees (`isGroundableTree`): the PC data places most trunks with their base at or under the ground at the origin, so on a
 *   slope the downhill side of the trunk floats (up to about 150 units; a few trees float all round). A tree whose trunk
 *   base is over the ground at any sample of its trunk footprint drops until the base meets the lowest ground under the
 *   trunk, so no side floats and the uphill side goes into the ground (`groundSnapHeight`, kind `tree`).
 * * Other ground objects (kind `prop`: crates, barrels, chests, tables ...): only one that floats all round by a little
 *   (`PROP_MAX_DROP`) drops, and only until its base touches the highest ground under it, so a flat base on a slope is
 *   not buried on its uphill side; anything higher stands on something or hangs on purpose.
 * * Classes drawn with a Drakan 2 model of their own (a PC class the converter maps by name onto a disc class: the
 *   Ballista's "Ballisata Base") keep the PC model's bottom: the disc base has its origin on top (1558 units over its
 *   bottom), the PC one at the bottom, so the converted base was drawn under the ground and the ballista floated on its
 *   swivel (`nativeModelLift`).
 *
 * An object is never raised by the snap and never moved when another object's mesh is under its footprint between the
 * terrain and its base (bridges, floors, ledges, rocks: `meshUnder`), when no terrain is under it, or when the terrain
 * under the footprint rises more than `TREE_MAX_RANGE` (a cliff edge). On by default; `DRAKAN_TREE_GROUNDING=off` or the
 * option `treeGrounding: false` keeps the PC heights.
 */

/** World units per model unit. */
const MODEL_UNIT = 2048;

/** Bottom of a model: its lowest point and the horizontal outline of the vertices near it (model units). */
export interface TrunkFootprint {
    /** Lowest y of the model (model units, normally negative: under the origin). */
    foot: number;
    /** (x, z) of the vertices within `TRUNK_BAND` of the lowest point, plus their centre. */
    ring: [number, number][];
}

/** Share of the model's height above its lowest point that counts as its base ... */
export const TRUNK_BAND = 0.05;
/** ... but at most this many world units (unscaled): a Drakan 2 pine's lowest branches reach down near its trunk's foot. */
export const TRUNK_BAND_MAX = 48;
/** A tree is touching the ground when its trunk base is within this of the lowest ground under it (world units). */
export const TREE_TOUCH_TOLERANCE = 4;
/** Largest drop applied to a tree (world units); a tree higher than this over the terrain stands on something else. */
export const TREE_MAX_DROP = 1200;
/** Largest rise of the terrain under a footprint (world units) for a move: more is a cliff edge or a step, left alone. */
export const TREE_MAX_RANGE = 512;
/** A prop floating all round by more than this and at most `PROP_MAX_DROP` drops onto the ground (world units). */
export const PROP_TOUCH_TOLERANCE = 4;
/** Largest drop applied to a prop (world units); higher props stand on something or hang (sconces, books on shelves). */
export const PROP_MAX_DROP = 96;
/** Largest footprint radius of a prop (world units): wider objects are architecture (walls, arches, pits, rooms). */
export const PROP_MAX_RADIUS = 600;
/** A mesh under the footprint counts as a support from this far over the terrain (world units). */
export const SUPPORT_CLEARANCE = 8;
/** ... up to this far over the object's base (a base set slightly into a floor). */
export const SUPPORT_OVER_BASE = 32;
/** Smallest native-model lift applied (world units). */
export const NATIVE_LIFT_MIN = 16;

/** The footprint of a model given its vertex positions (x, y, z per vertex, model units); null without vertices. */
export function trunkFootprint(positions: ArrayLike<number>): TrunkFootprint | null {
    const n = Math.floor(positions.length / 3);
    if (!n) return null;
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < n; i++) {
        lo = Math.min(lo, positions[i * 3 + 1]!);
        hi = Math.max(hi, positions[i * 3 + 1]!);
    }
    if (!Number.isFinite(lo)) return null;
    const cut = lo + Math.min((hi - lo) * TRUNK_BAND, TRUNK_BAND_MAX / MODEL_UNIT);
    const ring: [number, number][] = [];
    let cx = 0;
    let cz = 0;
    for (let i = 0; i < n; i++) {
        if (positions[i * 3 + 1]! > cut) continue;
        ring.push([positions[i * 3]!, positions[i * 3 + 2]!]);
        cx += positions[i * 3]!;
        cz += positions[i * 3 + 2]!;
    }
    // Keep at most 64 outline points (a large base has hundreds) and the centre.
    const step = Math.ceil(ring.length / 64);
    const kept = step > 1 ? ring.filter((_, i) => i % step === 0) : ring;
    kept.push([cx / ring.length, cz / ring.length]);
    return { foot: lo, ring: kept };
}

export interface TreeGroundInput {
    /** Object origin (world units). */
    pos: readonly number[];
    /** Rotation words in degrees (x, y, z); only the turn about y moves the footprint (the engine turns by y - 90). */
    rot?: readonly number[];
    /** Object scale (x, y, z); null or absent is 1. */
    scale?: readonly number[] | null;
}

/** World (x, z) of the footprint's samples for an object (turned by the stored y minus 90 degrees and scaled). */
export function footprintSamples(o: TreeGroundInput, f: TrunkFootprint): [number, number][] {
    const s = o.scale && o.scale.length === 3 ? o.scale : [1, 1, 1];
    const yaw = ((((o.rot?.[1] ?? 0) - 90) % 360) * Math.PI) / 180;
    const c = Math.cos(yaw);
    const sn = Math.sin(yaw);
    return f.ring.map(([mx, mz]) => {
        const x = mx * MODEL_UNIT * s[0]!;
        const z = mz * MODEL_UNIT * s[2]!;
        return [o.pos[0]! + x * c + z * sn, o.pos[2]! - x * sn + z * c];
    });
}

/** World height of the footprint's base (`pos.y + foot * scale.y`). */
export function footprintBase(o: TreeGroundInput, f: TrunkFootprint): number {
    const s = o.scale && o.scale.length === 3 ? o.scale : [1, 1, 1];
    return o.pos[1]! + f.foot * MODEL_UNIT * s[1]!;
}

export type GroundKind = 'tree' | 'prop';

/** Why an object was left (or `moved`). */
export type GroundVerdict = 'moved' | 'touching' | 'no-ground' | 'too-high' | 'cliff' | 'large' | 'supported';

export interface GroundSnapResult {
    verdict: GroundVerdict;
    /** New origin height when moved. */
    y?: number;
    /** Base over the lowest / highest ground under the footprint (world units). */
    floatLow: number;
    floatAll: number;
}

/**
 * Snap of one object: `groundAt(x, z)` is the terrain under a point (NaN where there is none: such a sample does not
 * count), `meshAt(x, z, top)` the highest surface of another object's mesh under (x, z) at or below `top` (NaN when none;
 * omitted = none). See the module comment for the rules.
 */
export function groundSnap(
    o: TreeGroundInput,
    f: TrunkFootprint,
    kind: GroundKind,
    groundAt: (x: number, z: number) => number,
    meshAt?: (x: number, z: number, top: number) => number,
): GroundSnapResult {
    const base = footprintBase(o, f);
    const pts = footprintSamples(o, f);
    let low = Infinity;
    let high = -Infinity;
    const grounds: number[] = [];
    for (const [x, z] of pts) {
        const g = groundAt(x, z);
        grounds.push(g);
        if (!Number.isFinite(g)) continue;
        low = Math.min(low, g);
        high = Math.max(high, g);
    }
    if (!Number.isFinite(low)) return { verdict: 'no-ground', floatLow: NaN, floatAll: NaN };
    const floatLow = base - low;
    const floatAll = base - high;
    const r = (verdict: GroundVerdict, y?: number): GroundSnapResult => ({ verdict, y, floatLow, floatAll });
    const drop =
        kind === 'tree'
            ? floatLow > TREE_TOUCH_TOLERANCE
                ? floatLow
                : 0
            : floatAll > PROP_TOUCH_TOLERANCE
              ? floatAll
              : 0;
    if (!drop) return r('touching');
    if (drop > (kind === 'tree' ? TREE_MAX_DROP : PROP_MAX_DROP)) return r('too-high');
    if (kind === 'prop' && pts.some(([x, z]) => Math.hypot(x - o.pos[0]!, z - o.pos[2]!) > PROP_MAX_RADIUS))
        return r('large');
    if (high - low > TREE_MAX_RANGE) return r('cliff');
    if (meshAt)
        for (let i = 0; i < pts.length; i++) {
            const g = grounds[i]!;
            const m = meshAt(pts[i]![0], pts[i]![1], base + SUPPORT_OVER_BASE);
            if (Number.isFinite(m) && (!Number.isFinite(g) || m > g + SUPPORT_CLEARANCE)) return r('supported');
        }
    return r('moved', o.pos[1]! - drop);
}

/**
 * New origin height for a floating tree, or null to leave it (`groundSnap` of kind `tree` without meshes): the trunk base
 * is over the lowest ground under the trunk footprint by more than `TREE_TOUCH_TOLERANCE`; the tree drops until it meets it.
 */
export function treeGroundHeight(
    o: TreeGroundInput,
    f: TrunkFootprint,
    groundAt: (x: number, z: number) => number,
): number | null {
    const s = groundSnap(o, f, 'tree', groundAt);
    return s.verdict === 'moved' ? s.y! : null;
}

/**
 * Height to add to an object whose class is drawn with another model than its PC one (a disc class of the same name), so
 * the drawn model's bottom stays where the PC model's bottom was: `(pcFoot - drawnFoot) * scale.y` in world units. Null
 * below `NATIVE_LIFT_MIN`.
 */
export function nativeModelLift(pcFoot: number, drawnFoot: number, scaleY = 1): number | null {
    const d = (pcFoot - drawnFoot) * MODEL_UNIT * scaleY;
    return Math.abs(d) >= NATIVE_LIFT_MIN ? d : null;
}

/**
 * Height under the top of a disc "Ballisata Base" at which the disc seats its "Ballista" (world units): LEVEL1NA places
 * three of its four ballistas on a base 495 under the base's origin (its top), the fourth 355; the swivel then reaches
 * 1285 under the ballista, into the base.
 */
export const BALLISTA_UNDER_BASE_TOP = 495;

/** Height of a turret (engine class 37 "Ballista") seated on a disc base whose origin (top) is at `baseY`; null for others. */
export function turretOnBase(cls: { name: string; rflClass?: number }, baseY: number): number | null {
    return cls.rflClass === 37 && /^ballista$/i.test(cls.name.trim()) ? baseY - BALLISTA_UNDER_BASE_TOP : null;
}

/** Lowest y of a model (model units), or null without vertices. */
export function modelFoot(positions: ArrayLike<number>): number | null {
    let lo = Infinity;
    for (let i = 1; i < positions.length; i += 3) lo = Math.min(lo, positions[i]!);
    return Number.isFinite(lo) ? lo : null;
}

/**
 * A placed class that is a tree: a ground object (engine class 17) named as a tree, pine or palm (Large Tree, MedTree,
 * Small Tree, their snowy kinds, the palms), or a class the Drakan 2 model table draws as a tree. Trees that fall when
 * pushed or struck (the PC `Push Over Mode` set: Ruined Village's push tree and its base) are puzzle pieces and are left.
 */
export function isGroundableTree(
    cls: { name: string; rflClass?: number },
    pushOver: number,
    swappedTree = false,
): boolean {
    if (cls.rflClass !== 17 || pushOver) return false;
    const n = cls.name.trim();
    if (/push|stump|base|log|fallen|dead|burnt/i.test(n)) return false;
    return swappedTree || /\btree\b|tree\s*\(|^smalltree$|^medtree$|pine|palm/i.test(n);
}

/**
 * A placed class that stands on the ground as a prop (kind `prop`): a ground object (17) that is not a tree, not a
 * push-over piece, not an invisible helper (Bounding Box, Invisible Wall, plugs) and not a hanging or wall-mounted one
 * (sconces, hanging torches, banners, vines, lamps, stalactites, cocoons, cages, bodies).
 */
export function isGroundableProp(cls: { name: string; rflClass?: number }, pushOver: number): boolean {
    if (cls.rflClass !== 17 || pushOver) return false;
    const n = cls.name.trim();
    if (isGroundableTree(cls, 0)) return false;
    return !/bounding|invisible|plug|sconce|hang|banner|vine|ivy|lamp|stalag|cocoon|cage|body|guy|skeleton|torso|web|chain|rope|flag|glass|book|candle|light|backdrop|pressure|plate base|switch|lever|pit|room|arch|wall|mirror|cart|cog|hole|pillar|statue|door|gate|stair|floor|bridge|dummy|sanctum|timber/i.test(
        n,
    );
}

/** Ground snap on unless the option says false or the env says off / 0. */
export function treeGroundingOn(option: boolean | undefined, env: Record<string, string | undefined>): boolean {
    if (option === false) return false;
    const v = env['DRAKAN_TREE_GROUNDING']?.trim().toLowerCase();
    return !(v === 'off' || v === '0' || v === 'false');
}

/** One placed mesh for `meshUnder`: world-space triangles (9 numbers each) and their box. */
export interface PlacedMesh {
    id: number;
    tris: Float32Array;
    min: [number, number, number];
    max: [number, number, number];
}

/**
 * World triangles of a model placed upright (turned by y - 90, scaled), or null for a tilted placement (no Euler order is
 * known for x / z). `polygons` index `positions` (model units); polygons with more than three corners are fanned.
 */
export function placeMesh(
    id: number,
    o: TreeGroundInput,
    positions: ArrayLike<number>,
    polygons: readonly { indices: readonly number[] }[],
): PlacedMesh | null {
    if ((o.rot?.[0] ?? 0) % 360 !== 0 || (o.rot?.[2] ?? 0) % 360 !== 0) return null;
    const s = o.scale && o.scale.length === 3 ? o.scale : [1, 1, 1];
    const yaw = ((((o.rot?.[1] ?? 0) - 90) % 360) * Math.PI) / 180;
    const c = Math.cos(yaw);
    const sn = Math.sin(yaw);
    const out: number[] = [];
    const min: [number, number, number] = [Infinity, Infinity, Infinity];
    const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
    const w = (i: number): [number, number, number] => {
        const x = positions[i * 3]! * MODEL_UNIT * s[0]!;
        const y = positions[i * 3 + 1]! * MODEL_UNIT * s[1]!;
        const z = positions[i * 3 + 2]! * MODEL_UNIT * s[2]!;
        return [o.pos[0]! + x * c + z * sn, o.pos[1]! + y, o.pos[2]! - x * sn + z * c];
    };
    for (const p of polygons) {
        const ix = p.indices;
        for (let k = 1; k + 1 < ix.length; k++)
            for (const v of [w(ix[0]!), w(ix[k]!), w(ix[k + 1]!)])
                for (let a = 0; a < 3; a++) {
                    out.push(v[a]!);
                    min[a] = Math.min(min[a]!, v[a]!);
                    max[a] = Math.max(max[a]!, v[a]!);
                }
    }
    return out.length ? { id, tris: Float32Array.from(out), min, max } : null;
}

/**
 * Highest surface of the meshes under (x, z) at or below `top` (NaN when none), `skip` excluded: a vertical ray against
 * each triangle whose box holds the point.
 */
export function meshUnder(meshes: readonly PlacedMesh[], x: number, z: number, top: number, skip?: number): number {
    let best = NaN;
    for (const m of meshes) {
        if (m.id === skip || x < m.min[0] || x > m.max[0] || z < m.min[2] || z > m.max[2] || m.min[1] > top) continue;
        const t = m.tris;
        for (let i = 0; i + 8 < t.length; i += 9) {
            const ax = t[i]!,
                ay = t[i + 1]!,
                az = t[i + 2]!;
            const bx = t[i + 3]!,
                by = t[i + 4]!,
                bz = t[i + 5]!;
            const cx = t[i + 6]!,
                cy = t[i + 7]!,
                cz = t[i + 8]!;
            const d = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
            if (Math.abs(d) < 1e-6) continue;
            const l1 = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / d;
            const l2 = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / d;
            const l3 = 1 - l1 - l2;
            if (l1 < 0 || l2 < 0 || l3 < 0) continue;
            const y = l1 * ay + l2 * by + l3 * cy;
            if (y <= top && !(y <= best)) best = y;
        }
    }
    return best;
}
