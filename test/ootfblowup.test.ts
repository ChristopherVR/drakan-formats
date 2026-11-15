import { describe, expect, it } from 'vitest';
import type { OdbClass } from '../src/odb.ts';
import type { PcLevel } from '../src/pc.ts';
import type { PcSequence } from '../src/ootfseq.ts';
import { addBlowUpPropActors, addBlowUpProps, blowUpGenerator } from '../src/ootfblowup.ts';

const cls = (fields: [string, number][], rflClass: number, model: OdbClass['model'] = null): OdbClass =>
    ({
        id: 1,
        name: 'c',
        rflClass,
        model,
        fields: fields.map(([name]) => ({ name, type: 7 })),
        data: fields.map(([, v]) => v),
    }) as unknown as OdbClass;

describe('ootfblowup', () => {
    it('recognises a PC generator that shows its model until it bursts (Run Type 1)', () => {
        const model = { id: 3992, db: 0 };
        expect(blowUpGenerator(cls([['Run Type', 1]], 63, model))).toBe(true);
        expect(blowUpGenerator(cls([['Run Type', 0]], 63, model))).toBe(false);
        expect(blowUpGenerator(cls([['Run Type', 1]], 63, null))).toBe(false);
        expect(blowUpGenerator(cls([['Run Type', 1]], 17, model))).toBe(false);
    });

    it('adds a prop with the blow-up generator model and hides it with the generator in its scenes', () => {
        const model = { id: 3992, db: 0 };
        const gen = cls([['Run Type', 1]], 63, model);
        const prop = { ...cls([['Wait For Trigger?', 0]], 17, { id: 4205, db: 0 }), id: 7, name: 'Crystal Base' };
        const pc = {
            path: 'lvl',
            list: {
                objects: [
                    {
                        id: 10,
                        dbIndex: 2,
                        classId: 1,
                        pos: [1, 2, 3],
                        rot: [0, 90, 0],
                        links: [11],
                        params: [{ fieldIndex: 0 }],
                    },
                    { id: 11, dbIndex: 2, classId: 7, pos: [0, 0, 0], rot: [0, 0, 0], links: [], params: [] },
                ],
            },
            classes: new Map([
                [
                    2,
                    new Map([
                        [1, gen],
                        [7, prop],
                    ]),
                ],
            ]),
        } as unknown as PcLevel;
        const made = addBlowUpProps(pc);
        expect(made).toHaveLength(1);
        const b = made[0]!;
        expect([b.generator, b.prop, b.db, b.classId]).toEqual([10, 12, 2, 8]);
        expect(b.cls.rflClass).toBe(17);
        expect(b.cls.model).toEqual(model);
        const o = pc.list.objects.at(-1)!;
        expect([o.id, o.classId, o.pos, o.rot, o.links, o.params]).toEqual([12, 8, [1, 2, 3], [0, 90, 0], [], []]);
        const vis = (time: number, v: number) => ({ type: 6, time, payload: Uint8Array.from([v, 0, 0, 0]) });
        const msg = (time: number) => ({ type: 7, time, payload: Uint8Array.from([0xa3, 0x10, 0, 0, 0, 0, 0, 0]) });
        const seq = (actions: PcSequence['actors'][number]['actions']): PcSequence => ({
            id: 1,
            group: 1,
            name: 's',
            flags: 0,
            modifyRunState: 0,
            unk2: 0,
            actors: [{ name: 'Blow', id: 3, actorType: 1, assignedAs: 0, objectId: 10, actions }],
        });
        const twin = (s: PcSequence) =>
            addBlowUpPropActors(s, new Map([[10, 12]])).actors.find((a) => a.objectId === 12);
        // the scene's own show / hide
        const a = twin(seq([vis(0, 1), msg(5), vis(5.1, 0)]))!;
        expect([a.id, a.actions.map((x) => [x.type, x.time, x.payload[0]])]).toEqual([
            4,
            [
                [6, 0, 1],
                [6, 5.1, 0],
            ],
        ]);
        // no hide after the start: hidden at the start
        expect(twin(seq([msg(2)]))!.actions.map((x) => [x.type, x.time, x.payload[0]])).toEqual([[6, 2, 0]]);
    });
});
