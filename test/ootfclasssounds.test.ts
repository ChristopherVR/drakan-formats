// Synthetic fixtures only; no game bytes.
import { describe, expect, it } from 'vitest';
import { parseClassBody, splitClassRecord, type OdbClass } from '../src/index.ts';
import { buildPlainClassRecord, type Synthesized } from '../src/ootfclass.ts';
import { matchClassSounds, matchSoundObjects, pcClassSoundRefs, writeClassSounds } from '../src/ootfclasssounds.ts';

const T_INT = 1;
const T_CLASS = 3;
const T_SOUND = 5;
const T_SOUND_LIST = 0x1005;

function cls(name: string, rfl: number, fields: [number, string][], data: number[]): OdbClass {
    return {
        id: 1,
        name,
        group: 0,
        runtimeClass: 0,
        model: null,
        rflClass: rfl,
        icon: 0,
        fields: fields.map(([type, n]) => ({ type, name: n })),
        data,
    } as OdbClass;
}

function synth(tpl: OdbClass): Synthesized {
    const record = buildPlainClassRecord({
        name: tpl.name,
        group: 0,
        rfl: tpl.rflClass ?? 0,
        icon: 0,
        fieldCount: tpl.fields!.length,
        data: tpl.data!,
    });
    return {
        pcKeys: ['1:1'],
        name: tpl.name,
        file: 'RESOURES.ODB',
        dbIndex: 1,
        classId: 9,
        group: 0,
        rfl: tpl.rflClass ?? 0,
        template: { dbIndex: 1, classId: 2, name: 'template' },
        record,
        cls: { ...tpl, data: [...tpl.data!] },
        copied: [],
        skipped: [],
        coverage: 1,
    };
}

describe('class-default sounds', () => {
    // PC: a scalar, a list (2 refs at dword 4) and an empty sound field.
    const pc = cls(
        'Door',
        19,
        [
            [T_INT, 'Locked'],
            [T_SOUND, 'Bang Hinges Sound'],
            [T_SOUND_LIST, 'Death Sounds'],
            [T_SOUND, 'Open Start Sound'],
        ],
        [1, 0x20057, (2 << 16) | 4, 0, 0x10003, 0x10004],
    );
    // Template: the same names in another order, one PC-less field and no "Death Sounds" list of its own.
    const tpl = cls(
        'Door',
        19,
        [
            [T_SOUND_LIST, 'death sounds'],
            [T_INT, 'Locked'],
            [T_SOUND, 'Bang Hinges Sound'],
            [T_SOUND, 'Close Stop Sound'],
        ],
        [0, 0, 0x5000a, 0x5000b],
    );

    it('lists the non-empty sound fields of a PC class', () => {
        expect(pcClassSoundRefs(pc)).toEqual([
            { name: 'Bang Hinges Sound', refs: [0x20057] },
            { name: 'Death Sounds', refs: [0x10003, 0x10004] },
        ]);
    });

    it('matches PC sound fields to the template field of the same name', () => {
        const m = matchClassSounds(pc, tpl);
        expect(m.unmatched).toEqual([]);
        expect(m.fields).toEqual([
            { name: 'Bang Hinges Sound', field: 2, array: false, refs: [0x20057] },
            { name: 'Death Sounds', field: 0, array: true, refs: [0x10003, 0x10004] },
        ]);
        const other = cls('Door', 19, [[T_SOUND, 'Close Stop Sound']], [0]);
        expect(matchClassSounds(pc, other).unmatched).toEqual(['Bang Hinges Sound', 'Death Sounds']);
    });

    it('keeps the template pickup sound', () => {
        const item = cls('Sword', 14, [[T_SOUND, 'Picked Up Sound']], [0x20005]);
        const tplItem = cls('Club', 14, [[T_SOUND, 'Picked Up Sound']], [0xc4]);
        expect(matchClassSounds(item, tplItem)).toEqual({ fields: [], unmatched: [] });
    });

    it('clears a template sound where the PC field has none', () => {
        const silent = cls('Door', 19, [[T_SOUND, 'Close Stop Sound']], [0]);
        expect(matchClassSounds(silent, tpl).fields).toEqual([
            { name: 'Close Stop Sound', field: 3, array: false, refs: [] },
        ]);
        expect(matchClassSounds(silent, cls('Door', 19, [[T_SOUND, 'Close Stop Sound']], [0])).fields).toEqual([]);
        const s = synth(tpl);
        writeClassSounds(s, new Map([[3, []]]));
        expect(parseClassBody(splitClassRecord(s.record).body)!.data).toEqual([0, 0, 0x5000a, 0]);
    });

    it('writes scalars in place and lists at the end of the data area, keeping the other fields', () => {
        const s = synth(tpl);
        writeClassSounds(
            s,
            new Map([
                [2, [0x60001]],
                [0, [0x60002, 0x60003]],
            ]),
        );
        const parsed = parseClassBody(splitClassRecord(s.record).body)!;
        expect(parsed.data).toEqual([(2 << 16) | 4, 0, 0x60001, 0x5000b, 0x60002, 0x60003]);
        expect(s.cls.data).toEqual(parsed.data);
    });

    it("takes a sound effect class ref for the template's looping sound", () => {
        const flame = cls(
            'Torch Flame',
            20,
            [
                [T_INT, 'Radius'],
                [T_CLASS, 'Sound Effect Object'],
            ],
            [3, 0x10c2f],
        );
        const wallTorch = cls(
            'Wall Torch',
            20,
            [
                [T_CLASS, 'Dynamic Light'],
                [T_SOUND, 'Looping Sound'],
            ],
            [0, 0],
        );
        expect(matchSoundObjects(flame, wallTorch)).toEqual([
            { name: 'Sound Effect Object', field: 1, array: false, ref: 0x10c2f },
        ]);
        expect(matchSoundObjects(flame, cls('Light', 20, [[T_CLASS, 'Dynamic Light']], [0]))).toEqual([]);
    });
});
