import { describe, expect, it } from 'vitest';
import type { OdbClass } from '../src/odb.ts';
import { buildCrystalMetadata, type CrystalRef } from '../src/ootfcrystal.ts';

function cls(id: number, name: string, rflClass: number, fields: [string, number][], data: number[]): OdbClass {
    return {
        id,
        name,
        group: 1,
        rflClass,
        runtimeClass: rflClass,
        model: null,
        fields: fields.map(([n, type]) => ({ name: n, type })),
        data,
    };
}

const crystal = (id: number, name: string, effect: number): OdbClass =>
    cls(
        id,
        name,
        91,
        [
            ['Quantity', 1],
            ['Effect', 0x4003],
        ],
        [5, effect],
    );
const fireFx = cls(3079, 'Fire Crystal FX', 90, [['Damage', 1]], [6]);
const iceFx = cls(3845, 'Ice Shield FX', 119, [['Damage per second', 1]], [5]);
const bolt = cls(3082, 'Lightning (Lightning Crystal)', 58, [], []);
const lightningFx = cls(3083, 'Lightning Crystal FX', 96, [['Ground Lightning Object', 0x2003]], [3082]);
const pcById = new Map([fireFx, iceFx, bolt, lightningFx].map((c) => [c.id, c]));

function synth(key: string, classId: number, name: string, file = 'RESOURES.ODB', dbIndex = 3) {
    return { pcKeys: [key], name, file, dbIndex, classId } as never;
}

describe('OotF Magic Crystal metadata', () => {
    const sources = new Map([
        ['1:3158', crystal(3158, 'Fire Crystal', 0x20c07)],
        ['1:3159', crystal(3159, 'Ice Crystal', 0x20f05)],
        ['1:3157', crystal(3157, 'Lightning Crystal', 0x20c0b)],
    ]);
    const resolve = (_from: OdbClass, ref: number): CrystalRef | null => {
        const pc = pcById.get(ref & 0xffff);
        if (!pc) return null;
        const target =
            pc.rflClass === 90
                ? { dbIndex: 4, classId: 3079 }
                : pc.rflClass === 58
                  ? { dbIndex: 3, classId: 18402 }
                  : null; // Ice Shield FX and the Lightning Crystal FX have no PS2 class
        return { pc, target };
    };
    const ps2 = [
        {
            file: 'RESOURES.ODB',
            dbIndex: 3,
            classes: new Map([
                [16137, cls(16137, "!! Rynn's Ice Ring !!", 90, [], [])],
                [15567, cls(15567, '!! Lightning Secondary Gen !!', 63, [], [])],
            ]),
        },
    ];

    it('maps fire to its native effect, ice to the ice ring and lightning to the lightning generator', () => {
        const plan = {
            synthesized: [
                synth('1:3158', 17059, 'Fire Crystal'),
                synth('1:3159', 17241, 'Ice Crystal'),
                synth('1:3157', 17150, 'Lightning Crystal'),
            ],
        };
        const out = buildCrystalMetadata(plan, (k) => sources.get(k), resolve, ps2);
        expect(out.text).toBe(
            [
                'format = 1',
                '',
                '[crystal 0x342a3]',
                'effect = 0x40c07',
                'kind = fire',
                'name = Fire Crystal',
                '',
                '[crystal 0x342fe]',
                'effect = 0x33ccf',
                'kind = lightning',
                'name = Lightning Crystal',
                '',
                '[crystal 0x34359]',
                'effect = 0x33f09',
                'kind = ice',
                'name = Ice Crystal',
                '',
            ].join('\n'),
        );
        expect(out.warnings.filter((w) => w.includes('casts'))).toHaveLength(3);
    });

    it('omits crystals outside the verified namespace, without an effect or with an unknown one', () => {
        const odd = crystal(9, 'Odd', 0x29999);
        const none = crystal(10, 'None', 0);
        const src = new Map([...sources, ['1:9', odd], ['1:10', none]]);
        const plan = {
            synthesized: [
                synth('1:3158', 100, 'Fire Crystal', 'FX.ODB', 4),
                synth('1:9', 101, 'Odd'),
                synth('1:10', 102, 'None'),
                synth('1:77', 103, 'Not a crystal'),
            ],
        };
        const out = buildCrystalMetadata(plan, (k) => src.get(k), resolve, ps2);
        expect(out.text).toBeNull();
        expect(out.warnings).toHaveLength(3);
    });
});
