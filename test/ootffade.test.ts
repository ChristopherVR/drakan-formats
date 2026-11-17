// Synthetic fixtures only; no game bytes.
import { describe, expect, it } from 'vitest';
import type { LvlObject, LvlObjectList, OdbClass } from '../src/index.ts';
import { FADER_RFL } from '../src/ootfclass.ts';
import {
    dropStompFader,
    FADER_FIELDS,
    hasScenes,
    holdLevelStartFaders,
    isLevelStartFadeIn,
    levelStartFaders,
    pcFaderTimes,
    STOMP_FADER_FIELD,
    STOMP_PLAYER_RFL,
} from '../src/ootffade.ts';
import type { PcLevel } from '../src/pc.ts';

const T_INT = 1;
const T_FLOAT = 2;
const f32 = (x: number): number => {
    const dv = new DataView(new ArrayBuffer(4));
    dv.setFloat32(0, x);
    return dv.getUint32(0);
};

const faderFields = [
    { type: T_FLOAT, name: FADER_FIELDS.fadeIn },
    { type: T_FLOAT, name: FADER_FIELDS.faded },
    { type: T_FLOAT, name: FADER_FIELDS.fadeOut },
    { type: T_INT, name: FADER_FIELDS.startMode },
    { type: T_INT, name: 'Color' },
];

/** A fader class with the given defaults (fade in, faded, fade out, start mode). */
function faderClass(id: number, d: [number, number, number, number], model: unknown = null): OdbClass {
    return {
        id,
        name: 'Fader',
        group: 0,
        runtimeClass: FADER_RFL,
        rflClass: FADER_RFL,
        model,
        fields: faderFields,
        data: [f32(d[0]), f32(d[1]), f32(d[2]), d[3], 0],
    } as unknown as OdbClass;
}

const obj = (id: number, classId: number): LvlObject =>
    ({
        id,
        classId,
        dbIndex: 1,
        pos: [0, 0, 0],
        rot: [0, 0, 0],
        scale: null,
        flags: 1,
        initialEvents: 0,
        radius: null,
        links: [],
        params: [],
        data: [],
    }) as unknown as LvlObject;

/** Object `o` with its Start Mode overridden (the PC level's own parameter). */
function withStartMode(o: LvlObject, mode: number): LvlObject {
    const name = FADER_FIELDS.startMode;
    const nameRaw = new Uint8Array(name.length + 1 + ((name.length + 1) % 2));
    for (let i = 0; i < name.length; i++) nameRaw[i] = name.charCodeAt(i);
    return { ...o, params: [{ fieldIndex: 3, type: T_INT, name, nameRaw }], data: [mode] } as LvlObject;
}

// The Ruined Village shape: a level-start fader (Start Mode 0, black at once, 2 s fade out), scene faders that run on a
// message (one black at once, one that fades to black and holds 4 s), a fader that holds black until a second message,
// and a model fader (fades its own model, not the screen).
const classes = new Map<number, OdbClass>([
    [10, faderClass(10, [0, 0, 2, 0])],
    [11, faderClass(11, [0, 0, 2, 1])],
    [12, faderClass(12, [2, 4, 0, 1])],
    [13, faderClass(13, [0, -1, 3, 0])],
    [14, faderClass(14, [0, 0, 2, 0], { ref: 1 })],
]);
const pc = {
    path: 'Test/Test.lvl',
    list: {
        objects: [obj(100, 10), obj(101, 11), obj(102, 12), obj(103, 13), obj(104, 14), withStartMode(obj(105, 11), 0)],
        warnings: [],
    },
    classes: new Map([[1, classes]]),
} as unknown as PcLevel;

describe('OotF level-start faders', () => {
    it('recognises a fade in from black at the level start only', () => {
        expect(isLevelStartFadeIn({ fadeIn: 0, faded: 0, fadeOut: 2, startMode: 0 })).toBe(true);
        expect(isLevelStartFadeIn({ fadeIn: 0, faded: 0, fadeOut: 2, startMode: 1 })).toBe(false); // waits for a scene
        expect(isLevelStartFadeIn({ fadeIn: 2, faded: 4, fadeOut: 0, startMode: 0 })).toBe(false); // a fade to black
        expect(isLevelStartFadeIn({ fadeIn: 0, faded: -1, fadeOut: 3, startMode: 0 })).toBe(false); // holds black
        expect(isLevelStartFadeIn({ fadeIn: 0, faded: 0, fadeOut: 0, startMode: 0 })).toBe(false); // nothing to fade
    });

    it('reads class defaults and the object override', () => {
        expect(pcFaderTimes(pc, pc.list.objects[0]!)).toEqual({ fadeIn: 0, faded: 0, fadeOut: 2, startMode: 0 });
        expect(pcFaderTimes(pc, pc.list.objects[5]!)?.startMode).toBe(0);
        expect(pcFaderTimes(pc, pc.list.objects[4]!)).toBeUndefined(); // model fader
    });

    it('finds the start faders of a level and makes their converted copies wait for a message', () => {
        expect(levelStartFaders(pc)).toEqual([100, 105]);
        // Converted ids are renumbered; 105 was dropped by the conversion.
        const ps2 = new Map<number, OdbClass>([[10, faderClass(10, [0, 0, 2, 0])]]);
        const converted: LvlObjectList = {
            objects: [obj(500, 10), obj(501, 10), obj(502, 10)],
            warnings: [],
        };
        const idMap = new Map([
            [100, 500],
            [101, 501],
            [102, 502],
        ]);
        const held = holdLevelStartFaders(pc, converted, idMap, (o) => ps2.get(o.classId));
        expect(held).toEqual([500]);
        const start = (o: LvlObject): number | undefined => {
            const i = o.params.findIndex((p) => p.name === FADER_FIELDS.startMode);
            return i < 0 ? undefined : o.data[i];
        };
        expect(start(converted.objects[0]!)).toBe(1);
        expect(start(converted.objects[1]!)).toBeUndefined(); // scene fader: untouched
        expect(start(converted.objects[2]!)).toBeUndefined();
    });
});

describe('OotF Stomp Fader', () => {
    const stomp = {
        id: 20,
        name: 'Stomp Player',
        group: 0,
        runtimeClass: STOMP_PLAYER_RFL,
        rflClass: STOMP_PLAYER_RFL,
        model: null,
        fields: [{ type: T_INT, name: 'Initial State' }],
        data: [0],
    } as unknown as OdbClass;
    const props = {
        id: 30,
        name: 'Level Properties',
        group: 0,
        runtimeClass: 54,
        rflClass: 54,
        model: null,
        fields: [
            { type: T_INT, name: 'Starting Fader' },
            { type: T_INT, name: STOMP_FADER_FIELD },
        ],
        data: [200745, 200746],
    } as unknown as OdbClass;
    const level = (withStomp: boolean): PcLevel =>
        ({
            path: 'Test/Test.lvl',
            list: { objects: withStomp ? [obj(1, 20)] : [obj(2, 10)], warnings: [] },
            classes: new Map([
                [
                    1,
                    new Map<number, OdbClass>([
                        [10, faderClass(10, [0, 0, 2, 0])],
                        [20, stomp],
                    ]),
                ],
            ]),
        }) as unknown as PcLevel;
    const stompFader = (o: LvlObject): number | undefined => {
        const i = o.params.findIndex((p) => p.name === STOMP_FADER_FIELD);
        return i < 0 ? undefined : o.data[i];
    };

    it('clears the Stomp Fader of a level with scenes and keeps the Starting Fader', () => {
        expect(hasScenes(level(true))).toBe(true);
        const lp = obj(900, 30);
        const list: LvlObjectList = { objects: [lp], warnings: [] };
        expect(dropStompFader(level(true), list, lp, props.fields)).toBe(true);
        expect(stompFader(lp)).toBe(0);
        expect(lp.params.some((p) => p.name === 'Starting Fader')).toBe(false); // class default stays
    });

    it('leaves a level without scenes alone', () => {
        expect(hasScenes(level(false))).toBe(false);
        const lp = obj(900, 30);
        expect(dropStompFader(level(false), { objects: [lp], warnings: [] }, lp, props.fields)).toBe(false);
        expect(stompFader(lp)).toBeUndefined();
        expect(dropStompFader(level(true), { objects: [], warnings: [] }, undefined, props.fields)).toBe(false);
    });
});
