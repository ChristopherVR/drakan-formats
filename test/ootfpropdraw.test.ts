// Synthetic plans only; no game assets.
import { describe, expect, it, vi } from 'vitest';
import type { ClassPlan } from '../src/ootfclass.ts';
import { requireGenericPropDrawLists } from '../src/ootfpropdraw.ts';

describe('native generic-prop draw requirements', () => {
    it('selects chosen native targets instead of a source runtime-class whitelist', () => {
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
                    target(35, { id: 42, db: 0 }), // native Lift is a separate path
                    target(14, { id: 43, db: 0 }), // no weapon-class extension
                    target(17, null),
                    target(17, { id: 44, db: 9 }), // unknown destination is not silently assigned to the host
                ],
            },
            resolve,
        );
        expect(local.requireDisplayList.mock.calls).toEqual([[40]]);
        expect(host.requireDisplayList.mock.calls).toEqual([[41]]);
        expect(resolve.mock.calls).toEqual([
            ['RESOURES.ODB', 0],
            ['NPCS.ODB', 1],
            ['RESOURES.ODB', 9],
        ]);
    });
});
