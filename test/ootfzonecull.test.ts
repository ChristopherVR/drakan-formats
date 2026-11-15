// Synthetic classes and objects only; no game assets.
import { describe, expect, it } from 'vitest';
import { FIELD_ENUM } from '../src/fields.ts';
import type { LvlObject, LvlObjectList } from '../src/lvl.ts';
import type { OdbClass } from '../src/odb.ts';
import { applyZoneCulls, findZoneCulls } from '../src/ootfzonecull.ts';

const cls = (id: number, rflClass: number, fields: [string, number][]): OdbClass => ({
    id,
    name: `class ${id}`,
    group: 0,
    runtimeClass: 0x10000 + rflClass,
    rflClass,
    fields: fields.map(([name]) => ({ name, type: FIELD_ENUM })),
    data: fields.map(([, v]) => v),
});

const toggler = cls(1, 121, [
    ['Trigger Mode', 1],
    ['Show Message', 1],
    ['Hide Message', 0],
]);
const togglerMode0 = cls(2, 121, [
    ['Trigger Mode', 0],
    ['Show Message', 1],
    ['Hide Message', 0],
]);
const detOn = cls(3, 61, [['Trigger Message', 1]]);
const detOff = cls(4, 61, [['Trigger Message', 0]]);
const prop = cls(5, 17, []);
const boulder = cls(6, 16, []);
const grunt = cls(7, 49, []);
const lever = cls(8, 13, []);
const counter = cls(9, 7, [['Message To Send', 1]]);
const classes = new Map(
    [toggler, togglerMode0, detOn, detOff, prop, boulder, grunt, lever, counter].map((c) => [c.id, c]),
);
const classOf = (o: LvlObject): OdbClass | undefined => classes.get(o.classId);
const isCreature = (rfl: number): boolean => rfl === 49;

const object = (id: number, classId: number, links: number[] = [], visible = true, pos = [0, 0, 0]): LvlObject => ({
    id,
    classId,
    dbIndex: 0,
    prefix0: 0,
    prefix1: 0,
    flags: visible ? 1 : 0,
    pos: pos as [number, number, number],
    rot: [0, 0, 0],
    scale: null,
    links,
    params: [],
    data: [],
    initialEvents: 1,
    radius: null,
    preSentinel: 0,
    sentinel: 0xffffffff,
});

/** A camp: toggler 10 over hidden props 20-23 and a visible arch 24; detector 30 shows (and wakes grunts 40, 41), 31 hides. */
const camp = (
    opt: { togglerClass?: number; hiddenBoulder?: boolean; extraSource?: LvlObject } = {},
): LvlObjectList => ({
    objects: [
        object(10, opt.togglerClass ?? 1, [20, 21, 22, 23, 24]),
        object(20, 5, [], false, [1000, 0, 1000]),
        object(21, 5, [], false, [1500, 0, 1000]),
        object(22, 8, [], false, [1200, 0, 1400]),
        object(23, opt.hiddenBoulder ? 6 : 5, [], false, [900, 0, 900]),
        object(24, 5, [], true, [9000, 0, 9000]),
        object(30, 3, [40, 41, 10]),
        object(31, 4, [10]),
        object(40, 7, [], false, [2000, 0, 2000]),
        object(41, 7, [], false, [40000, 0, 40000]),
        ...(opt.extraSource ? [opt.extraSource] : []),
    ],
    warnings: [],
});

describe('zone culling togglers', () => {
    it('shows the hidden scenery and the grunts among it, and cuts the Hide source', () => {
        const pc = camp();
        const culls = findZoneCulls(pc, classOf, isCreature);
        expect(culls).toEqual([{ toggler: 10, shown: [20, 21, 22, 23], hideSources: [31], creatures: [40] }]);
        const ps2 = camp();
        expect(applyZoneCulls(ps2, culls)).toBe(5);
        const by = new Map(ps2.objects.map((o) => [o.id, o]));
        for (const id of [20, 21, 22, 23, 40]) expect(by.get(id)!.flags & 1).toBe(1);
        expect(by.get(41)!.flags & 1).toBe(0); // far from the camp: still waits for its detector
        expect(by.get(31)!.links).toEqual([]);
        expect(by.get(30)!.links).toEqual([40, 41, 10]);
    });

    it('leaves puzzle togglers alone', () => {
        // Toggle mode, a hidden boulder, a non-detector source, too few links, no Hide detector.
        expect(findZoneCulls(camp({ togglerClass: 2 }), classOf, isCreature)).toEqual([]);
        expect(findZoneCulls(camp({ hiddenBoulder: true }), classOf, isCreature)).toEqual([]);
        expect(findZoneCulls(camp({ extraSource: object(50, 9, [10]) }), classOf, isCreature)).toEqual([]);
        const few: LvlObjectList = {
            objects: [
                object(10, 1, [20, 21]),
                object(20, 5, [], false),
                object(21, 5, [], false),
                object(30, 3, [10]),
                object(31, 4, [10]),
            ],
            warnings: [],
        };
        expect(findZoneCulls(few, classOf, isCreature)).toEqual([]);
        const allVisible = camp();
        for (const o of allVisible.objects) if (o.classId !== 7) o.flags |= 1;
        expect(findZoneCulls(allVisible, classOf, isCreature)).toEqual([]);
        const showOnly = camp();
        showOnly.objects = showOnly.objects.filter((o) => o.id !== 31);
        expect(findZoneCulls(showOnly, classOf, isCreature)).toEqual([]);
    });
});
