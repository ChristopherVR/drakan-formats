// Synthetic fixtures only; no game bytes.
import { describe, expect, it } from 'vitest';
import { paramValue, type LvlObject, type OdbClass } from '../src/index.ts';
import {
    DETECTOR_TASK_TRIGGER_ONLY,
    applyPuzzleLogic,
    relayDetectorSequences,
    setNamedParam,
} from '../src/ootfpuzzle.ts';
import type { TerrainLayer } from '../src/terrain.ts';
import { sequenceSsdStem } from '../src/ootfseq.ts';
import type { PcLevel } from '../src/pc.ts';

const T_ENUM = 7;
const T_SEQ = 0x0b;
const T_SEQ_LIST = 0x100b;

const detectorFields = [
    { type: T_ENUM, name: 'Task' },
    { type: T_ENUM, name: 'Trigger Message' },
    { type: T_SEQ, name: 'Sequence To Play' },
];
const playerFields = [
    { type: T_SEQ_LIST, name: 'Sequence List' },
    { type: T_ENUM, name: 'List Play Order' },
    { type: T_ENUM, name: 'Initial State' },
    { type: T_ENUM, name: 'Message To Play Next' },
];
const cls = (id: number, name: string, rfl: number, fields: typeof detectorFields, data: number[]): OdbClass => ({
    id,
    name,
    group: 0,
    runtimeClass: 0x10000 + rfl,
    model: null,
    rflClass: rfl,
    icon: 0,
    fields,
    data,
});
const obj = (id: number, dbIndex: number, classId: number, links: number[] = []): LvlObject =>
    ({
        id,
        classId,
        dbIndex,
        pos: [100, 200, 300],
        rot: [0, 0, 0],
        scale: [5, 3, 3],
        flags: 0x101,
        initialEvents: 1,
        radius: null,
        links,
        params: [],
        data: [],
    }) as unknown as LvlObject;
const value = (o: LvlObject, name: string) =>
    paramValue(
        o,
        o.params.findIndex((p) => p.name === name),
    );

describe('ootf detector cut scenes (issue 5: Islands bell scenes dropped)', () => {
    it('sends the sequences of a database without an SSD to the Stomp Player database', () => {
        const ssds = new Set(['LEVEL1ON']);
        expect(sequenceSsdStem('LEVEL1ON', ssds, 'LEVEL1ON')).toBe('LEVEL1ON');
        expect(sequenceSsdStem('FX', ssds, 'LEVEL1ON')).toBe('LEVEL1ON');
        expect(sequenceSsdStem('SYSTEM', ssds, 'LEVEL1ON')).toBe('LEVEL1ON');
        expect(sequenceSsdStem('FX', ssds, null)).toBeNull();
        expect(sequenceSsdStem('FX', ssds, 'NOSSD')).toBeNull();
    });

    it('gives a Play Sequence detector a Stomp Player for its scene and keeps its other links', () => {
        // PC: detector 10 (Task Play Sequence, class Trigger Message default 1) plays sequence 0x1a6 and also starts timer 11.
        const pcDet = cls(5, 'Detector', 61, detectorFields, [6, 1, 0]);
        const pcList = { objects: [obj(10, 2, 5, [11]), obj(12, 2, 5)], warnings: [] };
        setNamedParam(pcList, pcList.objects[0]!, detectorFields, 'Task', 4);
        setNamedParam(pcList, pcList.objects[0]!, detectorFields, 'Sequence To Play', 0x1a6);
        const pc = {
            path: 'Islands World/Islands/islands.lvl',
            list: pcList,
            classes: new Map([[2, new Map([[5, pcDet]])]]),
        } as unknown as PcLevel;
        // PS2: the detector class is an FX clone (default Trigger Message 5), the player the template's own Stomp Player.
        const ps2Det = cls(900, 'Detector', 61, detectorFields, [6, 5, 0]);
        const ps2Player = cls(129, 'Stomp Player', 51, playerFields, [0, 0, 0, 4]);
        const list = { objects: [obj(10, 4, 900, [11]), obj(11, 8, 128), obj(12, 4, 900)], warnings: [] };
        setNamedParam(list, list.objects[0]!, detectorFields, 'Task', 4);
        const warnings: string[] = [];
        const n = relayDetectorSequences({
            pc,
            list,
            title: 'test',
            classOf: (o) => (o.classId === 900 ? ps2Det : o.classId === 129 ? ps2Player : undefined),
            player: { dbIndex: 8, classId: 129 },
            relayed: (o) => (o.id === 10 ? [0x2a] : []),
            warnings,
        });
        expect(n).toBe(1);
        expect(warnings).toEqual([]);
        const det = list.objects[0]!;
        const player = list.objects.find((o) => o.classId === 129)!;
        expect(player.id).toBe(13);
        expect(player.pos).toEqual([100, 200, 300]);
        expect(player.scale).toBeNull();
        expect(value(player, 'Sequence List')).toEqual([0x2a]);
        expect(value(player, 'Message To Play Next')).toBe(1);
        expect(value(player, 'Initial State')).toBe(0);
        expect(value(det, 'Task')).toBe(DETECTOR_TASK_TRIGGER_ONLY);
        expect(value(det, 'Trigger Message')).toBe(1);
        expect(det.links).toEqual([11, 13]);
        // A detector without a relayed scene is left alone.
        expect(list.objects[2]!.params).toEqual([]);
        expect(list.objects[2]!.links).toEqual([]);
    });

    it('drops a relayed scene of a class that is not a detector, with a warning', () => {
        const pcExit = cls(6, 'Level Transition', 55, detectorFields, [0, 0, 0]);
        const pc = {
            path: 'x.lvl',
            list: { objects: [obj(20, 2, 6)], warnings: [] },
            classes: new Map([[2, new Map([[6, pcExit]])]]),
        } as unknown as PcLevel;
        const list = { objects: [obj(20, 4, 901)], warnings: [] };
        const warnings: string[] = [];
        const n = relayDetectorSequences({
            pc,
            list,
            title: 'test',
            classOf: () => undefined,
            player: { dbIndex: 8, classId: 129 },
            relayed: () => [0x2a],
            warnings,
        });
        expect(n).toBe(0);
        expect(list.objects).toHaveLength(1);
        expect(warnings[0]).toMatch(/object 20 .*dropped/);
    });
});

describe('ootf quest item locks (issue 5: Islands bell)', () => {
    const T_INT = 1;
    const T_CLASS = 0x4003;
    const lockFields = [
        { type: T_INT, name: 'Lock Code' },
        { type: 5, name: 'No Key Sound' },
        { type: T_ENUM, name: 'Trigger To Send' },
    ];
    const itemFields = [
        { type: T_INT, name: 'Quantity' },
        { type: T_INT, name: 'Lock Code' },
    ];
    const detFields = [
        { type: T_ENUM, name: 'Task' },
        { type: T_ENUM, name: 'Detect Which?' },
        { type: T_CLASS, name: 'Trigger Only If Carrying Item...' },
        { type: T_ENUM, name: 'Initial State' },
        { type: T_ENUM, name: 'Trigger Message' },
        { type: T_ENUM, name: 'Detect Only Once?' },
    ];
    // One floor layer of 4 x 4 cells at height 74712 under the lock, and a ceiling layer above it that must not count.
    const layer = (type: number, h: number): TerrainLayer =>
        ({
            type,
            originX: 318,
            originZ: 229,
            width: 4,
            height: 4,
            heights: new Float32Array(25).fill(h),
            cellFlags: new Uint16Array(16),
            cellTexLeft: new Uint32Array(16).fill(1),
            cellTexRight: new Uint32Array(16).fill(1),
        }) as unknown as TerrainLayer;

    it('turns the lock of a quest item into a carry-gated detector column that takes over its links', () => {
        const pcLock = cls(3760, 'Bell Hammer Detector', 34, lockFields as never, [20, 0, 1]);
        const pcItem = cls(3172, 'Bell Hammer of Alwarren', 117, itemFields as never, [1, 20]);
        const pcKeyLock = cls(3381, 'lock', 34, lockFields as never, [1, 0, 1]);
        const lock = {
            ...obj(4128, 2, 3760, [4126, 6138]),
            pos: [656374, 101088, 474093],
            scale: [1.25, 0.5, 1.25],
            flags: 0x101,
        } as LvlObject;
        const keyLock = {
            ...obj(3626, 2, 3381, [3625]),
            pos: [649610, 64590, 511016],
            scale: null,
            flags: 1,
        } as LvlObject;
        const pc = {
            path: 'Islands World/Islands/islands.lvl',
            list: { objects: [lock, keyLock], warnings: [] },
            classes: new Map([
                [
                    2,
                    new Map([
                        [3760, pcLock],
                        [3381, pcKeyLock],
                    ]),
                ],
                [5, new Map([[3172, pcItem]])],
            ]),
            terrain: [layer(0, 74712), layer(1, 90000)],
        } as unknown as PcLevel;
        const ps2Det = cls(3050, 'Trigger Detector', 61, detFields as never, [6, 2, 0, 0, 1, 0]);
        const list = {
            objects: [
                { ...obj(4128, 3, 17228, [4126, 6138]), pos: lock.pos } as LvlObject,
                obj(3626, 3, 17000, [3625]),
                obj(4126, 3, 17226),
                obj(6138, 8, 128),
                obj(3625, 3, 17001),
                obj(7000, 8, 128, [4128]),
            ],
            warnings: [],
        };
        const asked: unknown[] = [];
        const warnings: string[] = [];
        const rep = applyPuzzleLogic({
            pc,
            list,
            title: 'test',
            classOf: (o) => (o.classId === 3050 ? ps2Det : undefined),
            detector: { dbIndex: 2, classId: 3050 },
            classRef: (db, id, holder) => (asked.push([db, id, holder.classId]), (1 << 16) | 16975),
            warnings,
        });
        expect(rep.questLocks).toBe(1);
        expect(warnings).toEqual([]);
        expect(asked).toEqual([[5, 3172, 3050]]);
        const d = list.objects.find((o) => o.classId === 3050)!;
        // Column from the floor (74712) to the lock's top (101088 + 0.5 cell), two cells wide around the lock.
        expect(d.pos[0]).toBeCloseTo(656374);
        expect(d.pos[2]).toBeCloseTo(474093);
        expect(d.pos[1]).toBeCloseTo((74712 + 101088 + 1024) / 2, 0);
        expect(d.scale![0]).toBeCloseTo(2.5);
        expect(d.scale![1]).toBeCloseTo((101088 + 1024 - 74712) / 2048, 3);
        expect(d.scale![2]).toBeCloseTo(2.5);
        expect(value(d, 'Task')).toBe(DETECTOR_TASK_TRIGGER_ONLY);
        expect(value(d, 'Detect Which?')).toBe(0);
        expect(value(d, 'Trigger Message')).toBe(1);
        expect(value(d, 'Detect Only Once?')).toBe(1);
        expect(value(d, 'Trigger Only If Carrying Item...')).toBe((1 << 16) | 16975);
        expect(d.links).toEqual([4126, 6138]);
        expect(list.objects[0]!.links).toEqual([]);
        expect(list.objects.find((o) => o.id === 7000)!.links).toEqual([4128, d.id]);
        // The Mystic Key lock (a Key, code 1) keeps the native Use path.
        expect(list.objects[1]!.links).toEqual([3625]);
    });

    it('leaves a lock alone when a Key with the same code lies in the level', () => {
        // Succubus Lair: the Jail Key (a Key) shares code 20 with the Bell Hammer class the level's tables also list.
        const pcLock = cls(3822, 'Iron Lock', 34, lockFields as never, [20, 0, 7]);
        const pcItem = cls(3172, 'Bell Hammer of Alwarren', 117, itemFields as never, [1, 20]);
        const pcKey = cls(5965, 'Jail Key', 33, itemFields as never, [1, 20]);
        const pc = {
            path: 'Islands World/Succubus Lair/Succubus Lair.lvl',
            list: { objects: [obj(2352, 2, 3822, [2353]), obj(2351, 5, 5965)], warnings: [] },
            classes: new Map([
                [2, new Map([[3822, pcLock]])],
                [
                    5,
                    new Map([
                        [3172, pcItem],
                        [5965, pcKey],
                    ]),
                ],
            ]),
            terrain: [],
        } as unknown as PcLevel;
        const list = { objects: [obj(2352, 3, 17000, [2353]), obj(2351, 3, 17001), obj(2353, 8, 1)], warnings: [] };
        const rep = applyPuzzleLogic({
            pc,
            list,
            title: 'test',
            classOf: () => undefined,
            detector: { dbIndex: 2, classId: 3050 },
            classRef: () => (1 << 16) | 16975,
            warnings: [],
        });
        expect(rep.questLocks).toBe(0);
        expect(list.objects).toHaveLength(3);
        expect(list.objects[0]!.links).toEqual([2353]);
    });
});
