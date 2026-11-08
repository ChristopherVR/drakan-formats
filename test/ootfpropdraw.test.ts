// Synthetic plans only; no game assets.
import { describe, expect, it, vi } from 'vitest';
import type { ClassPlan } from '../src/ootfclass.ts';
import { requireGenericPropDrawLists, requireRigidWeaponDrawLists } from '../src/ootfpropdraw.ts';

describe('native generic-prop draw requirements', () => {
    it('selects drawn native targets (props, doors, mechanisms) and leaves weapons and effects alone', () => {
        const target = (rfl: number, model: { id: number; db: number } | null, file = 'RESOURES.ODB') =>
            ({ rfl, cls: { model }, file }) as ClassPlan['synthesized'][number];
        const host = { requireDisplayList: vi.fn(() => true) };
        const local = { requireDisplayList: vi.fn(() => true) };
        const resolve = vi.fn((file: string, db: number) =>
            file === 'NPCS.ODB' && db === 1 ? host : db === 0 ? local : undefined,
        );
        requireGenericPropDrawLists(
            {
                synthesized: [
                    target(17, { id: 40, db: 0 }), // e.g. a source pressure plate mapped to native generic prop
                    target(17, { id: 41, db: 1 }, 'NPCS.ODB'), // model owned by the host through a dependency
                    target(35, { id: 42, db: 0 }), // a mechanism: native ones all carry the draw list
                    target(19, { id: 45, db: 0 }), // a door
                    target(60, { id: 46, db: 0 }), // an effect (weapon blur): native ones have none
                    target(14, { id: 43, db: 0 }), // no weapon-class extension
                    target(17, null),
                    target(17, { id: 44, db: 9 }), // unknown destination is not silently assigned to the host
                ],
            },
            resolve,
        );
        expect(local.requireDisplayList.mock.calls).toEqual([[40], [42], [45]]);
        expect(host.requireDisplayList.mock.calls).toEqual([[41]]);
        expect(resolve.mock.calls).toEqual([
            ['RESOURES.ODB', 0],
            ['NPCS.ODB', 1],
            ['RESOURES.ODB', 0],
            ['RESOURES.ODB', 0],
            ['RESOURES.ODB', 9],
        ]);
    });
});

describe('native melee-weapon draw requirements', () => {
    it('requests bow draw upgrades only after verified complete rigid-template selection', () => {
        const target = (rfl: number, id: number, rigidBowTemplate?: boolean, db = 0) =>
            ({
                rfl,
                rigidBowTemplate,
                cls: { model: { id, db } },
                file: 'RESOURES.ODB',
            }) as ClassPlan['synthesized'][number];
        const host = { requireRigidWeaponDisplayList: vi.fn(() => true) };
        const resolve = vi.fn((_file: string, db: number) => (db === 0 ? host : undefined));
        requireRigidWeaponDrawLists(
            {
                synthesized: [
                    target(79, 10, true),
                    target(79, 11),
                    target(79, 12, false),
                    target(95, 13, true),
                    target(79, 14, true, 9),
                ],
            },
            resolve,
        );
        expect(host.requireRigidWeaponDisplayList.mock.calls).toEqual([[10]]);
        expect(resolve.mock.calls).toEqual([
            ['RESOURES.ODB', 0],
            ['RESOURES.ODB', 9],
        ]);
    });

    it('selects only native class 14 and delegates authored-bounds validation to the resolved owner', () => {
        const target = (rfl: number, model: { id: number; db: number } | null) =>
            ({ rfl, cls: { model }, file: 'RESOURES.ODB' }) as ClassPlan['synthesized'][number];
        const host = { requireRigidWeaponDisplayList: vi.fn(() => true) };
        const resolve = vi.fn((_file: string, db: number) => (db === 0 ? host : undefined));
        requireRigidWeaponDrawLists(
            {
                synthesized: [
                    target(14, { id: 40, db: 0 }),
                    target(79, { id: 41, db: 0 }), // bows retain their independent conversion/rig path
                    target(17, { id: 42, db: 0 }),
                    target(35, { id: 43, db: 0 }),
                    target(14, null),
                    target(14, { id: 44, db: 9 }),
                ],
            },
            resolve,
        );
        expect(host.requireRigidWeaponDisplayList.mock.calls).toEqual([[40]]);
        expect(resolve.mock.calls).toEqual([
            ['RESOURES.ODB', 0],
            ['RESOURES.ODB', 9],
        ]);
    });
});
