import { describe, expect, it } from 'vitest';
import type { OdbClass } from '../src/odb.ts';
import type { ClassPlan } from '../src/ootfclass.ts';
import { buildBowAimMetadata } from '../src/ootfbowaim.ts';
const bow = (cone = 25, range = 16000): OdbClass => ({
    id: 3104,
    name: 'Long Bow',
    group: 1,
    runtimeClass: 79,
    rflClass: 79,
    fields: [
        { name: 'Maximum Range (wu)', type: 1 },
        { name: 'Cone of AutoAim (degrees)', type: 1 },
    ],
    data: [range, cone],
});
const target = (id: number, keys = ['1:3104']) =>
    ({ rfl: 79, dbIndex: 3, file: 'RESOURES.ODB', classId: id, pcKeys: keys }) as ClassPlan['synthesized'][number];
describe('original Bow automatic-aiming metadata', () => {
    it('preserves actual typed cone/range with target resource identity, independently of field order', () => {
        const a = bow(),
            energy = bow(35),
            flame = bow(25, 18000);
        const plan = { synthesized: [target(17380, ['3:3104']), target(17379, ['2:3104']), target(17378)] };
        const result = buildBowAimMetadata(plan, (key) => (key === '1:3104' ? a : key === '2:3104' ? energy : flame));
        expect(result.warnings).toEqual([]);
        expect(result.text).toBe(
            'format = 1\n\n[bow 0x343e2]\ncone_degrees = 25\nmaximum_range = 16000\n\n[bow 0x343e3]\ncone_degrees = 35\nmaximum_range = 16000\n\n[bow 0x343e4]\ncone_degrees = 25\nmaximum_range = 18000\n',
        );
        expect(buildBowAimMetadata({ synthesized: [] }, () => a).text).toBeNull(); // reused native classes stay native
    });
    it('rejects absent, ambiguous, indirect and foreign schemas rather than inventing properties', () => {
        const original = bow();
        const invalid = [
            { ...original, fields: undefined },
            { ...original, data: [] },
            { ...original, rflClass: 14 },
            bow(-1),
            bow(181),
            bow(25, -1),
            { ...original, fields: [...original.fields!, original.fields![1]!] },
            { ...original, fields: original.fields!.map((f) => ({ ...f, type: 2 })) },
            { ...original, fields: original.fields!.map((f) => ({ ...f, type: 0x1001 })) },
        ];
        for (const source of invalid)
            expect(buildBowAimMetadata({ synthesized: [target(17378)] }, () => source).text).toBeNull();
        expect(buildBowAimMetadata({ synthesized: [target(17378)] }, () => bow(0, 0)).text).toContain(
            'maximum_range = 0',
        );
    });
    it('omits conflicting profiles if a target was shared and leaves unrelated native engines unannotated', () => {
        const result = buildBowAimMetadata({ synthesized: [target(17378, ['1:3104', '2:3104'])] }, (key) =>
            bow(key === '1:3104' ? 25 : 35),
        );
        expect(result.text).toBeNull();
        expect(result.warnings).toHaveLength(1);
        expect(
            buildBowAimMetadata({ synthesized: [target(17378, ['1:3104', '2:3104'])] }, (key) =>
                key === '1:3104' ? bow() : undefined,
            ).text,
        ).toBeNull();
        expect(buildBowAimMetadata({ synthesized: [{ ...target(17378), rfl: 14 }] }, () => bow()).text).toBeNull();
        expect(
            buildBowAimMetadata({ synthesized: [{ ...target(17378), dbIndex: 4 }] }, () => bow()).warnings,
        ).toHaveLength(1);
        expect(
            buildBowAimMetadata({ synthesized: [{ ...target(17378), file: 'OTHER.ODB' }] }, () => bow()).text,
        ).toBeNull();
    });
});
