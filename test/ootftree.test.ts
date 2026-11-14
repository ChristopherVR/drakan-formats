// Trees Rynn fells over a gap (ootftree.ts). Synthetic terrain, classes and objects; no game bytes.
import { describe, expect, it } from 'vitest';
import type { LvlObject, LvlObjectList, OdbClass } from '../src/index.ts';
import { FLAG_VISIBLE, paramValue } from '../src/lvl.ts';
import {
    MOVER_RFL,
    bridgeAxis,
    fallRotation,
    fallingTreeMoverClass,
    findFallingTrees,
    freeClassId,
    modelAxisWorld,
    placeFallingTrees,
} from '../src/ootftree.ts';
import type { PcLevel } from '../src/pc.ts';
import type { TerrainLayer } from '../src/terrain.ts';

const E = 7;
const I = 1;
const F = 2;
const fbits = (v: number): number => {
    const dv = new DataView(new ArrayBuffer(4));
    dv.setFloat32(0, v);
    return dv.getUint32(0);
};
const ffrom = (u: number): number => {
    const dv = new DataView(new ArrayBuffer(4));
    dv.setUint32(0, u >>> 0);
    return dv.getFloat32(0);
};

/** A flat layer `width` cells wide from cell `originX`, one row of 2 cells deep, at `height`. */
const flat = (index: number, originX: number, width: number, height: number): TerrainLayer => {
    const verts = (width + 1) * 3;
    const cells = width * 2;
    return {
        index,
        id: 10 + index,
        width,
        height: 2,
        type: 0,
        originX,
        originZ: 0,
        worldHeight: height,
        name: `l${index}`,
        flags: 0,
        lightDirection: 0,
        lightAscension: 0,
        lightColor: 0,
        ambientColor: 0,
        lightDropoff: 0,
        visible: [],
        heights: new Float32Array(verts).fill(height),
        vertexFlags: new Uint16Array(verts),
        vertexMask: new Uint8Array(verts),
        cellFlags: new Uint16Array(cells),
        cellTexLeft: new Uint32Array(cells).fill(5),
        cellTexRight: new Uint32Array(cells).fill(5),
        cellUv: new Uint16Array(cells * 8),
        source: 'pc',
    } as TerrainLayer;
};
// A ledge (cells 0..2, x 0..6144) and a far ledge (cells 5..7, x 10240..16384) at 1000 over low ground at 0.
const terrain = (): TerrainLayer[] => [flat(0, 0, 3, 1000), flat(1, 0, 10, 0), flat(2, 5, 3, 1000)];

const treeFields: [string, number, number][] = [
    ['Initial Health', I, 0],
    ['Message To Send', E, 5],
    ['Push Over Mode', E, 5],
    ['Fall When Dead', E, 1],
    ['Message To Send When Pushed', E, 1],
];
const treeClass = (fields = treeFields): OdbClass => ({
    id: 3400,
    name: 'push tree',
    group: 1,
    runtimeClass: 0x10011,
    rflClass: 17,
    model: { id: 3792, db: 0 },
    fields: fields.map(([name, type]) => ({ name, type })),
    data: fields.map(([, , v]) => v),
});
const obj = (
    id: number,
    classId: number,
    pos: [number, number, number],
    yaw: number,
    links: number[] = [],
): LvlObject => ({
    id,
    classId,
    dbIndex: 2,
    prefix0: 0,
    prefix1: 0,
    pos,
    flags: FLAG_VISIBLE,
    initialEvents: 1,
    radius: null,
    links,
    rot: [0, yaw, 0],
    scale: null,
    preSentinel: 0,
    sentinel: 0xffffffff,
    data: [],
    params: [],
});
const level = (objects: LvlObject[], classes: OdbClass[]): PcLevel =>
    ({
        path: 'Test/Test.lvl',
        header: {} as PcLevel['header'],
        list: { objects, warnings: [] },
        terrain: terrain(),
        classes: new Map([[2, new Map(classes.map((c) => [c.id, c]))]]),
        odbPaths: new Map(),
        warnings: [],
    }) as PcLevel;

describe('falling trees', () => {
    it('maps model axes to the world with the loader quarter turn', () => {
        expect(modelAxisWorld('+x', 0)).toEqual([0, 1]);
        expect(modelAxisWorld('+x', 90)).toEqual([1, -0]);
        expect(modelAxisWorld('-z', 180)).toEqual([-1, -0]);
        expect(modelAxisWorld('+z', 180)).toEqual([1, 0]);
    });

    it('finds the axis toward the far ledge and none when nothing bridges', () => {
        const pc = level([], []);
        expect(bridgeAxis(pc, [5500, 1050, 1000], 180, 6000)).toBe('+z');
        expect(bridgeAxis(pc, [5500, 1050, 1000], 90, 6000)).toBe('+x');
        // too short to reach the far ledge
        expect(bridgeAxis(pc, [5500, 1050, 1000], 90, 3000)).toBeUndefined();
    });

    it('picks struck trees that fall when dead, with the PC fall message', () => {
        const c = treeClass();
        const still = { ...treeClass(), id: 3401, name: 'plain tree', data: [0, 5, 0, 0, 0] };
        const pc = level([obj(7, 3400, [5500, 1050, 1000], 90, [8]), obj(8, 3401, [5600, 1050, 1000], 90)], [c, still]);
        const found = findFallingTrees(pc, () => 6000);
        expect(found.map((t) => [t.tree.id, t.toward, t.dir, t.length, t.message])).toEqual([
            [7, '+x', [1, -0], 6000, 1],
        ]);
    });

    it('turns a quarter turn about the axis that tips the top toward the fall', () => {
        expect(fallRotation('-z')).toEqual({ axis: 0, turns: -0.25 });
        expect(fallRotation('+z')).toEqual({ axis: 0, turns: 0.25 });
        expect(fallRotation('-x')).toEqual({ axis: 2, turns: 0.25 });
        expect(fallRotation('+x', -1)).toEqual({ axis: 2, turns: 0.25 });
    });

    it('describes the Mover class with the tree model and the fall', () => {
        const pc = level([obj(7, 3400, [5500, 1050, 1000], 180)], [treeClass()]);
        const [t] = findFallingTrees(pc, () => 6000);
        const id = freeClassId(pc.classes.get(2)!);
        expect(id).toBe(3401);
        const m = fallingTreeMoverClass(t!, id);
        expect(m.rflClass).toBe(MOVER_RFL);
        expect(m.model).toEqual({ id: 3792, db: 0 });
        expect(m.name).toBe('push tree (falling)');
        const v = (name: string): number => m.data![m.fields!.findIndex((f) => f.name === name)]!;
        expect(v('Type')).toBe(1);
        expect(v('Rotation Axis')).toBe(0);
        expect(ffrom(v('Rotate Distance (r)'))).toBe(0.25);
        expect(v('Collide with player')).toBe(1);
    });

    it('makes the standing tree fall to one blow and adds its hidden Mover and a toggler that shows it', () => {
        const pc = level([obj(7, 3400, [5500, 1050, 1000], 90, [8])], [treeClass()]);
        const [t] = findFallingTrees(pc, () => 6000);
        const ps2Tree: [string, number][] = [
            ['Initial Health', I],
            ['Message To Send', E],
            ['2D Explosion Object', 0x2003],
            ['Explosion Generator', 0x2003],
            ['Smoke Generator', 0x2003],
        ];
        const ps2Mover: [string, number][] = [
            ['Type', E],
            ['Stop Sound', 5],
            ['Reverse motion Stop Sound', 5],
            ['Forward Looped Sound', 5],
            ['Reverse Looped Sound', 5],
            ['Forward Slide Sound', 5],
            ['Reverse Slide Sound', 5],
            ['Forward Rotate Sound', 5],
            ['Reverse Rotate Sound', 5],
            ['Rotate Distance (r)', F],
        ];
        const tree = obj(7, 50, [5500, 1050, 1000], 90, [8]);
        const list: LvlObjectList = { objects: [tree, obj(8, 60, [0, 0, 0], 0)], warnings: [] };
        const warnings: string[] = [];
        const ps2Toggler: [string, number][] = [
            ['Trigger Mode', E],
            ['Show Message', E],
            ['Hide Message', E],
        ];
        const fieldsOf = (o: LvlObject) =>
            (o.classId === 50 ? ps2Tree : o.classId === 70 ? ps2Mover : o.classId === 80 ? ps2Toggler : []).map(
                ([name, type]) => ({ name, type }),
            );
        const n = placeFallingTrees(list, [{ t: t!, mover: { dbIndex: 3, classId: 70 } }], fieldsOf, warnings, 'Test', {
            toggler: { dbIndex: 8, classId: 80 },
        });
        expect(n).toBe(1);
        expect(warnings).toEqual([]);
        const named = (o: LvlObject): Record<string, unknown> =>
            Object.fromEntries(o.params.map((p, i) => [p.name.replace(/\0+$/, ''), paramValue(o, i)]));
        expect(named(tree)).toEqual({
            'Initial Health': 1,
            'Message To Send': 1,
            '2D Explosion Object': 0,
            'Explosion Generator': 0,
            'Smoke Generator': 0,
        });
        const mover = list.objects.find((o) => o.classId === 70)!;
        const toggler = list.objects.find((o) => o.classId === 80)!;
        expect(tree.links).toEqual([8, toggler.id, mover.id]);
        expect(toggler.links).toEqual([mover.id]);
        expect(toggler.flags & FLAG_VISIBLE).toBe(FLAG_VISIBLE);
        expect(named(toggler)).toEqual({ 'Trigger Mode': 1, 'Show Message': 1, 'Hide Message': 0 });
        expect(mover.dbIndex).toBe(3);
        expect(mover.pos).toEqual([5500, 1050, 1000]);
        expect(mover.rot).toEqual([0, 90, 0]);
        expect(mover.flags & FLAG_VISIBLE).toBe(0);
        expect(Object.values(named(mover))).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
        expect(fbits(0)).toBe(0);
    });

    it('places the Mover visible as a test aid, and warns when a hidden one has no toggler', () => {
        const pc = level([obj(7, 3400, [5500, 1050, 1000], 90)], [treeClass()]);
        const [t] = findFallingTrees(pc, () => 6000);
        const mk = (): LvlObjectList => ({ objects: [obj(7, 50, [5500, 1050, 1000], 90)], warnings: [] });
        const fieldsOf = () => [];
        const w1: string[] = [];
        const a = mk();
        placeFallingTrees(a, [{ t: t!, mover: { dbIndex: 3, classId: 70 } }], fieldsOf, w1, 'Test', { visible: true });
        expect(a.objects.find((o) => o.classId === 70)!.flags & FLAG_VISIBLE).toBe(FLAG_VISIBLE);
        const w2: string[] = [];
        placeFallingTrees(mk(), [{ t: t!, mover: { dbIndex: 3, classId: 70 } }], fieldsOf, w2, 'Test');
        expect(w2.some((w) => /no Visibility Toggler/.test(w))).toBe(true);
    });
});
