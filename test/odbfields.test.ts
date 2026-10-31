// Synthetic class-field fixtures only; no game bytes.
import { zlibSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import {
    FIELD_ARRAY,
    LvlEditError,
    SrscReader,
    classFieldDefault,
    decodeFieldValue,
    objectParamSpecs,
    paramValue,
    parseFieldLists,
    parseObjectList,
    parseOdbClasses,
    refParts,
    refValue,
    setObjectParams,
    stringToWords,
    writeObjectList,
    type LvlObject,
    type LvlObjectList,
} from '../src/index.ts';
import { buildSrsc } from './fixtures.ts';

const u16 = (n: number): number[] => [n & 255, (n >> 8) & 255];
const u32 = (n: number): number[] => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];
const f32 = (n: number): number[] => {
    const d = new DataView(new ArrayBuffer(4));
    d.setFloat32(0, n, true);
    return [...new Uint8Array(d.buffer)];
};
const str = (s: string): number[] => {
    const raw = [...s].map((c) => c.charCodeAt(0));
    raw.push(0);
    if (raw.length % 2) raw.push(0);
    return [...u16(raw.length), ...raw];
};
const defs = (d: [number, string][]): number[] => [...u32(d.length), ...d.flatMap(([t, n]) => [...u32(t), ...str(n)])];

/** Plain class (no model): group, model 0/0, 10 zero bytes, rfl class, 1, icon, fc, dc, data. */
function plainClass(name: string, fc: number, data: number[]): Uint8Array {
    return Uint8Array.from([
        ...str(name),
        ...u16(7),
        ...u16(0),
        ...u16(0),
        ...new Array<number>(10).fill(0),
        ...u16(28),
        ...u16(1),
        ...u16(3),
        ...u32(fc),
        ...u32(data.length),
        ...data.flatMap(u32),
    ]);
}

/** Model class: 86 bytes (with model ref and an rfl/icon pair at +80/+84) before the field count. */
function modelClass(name: string, fc: number, data: number[]): Uint8Array {
    const head = new Array<number>(86).fill(0);
    head.splice(0, 6, ...u16(7), ...u16(1234), ...u16(2));
    head.splice(80, 6, ...u16(41), ...u16(1), ...u16(9));
    return Uint8Array.from([...str(name), ...head, ...u32(fc), ...u32(data.length), ...data.flatMap(u32)]);
}

const floatBits = (v: number): number => new DataView(new Uint8Array(f32(v)).buffer).getUint32(0, true);

// Plain class "Switch": float 1.5, enum 4, string "hi" at dword 3..3, int array at dword 4..5 ([-2, 7]).
const SWITCH_DEFS: [number, string][] = [
    [2, 'Delay'],
    [7, 'Mode'],
    [0x0a, 'Text'],
    [0x1001, 'Values'],
    [0x2003, 'Target'],
];
const SWITCH_DATA = [
    floatBits(1.5),
    4,
    ((1 << 16) | 5) >>> 0,
    ((2 << 16) | 6) >>> 0,
    0x20005,
    ...stringToWords('hi'),
    0xfffffffe,
    7,
];

function odb(): Uint8Array {
    const blob = Uint8Array.from([
        ...defs(SWITCH_DEFS),
        ...defs([
            [1, 'Initial Health'],
            [5, 'Hit Sound'],
        ]),
    ]);
    return buildSrsc([
        { type: 0x0101, id: 1, sub: 0, data: Uint8Array.from(str('Group')) },
        { type: 0x0102, id: 10, sub: 1, data: plainClass('Switch', 5, SWITCH_DATA) },
        { type: 0x0102, id: 11, sub: 1, data: modelClass('Orc', 2, [35, 0x10042]) },
        { type: 0x0103, id: 0, sub: 0, data: zlibSync(blob) },
    ]);
}

describe('ODB class fields', () => {
    it('decodes definitions, defaults, strings and arrays for classes with and without a model', async () => {
        const classes = await parseOdbClasses(await SrscReader.fromBytes(odb()));
        const sw = classes.get(10)!;
        expect(sw.fields?.map((f) => f.name)).toEqual(['Delay', 'Mode', 'Text', 'Values', 'Target']);
        expect(sw.model).toBeNull();
        expect(sw.rflClass).toBe(28);
        expect(sw.icon).toBe(3);
        expect([0, 1, 2, 3, 4].map((i) => classFieldDefault(sw, i))).toEqual([1.5, 4, 'hi', [0xfffffffe, 7], 0x20005]);
        const orc = classes.get(11)!;
        expect(orc.model).toEqual({ id: 1234, db: 2 });
        expect(orc.rflClass).toBe(41);
        expect(orc.icon).toBe(9);
        expect(classFieldDefault(orc, 0)).toBe(35);
        expect(classFieldDefault(orc, 1)).toBe(0x10042);
    });

    it('leaves fields off when the list does not match the records', async () => {
        const bad = buildSrsc([
            { type: 0x0102, id: 10, sub: 1, data: plainClass('Switch', 5, SWITCH_DATA) },
            { type: 0x0103, id: 0, sub: 0, data: zlibSync(Uint8Array.from(defs([[1, 'Only one']]))) },
        ]);
        const c = (await parseOdbClasses(await SrscReader.fromBytes(bad))).get(10)!;
        expect(c.name).toBe('Switch');
        expect(c.fields).toBeUndefined();
    });

    it('rejects a truncated field blob', () => {
        const blob = Uint8Array.from(defs([[1, 'Initial Health']]));
        expect(parseFieldLists(blob)).toHaveLength(1);
        expect(parseFieldLists(blob.subarray(0, blob.length - 1))).toBeNull();
    });

    it('splits references into id and db', () => {
        expect(refParts(0x30219)).toEqual({ id: 0x219, db: 3 });
        expect(refValue(3, 0x219)).toBe(0x30219);
        expect(decodeFieldValue(1, 0xffffffff, [])).toBe(-1);
    });
});

function obj(id: number, over: Partial<LvlObject> = {}): LvlObject {
    return {
        id,
        classId: 10,
        dbIndex: 2,
        prefix0: 0,
        prefix1: 0,
        pos: [1, 2, 3],
        flags: 1,
        initialEvents: 1,
        radius: null,
        links: [],
        rot: [0, 0, 0],
        scale: null,
        preSentinel: 0,
        sentinel: 0xffffffff,
        data: [],
        params: [],
        ...over,
    };
}

describe('setObjectParams', () => {
    it('writes scalars, strings and arrays in field order and reads them back through the parser', () => {
        const list: LvlObjectList = { objects: [obj(5), obj(6)], warnings: [] };
        setObjectParams(list, 5, [
            { fieldIndex: 3, type: 0x1001, name: 'Values', value: [0xfffffffe, 7, 9] },
            { fieldIndex: 0, type: 2, name: 'Delay', value: 2.25 },
            { fieldIndex: 2, type: 0x0a, name: 'Text', value: 'hello' },
        ]);
        const o = list.objects[0]!;
        expect(o.params.map((p) => p.fieldIndex)).toEqual([0, 2, 3]);
        expect(o.params.map((p) => p.nameRaw.length % 2)).toEqual([0, 0, 0]);
        const back = parseObjectList(writeObjectList(list)).objects[0]!;
        expect(back.params.map((p) => p.name)).toEqual(['Delay', 'Text', 'Values']);
        expect([0, 1, 2].map((i) => paramValue(back, i))).toEqual([2.25, 'hello', [0xfffffffe, 7, 9]]);
        // rewriting the same specs keeps the values
        setObjectParams(list, 5, objectParamSpecs(back));
        expect(objectParamSpecs(list.objects[0]!)).toEqual(objectParamSpecs(back));
        // dropping every parameter empties the data area
        setObjectParams(list, 5, []);
        expect(list.objects[0]!.data).toEqual([]);
    });

    it('rejects duplicates, bad values and unknown objects', () => {
        const list: LvlObjectList = { objects: [obj(5)], warnings: [] };
        const f = { fieldIndex: 1, type: 7, name: 'Mode', value: 1 };
        expect(() => setObjectParams(list, 5, [f, f])).toThrow(LvlEditError);
        expect(() => setObjectParams(list, 5, [{ ...f, value: Number.NaN }])).toThrow(LvlEditError);
        expect(() => setObjectParams(list, 5, [{ ...f, type: 0x0a }])).toThrow(LvlEditError);
        expect(() => setObjectParams(list, 5, [{ ...f, type: 2 | FIELD_ARRAY }])).toThrow(LvlEditError);
        expect(() => setObjectParams(list, 99, [])).toThrow(LvlEditError);
    });
});
