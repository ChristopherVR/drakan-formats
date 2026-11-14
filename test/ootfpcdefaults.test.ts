// Synthetic classes only: no game assets. A PC class mapped onto a same-named PS2 class keeps the PS2 class defaults
// unless the object carries the PC default explicitly (Alwarren's "count down to zero": PC Off decrements, PS2 Off increments).
import { describe, expect, it } from 'vitest';
import { convertPcLevel, encodeString, objectParamSpecs, type ClassTarget } from '../src/index.ts';
import { keepsPcDefaults } from '../src/ootfclass.ts';
import type { LvlHeader, LvlObject } from '../src/lvl.ts';
import type { OdbClass } from '../src/odb.ts';
import type { PcLevel } from '../src/pc.ts';

const T_INT = 1;
const T_FLOAT = 2;
const T_ENUM = 7;
const T_STR = 0x0a;
const f32 = (n: number): number => {
    const d = new DataView(new ArrayBuffer(4));
    d.setFloat32(0, n, true);
    return d.getUint32(0, true);
};

const counter = (name: string, data: number[]): OdbClass => ({
    id: 951,
    name,
    rflClass: 7,
    runtimeClass: 0x10007,
    group: 1,
    fields: [
        { type: T_INT, name: 'Initial Counter Value' },
        { type: T_ENUM, name: 'Increment (+1) Message' },
        { type: T_ENUM, name: 'Decrement (-1) Message' },
        { type: T_FLOAT, name: 'Delay' },
        { type: T_STR, name: 'Note' },
    ],
    data,
});

const object = (id: number, params: LvlObject['params'] = [], data: number[] = []): LvlObject => ({
    id,
    classId: 3369,
    dbIndex: 2,
    prefix0: 0,
    prefix1: 0,
    flags: 1,
    pos: [0, 0, 0],
    rot: [0, 0, 0],
    scale: null,
    links: [],
    params,
    data,
    initialEvents: 0,
    radius: null,
    preSentinel: 0,
    sentinel: 0xffffffff,
});

function level(pcClass: OdbClass, objects: LvlObject[]): PcLevel {
    const header: LvlHeader = {
        name: encodeString('Synthetic Alwarren'),
        maxWidth: 1,
        maxHeight: 1,
        dependencies: [{ dbIndex: 2, zero: 0, path: encodeString('Alwarren') }],
        trailer: new Uint8Array(),
    };
    return {
        path: 'Islands World/Alwarren/Alwarren.lvl',
        header,
        terrain: [],
        list: { objects, warnings: [] },
        classes: new Map([[2, new Map([[3369, pcClass]])]]),
        odbPaths: new Map([[2, 'Islands World/Alwarren/Alwarren.odb']]),
        warnings: [],
    } as unknown as PcLevel;
}

describe('PC class defaults of name-mapped classes', () => {
    // PC: counts Off (0) down and On (1) up; PS2 class of the same name: Off up, On down. The string and the equal
    // field stay with the PS2 class.
    const pc = counter('count down to zero', [6, 1, 0, f32(0.5), 0]);
    const ps2 = counter('Count down to Zero', [6, 0, 1, f32(1), 0]);
    const target: ClassTarget = { dbIndex: 8, classId: 951, cls: ps2 };
    const header = level(pc, []).header;
    const convert = (objects: LvlObject[], keep: boolean) =>
        convertPcLevel(level(pc, objects), {
            template: { header, classes: new Map([[8, new Map([[951, ps2]])]]) },
            textureFallback: 0,
            resolveClass: () => target,
            keepPcDefaults: keep ? (c, t) => keepsPcDefaults(c.rflClass) && t === target : undefined,
        });
    const params = (r: ReturnType<typeof convert>, id: number) =>
        Object.fromEntries(objectParamSpecs(r.objects.objects.find((o) => o.id === id)!).map((s) => [s.name, s.value]));

    it('writes the PC defaults that differ from the PS2 class into objects without parameters', () => {
        const r = convert([object(672)], true);
        expect(params(r, 672)).toEqual({ 'Increment (+1) Message': 1, 'Decrement (-1) Message': 0, Delay: 0.5 });
        expect(r.report.pcDefaultsKept?.get('count down to zero.Decrement (-1) Message 0 (PS2 1)')).toBe(1);
        expect(r.report.warnings.some((w) => w.startsWith('PC class defaults kept on 3 object field(s)'))).toBe(true);
    });

    it("keeps the object's own values over the PC defaults", () => {
        // Alwarren 1765: Increment 4 and Decrement 8 (I'm Dead) are set on the object itself.
        const own = object(
            1765,
            [
                { fieldIndex: 1, type: T_ENUM, name: 'Increment (+1) Message', nameRaw: new Uint8Array() },
                { fieldIndex: 2, type: T_ENUM, name: 'Decrement (-1) Message', nameRaw: new Uint8Array() },
            ],
            [4, 8],
        );
        const r = convert([own], true);
        expect(params(r, 1765)).toEqual({ 'Increment (+1) Message': 4, 'Decrement (-1) Message': 8, Delay: 0.5 });
    });

    it('leaves objects alone without the hook, and limits it to logic classes other than Stomp Players and markers, and Rigid Bodies', () => {
        expect(params(convert([object(672)], false), 672)).toEqual({});
        expect([7, 62, 61, 121, 136, 16].map(keepsPcDefaults)).toEqual([true, true, true, true, true, true]);
        expect([51, 104, 111, 33, 34, 19, undefined].map(keepsPcDefaults)).toEqual([
            false,
            false,
            false,
            false,
            false,
            false,
            false,
        ]);
    });
});
