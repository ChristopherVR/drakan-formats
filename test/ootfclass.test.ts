// Synthetic fixtures only; no game bytes.
import { describe, expect, it } from 'vitest';
import { encodeFieldList, joinClassRecord, parseClassBody, splitClassRecord, stringToWords, type OdbClass } from '../src/index.ts';
import {
    ENGINE_CLASSES,
    buildClassEntries,
    aliasSquash,
    buildPlainClassRecord,
    cloneClassRecord,
    levelPropertiesParams,
    mergeDefaults,
    patchRecordModel,
    PS2_SUBSTITUTES,
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

    it('maps animation-typed defaults (scalar and array) through the converted clip ids', () => {
        const T_ANIM = 9;
        const T_ANIMS = 0x1009;
        const pc = cls(
            1,
            'x',
            62,
            [
                [T_ANIM, 'Idle'],
                [T_ANIMS, 'Attacks'],
                [T_ANIM, 'Gone'],
            ],
            [577, (2 << 16) | 3, 99, 10, 11],
        );
        const tpl = cls(
            2,
            'x',
            62,
            [
                [T_ANIM, 'Idle'],
                [T_ANIMS, 'Attacks'],
                [T_ANIM, 'Gone'],
            ],
            [1, (1 << 16) | 3, 7, 5],
        );
        const m = mergeDefaults(
            pc,
            tpl,
            undefined,
            new Map([
                [577, 100],
                [10, 101],
                [11, 102],
            ]),
        );
        expect(m.data[0]).toBe(100);
        expect(m.data[1]! >>> 16).toBe(2);
        const at = m.data[1]! & 0xffff;
        expect(m.data.slice(at, at + 2)).toEqual([101, 102]);
        expect(m.data[2]).toBe(100); // no converted clip: the template's clip would not fit the converted rig, a converted one stands in
        expect(m.skipped).toEqual(['Gone']);
        expect(mergeDefaults(pc, tpl).data[0]).toBe(1); // without a map animations stay the template's
    });

    it('clamps template joint ids past the converted rig to the root', () => {
        const pc = cls(1, 'x', 62, [[2, 'Other']], [0]);
        const tpl = cls(
            2,
            'x',
            62,
            [
                [0x1008, 'Body Attachment Channels'],
                [8, 'Head Channel'],
            ],
            [(3 << 16) | 2, 50, 8, 42, 7],
        );
        const m = mergeDefaults(pc, tpl, undefined, undefined, true, 32);
        expect(m.data[1]).toBe(0); // joint 50 does not exist on a 32 joint rig
        expect(m.data.slice(2, 5)).toEqual([8, 0, 7]);
    });

    it('copies channel (joint id) fields only for converted models', () => {
        const T_CHAN = 8;
        const T_CHANS = 0x1008;
        const fields: [number, string][] = [
            [T_CHAN, 'Head Channel'],
            [T_CHANS, 'Dmg Inflicting Chans'],
        ];
        const pc = cls(1, 'x', 41, fields, [6, (2 << 16) | 2, 8, 22]);
        const tpl = cls(2, 'x', 41, fields, [3, (1 << 16) | 2, 26]);
        const own = mergeDefaults(pc, tpl, undefined, undefined, true);
        expect(own.data[0]).toBe(6);
        const at = own.data[1]! & 0xffff;
        expect(own.data.slice(at, at + 2)).toEqual([8, 22]);
        expect(mergeDefaults(pc, tpl).data[0]).toBe(3); // a PS2 rig keeps the template's joints
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
        // synthesized ids sit above the ODB maximum (900) so file, index and id order agree (ootf-odb-class-count.md)
        expect(s.classId).toBeGreaterThan(900);
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

    it('substitutes the PC Water Droplet (144) for the PS2 Water Drip (146) although the PS2 has another class 144', () => {
        const dripFields: [number, string][] = [
            [T_ENUM, 'Type'],
            [T_FLOAT, 'Period (s)'],
            [T_FLOAT, 'Deviation (+/- s)'],
            [T_INT, 'Max Particles Per Period'],
        ];
        const drip = cls(20, 'Water Drip', 146, dripFields, [0, f32(2), f32(1), 1]);
        const shield = cls(21, 'Wood Shield', 144, [[T_INT, 'Quantity']], [1]);
        const o = odb();
        o.classes.set(20, drip);
        o.classes.set(21, shield);
        const pc = [{ db: 1, id: 1, cls: cls(1, 'Water Droplet', 144, dripFields.slice(0, 3), [0, f32(3), f32(0.5)]) }];
        const plan = planClassMapping(pc, [o], { substituteEngineId: PS2_SUBSTITUTES });
        expect(plan.unsupported.size).toBe(0);
        expect(plan.synthesized[0]?.template.name).toBe('Water Drip');
        expect(plan.synthesized[0]?.cls.data?.[1]).toBe(f32(3));
    });

    it('maps an aliased PC creature name to the differently named PS2 class', () => {
        expect(aliasSquash('Troll Leather')).toBe('leatherwartockcenter');
        expect(aliasSquash('Timer')).toBe('timer');
        const tock = cls(11, 'LeatherWartock : Center', 62, timerFields, [f32(1), 1, 0, 0]);
        const ps2 = odb();
        (ps2.classes as Map<number, OdbClass>).set(11, tock);
        const pc = cls(1, 'Troll Leather', 62, timerFields, [f32(2), 1, 0, 0]);
        expect(planClassMapping([{ db: 1, id: 1, cls: pc }], [ps2]).mapped.get('1:1')?.classId).toBe(11);
        const own = planClassMapping([{ db: 1, id: 1, cls: pc }], [ps2], { keepOwnModel: (c) => c === pc });
        expect(own.mapped.has('1:1')).toBe(false);
    });

    it('keepOwnModel skips the same-name mapping so the class is cloned instead', () => {
        const pc = cls(1, 'Timer', 62, timerFields, [f32(2), 1, 0, 0]);
        const mapped = planClassMapping([{ db: 1, id: 1, cls: pc }], [odb()]);
        expect(mapped.mapped.has('1:1')).toBe(true);
        const own = planClassMapping([{ db: 1, id: 1, cls: pc }], [odb()], { keepOwnModel: (c) => c === pc });
        expect(own.mapped.has('1:1')).toBe(false);
        expect(own.synthesized).toHaveLength(1);
    });

    it('clones a model-less mechanism from a model-less template and a model class across ODBs with its own bounds', () => {
        // a class record with a model block: u16 group, u16 model, u16 db, ..., bounds at 16..80, u16 rfl at 80, icon at 84, counts at 86
        const modelRec = (name: string, rfl: number, model: number): Uint8Array => {
            const body = new Uint8Array(94);
            const dv = new DataView(body.buffer);
            dv.setUint16(0, 5, true);
            dv.setUint16(2, model, true);
            dv.setUint16(80, rfl, true);
            return joinClassRecord(name, body);
        };
        const tplModel: OdbClass = { ...cls(30, 'Door', 19, [], []), model: { id: 7, db: 0 } };
        const tplNone = cls(31, 'Breakaway', 44, [], []);
        const other = odb();
        other.file = 'LEVEL1ON.ODB';
        other.classes = new Map([
            [30, tplModel],
            [31, tplNone],
        ]);
        const raw = new Map<number, Uint8Array>([
            [30, modelRec('Door', 19, 7)],
            [31, buildPlainClassRecord({ name: 'Breakaway', group: 5, rfl: 44, icon: 1, fieldCount: 0, data: [] })],
        ]);
        other.raw = (id) => raw.get(id);
        const host = odb();
        host.file = 'RESOURES.ODB';
        host.dbIndex = 3;
        host.classes = new Map();
        const bounds = new Uint8Array(64).fill(0xab);
        const pc = [
            { db: 1, id: 1, cls: { ...cls(1, 'Gate', 19, [], []), model: { id: 99, db: 0 } } },
            { db: 1, id: 2, cls: cls(2, 'Break floor', 44, [], []) },
        ];
        const plan = planClassMapping(pc, [host, other], {
            modelOdbFile: 'RESOURES.ODB',
            modelOdbFiles: new Set(['LEVEL1ON.ODB']),
            modelFor: (_c, file) => (file === 'LEVEL1ON.ODB' ? { id: 500, db: 4 } : null),
            modelBounds: () => bounds,
        });
        expect(plan.unsupported.size).toBe(0);
        const gate = plan.synthesized.find((x) => x.name === 'Gate')!;
        expect(gate.file).toBe('LEVEL1ON.ODB');
        const body = splitClassRecord(gate.record).body;
        const dv = new DataView(body.buffer, body.byteOffset);
        expect([dv.getUint16(2, true), dv.getUint16(4, true)]).toEqual([500, 4]);
        expect([...body.subarray(16, 80)]).toEqual([...bounds]);
        expect(plan.synthesized.find((x) => x.name === 'Break floor')?.template.name).toBe('Breakaway');
        const patched = patchRecordModel(modelRec('x', 19, 7), { id: 8, db: 0 }, bounds);
        expect([...splitClassRecord(patched).body.subarray(16, 80)]).toEqual([...bounds]);
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
