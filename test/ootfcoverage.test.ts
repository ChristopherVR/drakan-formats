// Class coverage of the OotF conversion: every placed PC class is mapped, cloned, stood in for, or kept out on purpose with a
// note. Synthetic classes only; no game bytes.
import { describe, expect, it } from 'vitest';
import {
    ARENA_EXPORT_RFL,
    REFERENCE_ENGINES,
    SKY_FOG_SWITCH_RFL,
    deliberateOmission,
    pcParamAlias,
} from '../src/ootfcoverage.ts';
import { ENGINE_CLASSES, buildPlainClassRecord, planClassMapping, type Ps2OdbIn } from '../src/ootfclass.ts';
import { decodeFieldValue } from '../src/fields.ts';
import type { OdbClass } from '../src/odb.ts';

const T_INT = 1;
const T_FLOAT = 2;
const T_SOUND = 5;
const T_ENUM = 7;
const T_COLOUR = 0x0f;
const T_MODELS = 0x1004;

const cls = (
    id: number,
    name: string,
    rfl: number,
    fields: [number, string][],
    data: number[],
    model: OdbClass['model'] = null,
): OdbClass => ({
    id,
    name,
    group: 5,
    runtimeClass: 0x10000 + rfl,
    model,
    rflClass: rfl,
    icon: 1,
    fields: fields.map(([type, n]) => ({ type, name: n })),
    data,
});

/** One PS2 ODB holding `classes`, with raw records for each (model-less). */
function odb(dbIndex: number, file: string, classes: OdbClass[]): Ps2OdbIn {
    const raws = new Map(
        classes.map((c) => [
            c.id,
            buildPlainClassRecord({
                name: c.name,
                group: c.group,
                rfl: c.rflClass!,
                icon: 1,
                fieldCount: c.fields!.length,
                data: c.data!,
            }),
        ]),
    );
    return { dbIndex, file, classes: new Map(classes.map((c) => [c.id, c])), raw: (id) => raws.get(id) };
}

describe('deliberate omissions', () => {
    // A localized install (German) keeps the class names in English; the engine id decides, never the name.
    const fog = cls(
        3801,
        'Nebelwechsel',
        SKY_FOG_SWITCH_RFL,
        [
            [T_COLOUR, 'Positive Fog'],
            [T_COLOUR, 'Negative Fog'],
        ],
        [0xa68961, 0],
        { id: 3727, db: 1 },
    );

    it('keeps the PC sky and fog switches out with a note, whatever the class is called', () => {
        for (const name of [
            'Fog + Sky Changer',
            'Sky Trigger',
            'Fog Transition',
            'Fog Color Changer',
            'Nebelwechsel',
        ]) {
            const o = deliberateOmission({ ...fog, name }, { arena: false });
            expect(o?.kind).toBe('sky-fog-switch');
            expect(o?.note).toMatch(/keeps one sky and fog/);
        }
    });

    it('sends multiplayer pads to the arena file in an arena, and says they are multiplayer only elsewhere', () => {
        for (const rfl of ARENA_EXPORT_RFL) {
            const pad = cls(1, 'Rynn Startfeld', rfl, [], []);
            expect(deliberateOmission(pad, { arena: true })).toMatchObject({ kind: 'arena-export' });
            expect(deliberateOmission(pad, { arena: true })!.note).toMatch(/maps\/<level>\.ini/);
            expect(deliberateOmission(pad, { arena: false })!.note).toMatch(/multiplayer only/);
        }
    });

    it('explains a prop whose model the install itself does not have, and only then', () => {
        const prop = cls(3323, 'Fall01', 17, [[T_INT, 'Initial Health']], [0], { id: 3918, db: 0 });
        const o = deliberateOmission(prop, { arena: false, missingModel: 'model 3918 is not in Alwarren.mod' });
        expect(o).toMatchObject({ kind: 'no-source-model' });
        expect(o!.note).toContain('model 3918 is not in Alwarren.mod');
        expect(o!.note).toMatch(/original game draws nothing here either/);
        // a model that exists (or was simply not converted) is a real gap, not a deliberate omission
        expect(deliberateOmission(prop, { arena: false })).toBeNull();
        // a logic class with a missing model is not explained away
        expect(deliberateOmission({ ...prop, rflClass: 62 }, { arena: false, missingModel: 'x' })).toBeNull();
    });

    it('never words a note as an error', () => {
        const notes = [
            deliberateOmission(fog, { arena: false })!.note,
            deliberateOmission(cls(1, 'p', 18, [], []), { arena: true })!.note,
            deliberateOmission(cls(1, 'p', 17, [], [], { id: 1, db: 0 }), { arena: false, missingModel: 'm' })!.note,
        ];
        const dash = String.fromCharCode(0x2014);
        for (const n of notes) {
            expect(n).not.toMatch(/unknown|error|fail|dropped/i);
            expect(n.includes(dash)).toBe(false);
        }
    });

    it('names every reference-only engine id, none of which the placement catalogue claims', () => {
        for (const [rfl, name] of REFERENCE_ENGINES) {
            expect(name.length).toBeGreaterThan(2);
            expect(ENGINE_CLASSES.has(rfl)).toBe(false);
        }
    });
});

describe('parameter aliases', () => {
    const ambient = cls(
        46,
        'Ambient Sound',
        131,
        [
            [T_ENUM, 'Slot'],
            [T_SOUND, 'Front Sound'],
            [T_SOUND, 'Back Sound'],
        ],
        [0, 0, 0],
    );

    it('puts the PC ambient sound pair into the PS2 slot the object names', () => {
        expect(pcParamAlias(ambient, 'Front Sound', () => 2)).toBe('Front Sound Slot 2');
        expect(pcParamAlias(ambient, 'back sound', () => 0)).toBe('Back Sound Slot 0');
        // out-of-range slots clamp to the four PS2 slots
        expect(pcParamAlias(ambient, 'Front Sound', () => 9)).toBe('Front Sound Slot 3');
        expect(pcParamAlias(ambient, 'Front Sound', () => -1)).toBe('Front Sound Slot 0');
        expect(pcParamAlias(ambient, 'Slot', () => 0)).toBeUndefined();
        expect(pcParamAlias({ ...ambient, rflClass: 6 }, 'Front Sound', () => 0)).toBeUndefined();
    });
});

describe('class plan coverage', () => {
    it('name-maps the multiplayer Ambient Sound onto the PS2 Ambient Transition', () => {
        const ps2 = odb(2, 'FX.ODB', [
            cls(
                3158,
                'AmbientTransition',
                131,
                [
                    [T_SOUND, 'Front Sound Slot 0'],
                    [T_SOUND, 'Back Sound Slot 0'],
                ],
                [0, 0],
            ),
        ]);
        const pc = cls(
            46,
            'Ambient Sound',
            131,
            [
                [T_ENUM, 'Slot'],
                [T_SOUND, 'Front Sound'],
                [T_SOUND, 'Back Sound'],
            ],
            [0, 0, 0],
        );
        const plan = planClassMapping([{ db: 1, id: 46, cls: pc }], [ps2]);
        expect(plan.unsupported.size).toBe(0);
        expect(plan.resolve(1, 46)).toMatchObject({ dbIndex: 2, classId: 3158 });
    });

    it('stands a Particle Spawner in for the Quickening Effect, with the PS2 defaults', () => {
        const spawner = cls(
            3060,
            'Particle Spawner',
            71,
            [
                [T_FLOAT, 'Release Rate'],
                [T_INT, 'Max Particles'],
            ],
            [0x40a00000, 40],
        );
        const quick = cls(
            3051,
            'Quickening Effect',
            80,
            [
                [0x0b, 'Patrol Sequence'],
                [0x04, 'Particle Model (sparks)'],
                [T_FLOAT, 'Particle Size (sparks)'],
                [T_COLOUR, 'Particle Color'],
            ],
            [0, 3824, 0x430c0000, 0x939393],
        );
        const plan = planClassMapping([{ db: 3, id: 3051, cls: quick }], [odb(2, 'FX.ODB', [spawner])], {
            substituteEngineId: new Map([[80, 71]]),
        });
        expect(plan.unsupported.size).toBe(0);
        const s = plan.synthesized[0]!;
        expect(s).toMatchObject({ name: 'Quickening Effect', file: 'FX.ODB', rfl: 71 });
        expect(s.template.name).toBe('Particle Spawner');
        expect(s.cls.data).toEqual([0x40a00000, 40]);
        expect(s.coverage).toBe(0);
    });

    it('clones a break-away floor whose class also names a model from the model-less floor template', () => {
        const tpl = cls(
            1331,
            'Bridge Breakway Pieces',
            44,
            [
                [T_MODELS, 'Model List'],
                [T_ENUM, 'Break Away on Trigger Only'],
            ],
            [(1 << 16) | 2, 1, 950],
        );
        // Alwarren's "Brick17": class model 4101 and Model List [4101]
        const brick = cls(
            3463,
            'Brick17',
            44,
            [
                [T_MODELS, 'Model List'],
                [T_ENUM, 'Break Away on Trigger Only'],
            ],
            [(1 << 16) | 2, 0, 4101],
            { id: 4101, db: 0 },
        );
        const ps2 = [
            { dbIndex: 3, file: 'RESOURES.ODB', classes: new Map(), raw: () => undefined },
            odb(7, 'LEVEL1ON.ODB', [tpl]),
        ];
        const plan = planClassMapping([{ db: 2, id: 3463, cls: brick }], ps2, {
            modelOdbFile: 'RESOURES.ODB',
            // a converted class model would otherwise demand a model-bearing floor template, which no PS2 ODB has
            modelFor: () => ({ id: 9000, db: 0 }),
            mapModelFor: (_c, file) => (file === 'LEVEL1ON.ODB' ? (ref) => (ref === 4101 ? 7101 : null) : undefined),
        });
        expect(plan.unsupported.size).toBe(0);
        const s = plan.synthesized[0]!;
        expect([s.name, s.file, s.cls.model]).toEqual(['Brick17', 'LEVEL1ON.ODB', null]);
        const i = s.cls.fields!.findIndex((f) => f.name === 'Model List');
        expect(decodeFieldValue(s.cls.fields![i]!.type, s.cls.data![i]!, s.cls.data!)).toEqual([7101]);
    });
});
