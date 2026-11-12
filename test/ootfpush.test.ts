// Push puzzles (ootfpush.ts) and their wiring in the puzzle pass. Synthetic levels and classes; no game bytes.
import { describe, expect, it } from 'vitest';
import type { LvlObject, LvlObjectList, OdbClass } from '../src/index.ts';
import { paramValue } from '../src/lvl.ts';
import { sinkLowestSphere } from '../src/ootfassets.ts';
import { parseClassBody } from '../src/odb.ts';
import { splitClassRecord } from '../src/odbwrite.ts';
import { PRESSURE_PLATE_FIELDS, planClassMapping, type Ps2OdbIn } from '../src/ootfclass.ts';
import { sphereHierarchyCount, synthesizeBounds } from '../src/ootfmodel.ts';
import { applyPuzzleLogic } from '../src/ootfpuzzle.ts';
import {
    PUSH_FLOOR_DROP,
    addPushFloor,
    findPushPuzzles,
    isPushBlock,
    modelBoxOf,
    modelTriangles,
    plateSinkDistance,
    pushFloor,
    pushPuzzleSoundRefs,
    pushableBounds,
    standsOnModel,
    worldBox,
    type FloorTriangle,
    type ModelBox,
} from '../src/ootfpush.ts';
import type { PcLevel } from '../src/pc.ts';
import { TEX_HOLE, TEX_INVISIBLE, layerHeightAt, type TerrainLayer } from '../src/terrain.ts';

const F = 2; // float
const E = 7; // enumeration
const I = 1; // int
const fbits = (v: number): number => {
    const dv = new DataView(new ArrayBuffer(4));
    dv.setFloat32(0, v);
    return dv.getUint32(0);
};
const cls = (id: number, name: string, rfl: number, fields: [string, number, number][]): OdbClass => ({
    id,
    name,
    group: 1,
    runtimeClass: 0x10000 | rfl,
    rflClass: rfl,
    model: { id: 100 + id, db: 0 },
    fields: fields.map(([n, type]) => ({ name: n, type })),
    data: fields.map(([, , v]) => v),
});
const body = (push: number, wait: number): [string, number, number][] => [
    ['Wait For Trigger?', E, wait],
    ['Push Mode', E, push],
    ['Friction', F, fbits(4)],
    ['Looped Roll Sound', I, 0x20002],
];
const plate = (initial: number): [string, number, number][] => [
    ['Sink Distance (wu)', F, fbits(75)],
    ['Initial State', E, initial],
    ['Message To Send At Bottom', E, 1],
    ['Sink Sound', I, 0x20001],
    ['Rise Sound', I, 0],
];
const obj = (id: number, classId: number, pos: [number, number, number], links: number[] = []): LvlObject =>
    ({
        id,
        classId,
        dbIndex: 1,
        prefix0: 0,
        prefix1: 0,
        pos,
        flags: 1,
        initialEvents: 1,
        radius: null,
        links,
        rot: [0, 0, 0],
        scale: null,
        preSentinel: 0,
        sentinel: 0xffffffff,
        data: [],
        params: [],
    }) as LvlObject;

/** A flat floor layer at `height` over cells 0..9 x 0..9. */
const layer = (height: number): TerrainLayer =>
    ({
        index: 0,
        id: 1,
        width: 10,
        height: 10,
        type: 0,
        originX: 0,
        originZ: 0,
        worldHeight: height,
        name: 'floor',
        flags: 0,
        lightDirection: 0,
        lightAscension: 0,
        lightColor: 0,
        ambientColor: 0,
        lightDropoff: 0,
        visible: [],
        heights: new Float32Array(121).fill(height),
        vertexFlags: new Uint16Array(121),
        vertexMask: new Uint8Array(121),
        cellFlags: new Uint16Array(100),
        cellTexLeft: new Uint32Array(100).fill(5),
        cellTexRight: new Uint32Array(100).fill(5),
        cellUv: new Uint16Array(800),
        source: 'pc',
    }) as TerrainLayer;

// The shape of the tomb: a block beside the tile of the raised plate 2 it is linked to; plates 1 and 3 start lowered.
const classes = new Map<number, OdbClass>([
    [1, cls(1, 'Push Block', 16, body(0, 0))],
    [2, cls(2, 'Boulder', 16, body(1, 0))],
    [3, cls(3, 'Trap Cage', 16, body(0, 1))],
    [11, cls(11, 'Plate 1', 29, plate(1))],
    [12, cls(12, 'Plate 2', 29, plate(0))],
    [13, cls(13, 'Plate 3', 29, plate(1))],
    [20, cls(20, 'Counter', 7, [['Initial Counter Value', I, 1]])],
    [30, cls(30, 'Ring', 35, [])],
]);
const centre: [number, number, number] = [10000, 7789, 10000];
const objects = [
    obj(1101, 1, [9935, 7809, 16315], [992]),
    obj(5, 2, [3000, 1814, 3000]),
    obj(6, 3, [4000, 5000, 4000]),
    obj(988, 11, centre, [1009, 992]),
    obj(991, 13, centre, [1009, 988]),
    obj(992, 12, centre, [1009, 991]),
    obj(1009, 20, [0, 0, 0], [2176]),
    obj(2176, 30, [10000, 1544, 10000]),
];
const pc = {
    path: 'Mountain World/Test/Test.lvl',
    list: { objects, warnings: [] },
    classes: new Map([[1, classes]]),
    terrain: [layer(1500)],
} as unknown as PcLevel;

// Model boxes in world units before placement: the block 532 wide and 969 high, each plate a flat tile off the origin.
const boxes = new Map<number, ModelBox>([
    [1101, { min: [-266, 0, -266], max: [266, 969, 266] }],
    [991, { min: [-317, -102, 6554], max: [317, -102, 7195] }],
    [992, { min: [5537, -102, 699], max: [6171, -102, 1341] }],
    [988, { min: [-317, -102, -5148], max: [317, -102, -4506] }],
]);
const box = (o: LvlObject): ModelBox | null => boxes.get(o.id) ?? null;

describe('push puzzles', () => {
    it('takes slide-mode bodies that do not wait for a trigger as push blocks', () => {
        expect(objects.filter((o) => isPushBlock(pc, o)).map((o) => o.id)).toEqual([1101]);
    });

    it('groups the plates linked with the plate the block names', () => {
        const [z] = findPushPuzzles(pc);
        expect(z!.block.id).toBe(1101);
        expect(z!.plates.map((p) => p.id)).toEqual([988, 991, 992]);
        expect(plateSinkDistance(pc, z!.plates[0]!)).toBe(75);
        // The class sounds of plates and of the block are converted with the level.
        expect(pushPuzzleSoundRefs(pc, z!.plates[0]!)).toEqual([0x20001]);
        expect(pushPuzzleSoundRefs(pc, z!.block)).toEqual([0x20002]);
        expect(pushPuzzleSoundRefs(pc, objects.find((o) => o.id === 5)!)).toEqual([]);
    });

    it('knows a block on a model from a block on terrain', () => {
        const block = objects[0]!;
        expect(standsOnModel(pc, block, box(block))).toBe(true); // 6,309 over the terrain
        expect(standsOnModel(pc, { ...block, pos: [9935, 1500, 16315] }, box(block))).toBe(false);
        expect(standsOnModel(pc, block, null)).toBe(false);
    });

    it('places an unrotated model with its +x toward +z, as the engine does', () => {
        // The tile of plate 2 lies at +x in the model: in the world it is north of the room centre, beside the block.
        const w = worldBox(objects.find((o) => o.id === 992)!, boxes.get(992)!);
        expect(w.min.map(Math.round)).toEqual([10000 - 1341, 7789 - 102, 10000 + 5537]);
        expect(w.max.map(Math.round)).toEqual([10000 - 699, 7789 - 102, 10000 + 6171]);
        // A quarter turn brings +x back to +x; the scale applies before the turn.
        const turned = worldBox({ pos: [0, 0, 0], rot: [0, 90, 0], scale: [2, 1, 1] }, { min: [1, 0, 0], max: [2, 1, 1] });
        expect(turned.min.map(Math.round)).toEqual([2, 0, 0]);
        expect(turned.max.map(Math.round)).toEqual([4, 1, 1]);
        const [t] = modelTriangles(
            { pos: [100, 10, 200], rot: [0, 0, 0], scale: null },
            { positions: [1, 0, 0, 0, 0, 1, 0, 1, 0], polygons: [{ indices: [0, 1, 2] }] },
        );
        expect(t!.map((p) => p.map(Math.round))).toEqual([
            [100, 10, 200 + 2048],
            [100 - 2048, 10, 200],
            [100, 10 + 2048, 200],
        ]);
    });

    it('reads the model box off the vertices', () => {
        expect(modelBoxOf([0, 0, 0, 1, 0.5, -1])).toEqual({ min: [0, 0, -2048], max: [2048, 1024, 0] });
        expect(modelBoxOf([])).toBeNull();
    });
});

describe('the floor layer of a push block on a model', () => {
    const flat = (index: number, originZ: number, height: number, tex: number, visible: number[]): TerrainLayer => ({
        ...layer(height),
        index,
        id: 10 + index,
        width: 4,
        height: 2,
        originZ,
        visible,
        heights: new Float32Array(15).fill(height),
        vertexFlags: new Uint16Array(15),
        vertexMask: new Uint8Array(15),
        cellFlags: new Uint16Array(8).fill(13),
        cellTexLeft: new Uint32Array(8).fill(tex),
        cellTexRight: new Uint32Array(8).fill(tex),
        cellUv: new Uint16Array(64),
    });
    // Two invisible layers under the room (rows 0..1 and 2..3), and a hill far above both.
    const terrain = (): TerrainLayer[] => [
        flat(0, 0, 1500, TEX_INVISIBLE, [0, 1, 2]),
        flat(1, 2, 1500, TEX_INVISIBLE, [1, 2]),
        { ...flat(2, 0, 20000, 5, [2, 0]), height: 4, heights: new Float32Array(25).fill(20000) },
    ];
    const quad = (z0: number, z1: number): FloorTriangle[] => [
        [
            [0, 7688, z0],
            [8192, 7688, z0],
            [8192, 7688, z1],
        ],
        [
            [0, 7688, z0],
            [8192, 7688, z1],
            [0, 7688, z1],
        ],
    ];
    // The floor model: a strip along each side of the room, a pit between them.
    const floor = [...quad(0, 1900), ...quad(6300, 8192)];
    const block = { pos: [4096, 7809, 7000] as [number, number, number] };

    it('covers the room at floor height, with holes where the floor model has none', () => {
        const pf = pushFloor(terrain(), block, 7700, [quad(0, 8192).map((t) => t.map((p) => [p[0], 300, p[2]])) as FloorTriangle[], floor])!;
        expect(pf.floor).toBe(7688);
        expect(pf.room).toEqual([1, 0]);
        const L = pf.layer;
        expect([L.index, L.originX, L.originZ, L.width, L.height, L.type]).toEqual([3, 0, 0, 4, 4, 0]);
        expect(L.id).toBe(13);
        expect([...new Set(L.heights)]).toEqual([7688 - PUSH_FLOOR_DROP]);
        const row = (z: number): number[] => [...L.cellTexLeft.slice(z * 4, z * 4 + 4), ...L.cellTexRight.slice(z * 4, z * 4 + 4)];
        expect(new Set(row(0))).toEqual(new Set([TEX_INVISIBLE]));
        expect(new Set(row(1))).toEqual(new Set([TEX_HOLE]));
        expect(new Set(row(2))).toEqual(new Set([TEX_HOLE]));
        expect(new Set(row(3))).toEqual(new Set([TEX_INVISIBLE]));
        expect([pf.solid, pf.holes]).toEqual([16, 16]);
        expect(layerHeightAt(L, 4096, 7000)).toBe(7680);
        expect(layerHeightAt(L, 4096, 4096)).toBeNaN();
    });

    it('names the new layer right after the room layers in every list, low to high', () => {
        const t = terrain();
        const pf = pushFloor(t, block, 7700, [floor])!;
        // Its own list is the list of the layer under the block, with the other room layer and itself after that layer.
        expect(pf.layer.visible).toEqual([1, 0, 3, 2]);
        expect(pf.listedBy.sort()).toEqual([0, 1, 2]);
        addPushFloor(t, pf);
        expect(t.length).toBe(4);
        expect(t[0]!.visible).toEqual([0, 1, 3, 2]);
        expect(t[1]!.visible).toEqual([1, 3, 2]);
        expect(t[2]!.visible).toEqual([2, 0, 3]);
    });

    it('makes none for a block on terrain or without a floor under it', () => {
        expect(pushFloor(terrain(), block, 7700, [])).toBeNull();
        expect(pushFloor(terrain(), { pos: [4096, 1600, 7000] }, 1500, [quad(0, 8192).map((t) => t.map((p) => [p[0], 1500, p[2]])) as FloorTriangle[]])).toBeNull();
    });
});

describe('bounds of a push block', () => {
    const spheres = (list: [number, number, number, number][]): Uint8Array => {
        const n = list.length;
        const b = new Uint8Array(76 + n * 20);
        const dv = new DataView(b.buffer);
        dv.setFloat32(20, 1, true);
        dv.setUint16(72, n, true);
        list.forEach((sp, i) => sp.forEach((v, k) => dv.setFloat32(76 + n * 4 + i * 16 + k * 4, v, true)));
        return b;
    };

    it('moves the lowest sphere down and leaves the others', () => {
        const b = spheres([
            [0, 0.5, 0, 0.6],
            [0, 0.8, 0, 0.3],
            [0, 0.25, 0, 0.3],
        ]);
        expect(sphereHierarchyCount(b)).toBe(3);
        const out = sinkLowestSphere(b, 0.05)!;
        const y = (i: number): number => new DataView(out.buffer).getFloat32(76 + 12 + i * 16 + 4, true);
        expect([y(0), y(1)]).toEqual([0.5, 0.800000011920929]);
        expect(y(2)).toBeCloseTo(0.2, 6);
        expect(b).not.toEqual(out);
    });

    it('knows sphere bounds, the only ones a PS2 Rigid Body can be pushed with, from a box', () => {
        const box = synthesizeBounds(Float32Array.from([0, 0, 0, 1, 1, 1]), 0);
        expect(sinkLowestSphere(box, 0.05)).toBeNull();
        // The PC record has no 8 byte prefix.
        expect(pushableBounds(spheres([[0, 0, 0, 1]]).slice(8))).toBe(true);
        expect(pushableBounds(box.slice(8))).toBe(false);
        expect(pushableBounds(null)).toBe(false);
    });
});

describe('puzzle pass: native plates and the block', () => {
    const plateFields: [string, number, number][] = [
        ['Sink Distance (wu)', F, fbits(75)],
        ['Initial State', E, 0],
        ['Message To Send At Bottom', E, 1],
        ['Sink Sound', I, 0],
        ['Rise Sound', I, 0],
    ];
    const ps2 = new Map<number, OdbClass>([
        [
            501,
            cls(501, 'Push Block', 16, [
                ['Detect Objects?', E, 0],
                ['Looped Roll Sound', I, 0],
            ]),
        ],
        [502, cls(502, 'Plate prop', 17, [])],
        [
            503,
            cls(503, 'Trigger Detector', 61, [
                ['Task', E, 0],
                ['Trigger Message', E, 0],
                ['Detect Only Once?', E, 0],
            ]),
        ],
        [505, cls(505, 'Counter', 7, [['Initial Counter Value', I, 1]])],
        [506, cls(506, 'Ring', 35, [])],
        [511, cls(511, 'Plate 1', 29, plateFields)],
    ]);
    const run = (plateClass: number) => {
        const target = new Map([
            [1, 501],
            [11, plateClass],
            [12, plateClass],
            [13, plateClass],
            [20, 505],
            [30, 506],
        ]);
        const list: LvlObjectList = {
            objects: objects
                .filter((o) => target.has(o.classId))
                .map((o) => ({ ...obj(o.id, target.get(o.classId)!, [...o.pos], [...o.links]) })),
            warnings: [],
        };
        const warnings: string[] = [];
        const rep = applyPuzzleLogic({
            pc,
            list,
            title: 'test',
            classOf: (o) => ps2.get(o.classId),
            detector: { dbIndex: 1, classId: 503 },
            soundRef: (_o, ref) => (ref === 0x20001 ? 0x30007 : null),
            warnings,
        });
        return { list, warnings, rep };
    };
    const value = (o: LvlObject, name: string): unknown => {
        const i = o.params.findIndex((p) => p.name === name);
        return i < 0 ? undefined : paramValue(o, i);
    };

    it('leaves native plates to the engine: their links stay, no detector stands in', () => {
        const { list, warnings, rep } = run(511);
        expect(warnings).toEqual([]);
        expect([rep.nativePlates, rep.pushBlocks, rep.plates, rep.detectors]).toEqual([3, 1, 0, 0]);
        expect(list.objects.some((o) => o.classId === 503)).toBe(false);
        const of = (id: number): LvlObject => list.objects.find((o) => o.id === id)!;
        expect(of(992).links).toEqual([1009, 991]);
        expect(of(991).links).toEqual([1009, 988]);
        expect(of(988).links).toEqual([1009, 992]);
        expect(of(1009).links).toEqual([2176]);
        // The block stays linked to the plate the engine pulls it onto.
        expect(of(1101).links).toEqual([992]);
        // A converted sound becomes a parameter of the object; one that was not converted stays the class default.
        expect(value(of(992), 'Sink Sound')).toBe(0x30007);
        expect(value(of(992), 'Rise Sound')).toBeUndefined();
        expect(value(of(1101), 'Detect Objects?')).toBe(1);
        expect(value(of(1101), 'Looped Roll Sound')).toBeUndefined();
    });

    it('keeps the detector stand-in for a plate that could not become a native one', () => {
        const { list, rep } = run(502);
        expect([rep.nativePlates, rep.plates, rep.detectors]).toEqual([0, 3, 3]);
        expect(list.objects.filter((o) => o.classId === 503).length).toBe(3);
    });
});

describe('class plan: the Pressure Plate', () => {
    const host = (): Ps2OdbIn => ({
        file: 'RESOURES.ODB',
        dbIndex: 3,
        classes: new Map([
            [900, { id: 900, name: 'Last', group: 7, rflClass: 35, runtimeClass: 0x10023, fields: [], data: [] }],
        ]),
        raw: () => undefined,
    });
    const types = [F, F, F, E, E, E, E, E, E, E, I, I, E];
    const source: OdbClass = {
        id: 4,
        name: 'Pressure Plate 02',
        group: 1,
        runtimeClass: 29,
        rflClass: 29,
        model: { id: 3885, db: 0 },
        fields: PRESSURE_PLATE_FIELDS.map((name, i) => ({ name, type: types[i]! })),
        data: [fbits(75), fbits(0.05), fbits(0.1), 0, 1, 0, 0, 2, 0, 1, 0x20226, 0x20227, 0],
    };
    const options = {
        modelOdbFile: 'RESOURES.ODB',
        modelFor: () => ({ id: 6732, db: 0 }),
        modelBounds: () => new Uint8Array(64).fill(0x35),
    };

    it('writes the native record from the PC defaults, with the converted model and without the PC sounds', () => {
        const plan = planClassMapping([{ db: 1, id: 4, cls: source }], [host()], options);
        const s = plan.synthesized[0]!;
        expect([s.rfl, s.cls.runtimeClass, s.file, s.name]).toEqual([29, 0x1001d, 'RESOURES.ODB', 'Pressure Plate 02']);
        const body = splitClassRecord(s.record).body;
        const dv = new DataView(body.buffer, body.byteOffset);
        expect([dv.getUint16(2, true), dv.getUint16(4, true), dv.getUint32(6, true), dv.getUint16(14, true)]).toEqual([
            6732, 0, 0, 1,
        ]);
        expect([...body.slice(16, 80)]).toEqual(Array<number>(64).fill(0x35));
        expect(dv.getUint16(80, true)).toBe(29);
        const data = [...source.data!];
        data[10] = 0;
        data[11] = 0;
        expect(parseClassBody(body)?.data).toEqual(data);
        expect(plan.unsupported.size).toBe(0);
    });

    it('falls back to the substitute when the schema, the model or its bounds are not the expected ones', () => {
        const none = (o: Parameters<typeof planClassMapping>[2], cls = source): number =>
            planClassMapping([{ db: 1, id: 4, cls }], [host()], o).synthesized.filter((x) => x.rfl === 29).length;
        expect(none({ ...options, modelFor: () => null })).toBe(0);
        expect(none({ ...options, modelBounds: () => undefined })).toBe(0);
        expect(none({})).toBe(0);
        const renamed = { ...source, fields: source.fields!.map((f, i) => (i === 3 ? { ...f, name: 'State' } : f)) };
        expect(none(options, renamed)).toBe(0);
        expect(none(options, { ...source, fields: source.fields!.slice(0, 12), data: source.data!.slice(0, 12) })).toBe(0);
    });
});
