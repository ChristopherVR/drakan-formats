// Push puzzles (ootfpush.ts) and their wiring in the puzzle pass. Synthetic levels and classes; no game bytes.
import { describe, expect, it } from 'vitest';
import type { LvlObject, LvlObjectList, OdbClass } from '../src/index.ts';
import { paramValue } from '../src/lvl.ts';
import { applyPuzzleLogic, PUSH_SLIDE_SECONDS } from '../src/ootfpuzzle.ts';
import {
    findPushPuzzles,
    isPushBlock,
    modelBoxOf,
    pushSlide,
    standsOnModel,
    worldBox,
    type ModelBox,
} from '../src/ootfpush.ts';
import type { PcLevel } from '../src/pc.ts';
import type { TerrainLayer } from '../src/terrain.ts';

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
];
const plate = (initial: number): [string, number, number][] => [
    ['Sink Distance (wu)', F, fbits(75)],
    ['Initial State', E, initial],
    ['Message To Send At Bottom', E, 1],
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

// The shape of the tomb: a block beside the tile of plate 3, which plate 2 raises; plates 1 and 3 start lowered.
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
    });

    it('knows a block on a model from a block on terrain', () => {
        const block = objects[0]!;
        expect(standsOnModel(pc, block, box(block))).toBe(true); // 6,309 over the terrain
        expect(standsOnModel(pc, { ...block, pos: [9935, 1500, 16315] }, box(block))).toBe(false);
        expect(standsOnModel(pc, block, null)).toBe(false);
    });

    it('slides the block onto the nearest plate tile along the larger world axis', () => {
        const s = pushSlide(findPushPuzzles(pc)[0]!, box)!;
        expect(s.target.id).toBe(991);
        expect(s.axis).toBe(2);
        expect(s.distance).toBeCloseTo(10000 + (6554 + 7195) / 2 - 16315, 3); // 559.5 toward +z
        expect(s.floor).toBe(7789 - 102);
    });

    it('places a model box with scale and a quarter turn', () => {
        const w = worldBox(
            { pos: [100, 0, 200], rot: [0, 90, 0], scale: [2, 1, 1] },
            { min: [0, 0, 0], max: [10, 5, 4] },
        );
        expect(w.min.map(Math.round)).toEqual([100, 0, 180]);
        expect(w.max.map(Math.round)).toEqual([104, 5, 200]);
        expect(modelBoxOf([0, 0, 0, 1, 0.5, -1])).toEqual({ min: [0, 0, -2048], max: [2048, 1024, 0] });
    });
});

describe('puzzle pass: a push block that became a Mover', () => {
    const moverFields = [
        'Type',
        'Looping?',
        'Damage',
        'Slide Axis',
        'Slide Distance (lu)',
        'Total sliding time',
        'Slide acceleration time',
        'Slide deceleration time',
        'Pause after moving forward (s)',
    ];
    const ps2 = new Map<number, OdbClass>([
        [
            501,
            cls(
                501,
                'Push Block',
                35,
                moverFields.map((n) => [n, n.includes('time') || n.includes('lu') || n.includes('(s)') ? F : E, 0]),
            ),
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
        [
            504,
            cls(504, 'Timer', 62, [
                ['Time Until Trigger', F, 0],
                ['Start Mode', E, 0],
                ['Repeat', E, 0],
                ['Trigger Message', E, 0],
            ]),
        ],
        [505, cls(505, 'Counter', 7, [['Initial Counter Value', I, 1]])],
        [506, cls(506, 'Ring', 35, [])],
    ]);
    const target = new Map([
        [1, 501],
        [11, 502],
        [12, 502],
        [13, 502],
        [20, 505],
        [30, 506],
    ]);
    const run = () => {
        const list: LvlObjectList = {
            objects: objects
                .filter((o) => target.has(o.classId))
                .map((o) => ({ ...obj(o.id, target.get(o.classId)!, [...o.pos], [...o.links]) })),
            warnings: [],
        };
        const warnings: string[] = [];
        applyPuzzleLogic({
            pc,
            list,
            title: 'test',
            classOf: (o) => ps2.get(o.classId),
            detector: { dbIndex: 1, classId: 503 },
            timer: { dbIndex: 1, classId: 504 },
            pushBox: box,
            warnings,
        });
        return { list, warnings };
    };
    const value = (o: LvlObject, name: string): unknown => {
        const i = o.params.findIndex((p) => p.name === name);
        return i < 0 ? undefined : paramValue(o, i);
    };

    it('slides the block onto the tile, counts the arrival and the pressed plate, and fires what the PC counter fires', () => {
        const { list, warnings } = run();
        expect(warnings).toEqual([]);
        const by = (id: number): LvlObject => list.objects.find((o) => o.id === id)!;
        const block = by(1101);
        expect(block.pos[1]).toBe(7687); // the base on the raised tile's height
        expect(block.links).toEqual([]);
        expect(value(block, 'Slide Axis')).toBe(0); // world z
        expect(value(block, 'Slide Distance (lu)') as number).toBeCloseTo(559.5 / 2048, 5);
        expect(value(block, 'Total sliding time')).toBe(PUSH_SLIDE_SECONDS);
        const added = list.objects.filter((o) => ![1101, 988, 991, 992, 1009, 2176].includes(o.id));
        const detectors = added.filter((o) => o.classId === 503);
        const timer = added.find((o) => o.classId === 504)!;
        const copy = added.find((o) => o.classId === 505)!;
        expect(detectors).toHaveLength(2);
        // around the block: starts the slide and the arrival timer
        const touch = detectors.find((d) => d.links.includes(1101))!;
        expect(touch.links).toEqual([1101, timer.id]);
        expect(touch.pos[0]).toBe(9935);
        expect(touch.pos[2]).toBe(16315);
        expect(value(timer, 'Time Until Trigger')).toBe(PUSH_SLIDE_SECONDS);
        expect(timer.links).toEqual([copy.id]);
        // on the tile of plate 2 (it raises the block's plate and starts raised), not at the plate object's origin
        const pressed = detectors.find((d) => d !== touch)!;
        expect(pressed.pos[0]).toBeCloseTo(10000 + (5537 + 6171) / 2, 3);
        expect(pressed.pos[2]).toBeCloseTo(10000 + (699 + 1341) / 2, 3);
        expect(pressed.links).toEqual([copy.id]);
        expect(value(pressed, 'Detect Only Once?')).toBe(1);
        // the copy needs both and sends what the PC counter sends; the PC counter hears nothing any more
        expect(value(copy, 'Initial Counter Value')).toBe(2);
        expect(copy.links).toEqual([2176]);
        expect(list.objects.filter((o) => o.links.includes(1009)).map((o) => o.id)).toEqual([988, 991, 992]);
        expect(list.objects.filter((o) => o.classId === 503 && o.links.includes(1009))).toEqual([]);
        // plates that start lowered are shown lowered
        expect(by(988).pos[1]).toBe(7789 - 75);
        expect(by(991).pos[1]).toBe(7789 - 75);
        expect(by(992).pos[1]).toBe(7789);
    });

    it('leaves a level whose block stayed a Rigid Body to the plate stand-ins', () => {
        const list: LvlObjectList = {
            objects: objects
                .filter((o) => target.has(o.classId))
                .map((o) => obj(o.id, o.classId === 1 ? 507 : target.get(o.classId)!, [...o.pos], [...o.links])),
            warnings: [],
        };
        const rigid = new Map(ps2).set(507, cls(507, 'Push Block', 16, body(0, 0)));
        applyPuzzleLogic({
            pc,
            list,
            title: 'test',
            classOf: (o) => rigid.get(o.classId),
            detector: { dbIndex: 1, classId: 503 },
            timer: { dbIndex: 1, classId: 504 },
            pushBox: box,
            warnings: [],
        });
        // the stand-in of platesToDetectors: the block's link reaches the plate and the plate's detector, nothing slides
        expect(list.objects.find((o) => o.id === 1101)!.links[0]).toBe(992);
        expect(list.objects.filter((o) => o.classId === 503)).toHaveLength(3); // one box per plate, at the plate's origin
        expect(list.objects.filter((o) => o.classId === 504)).toEqual([]);
    });
});
