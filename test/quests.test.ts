// Synthetic quest classes, string tables and rows only; no game bytes.
import { zlibSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import {
    SrscReader,
    chapterOfGroup,
    decodeXdbSlots,
    describeQuestRows,
    diffQuests,
    encodeXdbSlots,
    languageSlot,
    notStartedQuests,
    parseOdbGroups,
    parseQuestClasses,
    parseXdbNames,
    parseXdbStrings,
    xdbText,
    type QuestRow,
} from '../src/index.ts';
import { buildSrsc } from './fixtures.ts';

const u16 = (n: number): number[] => [n & 255, (n >> 8) & 255];
const u32 = (n: number): number[] => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];
const str = (s: string): number[] => {
    const raw = [...s].map((c) => c.charCodeAt(0));
    raw.push(0);
    if (raw.length % 2) raw.push(0);
    return [...u16(raw.length), ...raw];
};
const defs = (d: [number, string][]): number[] => [...u32(d.length), ...d.flatMap(([t, n]) => [...u32(t), ...str(n)])];

function plainClass(name: string, group: number, data: number[], fieldCount: number): Uint8Array {
    return Uint8Array.from([
        ...str(name),
        ...u16(group),
        ...u16(0),
        ...u16(0),
        ...new Array<number>(10).fill(0),
        ...u16(28),
        ...u16(1),
        ...u16(3),
        ...u32(fieldCount),
        ...u32(data.length),
        ...data.flatMap(u32),
    ]);
}

const QUEST_DEFS: [number, string][] = [
    [7, 'Type'],
    [7, 'SubQuest?'],
    [0x0a, 'Journal Entry'],
    [0x0a, 'Map Text'],
    [5, 'New Quest Sound'],
    [0x0f, 'Indicator Color'],
    [1, 'Map X Coordinate'],
    [1, 'Map Y Coordinate'],
];

// type, optional, journal id, map text id, sound, colour, x, y
const classData = (type: number, optional: number, journal: number, map: number, x = 0, y = 0): number[] => [
    type,
    optional,
    journal,
    map,
    0,
    65280,
    x,
    y,
];

async function systemOdb(): Promise<SrscReader> {
    const blob = Uint8Array.from([
        ...defs(QUEST_DEFS),
        ...defs(QUEST_DEFS),
        ...defs(QUEST_DEFS),
        ...defs([[1, 'Only']]),
    ]);
    const bytes = buildSrsc([
        { type: 0x0101, id: 0xbef, sub: 0xbee, data: Uint8Array.from(str('1 - Surdana')) },
        { type: 0x0101, id: 0xbf0, sub: 0xbee, data: Uint8Array.from(str('2 - Shadowmire')) },
        {
            type: 0x0102,
            id: 0x1041,
            sub: 0xbef,
            data: plainClass('Jade Icon', 0xbef, classData(0, 0, 0, 16, 124, 112), 8),
        },
        { type: 0x0102, id: 0x1047, sub: 0xbef, data: plainClass('Speak', 0xbef, classData(1, 0, 22, 0), 8) },
        { type: 0x0102, id: 0x1051, sub: 0xbf0, data: plainClass('Rune', 0xbf0, classData(2, 1, 32, 33, 5, 6), 8) },
        { type: 0x0102, id: 0x2000, sub: 1, data: plainClass('Not a quest', 1, [9], 1) },
        { type: 0x0103, id: 0, sub: 0, data: zlibSync(blob) },
    ]);
    return SrscReader.fromBytes(bytes);
}

function xdb(): Uint8Array {
    return buildSrsc([
        { type: 0x0500, id: 0, sub: 1, data: Uint8Array.from([0, 1, 0, 1, 4, 0, 7, 0]) },
        { type: 0x0330, id: 4, sub: 0, data: Uint8Array.from(str('Level 1 - Quests')) },
        { type: 0x0400, id: 16, sub: 11, data: encodeXdbSlots(["Jade's Magic Emporium", 'Jades Magierhaus']) },
        {
            type: 0x0400,
            id: 22,
            sub: 4,
            data: encodeXdbSlots(['Find Lady\r\nMyschala.', '', 'Trouver Lady Myschala.']),
        },
        { type: 0x0400, id: 32, sub: 4, data: encodeXdbSlots(['Retrieve the Rune.', 'Hole die Rune.']) },
        { type: 0x0400, id: 33, sub: 4, data: encodeXdbSlots(['Tree of Mourning']) },
    ]);
}

const row = (index: number, questId: number, state: number, icon = 0, enabled = 1): QuestRow => ({
    index,
    x: 0,
    y: 0,
    icon,
    enabled,
    region: 0,
    questId,
    state,
});

describe('XDB strings', () => {
    it('round-trips the eight slots and keeps 4-byte alignment', () => {
        const body = encodeXdbSlots(['Hello', 'Gr\xfc\xdfe', '']);
        expect(body.length % 4).toBe(0);
        const slots = decodeXdbSlots(body);
        expect(slots).toHaveLength(8);
        expect(slots.slice(0, 3)).toEqual(['Hello', 'Gr\xfc\xdfe', '']);
    });

    it('reads ids, group names and picks the language slot with an English fallback', async () => {
        const r = await SrscReader.fromBytes(xdb());
        const strings = await parseXdbStrings(r);
        expect(strings.size).toBe(4);
        expect(xdbText(strings, 22, 0)).toBe('Find Lady Myschala.');
        expect(xdbText(strings, 22, 2)).toBe('Trouver Lady Myschala.');
        expect(xdbText(strings, 22, 1)).toBe('Find Lady Myschala.');
        expect(xdbText(strings, 999)).toBe('');
        expect((await parseXdbNames(r)).get(4)).toBe('Level 1 - Quests');
        expect(languageSlot('FRENCH')).toBe(2);
        expect(languageSlot('klingon')).toBe(0);
    });

    it('tolerates a truncated body', () => {
        expect(decodeXdbSlots(Uint8Array.from([2, 0, 0x41]))).toHaveLength(8);
    });
});

describe('quest classes', () => {
    it('reads group names and chapter labels', async () => {
        const groups = await parseOdbGroups(await systemOdb());
        expect(groups.get(0xbef)).toEqual({ name: '1 - Surdana', parent: 0xbee });
        expect(chapterOfGroup('1B - Kragmor')).toEqual({ chapter: 1, label: 'Kragmor' });
        expect(chapterOfGroup('Maps')).toEqual({ chapter: 0, label: 'Maps' });
    });

    it('finds only classes with the quest fields and decodes them', async () => {
        const classes = await parseQuestClasses(await systemOdb());
        expect([...classes.keys()].sort()).toEqual([0x1041, 0x1047, 0x1051]);
        expect(classes.get(0x1041)).toMatchObject({ kind: 'map', mapTextId: 16, mapX: 124, mapY: 112, chapter: 1 });
        expect(classes.get(0x1047)).toMatchObject({ kind: 'journal', journalId: 22, optional: false });
        expect(classes.get(0x1051)).toMatchObject({
            kind: 'both',
            optional: true,
            chapter: 2,
            chapterName: 'Shadowmire',
        });
    });

    it('describes save rows: state, titles, unseen marker, unknown classes', async () => {
        const classes = await parseQuestClasses(await systemOdb());
        const strings = await parseXdbStrings(await SrscReader.fromBytes(xdb()));
        const rows = [
            row(0, 0x1041, 4), // map marker, seen on the map
            row(1, 0x1047, 0), // journal, not seen yet
            row(2, 0x1051, 6, 1), // both, seen, done flag set
            row(3, 0x21047, 2), // database index in the high half is ignored
            row(4, 0x9999, 0), // class missing from the catalog
        ];
        const e = describeQuestRows(rows, classes, strings, 0);
        expect(e.map((x) => x.state)).toEqual(['discovered', 'active', 'done', 'active', 'unknown']);
        expect(e.map((x) => x.unseen)).toEqual([false, true, false, false, false]);
        expect(e[0]!.title).toBe("Jade's Magic Emporium");
        expect(e[1]!.title).toBe('Find Lady Myschala.');
        expect(e[2]).toMatchObject({ title: 'Retrieve the Rune.', place: 'Tree of Mourning', chapter: 2 });
        expect(describeQuestRows([rows[1]!], classes, strings, 2)[0]!.title).toBe('Trouver Lady Myschala.');
    });

    it('lists journal quests the save has no row for, not map markers', async () => {
        const classes = await parseQuestClasses(await systemOdb());
        const strings = await parseXdbStrings(await SrscReader.fromBytes(xdb()));
        const todo = notStartedQuests([row(0, 0x1047, 2)], classes, strings);
        expect(todo.map((x) => x.classId)).toEqual([0x1051]);
        expect(todo[0]!.state).toBe('notStarted');
        expect(todo[0]!.row).toBe(-1);
    });
});

describe('quest diff', () => {
    it('matches rows by class id and names what changed', () => {
        const a = [row(0, 0x1047, 2), row(1, 0x1044, 0), row(2, 0x1041, 4)];
        const b = [row(0, 0x21047, 2, 1), row(1, 0x1041, 4), row(2, 0x1051, 0)];
        const d = diffQuests(a, b);
        expect(d.map((x) => [x.classId, x.change, x.what])).toEqual([
            [0x1047, 'changed', ['done']],
            [0x1044, 'onlyA', []],
            [0x1041, 'same', []],
            [0x1051, 'onlyB', []],
        ]);
        expect(diffQuests([row(0, 0x1047, 0)], [row(0, 0x1047, 6)])[0]!.what).toEqual(['seen']);
    });
});
