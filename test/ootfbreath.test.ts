import { describe, expect, it } from 'vitest';
import type { OdbClass } from '../src/odb.ts';
import { BREATH_STAND_INS, breathStandIn } from '../src/ootfbreath.ts';
import type { Ps2OdbIn } from '../src/ootfclass.ts';
import { REFERENCE_ENGINES } from '../src/ootfcoverage.ts';

function powerUp(id: number, name: string, weapon: number, alt: number): OdbClass {
    return {
        id,
        name,
        group: 1,
        rflClass: 57,
        runtimeClass: 0x10039,
        model: null,
        fields: [
            { name: 'Activation Sound', type: 5 },
            { name: 'Weapon', type: 0x4003 },
            { name: 'Alt. Weapon', type: 0x4003 },
            { name: 'Special Effect', type: 0x5003 },
        ],
        data: [7, weapon, alt, 0],
    };
}

const odb: Ps2OdbIn = {
    file: 'RESOURES.ODB',
    dbIndex: 3,
    classes: new Map([
        [1, powerUp(1, '#1 Fireball Power Up', 500, 501)],
        [2, powerUp(2, '#3 Ice Power Up', 600, 601)],
    ]),
};
const target = { rfl: 57, file: 'RESOURES.ODB' };

describe('OotF dragon power-up breath', () => {
    it('gives a PC-only fire breath the native fireball power-up breath of the same field', () => {
        expect(breathStandIn(target, 'Weapon', { rflClass: 48 }, [odb])).toEqual({
            ref: 500,
            powerUp: '#1 Fireball Power Up',
        });
        expect(breathStandIn(target, 'Alt. Weapon', { rflClass: 21 }, [odb])?.ref).toBe(501);
        expect(breathStandIn(target, 'Weapon', { rflClass: 108 }, [odb])?.ref).toBe(500);
        expect(breathStandIn(target, 'Weapon', { rflClass: 42 }, [odb])?.ref).toBe(600);
    });

    it('leaves other classes, fields, projectiles and other ODBs alone', () => {
        expect(breathStandIn({ rfl: 14, file: 'RESOURES.ODB' }, 'Weapon', { rflClass: 48 }, [odb])).toBeNull();
        expect(breathStandIn(target, 'Special Effect', { rflClass: 48 }, [odb])).toBeNull();
        expect(breathStandIn(target, 'Weapon', { rflClass: 70 }, [odb])).toBeNull();
        expect(breathStandIn(target, 'Weapon', undefined, [odb])).toBeNull();
        expect(breathStandIn({ rfl: 57, file: 'FX.ODB' }, 'Weapon', { rflClass: 48 }, [odb])).toBeNull();
    });

    it('only stands in for projectiles the converter cannot carry', () => {
        for (const rfl of BREATH_STAND_INS.keys()) expect(REFERENCE_ENGINES.has(rfl)).toBe(true);
    });
});
