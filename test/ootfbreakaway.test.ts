// Break-away floor conversion: the pieces named by "Model List". Synthetic classes only; no game bytes.
import { describe, expect, it } from 'vitest';
import { BREAKAWAY_RFL, breakawayPieceHosts } from '../src/ootfpipeline.ts';
import { buildPlainClassRecord, planClassMapping, type Ps2OdbIn } from '../src/ootfclass.ts';
import { decodeFieldValue } from '../src/fields.ts';
import type { OdbClass } from '../src/odb.ts';

const MODELS = 0x1004; // indirect array of FIELD_MODEL
const T_ENUM = 7;
const T_FLOAT = 2;

/** A floor class: "Model List" (pieces) and "Break Away on Trigger Only"; the array words follow the field words. */
const floorClass = (
    id: number,
    name: string,
    pieces: number[],
    triggerOnly = 0,
    extra: [number, string][] = [],
): OdbClass => ({
    id,
    name,
    group: 5,
    runtimeClass: 0x10000 + BREAKAWAY_RFL,
    model: null,
    rflClass: BREAKAWAY_RFL,
    icon: 1,
    fields: [
        { type: MODELS, name: 'Model List' },
        { type: T_ENUM, name: 'Break Away on Trigger Only' },
        ...extra.map(([type, n]) => ({ type, name: n })),
    ],
    data: [(pieces.length << 16) | (2 + extra.length), triggerOnly, ...extra.map(() => 0), ...pieces],
});

/** The PS2 side: one model-less floor template in a template ODB (LEVEL1ON) and an empty host (RESOURES). */
function ps2(): Ps2OdbIn[] {
    const tpl = floorClass(1331, 'Bridge Breakway Pieces', [950, 951, 952], 1, [
        [T_FLOAT, 'Wobble time before fall(seconds)'],
    ]);
    const raw = buildPlainClassRecord({
        name: tpl.name,
        group: 5,
        rfl: BREAKAWAY_RFL,
        icon: 1,
        fieldCount: 3,
        data: tpl.data!,
    });
    return [
        { dbIndex: 3, file: 'RESOURES.ODB', classes: new Map(), raw: () => undefined },
        {
            dbIndex: 7,
            file: 'LEVEL1ON.ODB',
            classes: new Map([[1331, tpl]]),
            raw: (id) => (id === 1331 ? raw : undefined),
        },
    ];
}

const modelList = (c: OdbClass): number[] => {
    const i = c.fields!.findIndex((f) => f.name === 'Model List');
    return decodeFieldValue(c.fields![i]!.type, c.data![i]!, c.data!) as number[];
};

describe('break-away floor conversion', () => {
    // Alwarren's bricks: one piece each, in the level's own database (db 0) and through its .db (db 2).
    const pc = [
        { db: 1, id: 3445, cls: floorClass(3445, 'Brick1', [4085]) },
        { db: 1, id: 3448, cls: floorClass(3448, 'Brick2', [(2 << 16) | 4086]) },
    ];

    it('keeps the template pieces and folds every floor into one class when the pieces cannot be named', () => {
        const plan = planClassMapping(pc, ps2(), { modelOdbFile: 'RESOURES.ODB' });
        expect(plan.unsupported.size).toBe(0);
        expect(plan.synthesized).toHaveLength(1);
        expect(plan.synthesized[0]!.pcKeys).toEqual(['1:3445', '1:3448']);
        expect(modelList(plan.synthesized[0]!.cls)).toEqual([950, 951, 952]);
    });

    it('gives every floor its own converted pieces, named with db 0 in the template ODB', () => {
        // the pieces converted into LEVEL1ON's own MOD: PC ref -> new id there
        const converted = new Map([
            [4085, 7001],
            [(2 << 16) | 4086, 7002],
        ]);
        const plan = planClassMapping(pc, ps2(), {
            modelOdbFile: 'RESOURES.ODB',
            mapModelFor: (_cls, file) => (file === 'LEVEL1ON.ODB' ? (ref) => converted.get(ref) ?? null : undefined),
        });
        expect(plan.synthesized.map((s) => [s.name, s.file, modelList(s.cls)])).toEqual([
            ['Brick1', 'LEVEL1ON.ODB', [7001]],
            ['Brick2', 'LEVEL1ON.ODB', [7002]],
        ]);
        // the PC break mode is kept; the template's own fields keep their values
        const b1 = plan.synthesized[0]!.cls;
        expect(b1.data![b1.fields!.findIndex((f) => f.name === 'Break Away on Trigger Only')]).toBe(0);
    });

    it('keeps the template pieces when any piece of a floor did not convert', () => {
        const plan = planClassMapping([pc[0]!], ps2(), {
            modelOdbFile: 'RESOURES.ODB',
            mapModelFor: () => () => null,
        });
        expect(modelList(plan.synthesized[0]!.cls)).toEqual([950, 951, 952]);
    });

    it('lists the floors whose pieces go into a hosted template ODB, each class once', () => {
        const plan = planClassMapping(pc, ps2(), { modelOdbFile: 'RESOURES.ODB' });
        const byKey = new Map(pc.map((p) => [`${p.db}:${p.id}`, p.cls]));
        const wants = breakawayPieceHosts(
            plan,
            (k) => byKey.get(k),
            (stem) => stem === 'LEVEL1ON',
        );
        expect(wants.map((w) => [w.stem, w.cls.name])).toEqual([
            ['LEVEL1ON', 'Brick1'],
            ['LEVEL1ON', 'Brick2'],
        ]);
        // a template ODB without its own MOD / TXD to host pieces in: nothing to convert
        expect(
            breakawayPieceHosts(
                plan,
                (k) => byKey.get(k),
                () => false,
            ),
        ).toEqual([]);
        // other engine classes are not floors
        const other = { synthesized: plan.synthesized.map((s) => ({ ...s, rfl: 99 })) };
        expect(
            breakawayPieceHosts(
                other,
                (k) => byKey.get(k),
                () => true,
            ),
        ).toEqual([]);
    });
});
