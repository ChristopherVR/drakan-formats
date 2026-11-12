// Ropes keep their own model; swapped weapons carry the disc weapon's child part. Synthetic classes; no game bytes.
import { describe, expect, it } from 'vitest';
import { joinClassRecord, splitClassRecord, type OdbClass } from '../src/index.ts';
import { planClassMapping, type Ps2OdbIn } from '../src/ootfclass.ts';
import { ROPE_RFL, ownModelClasses } from '../src/ootfownmodel.ts';
import { classCompanionRef } from '../src/ootfps2model.ts';

const cls = (id: number, name: string, rfl: number, model: number | null): OdbClass => ({
    id,
    name,
    group: 5,
    runtimeClass: 0x10000 + rfl,
    model: model === null ? null : { id: model, db: 0 },
    rflClass: rfl,
    icon: 1,
    fields: [{ type: 2, name: 'Swing Period (s)' }],
    data: [0x40200000],
});

/** A class record with a model block: flags, the auxiliary class reference at +10, bounds, engine class, one field. */
function record(c: OdbClass, companion: number): Uint8Array {
    const body = new Uint8Array(98);
    const d = new DataView(body.buffer);
    d.setUint16(0, c.group, true);
    d.setUint16(2, c.model!.id, true);
    d.setUint32(6, 1, true);
    d.setUint32(10, companion, true);
    d.setUint16(14, 1, true);
    d.setUint32(80, c.runtimeClass!, true);
    d.setUint32(86, 1, true);
    d.setUint32(90, 1, true);
    d.setUint32(94, c.data![0]!, true);
    return joinClassRecord(c.name, body);
}

function odb(file: string, dbIndex: number, classes: OdbClass[], companions = new Map<number, number>()): Ps2OdbIn {
    const raw = new Map(classes.filter((c) => c.model).map((c) => [c.id, record(c, companions.get(c.id) ?? 0)]));
    return { dbIndex, file, classes: new Map(classes.map((c) => [c.id, c])), raw: (id) => raw.get(id), group: () => 5 };
}

const companionOf = (rec: Uint8Array): number => {
    const body = splitClassRecord(rec).body;
    return new DataView(body.buffer, body.byteOffset, body.byteLength).getUint32(10, true);
};

describe('ownModelClasses', () => {
    const rope = cls(1, 'Rope', ROPE_RFL, 3733);
    const cable = cls(2, 'Cable', ROPE_RFL, 3733);
    const staticRope = cls(3, 'Static Rope', 35, 3733); // a mover placed with the rope mesh
    const blade = cls(4, 'Blade', 35, 3734);
    const crate = cls(5, 'Crate', 17, 3900);
    const marker = cls(6, 'Rope Marker', ROPE_RFL, null);
    const input = [rope, cable, staticRope, blade, crate, marker].map((c) => ({
        cls: c,
        model: c.model ? `common#${c.model.id}` : null,
    }));

    it('keeps every rope class with a model and every class placed with a rope mesh', () => {
        expect(ownModelClasses(input)).toEqual([rope, cable, staticRope]);
    });

    it('leaves other classes, model-less ropes and unconverted models to the name mapping', () => {
        const kept = ownModelClasses(input);
        for (const c of [blade, crate, marker]) expect(kept).not.toContain(c);
        expect(ownModelClasses([{ cls: rope, model: null }])).toEqual([]);
        expect(ownModelClasses([{ cls: staticRope, model: 'common#3733' }])).toEqual([]); // no rope uses that mesh
    });

    it('a kept rope is cloned with the PC model instead of taking the same-named disc class and its model', () => {
        const discRope = cls(3904, 'Rope', ROPE_RFL, 4621); // the disc's stub of a bridge rope
        const ps2 = odb('MOUNTAON.ODB', 10, [discRope]);
        const pc = [{ db: 1, id: 1, cls: rope }];
        const options = { modelFor: () => ({ id: 20000, db: 0 }) };
        const mapped = planClassMapping(pc, [ps2], options);
        expect(mapped.resolve(1, 1)?.cls.model).toEqual({ id: 4621, db: 0 }); // the fault: the disc stub
        const own = new Set(ownModelClasses([{ cls: rope, model: 'common#3733' }]));
        const kept = planClassMapping(pc, [ps2], { ...options, keepOwnModel: (c) => own.has(c) });
        expect(kept.mapped.size).toBe(0);
        expect(kept.synthesized).toHaveLength(1);
        expect(kept.resolve(1, 1)?.cls.model).toEqual({ id: 20000, db: 0 });
        expect(kept.resolve(1, 1)?.cls.rflClass).toBe(ROPE_RFL);
    });
});

describe('weapon child parts', () => {
    const handle = cls(8758, 'Steel Mace', 14, 6067);
    const head = cls(14989, 'Steel Mace Head', 203, 6066);
    const plain = cls(8571, 'Wood Club', 14, 6058);

    it('reads the auxiliary class reference of a disc class record', () => {
        expect(classCompanionRef(record(handle, 14989))).toBe(14989);
        expect(classCompanionRef(record(plain, 0))).toBe(0);
        expect(classCompanionRef(record(handle, (2 << 16) | 77))).toBe((2 << 16) | 77); // class 77 of db 2
        expect(classCompanionRef(new Uint8Array(1))).toBe(0);
        expect(classCompanionRef(joinClassRecord('short', new Uint8Array(8)))).toBe(0);
    });

    it('a clone carries the reference the caller names and otherwise none, never the template own', () => {
        // Both templates name a child; the PC mace is cloned from one of them.
        const ps2 = odb(
            'RESOURES.ODB',
            2,
            [handle, head, plain],
            new Map([
                [handle.id, head.id],
                [plain.id, 4242],
            ]),
        );
        const mace = cls(1, 'Mace', 14, 3684);
        const pc = [{ db: 1, id: 1, cls: mace }];
        const options = { modelFor: () => ({ id: 6067, db: 0 }), modelOdbFile: 'RESOURES.ODB' };
        const bare = planClassMapping(pc, [ps2], options).synthesized[0]!;
        expect(companionOf(bare.record)).toBe(0); // the fault: the handle alone
        const seen: string[] = [];
        const withHead = planClassMapping(pc, [ps2], {
            ...options,
            companionFor: (c, file) => (seen.push(`${c.name}@${file}`), c === mace ? head.id : undefined),
        }).synthesized[0]!;
        expect(seen).toEqual(['Mace@RESOURES.ODB']);
        expect(companionOf(withHead.record)).toBe(head.id);
        expect(withHead.cls.model).toEqual({ id: 6067, db: 0 });
        // everything else of the record is the same clone
        const a = splitClassRecord(bare.record).body.slice();
        const b = splitClassRecord(withHead.record).body.slice();
        new DataView(b.buffer).setUint32(10, 0, true);
        expect(b).toEqual(a);
        const none = planClassMapping(pc, [ps2], { ...options, companionFor: () => undefined }).synthesized[0]!;
        expect(companionOf(none.record)).toBe(0);
    });
});
