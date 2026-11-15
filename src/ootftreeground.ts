/**
 * Trees that float. A few Order of the Flame trees are placed with the bottom of their trunk over the ground all round
 * (Ruined Village: Large Tree 60 at scale 2 by 158 units, MedTree 1845 at 0.7 by 61, Small Tree 2661 at 1.5 by 7; the PC
 * data places them so, journal 2026-11-15/ootf-ground-placement.md). The converter lowers such a tree until its trunk base
 * meets the lowest ground under the trunk, so no side floats (the uphill side then sinks a little). Trees that already
 * touch the ground somewhere under the trunk are left where they are, and so is every object that is not a tree.
 * Owner's decision of 15 November; on by default, `DRAKAN_TREE_GROUNDING=off` or the option `treeGrounding: false` turns it off.
 */

/** World units per model unit. */
const MODEL_UNIT = 2048;

/** Bottom of a tree model's trunk: its lowest point and the horizontal outline of the vertices near it (model units). */
export interface TrunkFootprint {
    /** Lowest y of the model (model units, normally negative: under the origin). */
    foot: number;
    /** (x, z) of the vertices within `TRUNK_BAND` of the lowest point, plus the trunk's centre. */
    ring: [number, number][];
}

/** Share of the model's height above its lowest point that counts as the trunk's base. */
export const TRUNK_BAND = 0.05;
/** A tree is touching the ground when some sample under its trunk is within this of the trunk base (world units). */
export const TREE_TOUCH_TOLERANCE = 1;
/** Largest drop applied (world units); a tree higher than this over the terrain stands on something else. */
export const TREE_MAX_DROP = 1200;

/** The trunk footprint of a model given its vertex positions (x, y, z per vertex, model units); null without vertices. */
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
    const cut = lo + (hi - lo) * TRUNK_BAND;
    const ring: [number, number][] = [];
    let cx = 0;
    let cz = 0;
    for (let i = 0; i < n; i++) {
        if (positions[i * 3 + 1]! > cut) continue;
        ring.push([positions[i * 3]!, positions[i * 3 + 2]!]);
        cx += positions[i * 3]!;
        cz += positions[i * 3 + 2]!;
    }
    ring.push([cx / ring.length, cz / ring.length]);
    return { foot: lo, ring };
}

export interface TreeGroundInput {
    /** Object origin (world units). */
    pos: readonly number[];
    /** PC rotation words in degrees (x, y, z); only the turn about y moves the footprint. */
    rot?: readonly number[];
    /** Object scale (x, y, z); null or absent is 1. */
    scale?: readonly number[] | null;
}

/**
 * New origin height for a floating tree, or null to leave it: the trunk base (`pos.y + foot * scale.y`) is over the
 * ground at every sample of the trunk footprint (turned and scaled with the object) by more than
 * `TREE_TOUCH_TOLERANCE`; the tree then drops until the base meets the lowest sample. `groundAt(x, z)` is the terrain
 * under a point (NaN where there is none: such a sample does not count; no sample at all leaves the tree).
 */
export function treeGroundHeight(
    o: TreeGroundInput,
    f: TrunkFootprint,
    groundAt: (x: number, z: number) => number,
): number | null {
    const s = o.scale && o.scale.length === 3 ? o.scale : [1, 1, 1];
    const yaw = (((o.rot?.[1] ?? 0) % 360) * Math.PI) / 180;
    const c = Math.cos(yaw);
    const sn = Math.sin(yaw);
    const base = o.pos[1]! + f.foot * MODEL_UNIT * s[1]!;
    let low = Infinity;
    let high = -Infinity;
    for (const [mx, mz] of f.ring) {
        const x = mx * MODEL_UNIT * s[0]!;
        const z = mz * MODEL_UNIT * s[2]!;
        const g = groundAt(o.pos[0]! + x * c + z * sn, o.pos[2]! - x * sn + z * c);
        if (!Number.isFinite(g)) continue;
        low = Math.min(low, g);
        high = Math.max(high, g);
    }
    if (!Number.isFinite(low) || base <= high + TREE_TOUCH_TOLERANCE) return null;
    const drop = base - low;
    if (drop > TREE_MAX_DROP) return null;
    return o.pos[1]! - drop;
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

/** Tree grounding on unless the option says false or the env says off / 0. */
export function treeGroundingOn(option: boolean | undefined, env: Record<string, string | undefined>): boolean {
    if (option === false) return false;
    const v = env['DRAKAN_TREE_GROUNDING']?.trim().toLowerCase();
    return !(v === 'off' || v === '0' || v === 'false');
}
