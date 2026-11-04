import { describe, expect, it } from 'vitest';
import { decodeFieldValue } from '../src/fields.ts';
import type { OdbClass } from '../src/odb.ts';
import { buildPlainClassRecord, mergeDefaults, planClassMapping, type Ps2OdbIn } from '../src/ootfclass.ts';
import { classReferenceClosure, ownedClassKey, relocateClassDefaultReferences } from '../src/ootfclassrefs.ts';

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
