// Morph Plug conversion: the frame models named by "Morphing Models".
import { describe, expect, it } from 'vitest';
import { morphModelRefs } from '../src/ootfpipeline.ts';
import { mergeDefaults } from '../src/ootfclass.ts';
import type { OdbClass } from '../src/odb.ts';

const MODELS = 0x1004; // indirect array of FIELD_MODEL
const FLOATS = 0x1002;
const T_ENUM = 7;

/** Volcanic's "ice cover": four frames (IceCover01..04, db 0), 3 s each, not started at creation. */
const plugClass = (models: number[]): OdbClass => ({
    id: 3322,
    name: 'ice cover',
    group: 1,
    runtimeClass: 99,
    rflClass: 99,
    icon: 0,
    model: { id: models[0]!, db: 0 },
    fields: [
        { type: MODELS, name: 'Morphing Models' },
        { type: FLOATS, name: 'Morph Time to Next Model' },
        { type: T_ENUM, name: 'Start when created' },
    ],
    data: [(models.length << 16) | 3, (1 << 16) | (3 + models.length), 0, ...models, 0x40400000],
});

describe('Morph Plug conversion', () => {
    it('lists the models a Morph Plug class names, each once', () => {
        expect(morphModelRefs(plugClass([3671, 3672, 3673, 3674]))).toEqual([3671, 3672, 3673, 3674]);
        expect(morphModelRefs(plugClass([61, 61, 62]))).toEqual([61, 62]);
        expect(morphModelRefs({ ...plugClass([3671]), fields: [], data: [] })).toEqual([]);
    });

    it('carries the frame models into the clone only when every one of them converted', () => {
        const tpl: OdbClass = {
            ...plugClass([4551, 4551, 4552]),
            name: 'Crown Of Thorns_MorphSpikes',
            // a PS2 template keeps the field at another position
            fields: [
                { type: T_ENUM, name: 'Start when created' },
                { type: MODELS, name: 'Morphing Models' },
            ],
            data: [1, (3 << 16) | 2, 4551, 4551, 4552],
        };
        const pc = plugClass([3671, 3672, 3673, 3674]);
        const all = mergeDefaults(pc, tpl, undefined, undefined, false, undefined, (r) =>
            r === 0 ? 0 : (3 << 16) | (r + 4280),
        );
        expect(all.data.slice(0, 2)).toEqual([0, (4 << 16) | 5]);
        expect(all.data.slice(5)).toEqual([3, 3, 3, 3].map((d, i) => ((d << 16) | (7951 + i)) >>> 0));
        const partial = mergeDefaults(pc, tpl, undefined, undefined, false, undefined, (r) => (r === 3673 ? null : r));
        expect(partial.data.slice(1, 5)).toEqual([(3 << 16) | 2, 4551, 4551, 4552]); // the template's models stay
    });
});
