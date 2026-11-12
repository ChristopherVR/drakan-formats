// Marker models of converted logic objects (ootfmarkers.ts). Synthetic objects and classes; no game bytes.
import { describe, expect, it } from 'vitest';
import type { LvlObject, LvlObjectList, OdbClass } from '../src/index.ts';
import { FLAG_SCALED, FLAG_VISIBLE } from '../src/lvl.ts';
import { DYNAMIC_LIGHT_RFL, hideLightMarkers } from '../src/ootfmarkers.ts';

const cls = (id: number, rfl: number, model: boolean): OdbClass => ({
    id,
    name: `class ${id}`,
    group: 1,
    runtimeClass: 0x10000 | rfl,
    rflClass: rfl,
    model: model ? { id: 900 + id, db: 0 } : null,
    fields: [],
    data: [],
});
const obj = (id: number, classId: number, flags: number): LvlObject =>
    ({
        id,
        classId,
        dbIndex: 1,
        prefix0: 0,
        prefix1: 0,
        pos: [0, 0, 0],
        flags,
        initialEvents: 1,
        radius: null,
        links: [],
        rot: [0, 0, 0],
        scale: flags & FLAG_SCALED ? [2, 2, 2] : null,
        preSentinel: 0,
        sentinel: 0xffffffff,
        data: [],
        params: [],
    }) as LvlObject;

describe('hideLightMarkers', () => {
    const classes = new Map<number, OdbClass>([
        [1, cls(1, DYNAMIC_LIGHT_RFL, true)], // dynamic light with the marker cube
        [2, cls(2, DYNAMIC_LIGHT_RFL, false)], // model-less dynamic light
        [3, cls(3, 132, true)], // static light
        [4, cls(4, 61, true)], // detector box
        [5, cls(5, 17, true)], // scenery
    ]);
    const classOf = (o: LvlObject): OdbClass | undefined => classes.get(o.classId);
    const listOf = (objects: LvlObject[]): LvlObjectList => ({ objects }) as LvlObjectList;

    it('clears FLAG_VISIBLE on a dynamic light whose class carries a model, and on nothing else', () => {
        const objects = [
            obj(10, 1, FLAG_VISIBLE),
            obj(11, 1, FLAG_VISIBLE | 0x08),
            obj(12, 1, 0),
            obj(13, 2, FLAG_VISIBLE),
            obj(14, 3, FLAG_VISIBLE),
            obj(15, 4, FLAG_VISIBLE | FLAG_SCALED),
            obj(16, 5, FLAG_VISIBLE),
            obj(17, 99, FLAG_VISIBLE), // class not known
        ];
        expect(hideLightMarkers(listOf(objects), classOf)).toEqual([10, 11]);
        expect(objects.map((o) => o.flags)).toEqual([
            0,
            0x08,
            0,
            FLAG_VISIBLE,
            FLAG_VISIBLE,
            FLAG_VISIBLE | FLAG_SCALED,
            FLAG_VISIBLE,
            FLAG_VISIBLE,
        ]);
    });

    it('keeps the other flags, the scale and the links of a hidden light', () => {
        const o = obj(20, 1, FLAG_VISIBLE | FLAG_SCALED);
        o.links = [7, 8];
        expect(hideLightMarkers(listOf([o]), classOf)).toEqual([20]);
        expect(o.flags).toBe(FLAG_SCALED);
        expect(o.scale).toEqual([2, 2, 2]);
        expect(o.links).toEqual([7, 8]);
    });

    it('changes nothing on a second pass', () => {
        const objects = [obj(30, 1, FLAG_VISIBLE)];
        hideLightMarkers(listOf(objects), classOf);
        expect(hideLightMarkers(listOf(objects), classOf)).toEqual([]);
    });
});
