// Synthetic classes and objects only; no game assets.
import { describe, expect, it } from 'vitest';
import { FIELD_ENUM } from '../src/fields.ts';
import type { LvlObject, LvlObjectList } from '../src/lvl.ts';
import { paramValue } from '../src/lvl.ts';
import type { OdbClass } from '../src/odb.ts';
import { holdLinkedDoors, sceneAutoOpenDoors, sentMessage } from '../src/ootfdoors.ts';

const cls = (id: number, rflClass: number, fields: [string, number][]): OdbClass => ({
    id,
    name: `class ${id}`,
    group: 0,
    runtimeClass: 0x10000 + rflClass,
    rflClass,
    fields: fields.map(([name]) => ({ name, type: FIELD_ENUM })),
    data: fields.map(([, v]) => v),
});

const door = cls(1, 19, [
    ['Locked', 0],
    ['Auto-Open?', 1],
]);
const detector = cls(2, 61, [
    ['Task', 6],
    ['Trigger Message', 1],
]);
const toggler = cls(3, 121, [
    ['Trigger Mode', 1],
    ['Show Message', 1],
]);
const timer = cls(4, 62, [
    ['Time Until Trigger', 1],
    ['Trigger Message', 7],
]);
const creature = cls(5, 49, []);
const classes = new Map([door, detector, toggler, timer, creature].map((c) => [c.id, c]));
const hiddenCreature = (o: LvlObject): boolean => o.classId === 5 && !(o.flags & 1);

const object = (id: number, classId: number, links: number[] = []): LvlObject => ({
    id,
    classId,
    dbIndex: 0,
    prefix0: 0,
    prefix1: 0,
    flags: 1,
    pos: [0, 0, 0],
    rot: [0, 0, 0],
    scale: null,
    links,
    params: [],
    data: [],
    initialEvents: 0,
    radius: null,
    preSentinel: 0,
    sentinel: 0xffffffff,
});

const withMessage = (o: LvlObject, message: number): LvlObject => ({
    ...o,
    params: [{ fieldIndex: 1, type: FIELD_ENUM, name: 'Trigger Message', nameRaw: new Uint8Array(16) }],
    data: [message],
});

describe('ambush doors of converted OotF levels', () => {
    it('reads the sent message from the object or its class default', () => {
        expect(sentMessage(object(10, 2), detector)).toBe(1);
        expect(sentMessage(withMessage(object(10, 2), 0), detector)).toBe(0);
        expect(sentMessage(object(10, 3), toggler)).toBeNull();
    });

    it('turns auto-open off only on ambush doors: On from a source that also wakes a hidden creature', () => {
        const hidden = { ...object(300, 5), flags: 0 };
        const list: LvlObjectList = {
            objects: [
                object(100, 1), // the outhouse door: the detector opens it and starts the timer that wakes the orc
                object(101, 1), // only a visibility toggler links to it
                object(102, 1), // the detector sends Off
                object(103, 1), // nothing links to it
                object(104, 1), // opened by a detector that wakes nobody (the temple doors)
                object(200, 2, [100, 210]),
                object(201, 3, [101]),
                withMessage(object(202, 2, [102, 300]), 0),
                object(204, 2, [104]),
                object(210, 4, [300]),
                hidden,
            ],
            warnings: [],
        };
        const held = holdLinkedDoors(list, (o) => classes.get(o.classId), hiddenCreature);
        expect(held).toEqual([100]);
        const d = list.objects.find((o) => o.id === 100)!;
        expect(d.params.map((p) => p.name)).toEqual(['Auto-Open?']);
        expect(paramValue(d, 0)).toBe(0);
        for (const id of [101, 102, 103, 104]) expect(list.objects.find((o) => o.id === id)!.params).toEqual([]);
    });

    it('keeps a value the object already sets', () => {
        const own: LvlObject = {
            ...object(100, 1),
            params: [{ fieldIndex: 1, type: FIELD_ENUM, name: 'Auto-Open?', nameRaw: new Uint8Array(12) }],
            data: [1],
        };
        const list: LvlObjectList = {
            objects: [own, object(200, 2, [100, 300]), { ...object(300, 5), flags: 0 }],
            warnings: [],
        };
        expect(holdLinkedDoors(list, (o) => classes.get(o.classId), hiddenCreature)).toEqual([]);
        expect(paramValue(list.objects[0]!, 0)).toBe(1);
    });
});

describe('doors held during cut scenes', () => {
    const swing = cls(6, 19, [
        ['Locked', 0],
        ['Auto-Open?', 1],
        ['Auto-Open Distance (lu)', 2],
    ]);
    const lookup = new Map([...classes, [6, swing]]);
    const at = (o: LvlObject, x: number, z: number): LvlObject => ({ ...o, pos: [x, 0, z] });

    it('names the auto-open doors within their distance (plus a margin) of a scene key of the player', () => {
        const off: LvlObject = {
            ...at(object(103, 6), 0, 0),
            params: [{ fieldIndex: 1, type: FIELD_ENUM, name: 'Auto-Open?', nameRaw: new Uint8Array(12) }],
            data: [0],
        };
        const list: LvlObjectList = {
            objects: [
                at(object(100, 6), 3000, 0),
                at(object(101, 6), 6000, 0),
                at(object(102, 6), 0, 20000),
                off,
                at(object(104, 2), 0, 0),
            ],
            warnings: [],
        };
        // 2 lu = 4096 units, plus the 1024 margin: 100 (3000 away) and 101 (6000 away from the first key, 5000 from the second)
        expect(
            sceneAutoOpenDoors(list, (o) => lookup.get(o.classId), [
                [0, 0, 0],
                [1000, 0, 0],
            ]),
        ).toEqual([100, 101]);
        expect(sceneAutoOpenDoors(list, (o) => lookup.get(o.classId), [])).toEqual([]);
    });
});
