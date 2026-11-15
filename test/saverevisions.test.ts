// Synthetic fixtures only; no game bytes.
// Save revisions (runtime hle/SaveUpgrade.h): a pack that keeps its build lists, per revision, the objects it added and
// the spawned effect classes it retired, so the game can upgrade a save of an older revision when it loads.
import { describe, expect, it } from 'vitest';
import {
    NO_SAVE_REVISIONS,
    addedLevelObjects,
    formatSaveAddedObjects,
    formatSaveRelinkedPowerUps,
    formatSaveReplacedEffects,
    formatSaveResetTogglers,
    planSaveRevisions,
    readSaveRevisions,
    type SaveLayout,
} from '../src/index.ts';

const RV = 'OotF 01 - Ruined Village';
const swap = { level: RV, fromClass: 0x3a2b, toClass: 0x4b07, x: 321687.4, z: 197611.2 };

describe('save revisions', () => {
    it('reads what the manifest declares and nothing from an older pack', () => {
        expect(readSaveRevisions('id = "a"\nbuild = "b"\n')).toEqual(NO_SAVE_REVISIONS);
        const text = [
            'id = "a"',
            'save_revision = 2',
            `save_added_objects = ["1 | ${RV} | 3353", "2 | ${RV} | 5 6", "bad", "1 | x | 0"]`,
            `save_replaced_effects = ["1 | ${RV} | 3a2b 4b07 | 321687 197611", "1 | x | zz 1 | 1 2"]`,
            `save_relinked_powerups = ["1 | ${RV} | 1011 3157", "1 | x | 5"]`,
            `save_reset_togglers = ["1 | ${RV} | 2337 2684", "1 | x | y"]`,
        ].join('\n');
        const r = readSaveRevisions(text);
        expect(r.revision).toBe(2);
        expect(r.added).toEqual([
            { revision: 1, level: RV, ids: [3353] },
            { revision: 2, level: RV, ids: [5, 6] },
        ]);
        expect(r.replaced).toEqual([
            { revision: 1, level: RV, fromClass: 0x3a2b, toClass: 0x4b07, x: 321687, z: 197611 },
        ]);
        expect(formatSaveAddedObjects(r.added[1]!)).toBe(`2 | ${RV} | 5 6`);
        expect(formatSaveReplacedEffects(r.replaced[0]!)).toBe(`1 | ${RV} | 3a2b 4b07 | 321687 197611`);
        expect(r.relinked).toEqual([{ revision: 1, level: RV, dragon: 1011, powerUps: [3157] }]);
        expect(formatSaveRelinkedPowerUps(r.relinked[0]!)).toBe(`1 | ${RV} | 1011 3157`);
        expect(r.resetTogglers).toEqual([{ revision: 1, level: RV, ids: [2337, 2684] }]);
        expect(formatSaveResetTogglers(r.resetTogglers[0]!)).toBe(`1 | ${RV} | 2337 2684`);
    });

    it('lists the level objects a layout added', () => {
        const base: SaveLayout = new Map([
            ['obj|files/a.lvl|1', '3:5'],
            ['class|R.ODB|9', 'x|1|2'],
        ]);
        const next: SaveLayout = new Map([
            ...base,
            ['obj|files/a.lvl|7', '3:6'],
            ['obj|files/a.lvl|3', '3:6'],
            ['class|R.ODB|10', 'y|1|2'],
        ]);
        expect([...addedLevelObjects(base, next)]).toEqual([['files/a.lvl', [3, 7]]]);
    });

    it('opens a revision only for something new, and keeps the history', () => {
        const first = planSaveRevisions(NO_SAVE_REVISIONS, true, new Map([[RV, [3353]]]), [swap]);
        expect(first.bumped).toBe(true);
        expect(first.revisions).toEqual({
            revision: 1,
            added: [{ revision: 1, level: RV, ids: [3353] }],
            replaced: [{ ...swap, x: 321687, z: 197611, revision: 1 }],
            relinked: [],
            resetTogglers: [],
        });
        // the next rebuild changes nothing a save names: same revision, same lines
        const again = planSaveRevisions(first.revisions, true, new Map([[RV, [3353]]]), [swap]);
        expect(again.bumped).toBe(false);
        expect(again.revisions).toEqual(first.revisions);
        // a later converter feature adds an object: revision 2, the old lines stay
        const later = planSaveRevisions(first.revisions, true, new Map([[RV, [3353, 3390]]]), [swap]);
        expect(later.revisions.revision).toBe(2);
        expect(later.revisions.added).toEqual([
            { revision: 1, level: RV, ids: [3353] },
            { revision: 2, level: RV, ids: [3390] },
        ]);
        // a dragon's power-ups: listed once, kept on the next rebuild
        const linked = planSaveRevisions(
            first.revisions,
            true,
            new Map([[RV, [3353]]]),
            [swap],
            [{ level: RV, dragon: 1011, powerUps: [3157] }],
        );
        expect(linked.revisions.revision).toBe(2);
        expect(linked.revisions.relinked).toEqual([{ level: RV, dragon: 1011, powerUps: [3157], revision: 2 }]);
        expect(
            planSaveRevisions(
                linked.revisions,
                true,
                new Map(),
                [swap],
                [{ level: RV, dragon: 1011, powerUps: [3157] }],
            ).bumped,
        ).toBe(false);
        // zone togglers: listed once
        const togs = planSaveRevisions(
            first.revisions,
            true,
            new Map([[RV, [3353]]]),
            [swap],
            [],
            new Map([[RV, [2684, 2337]]]),
        );
        expect(togs.revisions.resetTogglers).toEqual([{ revision: 2, level: RV, ids: [2337, 2684] }]);
        expect(
            planSaveRevisions(togs.revisions, true, new Map(), [swap], [], new Map([[RV, [2337, 2684]]])).bumped,
        ).toBe(false);
        // an object that needs another one: written and read as id@required
        const cond = planSaveRevisions(
            NO_SAVE_REVISIONS,
            true,
            new Map([[RV, [3353, 3390]]]),
            [],
            [],
            new Map(),
            new Map([[`${RV}|3353`, 2855]]),
        );
        expect(cond.revisions.added).toEqual([{ revision: 1, level: RV, ids: [3353, 3390], requires: [2855, 0] }]);
        const line = formatSaveAddedObjects(cond.revisions.added[0]!);
        expect(line).toBe(`1 | ${RV} | 3353@2855 3390`);
        expect(readSaveRevisions(`save_revision = 1\nsave_added_objects = ["${line}"]`).added).toEqual(
            cond.revisions.added,
        );
        // a new build (old saves are refused) starts again
        expect(planSaveRevisions(first.revisions, false, new Map([[RV, [1]]]), [swap]).revisions).toEqual(
            NO_SAVE_REVISIONS,
        );
        // nothing at all: revision 0, no lines
        expect(planSaveRevisions(NO_SAVE_REVISIONS, true, new Map(), [])).toEqual({
            revisions: NO_SAVE_REVISIONS,
            bumped: false,
        });
    });
});
