// Synthetic fixtures only; no game bytes.
import { describe, expect, it } from 'vitest';
import { encodeFieldList, parseClassBody, splitClassRecord, stringToWords, type OdbClass } from '../src/index.ts';
import {
    ENGINE_CLASSES,
    buildClassEntries,
    buildPlainClassRecord,
    cloneClassRecord,
    levelPropertiesParams,
    mergeDefaults,
    planClassMapping,
    type Ps2OdbIn,
} from '../src/ootfclass.ts';
import { zlibSync } from 'fflate';

const T_INT = 1;
const T_FLOAT = 2;
const T_ENUM = 7;
const T_STR = 0x0a;
const f32 = (n: number): number => {
    const d = new DataView(new ArrayBuffer(4));
    d.setFloat32(0, n);
    return d.getUint32(0);
};

function cls(id: number, name: string, rfl: number, fields: [number, string][], data: number[]): OdbClass {
    return {
        id,
        name,
        group: 5,
        runtimeClass: 0x10000 + rfl,
        model: null,
        rflClass: rfl,
        icon: 1,
        fields: fields.map(([type, n]) => ({ type, name: n })),
        data,
    };
}

const timerFields: [number, string][] = [
    [T_FLOAT, 'Time Until Trigger'],
    [T_ENUM, 'Trigger Message'],
    [T_ENUM, 'Run after enabling?'],
    [T_STR, 'Debug Text'],
];
const ps2Timer = cls(10, 'Timer', 62, timerFields, [f32(1), 1, 0, (3 << 16) | 4, ...stringToWords('abc')]);

function odb(): Ps2OdbIn {
    const classes = new Map<number, OdbClass>([
        [10, ps2Timer],
        [900, cls(900, 'Other', 99, [], [])],
    ]);
    const raw = new Map<number, Uint8Array>([
        [10, buildPlainClassRecord({ name: 'Timer', group: 5, rfl: 62, icon: 1, fieldCount: 4, data: ps2Timer.data! })],
    ]);
    const lists = zlibSync(encodeFieldList([{ type: T_INT, name: 'a' }]));
    return {
        dbIndex: 4,
        file: 'FX.ODB',
        classes,
        raw: (id) => raw.get(id),
        group: () => 5,
        fieldLists: { id: 0, sub: 0, stored: lists },
    };
}

describe('ootfclass', () => {
    it('knows the engine ids it classifies', () => {
        expect(ENGINE_CLASSES.get(61)?.kind).toBe('logic');
        expect(ENGINE_CLASSES.get(54)?.name).toBe('Level Properties');
    });

    it('merges PC defaults by name and type, ignoring unknown fields', () => {
        const pc = cls(
            1,
            'my timer',
            62,
            [
                [T_FLOAT, 'Time Until Trigger'],
                [T_ENUM, 'Trigger Message'],
                [T_INT, 'Only in PC'],
            ],
            [f32(7.5), 4, 9],
        );
        const m = mergeDefaults(pc, ps2Timer);
        expect(m.data[0]).toBe(f32(7.5));
        expect(m.data[1]).toBe(4);
        expect(m.copied).toEqual(['Time Until Trigger', 'Trigger Message']);
        expect(m.skipped).toEqual(['Only in PC']);
        expect(m.coverage).toBeCloseTo(2 / 3);
    });

    it('appends string payloads instead of overwriting the old one', () => {
        const pc = cls(1, 'x', 62, [[T_STR, 'Debug Text']], [(3 << 16) | 1, ...stringToWords('longer text')]);
        const m = mergeDefaults(pc, ps2Timer);
        expect(m.data.length).toBe(ps2Timer.data!.length + stringToWords('longer text').length);
        expect(m.data[3]! & 0xffff).toBe(ps2Timer.data!.length);
    });

    it('clones a record keeping the head and replacing name and data', () => {
        const raw = buildPlainClassRecord({
            name: 'Timer',
            group: 5,
            rfl: 62,
            icon: 1,
            fieldCount: 4,
            data: [1, 2, 3, 4],
        });
        expect(cloneClassRecord(raw, 'Timer', [1, 2, 3, 4])).toEqual(raw);
        const c = cloneClassRecord(raw, 'A longer name', [9, 8, 7, 6, 5]);
        const { name, body } = splitClassRecord(c);
        const p = parseClassBody(body)!;
        expect(name).toBe('A longer name');
        expect(p.rflClass).toBe(62);
        expect(p.fieldCount).toBe(4);
        expect(p.data).toEqual([9, 8, 7, 6, 5]);
    });

    it('maps same-name classes, synthesizes logic classes and rejects scenery', async () => {
        const pc = [
            { db: 1, id: 1, cls: cls(1, 'timer', 62, timerFields, [f32(2), 1, 0, 0]) },
            { db: 1, id: 2, cls: cls(2, 'Slow Timer', 62, timerFields, [f32(30), 1, 0, 0]) },
            { db: 1, id: 3, cls: cls(3, 'Slow Timer 2', 62, timerFields, [f32(30), 1, 0, 0]) },
            { db: 1, id: 4, cls: cls(4, 'Crate', 17, [], []) },
            { db: 1, id: 5, cls: cls(5, 'Goblin', 88, [], []) },
        ];
        const ps2 = [odb()];
        const plan = planClassMapping(pc, ps2);
        expect(plan.mapped.get('1:1')?.classId).toBe(10);
        expect(plan.synthesized).toHaveLength(1);
        const s = plan.synthesized[0]!;
        expect(s.pcKeys).toEqual(['1:2', '1:3']); // identical results share one record
        expect(s.classId).toBeLessThan(900);
        expect(s.classId).toBeGreaterThan(10);
        expect(plan.resolve(1, 3)?.classId).toBe(s.classId);
        expect(plan.unsupported.get('1:4')?.reason).toBe('no-engine-class');
        expect(plan.unsupported.get('1:5')?.reason).toBe('no-engine-class');

        const entries = await buildClassEntries(plan, ps2);
        expect(entries.map((e) => [e.type, e.isNew])).toEqual([
            [0x102, true],
            [0x103, false],
        ]);
        expect(entries[0]!.id).toBe(s.classId);
    });

    it('does not retarget kinds that need a model', () => {
        const pc = [{ db: 1, id: 1, cls: cls(1, 'Lever', 13, [], []) }];
        const ps2 = odb();
        ps2.classes = new Map([[20, cls(20, 'Door Lever', 13, [], [])]]);
        const plan = planClassMapping(pc, [ps2]);
        expect(plan.unsupported.get('1:1')?.reason).toBe('needs-model');
    });

    it('turns PC level property defaults into overrides of the PS2 class', () => {
        const pcFields: [number, string][] = [
            [T_FLOAT, 'Gravity (wu/s^2)'],
            [T_INT, 'Kill Altitude (wu)'],
            [T_INT, 'Initial Music ID'],
        ];
        const ps2Fields: [number, string][] = [
            [T_FLOAT, 'Gravity (wu/s^2)'],
            [T_INT, 'Kill Altitude (wu)'],
            [5, 'Initial Music File'],
        ];
        const pc = cls(1, 'Level Properties', 54, pcFields, [f32(4096), 98000, 7]);
        const ps2 = cls(2, 'Level Properties', 54, ps2Fields, [f32(6000), 0, 0]);
        const { specs, left } = levelPropertiesParams(pc, ps2);
        expect(specs.map((s) => [s.name, s.value])).toEqual([
            ['Gravity (wu/s^2)', 4096],
            ['Kill Altitude (wu)', 98000],
        ]);
        expect(left).toEqual(['Initial Music ID']);
    });
});
