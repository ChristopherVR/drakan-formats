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
        const originals = [gen, creature, projectile, lightning, cloud];
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
        for (const source of [projectile, lightning, cloud]) {
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
