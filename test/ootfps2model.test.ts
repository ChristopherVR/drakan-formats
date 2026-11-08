// Drakan 2 models in place of OotF ones (ootfps2model.ts). Synthetic fixtures only: no game data.
import { describe, expect, it } from 'vitest';
import { OotfAssetBuilder } from '../src/ootfassets.ts';
import { PC_CLASS_ALIASES } from '../src/ootfclass.ts';
import {
    DEFAULT_PS2_MODEL_SUBSTITUTIONS,
    Ps2ModelMapError,
    effectiveModelSubstitutions,
    modelKey,
    planPs2Models,
    ps2ModelSwapFromEdits,
} from '../src/ootfps2model.ts';
import type { PcFileSource } from '../src/pc.ts';

describe('Drakan 2 model table', () => {
    it('names each pair once, with a category and a reason, and every enemy pair is the planner alias', () => {
        const seen = new Set<string>();
        for (const r of DEFAULT_PS2_MODEL_SUBSTITUTIONS) {
            expect(seen.has(modelKey(r.ootf))).toBe(false);
            seen.add(modelKey(r.ootf));
            expect(['enemies', 'weapons']).toContain(r.category);
            expect(r.why.length).toBeGreaterThan(10);
            expect(`${r.label} ${r.why}`).not.toMatch(/—/);
            if (r.scene) {
                // a scene prop names a disc creature that a gameplay row already plays
                expect(DEFAULT_PS2_MODEL_SUBSTITUTIONS.some((g) => !g.scene && g.ps2 === r.ps2)).toBe(true);
                expect(planPs2Models().enemyTarget(r.ootf)).toBe(r.ps2);
            } else if (r.category === 'enemies' && modelKey(r.ootf) !== modelKey(r.ps2))
                expect(PC_CLASS_ALIASES.get(modelKey(r.ootf))).toBe(modelKey(r.ps2));
        }
    });

    it('turns categories, rows and default-off rows on and off', () => {
        const all = effectiveModelSubstitutions();
        expect(all.some((r) => r.ootf === 'Troll Leather')).toBe(true);
        expect(all.some((r) => r.ootf === 'Scavenger')).toBe(true);
        expect(effectiveModelSubstitutions({ off: ['scavenger'] }).some((r) => r.ootf === 'Scavenger')).toBe(false);
        const table = [
            {
                category: 'enemies' as const,
                ootf: 'Demo',
                ps2: 'Demo',
                label: 'Demo',
                why: 'a default-off row',
                defaultOff: true,
            },
        ];
        expect(effectiveModelSubstitutions({ table }).length).toBe(0); // default-off rows stay off
        expect(effectiveModelSubstitutions({ table, on: ['demo'] }).length).toBe(1);
        expect(effectiveModelSubstitutions({ enabled: false })).toEqual([]);
        expect(effectiveModelSubstitutions({ categoriesOff: ['weapons'] }).every((r) => r.category === 'enemies')).toBe(
            true,
        );
        expect(effectiveModelSubstitutions({ off: ['LONG SWORD'] }).some((r) => r.ootf === 'Long Sword')).toBe(false);
    });

    it('answers per class: enemy animations, enemies turned off, weapon targets', () => {
        const p = planPs2Models();
        expect(p.enemy('Troll Chain')).toBe('drakan2');
        expect(p.enemyOff('Troll Chain')).toBe(false);
        expect(p.weapon('Long Sword')?.ps2).toBe('Steel Longsword');
        expect(p.weapon('Troll Chain')).toBeNull();
        expect(planPs2Models({ enemyAnimations: 'ootf' }).enemy('Troll Chain')).toBe('ootf');
        const off = planPs2Models({ off: ['Troll Chain'] });
        expect(off.enemy('Troll Chain')).toBeNull();
        expect(off.enemyOff('Troll Chain')).toBe(true);
        expect(off.enemyOff('Some Other Creature')).toBe(false); // not in the table: the converter decides as before
        const none = planPs2Models({ enabled: false });
        expect(none.enemyOff('Troll Chain')).toBe(true);
        expect(none.weapon('Long Sword')).toBeNull();
    });

    it('reads user edits', () => {
        const demo = [
            {
                category: 'enemies' as const,
                ootf: 'Scavenger',
                ps2: 'Scavenger',
                label: 'S',
                why: 'default-off demo row',
                defaultOff: true,
            },
        ];
        const o = ps2ModelSwapFromEdits(
            [
                { ootf: 'Mace', ps2: null },
                { ootf: 'Scavenger', ps2: 'Scavenger' },
                { ootf: 'Flame Sword', ps2: 'Fire Blade', label: 'Flame sword' },
            ],
            { table: demo },
        );
        expect(o.off).toEqual(['Mace']);
        expect(o.on).toEqual(['Scavenger']);
        expect(o.extra).toEqual([
            { category: 'weapons', ootf: 'Flame Sword', ps2: 'Fire Blade', label: 'Flame sword', why: 'user mapping' },
        ]);
        expect(planPs2Models(o).weapon('flame sword')?.ps2).toBe('Fire Blade');
        expect(() => ps2ModelSwapFromEdits({})).toThrow(Ps2ModelMapError);
        expect(() => ps2ModelSwapFromEdits([{ ootf: 'X', ps2: 3 }])).toThrow(/Drakan 2 class name/);
        expect(() => ps2ModelSwapFromEdits([{ ootf: 'X', ps2: 'Y', category: 'pets' }])).toThrow(/category/);
    });
});

describe('OotfAssetBuilder.useNativeModel', () => {
    const src: PcFileSource = { read: async () => null, list: async () => [] };
    it('names the native model for the PC model and converts nothing', async () => {
        const b = new OotfAssetBuilder(src, { firstModelId: 7000 });
        expect(await b.useNativeModel('Lvl/Lvl', 0, 5, 5965)).toBe(true);
        expect(b.mapModelRef(0, 5, 'Lvl/Lvl')).toBe(5965);
        expect(await b.useNativeModel('Lvl/Lvl', 0, 5, 5965)).toBe(true); // idempotent
        expect(await b.useNativeModel('Lvl/Lvl', 0, 5, 5966)).toBe(false); // already taken
        expect(await b.useNativeModel('Lvl/Lvl', 3, 5, 5965)).toBe(false); // db not in the .db
        expect(b.requireDisplayList(5965)).toBe(false); // native models are never rewritten
        expect(b.report.models.converted).toBe(0);
    });
});
