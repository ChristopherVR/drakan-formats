// Synthetic fixtures only; no game bytes.
import { describe, expect, it } from 'vitest';
import { encodeFieldList, parseClassBody, splitClassRecord, type LvlObject, type OdbClass } from '../src/index.ts';
import { buildPlainClassRecord, planClassMapping, setSynthesizedDefaults, type Ps2OdbIn } from '../src/ootfclass.ts';
import { applyPuzzleLogic, setNamedParam } from '../src/ootfpuzzle.ts';
import type { PcLevel } from '../src/pc.ts';
import { zlibSync } from 'fflate';

const T_INT = 1;
const T_STR = 0x0a;
const SCALE_BIT = 0; // no flags needed by the marker pass

const markerFields = [
    { type: T_INT, name: 'Type' },
    { type: T_INT, name: 'SubQuest?' },
    { type: T_STR, name: 'Journal Entry' },
    { type: T_STR, name: 'Map Text' },
    { type: T_INT, name: 'New Quest Sound' },
    { type: T_INT, name: 'Map X Coordinate' },
    { type: T_INT, name: 'Map Y Coordinate' },
];
// The template quest: optional journal entry, System.XDB text id 8 (the disc's farmer's wife quest in this story).
const templateData = [1, 1, 8, 0, 0, 0, 0];

function ps2Marker(): OdbClass {
    return {
        id: 40,
        name: 'Farmer Quest',
        group: 0xbef,
        runtimeClass: 0x10068,
        model: null,
        rflClass: 104,
        icon: 0x37,
        fields: markerFields,
        data: templateData,
    };
}

function systemOdb(): Ps2OdbIn & { classes: Map<number, OdbClass> } {
    const m = ps2Marker();
    const classes = new Map<number, OdbClass>([
        [40, m],
        [
            900,
            {
                id: 900,
                name: 'Other',
                group: 0,
                runtimeClass: 0,
                model: null,
                rflClass: 99,
                icon: 0,
                fields: [],
                data: [],
            },
        ],
    ]);
    const raw = new Map<number, Uint8Array>([
        [
            40,
            buildPlainClassRecord({
                name: m.name,
                group: 0xbef,
                rfl: 104,
                icon: 0x37,
                fieldCount: markerFields.length,
                data: templateData,
            }),
        ],
    ]);
    return {
        dbIndex: 2,
        file: 'SYSTEM.ODB',
        classes,
        raw: (id) => raw.get(id),
        group: () => 0xbef,
        fieldLists: { id: 0, sub: 0, stored: zlibSync(encodeFieldList([{ type: T_INT, name: 'a' }])) },
    };
}

function pcMarker(id: number, name: string, sound: number): OdbClass {
    return {
        id,
        name,
        group: 1,
        runtimeClass: 0x10068,
        model: null,
        rflClass: 104,
        icon: 0,
        fields: [
            { type: T_INT, name: 'New Quest Sound' },
            { type: T_INT, name: 'Map X Coordinate' },
            { type: T_INT, name: 'Map Y Coordinate' },
        ],
        data: [sound, 100, 200],
    };
}

const obj = (id: number, dbIndex: number, classId: number): LvlObject =>
    ({
        id,
        classId,
        dbIndex,
        pos: [0, 0, 0],
        rot: [0, 0, 0],
        scale: null,
        flags: SCALE_BIT,
        initialEvents: 0,
        radius: null,
        links: [],
        params: [],
        data: [],
    }) as unknown as LvlObject;

const recordData = (rec: Uint8Array): number[] => parseClassBody(splitClassRecord(rec).body)!.data;

describe('ootfpuzzle map markers (issue 5: wrong quest text)', () => {
    it('keeps a string id set before a later scalar parameter', () => {
        const o = obj(1, 2, 40);
        const list = { objects: [o], warnings: [] };
        setNamedParam(list, o, markerFields, 'Journal Entry', 0x6002);
        setNamedParam(list, o, markerFields, 'Map Text', 0x6003);
        setNamedParam(list, o, markerFields, 'Map X Coordinate', 98);
        setNamedParam(list, o, markerFields, 'Type', 1);
        const value = (name: string) => o.data[o.params.findIndex((p) => p.name === name)];
        // Before the fix the scalar rewrite turned both ids into empty inline strings (length 1, word 0).
        expect(value('Journal Entry')).toBe(0x6002);
        expect(value('Map Text')).toBe(0x6003);
        expect(value('Map X Coordinate')).toBe(98);
        expect(value('Type')).toBe(1);
        expect(o.data).toHaveLength(4);
    });

    it('clones one record per marker name, shares it for the same name and leaves generic markers on one record', () => {
        const pc = [
            { db: 1, id: 1, cls: pcMarker(1, 'Find Rimril', 5) },
            { db: 1, id: 2, cls: pcMarker(2, 'Succ Lair', 0) },
            { db: 3, id: 7, cls: pcMarker(7, 'Find Rimril', 5) },
            { db: 1, id: 3, cls: pcMarker(3, 'Map Trigger', 0) },
            { db: 1, id: 4, cls: pcMarker(4, 'Map Object', 0) },
        ];
        const plan = planClassMapping(pc, [systemOdb()]);
        const ids = pc.map((p) => plan.resolve(p.db, p.id)?.classId);
        expect(new Set(ids).size).toBe(3);
        expect(ids[0]).toBe(ids[2]);
        expect(ids[0]).not.toBe(ids[1]);
        expect(ids[3]).toBe(ids[4]);
    });

    it('writes the journal text, type and SubQuest of each marker into its own class record', () => {
        const pcCls = new Map<number, OdbClass>([
            [1, pcMarker(1, 'Find Rimril', 5)],
            [2, pcMarker(2, 'Succ Lair', 0)],
        ]);
        const plan = planClassMapping(
            [...pcCls].map(([id, cls]) => ({ db: 1, id, cls })),
            [systemOdb()],
        );
        const a = plan.resolve(1, 1)!;
        const b = plan.resolve(1, 2)!;
        const pc = {
            path: 'Islands World/Succubus Lair/Succubus Lair.lvl',
            list: { objects: [obj(10, 1, 1), obj(11, 1, 2)], warnings: [] },
            classes: new Map([[1, pcCls]]),
        } as unknown as PcLevel;
        const list = { objects: [obj(10, a.dbIndex, a.classId), obj(11, b.dbIndex, b.classId)], warnings: [] };
        const texts = new Map<string, number>();
        const warnings: string[] = [];
        const rep = applyPuzzleLogic({
            pc,
            list,
            title: 'test',
            classOf: (o) => plan.synthesized.find((s) => s.classId === o.classId)?.cls,
            textId: (_o, text) => texts.get(text) ?? texts.set(text, 0x6000 + texts.size).get(text)!,
            setClassDefaults: (o, values) => {
                const s = plan.synthesized.find((x) => x.classId === o.classId)!;
                warnings.push(...setSynthesizedDefaults(s, values));
            },
            warnings,
        });
        expect(rep.markers).toBe(2);
        expect(warnings).toEqual([]);
        const rec = (classId: number) => recordData(plan.synthesized.find((s) => s.classId === classId)!.record);
        // Quest: Type 1, primary (SubQuest? 0), journal text = its own id, no map text. Template id 8 is gone.
        expect(rec(a.classId).slice(0, 4)).toEqual([1, 0, texts.get('Find Rimril'), 0]);
        // Place label: Type 0, map text only.
        expect(rec(b.classId).slice(0, 4)).toEqual([0, 0, 0, texts.get('Succ Lair')]);
        expect(rec(a.classId)[5]).toBe(40); // map x 100 * 0.4
        expect(plan.synthesized.find((s) => s.classId === a.classId)!.cls.data![2]).toBe(texts.get('Find Rimril'));
    });

    it('keeps the first text when one class gets two different ones', () => {
        const plan = planClassMapping([{ db: 1, id: 1, cls: pcMarker(1, 'Find Rimril', 5) }], [systemOdb()]);
        const s = plan.synthesized[0]!;
        expect(
            setSynthesizedDefaults(s, [
                ['Journal Entry', 0x6000],
                ['Map X Coordinate', 3],
            ]),
        ).toEqual([]);
        const conflicts = setSynthesizedDefaults(s, [
            ['Journal Entry', 0x6001],
            ['Map X Coordinate', 9],
        ]);
        expect(conflicts).toHaveLength(1);
        expect(recordData(s.record)[2]).toBe(0x6000);
    });
});
