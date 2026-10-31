import { describe, expect, it } from 'vitest';
import {
    SaveFieldError,
    applyFieldEdits,
    assembleSave,
    describeRecords,
    getField,
    listProgress,
    parseSave,
    probeField,
    progressTable,
    readItemPanel,
    recordLabel,
    sameBytes,
    transferPlan,
    validateSave,
} from '../src/index.ts';
import { buildSave, saveEntries } from './savefixture.ts';

const ROWS: [number, number, number][] = [
    [50, 610, 35],
    [68, 611, 0],
    [20, 1094, 18],
    [100, 440, 7],
];

describe('Progress table', () => {
    const save = parseSave(buildSave(saveEntries({ progress: ROWS })));

    it('finds the rows from the end of the payload and stops at the skill rows', () => {
        expect(listProgress(save)).toEqual(ROWS.map(([kind, key, value]) => ({ kind, key, value })));
        const t = progressTable(save);
        expect(t.rows).toHaveLength(4);
        expect(t.start).toBe(t.entry.data.length - 4 * 12);
    });

    it('has no rows when nothing follows the skills', () => {
        expect(listProgress(parseSave(buildSave()))).toEqual([]);
    });

    it('reads and edits one row by key, touching only its value', () => {
        expect(getField(save, 'progress.610')).toBe(35);
        const out = applyFieldEdits(save, [{ name: 'progress.1094', value: 99 }]);
        expect(getField(out, 'progress.1094')).toBe(99);
        const before = progressTable(save).entry.data;
        const after = progressTable(out).entry.data;
        const diff = [...before].flatMap((b, i) => (b === after[i] ? [] : [i]));
        expect(diff).toHaveLength(1);
        expect(diff[0]).toBe(progressTable(save).start + 2 * 12 + 8);
        const bytes = assembleSave(out).bytes;
        expect(listProgress(parseSave(bytes)).map((r) => r.value)).toEqual([35, 0, 99, 7]);
    });

    it('rejects an unknown key and negative values', () => {
        expect(probeField(save, 'progress.5').status).toBe('missing');
        expect(() => applyFieldEdits(save, [{ name: 'progress.610', value: -1 }])).toThrow(SaveFieldError);
        expect(() => applyFieldEdits(save, [{ name: 'progress.9999', value: 1 }])).toThrow(/no unique progress row/);
    });

    it('round-trips byte for byte', () => {
        const blob = buildSave(saveEntries({ progress: ROWS }));
        expect(sameBytes(assembleSave(parseSave(blob)).bytes, blob)).toBe(true);
    });
});

describe('Arokh position', () => {
    it('is found by resource id and edited like Rynn', () => {
        const save = parseSave(buildSave(saveEntries({ arokh: [700, 200, 300] })));
        expect(getField(save, 'arokh.pos')).toEqual([700, 200, 300]);
        const out = applyFieldEdits(save, [{ name: 'arokh.pos', value: [1, 2, 3] }]);
        expect(getField(out, 'arokh.pos')).toEqual([1, 2, 3]);
        expect(getField(out, 'pos')).toEqual([1000, 2000, 3000]);
    });

    it('is missing when the save has no such record', () => {
        expect(probeField(parseSave(buildSave()), 'arokh.pos').status).toBe('missing');
    });

    it('labels records', () => {
        const save = parseSave(buildSave(saveEntries({ arokh: [700, 200, 300] })));
        const labels = describeRecords(save).map((r) => recordLabel(r));
        expect(labels).toContain('Rynn (player)');
        expect(labels).toContain('Arokh (dragon)');
        expect(labels).toContain('Gold counter');
    });
});

describe('Item panel', () => {
    it('reads the item text, repairing the damaged line starts', () => {
        const p = readItemPanel(parseSave(buildSave(saveEntries({ itemText: true }))))!;
        expect(p.name).toBe('Wood Club');
        expect(p.lines).toEqual([
            'Skill Needed: 1',
            'Damage: 8',
            'Speed: Medium',
            'Range: Short',
            'Durability: 144/150',
            'In left hand',
        ]);
        expect(p.durability).toEqual({ current: 144, max: 150 });
        expect(p.hand).toBe('left');
    });

    it('is null without item text', () => {
        expect(readItemPanel(parseSave(buildSave()))).toBeNull();
    });
});

describe('Validate', () => {
    const codes = (blob: Uint8Array): string[] => validateSave(parseSave(blob)).map((i) => i.code);

    it('finds nothing wrong with a normal save', () => {
        const issues = validateSave(parseSave(buildSave(saveEntries({ progress: ROWS }))));
        expect(issues.filter((i) => i.severity !== 'info')).toEqual([]);
    });

    it('reports a skill above its max with a working fix', () => {
        const save = parseSave(
            buildSave(
                saveEntries({
                    skills: [
                        [9, 8],
                        [2, 5],
                        [2, 6],
                    ],
                }),
            ),
        );
        const issue = validateSave(save).find((i) => i.code === 'skill-over-max')!;
        expect(issue.severity).toBe('error');
        const fixed = applyFieldEdits(save, issue.fix!.edits);
        expect(validateSave(fixed).some((i) => i.code === 'skill-over-max')).toBe(false);
        expect(getField(fixed, 'skill.1')).toBe(8);
    });

    it('reports duplicate keys, repeated state keys, a missing player and a huge gold value', () => {
        const dupe = saveEntries({ progress: [...ROWS, [50, 610, 1]] });
        expect(codes(buildSave(dupe))).toContain('progress-dup');
        const twice = saveEntries();
        twice.push({ ...twice.find((e) => e.id === 100)! });
        expect(codes(buildSave(twice))).toContain('duplicate-entries');
        const noPlayer = saveEntries().filter((e) => e.id !== 56);
        expect(codes(buildSave(noPlayer))).toContain('player');
        expect(codes(buildSave(saveEntries({ gold: 3_600_193_170 })))).toContain('gold-range');
    });

    it('reports an invalid player position and a missing level path', () => {
        expect(codes(buildSave(saveEntries({ pos: [Number.NaN, 0, 0] })))).toContain('player-pos');
        expect(codes(buildSave(saveEntries().filter((e) => e.type !== 0x400)))).toContain('level-path');
    });
});

describe('Transfer plan', () => {
    const src = parseSave(
        buildSave(
            saveEntries({
                gold: 999,
                hp: 50,
                pos: [5, 6, 7],
                arokh: [9, 9, 9],
                skills: [
                    [6, 10],
                    [3, 5],
                    [1, 6],
                ],
            }),
        ),
    );
    const dst = parseSave(buildSave(saveEntries({ gold: 10, arokh: [1, 1, 1] })));

    it('lists values with before and after, raising max when needed', () => {
        const plan = transferPlan(src, dst, true);
        const gold = plan.find((r) => r.name === 'gold')!;
        expect([gold.from, gold.to, gold.blocked]).toEqual([999, 10, null]);
        const melee = plan.find((r) => r.name === 'skill.1')!;
        expect(melee.edits.map((e) => e.name)).toEqual(['skill.1.max', 'skill.1']);
        const out = applyFieldEdits(
            dst,
            plan.filter((r) => !r.blocked).flatMap((r) => r.edits),
        );
        expect(getField(out, 'gold')).toBe(999);
        expect(getField(out, 'skill.1')).toBe(6);
        expect(getField(out, 'skill.1.max')).toBe(10);
        expect(getField(out, 'arokh.pos')).toEqual([9, 9, 9]);
    });

    it('blocks positions between different levels', () => {
        const plan = transferPlan(src, dst, false);
        expect(plan.find((r) => r.name === 'pos')!.blocked).toMatch(/different levels/);
        expect(plan.find((r) => r.name === 'gold')!.blocked).toBeNull();
    });
});
