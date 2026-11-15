// Synthetic models and terrain only; no game bytes.
import { describe, expect, it } from 'vitest';
import {
    BALLISTA_UNDER_BASE_TOP,
    PROP_MAX_DROP,
    TREE_MAX_RANGE,
    footprintSamples,
    groundSnap,
    isGroundableProp,
    isGroundableTree,
    meshUnder,
    nativeModelLift,
    placeMesh,
    treeGroundHeight,
    treeGroundingOn,
    trunkFootprint,
    turretOnBase,
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
    it('takes only the vertices within 48 units of the lowest point (low branches of a tall pine left out)', () => {
        // trunk foot ring at -0.1, branch tips 60 units higher at radius 1, top at 2: 5 % of the height would take both
        const pine = Float32Array.from([...ring(0.1, -0.1), ...ring(1, -0.1 + 60 / 2048), 0, 2, 0]);
        const f = trunkFootprint(pine)!;
        expect(Math.max(...f.ring.map(([x, z]) => Math.hypot(x, z)))).toBeCloseTo(0.1);
    });
});

describe('footprintSamples', () => {
    it('turns the footprint by the stored y minus 90 degrees, as the engine turns the model', () => {
        const f = { foot: 0, ring: [[0.5, 0]] as [number, number][] };
        // stored 90: no turn, model +x stays +x
        expect(footprintSamples({ pos: [0, 0, 0], rot: [0, 90, 0] }, f)[0]![0]).toBeCloseTo(1024);
        // stored 0: turned by -90 degrees, model +x lands on +z
        const [x, z] = footprintSamples({ pos: [0, 0, 0], rot: [0, 0, 0] }, f)[0]!;
        expect(x).toBeCloseTo(0);
        expect(z).toBeCloseTo(1024);
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
    it('leaves a tree whose trunk base meets the lowest ground under it, or is sunk', () => {
        expect(treeGroundHeight({ pos: [0, 204.8, 0] }, f, flat(0))).toBeNull(); // base exactly on the ground
        expect(treeGroundHeight({ pos: [0, 0, 0], scale: [2, 2, 2] }, f, flat(0))).toBeNull(); // sunk, as most are
        // on a slope with the base at the lowest sample (the downhill edge)
        expect(treeGroundHeight({ pos: [0, 204.8 - 102.4, 0] }, f, slope(0, 0.5))).toBeNull();
    });
    it('lowers a tree whose uphill side touches but whose downhill side floats', () => {
        // base at the origin's ground: the downhill edge (x = -204.8) floats 102.4 over the slope 0.5
        const y = treeGroundHeight({ pos: [0, 204.8, 0] }, f, slope(0, 0.5))!;
        expect(y).toBeCloseTo(204.8 - 102.4, 1);
    });
    it('leaves a tree with no ground under it, one so high it stands on something else, or one over a cliff edge', () => {
        expect(treeGroundHeight({ pos: [0, 1000, 0] }, f, () => NaN)).toBeNull();
        expect(treeGroundHeight({ pos: [0, 204.8 + TREE_MAX_DROP + 50, 0] }, f, flat(0))).toBeNull();
        const edge = (x: number) => (x < 0 ? 0 : TREE_MAX_RANGE + 100);
        expect(groundSnap({ pos: [0, 204.8 + TREE_MAX_RANGE + 100, 0] }, f, 'tree', edge).verdict).toBe('cliff');
    });
});

describe('groundSnap props', () => {
    // a crate: flat base of radius 0.1 model units at y = 0, 0.2 tall
    const crate = trunkFootprint(Float32Array.from([...ring(0.1, 0), ...ring(0.1, 0.2)]))!;
    it('drops a prop floating a little all round until it touches the highest ground under it', () => {
        const s = groundSnap({ pos: [0, 50, 0] }, crate, 'prop', slope(0, 0.1));
        expect(s.verdict).toBe('moved');
        expect(s.y).toBeCloseTo(20.48, 1); // touches the uphill edge, 204.8 * 0.1 over the origin's ground
    });
    it('leaves a prop that touches, floats too high (shelves, hooks) or is as wide as architecture', () => {
        expect(groundSnap({ pos: [0, 0, 0] }, crate, 'prop', flat(0)).verdict).toBe('touching');
        expect(groundSnap({ pos: [0, PROP_MAX_DROP + 10, 0] }, crate, 'prop', flat(0)).verdict).toBe('too-high');
        const wide = trunkFootprint(Float32Array.from([...ring(0.5, 0), ...ring(0.5, 0.2)]))!;
        expect(groundSnap({ pos: [0, 20, 0] }, wide, 'prop', flat(0)).verdict).toBe('large');
    });
    it('leaves an object with another mesh under its footprint over the terrain (a floor, a bridge)', () => {
        const quad = [-1, 0, -1, 1, 0, -1, 1, 0, 1, -1, 0, 1];
        const floor = placeMesh(9, { pos: [0, 40, 0], rot: [0, 90, 0] }, quad, [{ indices: [0, 1, 2, 3] }])!;
        const meshAt = (x: number, z: number, top: number) => meshUnder([floor], x, z, top);
        expect(meshUnder([floor], 0, 0, 100)).toBeCloseTo(40);
        expect(meshUnder([floor], 0, 0, 30)).toBeNaN(); // above the top asked for
        expect(meshUnder([floor], 0, 0, 100, 9)).toBeNaN(); // itself
        expect(groundSnap({ pos: [0, 50, 0] }, crate, 'prop', flat(0), meshAt).verdict).toBe('supported');
        expect(groundSnap({ pos: [0, 50, 0] }, crate, 'prop', flat(0), () => NaN).verdict).toBe('moved');
        // a tilted placement gives no mesh (no Euler order is known)
        const tri = [0, 0, 0, 1, 0, 0, 0, 0, 1];
        expect(placeMesh(1, { pos: [0, 0, 0], rot: [10, 0, 0] }, tri, [{ indices: [0, 1, 2] }])).toBeNull();
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

describe('isGroundableProp', () => {
    it('takes standing props, not trees, helpers, hanging or wall pieces, puzzle plates or architecture', () => {
        for (const n of ['Barrel', 'Troll Crate', 'Jug', 'Plant Small02', 'Standing Torch Base'])
            expect(isGroundableProp({ name: n, rflClass: 17 }, 0)).toBe(true);
        for (const n of [
            'Large Tree',
            'Bounding Box',
            'Sconce Base',
            'Hanging Torch',
            'Pressure Base',
            'Mirror Room',
            'Mine Cart',
            'Small Wall',
        ])
            expect(isGroundableProp({ name: n, rflClass: 17 }, 0)).toBe(false);
        expect(isGroundableProp({ name: 'Brick', rflClass: 17 }, 5)).toBe(false);
        expect(isGroundableProp({ name: 'Barrel', rflClass: 35 }, 0)).toBe(false);
    });
});

describe('disc models and turrets', () => {
    it('lifts an object drawn with a disc model whose origin is on top so its bottom stays at the PC bottom', () => {
        // PC base 0 .. +1395 over its origin, disc base -1558 .. 0
        expect(nativeModelLift(0, -1558 / 2048)).toBeCloseTo(1558);
        expect(nativeModelLift(0, -1558 / 2048, 2)).toBeCloseTo(3116);
        expect(nativeModelLift(-0.1, -0.1 - 4 / 2048)).toBeNull(); // under 16 units
    });
    it('seats a Ballista under the top of its disc base, and nothing else', () => {
        expect(turretOnBase({ name: 'Ballista', rflClass: 37 }, 20000)).toBe(20000 - BALLISTA_UNDER_BASE_TOP);
        expect(turretOnBase({ name: 'Crystal Magic', rflClass: 37 }, 20000)).toBeNull();
        expect(turretOnBase({ name: 'Ballista', rflClass: 17 }, 20000)).toBeNull();
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
