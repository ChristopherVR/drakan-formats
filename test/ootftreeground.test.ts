// Synthetic tree models and terrain only; no game bytes.
import { describe, expect, it } from 'vitest';
import {
    isGroundableTree,
    treeGroundHeight,
    treeGroundingOn,
    trunkFootprint,
    TREE_MAX_DROP,
} from '../src/ootftreeground.ts';

// A tree 2 model units tall: trunk ring of radius 0.1 at y = -0.1, a crown ring of radius 0.5 at y = 1.
const ring = (r: number, y: number): number[] =>
    [0, 1, 2, 3].flatMap((k) => [r * Math.cos((k * Math.PI) / 2), y, r * Math.sin((k * Math.PI) / 2)]);
const tree = Float32Array.from([...ring(0.1, -0.1), ...ring(0.5, 1), 0, 1.9, 0]);
const flat = (h: number) => () => h;
const slope = (h: number, perUnit: number) => (x: number) => h + x * perUnit;

describe('trunkFootprint', () => {
    it('takes the lowest point and the outline of the trunk base, not the crown', () => {
        const f = trunkFootprint(tree)!;
        expect(f.foot).toBeCloseTo(-0.1);
        expect(f.ring).toHaveLength(5); // four base vertices and the centre
        expect(Math.max(...f.ring.map(([x, z]) => Math.hypot(x, z)))).toBeCloseTo(0.1);
        expect(trunkFootprint([])).toBeNull();
    });
});

describe('treeGroundHeight', () => {
    const f = trunkFootprint(tree)!;
    it('lowers a tree whose trunk base floats all round onto the ground (scale counted)', () => {
        // base = 1000 - 0.1 * 2048 * 2 = 590.4, ground 400: drops 190.4
        expect(treeGroundHeight({ pos: [0, 1000, 0], scale: [2, 2, 2] }, f, flat(400))).toBeCloseTo(809.6);
    });
    it('meets the lowest ground under the trunk on a slope, so no side floats', () => {
        // ground 0 at x = 0, +0.1 per unit; trunk radius 204.8 * 1 -> samples from -20.48 to +20.48
        const y = treeGroundHeight({ pos: [0, 500, 0] }, f, slope(0, 0.1))!;
        expect(y - 204.8).toBeCloseTo(-20.48, 1);
    });
    it('leaves a tree that touches the ground anywhere under its trunk', () => {
        expect(treeGroundHeight({ pos: [0, 204.8, 0] }, f, flat(0))).toBeNull(); // base exactly on the ground
        expect(treeGroundHeight({ pos: [0, 0, 0], scale: [2, 2, 2] }, f, flat(0))).toBeNull(); // sunk, as most are
        expect(treeGroundHeight({ pos: [0, 214.8, 0] }, f, slope(0, 0.5))).toBeNull(); // uphill side touches
    });
    it('leaves a tree with no ground under it, or one so high it stands on something else', () => {
        expect(treeGroundHeight({ pos: [0, 1000, 0] }, f, () => NaN)).toBeNull();
        expect(treeGroundHeight({ pos: [0, 204.8 + TREE_MAX_DROP + 50, 0] }, f, flat(0))).toBeNull();
    });
});

describe('isGroundableTree', () => {
    it('takes ground-object trees, pines and palms, not puzzle trees or other objects', () => {
        for (const n of ['Large Tree', 'MedTree', 'Small Tree', 'SmallTree', 'Large Tree (Snowy)', 'Fan Palm 01'])
            expect(isGroundableTree({ name: n, rflClass: 17 }, 0)).toBe(true);
        expect(isGroundableTree({ name: 'push tree', rflClass: 17 }, 5)).toBe(false);
        expect(isGroundableTree({ name: 'pushtreebase', rflClass: 17 }, 0)).toBe(false);
        expect(isGroundableTree({ name: 'Large Tree', rflClass: 17 }, 5)).toBe(false);
        expect(isGroundableTree({ name: 'Tree Mechanism', rflClass: 35 }, 0)).toBe(false);
        expect(isGroundableTree({ name: 'Barrel', rflClass: 17 }, 0)).toBe(false);
    });
});

describe('treeGroundingOn', () => {
    it('is on by default and off by option or DRAKAN_TREE_GROUNDING=off / 0', () => {
        expect(treeGroundingOn(undefined, {})).toBe(true);
        expect(treeGroundingOn(false, {})).toBe(false);
        expect(treeGroundingOn(undefined, { DRAKAN_TREE_GROUNDING: 'off' })).toBe(false);
        expect(treeGroundingOn(undefined, { DRAKAN_TREE_GROUNDING: '0' })).toBe(false);
        expect(treeGroundingOn(true, { DRAKAN_TREE_GROUNDING: 'on' })).toBe(true);
    });
});
