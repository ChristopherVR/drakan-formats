import { describe, expect, it } from 'vitest';
import { decodeFieldValue } from '../src/fields.ts';
import { parseClassBody, type OdbClass } from '../src/odb.ts';
import { buildPlainClassRecord, mergeDefaults, planClassMapping, type Ps2OdbIn } from '../src/ootfclass.ts';
import { classReferenceClosure, ownedClassKey, relocateClassDefaultReferences } from '../src/ootfclassrefs.ts';
import { joinClassRecord, splitClassRecord } from '../src/odbwrite.ts';

function generator(id: number, name: string, refs: number[]): OdbClass {
    return {
        id,
        name,
        group: 1,
        rflClass: 63,
        runtimeClass: 0x1003f,
        model: null,
        fields: [
            { name: 'Spawn Object', type: 0x1003 },
            { name: 'Release Period (s)', type: 2 },
        ],
        data: [refs.length ? (refs.length << 16) | 2 : 0, 0x3f800000, ...refs],
    };
}
function native(): Ps2OdbIn {
    const g = generator(10, 'Native dust generator', [0x187a, 0x18ec]);
    return {
        file: 'FX.ODB',
        dbIndex: 4,
        classes: new Map([
            [10, g],
            [900, { id: 900, name: 'Last', group: 1, rflClass: 99, runtimeClass: 0x10063, fields: [], data: [] }],
        ]),
        raw: (id) =>
            id === 10
                ? buildPlainClassRecord({ name: g.name, group: 1, rfl: 63, icon: 0, fieldCount: 2, data: g.data! })
                : undefined,
    };
}

describe('OotF class reference defaults', () => {
    it('synthesizes only the verified Trail Master schema with an explicit model binding', () => {
        const names = [
            'Special Effect (TRACER!)',
            'Face Camera',
            'Total Cycles (-1 = forever)',
            'Square progression Range (0 = linear)',
            'Initial Y Offset',
            'Initial Angle Offset',
            'Direction (1 or -1)',
            'Upward Velocity (wu/s)',
            'Max Ceiling',
            'Forward Velocity (s/rotation)',
            'Initial Radius (wu)',
            'Final Radius (wu)',
            'Max Vertical Ribbon Offset',
            'Vertical Ribbon Speed',
            'Max Horizontal Ribbon Offset',
            'Horizontal Ribbon Speed',
            'Ellipse Scale (X)',
            'Ellipse Scale (Y)',
        ];
        const fields = [0x4003, 7, 1, ...Array<number>(15).fill(2)].map((type, i) => ({ name: names[i]!, type }));
        const source: OdbClass = {
            id: 2,
            name: 'Trail',
            group: 1,
            runtimeClass: 81,
            rflClass: 81,
            model: { id: 20, db: 0 },
            fields,
            data: [55, 1, 0xffffffff, ...Array<number>(15).fill(0)],
        };
        const options = {
            modelOdbFile: 'FX.ODB',
            modelSkinned: () => false,
            modelFor: () => ({ id: 20000, db: 0 }),
            modelBounds: () => new Uint8Array(64).fill(0x35),
        };
        const plan = planClassMapping([{ db: 1, id: 2, cls: source }], [native()], options);
        const result = plan.synthesized[0]!;
        expect(result.cls.runtimeClass).toBe(0x10051);
        const body = splitClassRecord(result.record).body;
        expect(new DataView(body.buffer, body.byteOffset).getUint16(14, true)).toBe(1);
        expect(parseClassBody(body)?.model).toEqual({ id: 20000, db: 0 });
        expect(parseClassBody(body)?.data).toEqual(source.data);
        expect(
            relocateClassDefaultReferences(
                plan,
                () => source,
                (_key, ref, file) => {
                    expect([ref, file]).toEqual([55, 'FX.ODB']);
                    return 0x20061;
                },
            ),
        ).toEqual([]);
        expect(parseClassBody(splitClassRecord(result.record).body)?.data[0]).toBe(0x20061);
        const invalid = { ...source, fields: fields.map((f, i) => (i === 0 ? { ...f, type: 1 } : f)) };
        expect(planClassMapping([{ db: 1, id: 2, cls: invalid }], [native()], options).synthesized).toHaveLength(0);
        expect(planClassMapping([{ db: 1, id: 2, cls: source }], [native()], {}).synthesized).toHaveLength(0);
        const swapped = [...fields];
        [swapped[3], swapped[4]] = [swapped[4]!, swapped[3]!];
        expect(
            planClassMapping([{ db: 1, id: 2, cls: { ...source, fields: swapped } }], [native()], options).synthesized,
        ).toHaveLength(0);
        expect(
            planClassMapping([{ db: 1, id: 2, cls: source }], [native()], { ...options, modelSkinned: () => true })
                .synthesized,
        ).toHaveLength(0);
        expect(
            planClassMapping([{ db: 1, id: 2, cls: source }], [native()], { ...options, modelSkinned: undefined })
                .synthesized,
        ).toHaveLength(0);
    });

    it('imports a current volume without the native header Dust Devil companion', () => {
        const fields = [
            { name: 'Initial State', type: 7 },
            { name: 'Speed (lu/s)', type: 2 },
        ];
        const source: OdbClass = {
            id: 1,
            name: 'Source river current',
            group: 1,
            runtimeClass: 111,
            rflClass: 111,
            model: { id: 40, db: 0 },
            fields,
            data: [1, 0x3f800000],
        };
        const template: OdbClass = {
            ...source,
            id: 6394,
            name: 'Native dust air current',
            runtimeClass: 0x1006f,
            model: { id: 5515, db: 1 },
        };
        const body = new Uint8Array(102);
        const dv = new DataView(body.buffer);
        dv.setUint16(2, 5515, true);
        dv.setUint16(4, 1, true);
        dv.setUint16(10, 6288, true);
        dv.setUint16(14, 1, true);
        dv.setUint32(80, 0x1006f, true);
        dv.setUint32(86, 2, true);
        dv.setUint32(90, 2, true);
        const bounds = new Uint8Array(64).fill(0x25);
        const inputs = [{ db: 1, id: 1, cls: source }];
        const odbs = [
            {
                file: 'FX.ODB',
                dbIndex: 4,
                classes: new Map([[6394, template]]),
                raw: () => joinClassRecord(template.name, body),
            },
        ];
        const options = {
            modelOdbFile: 'FX.ODB',
            modelFor: () => ({ id: 20000, db: 0 }),
            modelBounds: (id: number, file: string, db: number) => {
                expect([id, file, db]).toEqual([20000, 'FX.ODB', 0]);
                return bounds;
            },
        };
        const output = planClassMapping(inputs, odbs, options).synthesized[0]!;
        expect(output.cls.rflClass).toBe(111);
        expect(output.cls.model).toEqual({ id: 20000, db: 0 });
        const head = splitClassRecord(output.record).body;
        const hd = new DataView(head.buffer, head.byteOffset);
        expect(hd.getUint32(10, true)).toBe(0);
        expect(hd.getUint16(14, true)).toBe(1);
        expect(head.slice(16, 80)).toEqual(bounds);
        expect(parseClassBody(head)?.data).toEqual(source.data);
        // This is a general PC-header rule, including ordinary model-bearing scenery cloned from native templates.
        const scenery = { ...source, rflClass: 17, runtimeClass: 17 };
        const nativeScenery = { ...template, rflClass: 17, runtimeClass: 0x10011 };
        const b = body.slice();
        new DataView(b.buffer).setUint32(80, 0x10011, true);
        const other = planClassMapping(
            [{ db: 1, id: 1, cls: scenery }],
            [
                {
                    ...odbs[0]!,
                    classes: new Map([[6394, nativeScenery]]),
                    raw: () => joinClassRecord(nativeScenery.name, b),
                },
            ],
            options,
        );
        const otherHead = splitClassRecord(other.synthesized[0]!.record).body;
        expect(new DataView(otherHead.buffer, otherHead.byteOffset).getUint32(10, true)).toBe(0);
    });

    it('converts referenced lightning, projectile and fading-effect models instead of dropping their engine kinds', () => {
        const make = (id: number, name: string, rfl: number, fields: [string, number][], data: number[]): OdbClass => ({
            id,
            name,
            group: 1,
            runtimeClass: 0x10000 + rfl,
            rflClass: rfl,
            model: { id: id + 100, db: 0 },
            fields: fields.map(([name, type]) => ({ name, type })),
            data,
        });
        const raw = (c: OdbClass): Uint8Array => {
            const b = new Uint8Array(94 + c.data!.length * 4),
                dv = new DataView(b.buffer);
            dv.setUint16(0, 1, true);
            dv.setUint16(2, c.model!.id, true);
            dv.setUint16(80, c.rflClass!, true);
            dv.setUint32(86, c.fields!.length, true);
            dv.setUint32(90, c.data!.length, true);
            c.data!.forEach((v, i) => dv.setUint32(94 + i * 4, v, true));
            return joinClassRecord(c.name, b);
        };
        const projectile = make(
            13,
            'Source Sonic Boom',
            8,
            [
                ['Damage', 1],
                ['Life Time (sec)', 2],
            ],
            [25, 0x40000000],
        );
        const lightning = make(
            14,
            'Source Soul Lightning',
            58,
            [
                ['Damage', 1],
                ['Width (wu)', 2],
            ],
            [0, 0x42480000],
        );
        const cloud = make(
            15,
            'Source Fire Cloud',
            1,
            [
                ['Initial Scale', 2],
                ['Maximum Scale', 2],
            ],
            [0x3f800000, 0x40000000],
        );
        const creature = make(
            12,
            'Source Ebon Dragon',
            30,
            [
                ['Initial Health', 1],
                ['Weapon Objects', 0x1003],
            ],
            [200, (1 << 16) | 2, 13],
        );
        const gen = generator(11, 'Source Soul Generator', [14, 15]);
        const tracer = make(
            16,
            'Source Magic Tracer',
            60,
            [
                ['Maximum Polygons', 1],
                ['Length Along Object(%)', 2],
                ['Fade Out Time (s)', 2],
                ['Effect along which axis?', 7],
            ],
            [70, 0x42c80000, 0x3f800000, 1],
        );
        const originals = [gen, creature, projectile, lightning, cloud, tracer];
        const templates = originals.map((c) => ({ ...c, id: c.id + 100, name: `Native ${c.rflClass}` }));
        const records = new Map(templates.filter((c) => c.model).map((c) => [c.id, raw(c)]));
        const odb: Ps2OdbIn = {
            file: 'FX.ODB',
            dbIndex: 4,
            classes: new Map(templates.map((c) => [c.id, c])),
            raw: (id) => records.get(id),
        };
        const plan = planClassMapping(
            originals.map((cls) => ({ db: 1, id: cls.id, cls })),
            [odb],
            {
                modelFor: (c) => (c.model ? { id: c.model.id + 1000, db: 0 } : null),
            },
        );
        expect(plan.unsupported.size).toBe(0);
        const byId = new Map(originals.map((c) => [c.id, c]));
        expect(
            relocateClassDefaultReferences(
                plan,
                (key) => byId.get(Number(key.split(':')[1])),
                (_key, ref) => plan.resolve(1, ref)?.classId ?? null,
            ),
        ).toEqual([]);
        for (const source of [projectile, lightning, cloud, tracer]) {
            const target = plan.resolve(1, source.id)!;
            expect(target.cls!.rflClass).toBe(source.rflClass);
            expect(target.cls!.model).toEqual({ id: source.model!.id + 1000, db: 0 });
            expect(
                parseClassBody(
                    splitClassRecord(plan.synthesized.find((s) => s.classId === target.classId)!.record).body,
                )!.data,
            ).toEqual(target.cls!.data);
        }
        const convertedCreature = plan.resolve(1, creature.id)!.cls!;
        expect(decodeFieldValue(0x1003, convertedCreature.data![1]!, convertedCreature.data!)).toEqual([
            plan.resolve(1, projectile.id)!.classId,
        ]);
    });
    it('relocates a typed class array and never retains a foreign template effect when mapping fails', () => {
        const pc = generator(1, 'PC generator', [0x10007, 0x20008]);
        const tpl = generator(10, 'Native generator', [0x187a, 0x18ec]);
        const result = mergeDefaults(pc, tpl, (ref) => (ref === 0x10007 ? 0x30009 : null));
        expect(decodeFieldValue(0x1003, result.data[0]!, result.data)).toEqual([0x30009]);
        expect(result.skipped).toContain('Spawn Object');
        const empty = mergeDefaults(pc, tpl, () => null);
        expect(empty.data[0]).toBe(0);
    });

    it('plans referenced-only cyclic classes before relocating forward refs, without deduplicating generators', async () => {
        const a = generator(11, 'A', [0x1000c]);
        const b = generator(12, 'B', [0x2000b]);
        const sources = [
            { owner: 'world/a', id: 11, cls: a },
            { owner: 'common/b', id: 12, cls: b },
        ];
        const closure = await classReferenceClosure([sources[0]!], async (source, ref) =>
            source.owner === 'world/a' && ref === 0x1000c
                ? sources[1]!
                : source.owner === 'common/b' && ref === 0x2000b
                  ? sources[0]!
                  : null,
        );
        expect(closure).toHaveLength(2);
        const plan = planClassMapping(
            closure.map((c, i) => ({ db: i + 1, id: c.id, cls: c.cls })),
            [native()],
        );
        expect(plan.synthesized).toHaveLength(2); // same merged template defaults must not erase different spawn lists
        const byKey = new Map(closure.map((c, i) => [`${i + 1}:${c.id}`, c]));
        const warnings = relocateClassDefaultReferences(
            plan,
            (key) => byKey.get(key)?.cls,
            (key, ref, file) => {
                expect(file).toBe('FX.ODB');
                const target = key === '1:11' && ref === 0x1000c ? plan.resolve(2, 12) : plan.resolve(1, 11);
                return target?.classId ?? null; // target shares the owning ODB: local db 0, not global level db 4
            },
        );
        expect(warnings).toEqual([]);
        for (const [db, id, targetDb, targetId] of [
            [1, 11, 2, 12],
            [2, 12, 1, 11],
        ]) {
            const cls = plan.resolve(db!, id!)!.cls!;
            expect(decodeFieldValue(0x1003, cls.data![0]!, cls.data!)).toEqual([
                plan.resolve(targetDb!, targetId!)!.classId,
            ]);
        }
    });

    it('diagnoses unresolved references and clears scalar defaults as well as arrays', () => {
        const pc = generator(11, 'A', [0x10007]);
        pc.fields!.push({ name: 'Death Effect', type: 3 });
        pc.data!.push(0x20008);
        // Make space for the new scalar before the indirect payload.
        pc.data = [(1 << 16) | 3, 0x3f800000, 0x20008, 0x10007];
        const odb = native();
        odb.classes.get(10)!.fields!.push({ name: 'Death Effect', type: 3 });
        odb.classes.get(10)!.data = [(2 << 16) | 3, 0x3f800000, 0x5555, 0x187a, 0x18ec];
        const plan = planClassMapping([{ db: 1, id: 11, cls: pc }], [odb]);
        const warnings = relocateClassDefaultReferences(
            plan,
            () => pc,
            () => null,
        );
        expect(warnings).toHaveLength(2);
        expect(warnings.every((w) => w.includes('no safe target'))).toBe(true);
        expect(plan.synthesized[0]!.cls.data!.slice(0, 3)).toEqual([0, 0x3f800000, 0]);
        expect(ownedClassKey('World\\A', 11)).toBe(ownedClassKey('world/a', 11));
    });
});
