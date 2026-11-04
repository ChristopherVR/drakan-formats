import { describe, expect, it } from 'vitest';
import type { OdbClass } from '../src/odb.ts';
import { parseClassBody } from '../src/odb.ts';
import { splitClassRecord } from '../src/odbwrite.ts';
import { buildPlainClassRecord, planClassMapping, type Ps2OdbIn } from '../src/ootfclass.ts';
import { classReferenceClosure, relocateClassDefaultReferences } from '../src/ootfclassrefs.ts';

describe('referenced radius damage', () => {
    it('retains authored explosion damage and owner policy in a model-less native class', async () => {
        const radius: OdbClass = {
            id: 31,
            name: 'Source blast',
            group: 1,
            rflClass: 3,
            runtimeClass: 3,
            model: null,
            fields: [
                { name: 'Damage', type: 1 },
                { name: 'Damage radius (lu)', type: 2 },
                { name: 'Damage Owner', type: 7 },
                { name: 'Damage Effect', type: 0x4003 },
            ],
            data: [23, 0x3f000000, 1, 0],
        };
        const generator: OdbClass = {
            id: 30,
            name: 'Source explosion',
            group: 1,
            rflClass: 63,
            runtimeClass: 63,
            model: null,
            fields: [{ name: 'Spawn Object', type: 0x1003 }],
            data: [0x10001, radius.id],
        };
        const nativeRadius: OdbClass = {
            ...radius,
            id: 100,
            name: 'Native blast',
            runtimeClass: 0x10003,
            fields: [
                { name: 'Alt. Detection Method? (for large sweeps', type: 7 },
                radius.fields![2]!,
                radius.fields![1]!,
                radius.fields![0]!,
                radius.fields![3]!,
            ],
            data: [0, 0, 0x40000000, 100, 999],
        };
        const templates = [nativeRadius, { ...generator, id: 101, name: 'Native explosion', runtimeClass: 0x1003f }];
        const records = new Map(
            templates.map((c) => [
                c.id,
                buildPlainClassRecord({
                    name: c.name,
                    group: 1,
                    rfl: c.rflClass!,
                    icon: 0,
                    fieldCount: c.fields!.length,
                    data: c.data!,
                }),
            ]),
        );
        const odb: Ps2OdbIn = {
            file: 'FX.ODB',
            dbIndex: 4,
            classes: new Map(templates.map((c) => [c.id, c])),
            raw: (id) => records.get(id),
        };
        const closure = await classReferenceClosure(
            [{ owner: 'source', id: generator.id, cls: generator }],
            async (_source, ref) => (ref === radius.id ? { owner: 'source', id: radius.id, cls: radius } : null),
        );
        const sources = closure.map((c) => ({ db: 2, id: c.id, cls: c.cls }));
        const plan = planClassMapping(sources, [odb]);
        expect(plan.unsupported.size).toBe(0);
        expect(plan.synthesized).toHaveLength(2);
        expect(
            relocateClassDefaultReferences(
                plan,
                (key) => sources.find((c) => `${c.db}:${c.id}` === key)?.cls,
                (_key, ref, file) => {
                    expect(file).toBe('FX.ODB');
                    return plan.resolve(2, ref)?.classId ?? null;
                },
            ),
        ).toEqual([]);
        const target = plan.resolve(2, radius.id)!;
        expect(target.cls!.model).toBeNull();
        // Reordered native fields retain source radius, damage and self-damage policy; zero source FX clears native FX.
        expect(target.cls!.data).toEqual([0, 1, 0x3f000000, 23, 0]);
        const emitted = plan.synthesized.find((c) => c.rfl === 3)!;
        const body = splitClassRecord(emitted.record).body;
        expect(new DataView(body.buffer, body.byteOffset).getUint32(16, true)).toBe(0x10003);
        expect(parseClassBody(body)?.data).toEqual(target.cls!.data);
        const spawner = plan.resolve(2, generator.id)!.cls!;
        expect(spawner.data!.slice(spawner.data![0]! & 0xffff)).toEqual([target.classId]);
        // A source model cannot silently borrow unrelated geometry from a native model-less template.
        const withModel = { ...radius, model: { id: 50, db: 0 } };
        expect(planClassMapping([{ db: 2, id: radius.id, cls: withModel }], [odb]).unsupported.size).toBe(1);
        expect(planClassMapping([{ db: 2, id: radius.id, cls: radius }], []).unsupported.size).toBe(1);
    });
});
