// Synthetic fixtures only; no game bytes.
import { describe, expect, it } from 'vitest';
import { paramValue, setObjectParams, type LvlObject, type OdbClass } from '../src/index.ts';
import { relayDetectorSequences, setNamedParam } from '../src/ootfpuzzle.ts';
import {
    PS2_ORDER_ALL_AT_ONCE,
    PS2_ORDER_IN_ORDER_ONCE,
    PS2_ORDER_ONE_PER_TRIGGER,
    PS2_ORDER_RANDOMLY,
    convertStompPlayers,
    pcStompPlayer,
    ps2PlayOrder,
} from '../src/ootfstomp.ts';
import type { PcLevel } from '../src/pc.ts';

const T_ENUM = 7;
const T_SEQ = 0x0b;
const T_SEQ_LIST = 0x100b;

const playerFields = [
    { type: T_SEQ_LIST, name: 'Sequence List' },
    { type: T_ENUM, name: 'List Play Order' },
    { type: T_ENUM, name: 'Initial State' },
    { type: T_ENUM, name: 'Message To Play Next' },
];
const detectorFields = [
    { type: T_ENUM, name: 'Task' },
    { type: T_ENUM, name: 'Trigger Message' },
    { type: T_SEQ, name: 'Sequence To Play' },
];
const cls = (id: number, name: string, rfl: number, fields: typeof playerFields, data: number[]): OdbClass => ({
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
        scale: null,
        flags: 1,
        initialEvents: 1,
        radius: null,
        links,
        params: [],
        data: [],
    }) as unknown as LvlObject;
const value = (o: LvlObject, name: string) => {
    const i = o.params.findIndex((p) => p.name === name);
    return i < 0 ? undefined : paramValue(o, i);
};
const setList = (list: { objects: LvlObject[]; warnings: string[] }, o: LvlObject, refs: number[]) =>
    setObjectParams(list, o.id, [{ fieldIndex: 0, type: T_SEQ_LIST, name: 'Sequence List', value: refs }]);

describe('ootf Stomp Player play order (issue 5: Volcanic "Arrow No Flame" looped)', () => {
    it('maps every PC List Play Order to the PS2 order that plays the same scenes per trigger', () => {
        // PC 1 In Order Loop = next scene on each message: PS2 2, not PS2 1 (which replays the list by itself).
        expect(ps2PlayOrder(1, 1, false, 4)).toEqual({ order: PS2_ORDER_ONE_PER_TRIGGER });
        // PC 3 All at Once is PS2 4; PS2 3 is Randomly.
        expect(ps2PlayOrder(3, 1, false, 1)).toEqual({ order: PS2_ORDER_ALL_AT_ONCE });
        expect(ps2PlayOrder(2, 3, false, 4).order).toBe(PS2_ORDER_RANDOMLY);
        // PC 0 In Order Once with one scene is the same on both engines.
        expect(ps2PlayOrder(0, 1, false, 4)).toEqual({ order: PS2_ORDER_IN_ORDER_ONCE });
        expect(ps2PlayOrder(0, 1, true, 1)).toEqual({ order: PS2_ORDER_IN_ORDER_ONCE });
        // PC 0 with several scenes plays one per trigger; PS2 0 would run them all on the first trigger.
        const multi = ps2PlayOrder(0, 7, false, 4);
        expect(multi.order).toBe(PS2_ORDER_ONE_PER_TRIGGER);
        expect(multi.note).toMatch(/one per trigger/);
        // PS2 2 never plays on On or at load: keep 0 there, with a note.
        expect(ps2PlayOrder(1, 1, false, 1).order).toBe(PS2_ORDER_IN_ORDER_ONCE);
        expect(ps2PlayOrder(1, 1, false, 1).note).toBeDefined();
        expect(ps2PlayOrder(1, 1, true, 4).order).toBe(PS2_ORDER_IN_ORDER_ONCE);
        expect(ps2PlayOrder(0, 2, true, 4).order).toBe(PS2_ORDER_IN_ORDER_ONCE);
    });

    it('writes the mapped order, the PC class defaults and a class-default Sequence List', () => {
        // PC class 7: default list [0x172], In Order Loop, Initial State On, message 1 (none of them match the PS2 class).
        // Class data: the array default is (length << 16) | offset into the data words.
        const pcPlayer = cls(7, 'stomp player', 51, playerFields, [(1 << 16) | 4, 1, 1, 1, 0x172]);
        const pcList = { objects: [obj(30, 2, 7), obj(31, 2, 7), obj(32, 2, 7), obj(33, 2, 9)], warnings: [] };
        // 31 has its own list and PC order 3 (All at Once); 32 PC order 1 with message 4; 33 is not a player.
        setObjectParams(pcList, 31, [
            { fieldIndex: 0, type: T_SEQ_LIST, name: 'Sequence List', value: [0x1e7] },
            { fieldIndex: 1, type: T_ENUM, name: 'List Play Order', value: 3 },
        ]);
        setObjectParams(pcList, 32, [
            { fieldIndex: 0, type: T_SEQ_LIST, name: 'Sequence List', value: [0x1e7] },
            { fieldIndex: 3, type: T_ENUM, name: 'Message To Play Next', value: 4 },
            { fieldIndex: 2, type: T_ENUM, name: 'Initial State', value: 0 },
        ]);
        const pc = {
            path: 'Volcanic World/Volcano/volcano.lvl',
            list: pcList,
            classes: new Map([[2, new Map([[7, pcPlayer]])]]),
        } as unknown as PcLevel;
        expect(pcStompPlayer(pc, pcList.objects[0]!)).toEqual({
            sequences: [0x172],
            sequencesFromClass: true,
            order: 1,
            initialOn: true,
            message: 1,
        });
        expect(pcStompPlayer(pc, pcList.objects[3]!)).toBeNull();

        // PS2 template player class: default list [472] (a Drakan 2 scene), order 0, Triggered, message 4.
        const ps2Player = cls(129, 'Stomp Player', 51, playerFields, [0, 0, 0, 4]);
        const list = { objects: [obj(30, 8, 129), obj(31, 8, 129), obj(32, 8, 129), obj(33, 4, 5)], warnings: [] };
        setList(list, list.objects[1]!, [0x53]);
        setObjectParams(list, 31, [
            { fieldIndex: 0, type: T_SEQ_LIST, name: 'Sequence List', value: [0x53] },
            { fieldIndex: 1, type: T_ENUM, name: 'List Play Order', value: 3 },
        ]);
        setObjectParams(list, 32, [
            { fieldIndex: 0, type: T_SEQ_LIST, name: 'Sequence List', value: [0x53] },
            { fieldIndex: 1, type: T_ENUM, name: 'List Play Order', value: 1 },
        ]);
        const warnings: string[] = [];
        const changes = convertStompPlayers({
            pc,
            list,
            title: 'test',
            classOf: (o) => (o.classId === 129 ? ps2Player : undefined),
            mapSequence: (_o, ref) => (ref === 0x172 ? 0x61 : null),
            warnings,
        });
        expect(changes.map((c) => [c.id, c.pcOrder, c.before, c.ps2Order, c.classList])).toEqual([
            [30, 1, 0, PS2_ORDER_IN_ORDER_ONCE, true],
            [31, 3, 3, PS2_ORDER_ALL_AT_ONCE, false],
            [32, 1, 1, PS2_ORDER_ONE_PER_TRIGGER, false],
        ]);
        const [a, b, c] = list.objects;
        // 30: class list converted, PC defaults written; In Order Loop started at load stays 0 (with a note).
        expect(value(a!, 'Sequence List')).toEqual([0x61]);
        expect(value(a!, 'Initial State')).toBe(1);
        expect(value(a!, 'Message To Play Next')).toBe(1);
        expect(value(b!, 'Sequence List')).toEqual([0x53]);
        expect(value(b!, 'List Play Order')).toBe(PS2_ORDER_ALL_AT_ONCE);
        expect(value(b!, 'Message To Play Next')).toBe(1);
        expect(value(c!, 'List Play Order')).toBe(PS2_ORDER_ONE_PER_TRIGGER);
        expect(value(c!, 'Message To Play Next')).toBe(4);
        expect(value(c!, 'Initial State')).toBe(0);
        expect(list.objects[3]!.params).toEqual([]);
        expect(warnings.some((w) => /Stomp Player 30: In Order Loop starting at load/.test(w))).toBe(true);
    });

    it('writes an empty list for a class-default list that was not converted, never the PS2 class default', () => {
        const pcPlayer = cls(7, 'stomp player', 51, playerFields, [(1 << 16) | 4, 0, 0, 4, 0x2a8]);
        const pc = {
            path: 'x.lvl',
            list: { objects: [obj(40, 2, 7)], warnings: [] },
            classes: new Map([[2, new Map([[7, pcPlayer]])]]),
        } as unknown as PcLevel;
        const ps2Player = cls(129, 'Stomp Player', 51, playerFields, [0, 0, 0, 4]);
        const list = { objects: [obj(40, 8, 129)], warnings: [] };
        const warnings: string[] = [];
        convertStompPlayers({ pc, list, title: 't', classOf: () => ps2Player, mapSequence: () => null, warnings });
        expect(value(list.objects[0]!, 'Sequence List')).toEqual([0]);
        expect(warnings[0]).toMatch(/1 of 1 scene\(s\) not converted/);
    });
});

describe('ootf detector scenes sent Off (issue 5: Volcanic scene 9.2 never played)', () => {
    it('starts the scene of a detector whose message the player handles itself through a twin detector', () => {
        // PC detector 978: Play Sequence 9.2, Trigger Message Off, linked to the dragon; timer 5 enables it.
        const pcDet = cls(5, 'Detector', 61, detectorFields as never, [6, 1, 0]);
        const pcList = { objects: [obj(978, 2, 5, [40]), obj(40, 2, 6), obj(41, 2, 6, [978])], warnings: [] };
        setNamedParam(pcList, pcList.objects[0]!, detectorFields, 'Task', 4);
        setNamedParam(pcList, pcList.objects[0]!, detectorFields, 'Trigger Message', 0);
        const pc = {
            path: 'v.lvl',
            list: pcList,
            classes: new Map([[2, new Map([[5, pcDet]])]]),
        } as unknown as PcLevel;
        const ps2Det = cls(900, 'Detector', 61, detectorFields as never, [6, 5, 0]);
        const ps2Player = cls(129, 'Stomp Player', 51, playerFields, [0, 0, 0, 4]);
        const det = { ...obj(978, 4, 900, [40]), scale: [6, 2, 3], flags: 0x101 } as LvlObject;
        const list = { objects: [det, obj(40, 8, 128), obj(41, 8, 127, [978])], warnings: [] };
        setNamedParam(list, det, detectorFields, 'Task', 4);
        const warnings: string[] = [];
        const n = relayDetectorSequences({
            pc,
            list,
            title: 'test',
            classOf: (o) => (o.classId === 900 ? ps2Det : o.classId === 129 ? ps2Player : undefined),
            player: { dbIndex: 8, classId: 129 },
            relayed: (o) => (o.id === 978 ? [0x46] : []),
            warnings,
        });
        expect(n).toBe(1);
        const player = list.objects.find((o) => o.classId === 129)!;
        const twin = list.objects.find((o) => o.classId === 900 && o.id !== 978)!;
        // The detector keeps sending Off to the dragon only; the twin (same box) sends Play Sequence to the player.
        expect(det.links).toEqual([40]);
        expect(value(det, 'Trigger Message')).toBe(0);
        expect(twin.links).toEqual([player.id]);
        expect(twin.scale).toEqual([6, 2, 3]);
        expect(twin.flags).toBe(0x101);
        expect(value(twin, 'Trigger Message')).toBe(4);
        expect(value(twin, 'Task')).toBe(6);
        expect(value(player, 'Message To Play Next')).toBe(4);
        expect(value(player, 'Sequence List')).toEqual([0x46]);
        // Whatever enables the detector enables the twin too.
        expect(list.objects[2]!.links).toEqual([978, twin.id]);
    });

    it('keeps On: it arms the player, which plays its one scene', () => {
        const pcDet = cls(5, 'Detector', 61, detectorFields as never, [6, 1, 0]);
        const pcList = { objects: [obj(1994, 2, 5)], warnings: [] };
        setNamedParam(pcList, pcList.objects[0]!, detectorFields, 'Task', 4);
        const pc = {
            path: 'v.lvl',
            list: pcList,
            classes: new Map([[2, new Map([[5, pcDet]])]]),
        } as unknown as PcLevel;
        const ps2Det = cls(900, 'Detector', 61, detectorFields as never, [6, 5, 0]);
        const ps2Player = cls(129, 'Stomp Player', 51, playerFields, [0, 0, 0, 4]);
        const list = { objects: [obj(1994, 4, 900)], warnings: [] };
        relayDetectorSequences({
            pc,
            list,
            title: 'test',
            classOf: (o) => (o.classId === 900 ? ps2Det : o.classId === 129 ? ps2Player : undefined),
            player: { dbIndex: 8, classId: 129 },
            relayed: () => [0x13b],
            warnings: [],
        });
        expect(list.objects).toHaveLength(2);
        expect(list.objects[0]!.links).toEqual([list.objects[1]!.id]);
        expect(value(list.objects[1]!, 'Message To Play Next')).toBe(1);
    });
});
