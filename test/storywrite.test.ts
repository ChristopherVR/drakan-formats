// Story content writers: XDB strings, ODB class records, quest drafts and quest placements (synthetic data only).
import { describe, expect, it } from 'vitest';
import {
    FIELD_INT,
    FIELD_STRING,
    SrscReader,
    appendFieldList,
    cp1252Byte,
    classStringRefs,
    decodeXdbSlots,
    diffXdbStrings,
    draftEdits,
    editQuestRecord,
    encodeFieldList,
    encodeXdbString,
    freeClassId,
    joinClassRecord,
    nameAreaSize,
    nextStringId,
    parseClassBody,
    parseFieldLists,
    patchClassData,
    questPlacements,
    renameClassRecord,
    splitClassRecord,
    xdbTextProblem,
    type ClassFieldDef,
    type LvlHeader,
    type LvlObject,
    type OdbClass,
    type XdbString,
} from '../src/index.ts';

const QUEST_DEFS: ClassFieldDef[] = [
    { type: 7, name: 'Type' },
    { type: 7, name: 'SubQuest?' },
    { type: FIELD_STRING, name: 'Journal Entry' },
    { type: FIELD_STRING, name: 'Map Text' },
    { type: 5, name: 'New Quest Sound' },
    { type: FIELD_INT, name: 'Map X Coordinate' },
    { type: FIELD_INT, name: 'Map Y Coordinate' },
];

/** A class record without a model: name area, 22 header bytes, field count, dword count, data. */
function questRecord(name: string, data: number[]): Uint8Array {
    const body = new Uint8Array(30 + data.length * 4);
    const dv = new DataView(body.buffer);
    dv.setUint16(16, 0x1234, true);
    dv.setUint32(22, data.length, true);
    dv.setUint32(26, data.length, true);
    data.forEach((v, i) => dv.setUint32(30 + i * 4, v, true));
    return joinClassRecord(name, body);
}

describe('xdb writing', () => {
    it('encodes Windows-1252 text and round trips the eight slots', () => {
        const s: XdbString = { id: 5, sub: 2, text: ['Crème Œuvre – ok', 'a', '', '', '', '', '', ''] };
        const enc = encodeXdbString(s);
        expect(decodeXdbSlots(enc)).toEqual(s.text);
        expect(enc.length % 4).toBe(0);
        expect(cp1252Byte('Œ')).toBe(0x8c);
        expect(cp1252Byte('中')).toBe(-1);
        expect(xdbTextProblem('plain')).toBeNull();
        expect(xdbTextProblem('中')).toMatch(/Windows-1252/);
        expect(() => encodeXdbString({ id: 1, sub: 0, text: ['中'] })).toThrow();
    });

    it('diffs changed and new strings, keeping the original sub of a replacement', () => {
        const a = new Map<number, XdbString>([
            [1, { id: 1, sub: 7, text: ['one', '', '', '', '', '', '', ''] }],
            [2, { id: 2, sub: 7, text: ['two', '', '', '', '', '', '', ''] }],
        ]);
        const b = new Map(a);
        b.set(2, { id: 2, sub: 9, text: ['TWO', '', '', '', '', '', '', ''] });
        b.set(3, { id: 3, sub: 7, text: ['three', '', '', '', '', '', '', ''] });
        const d = diffXdbStrings(a, b);
        expect(d.map((p) => [p.id, p.sub, p.isNew])).toEqual([
            [2, 7, false],
            [3, 7, true],
        ]);
        expect(decodeXdbSlots(d[0]!.data)[0]).toBe('TWO');
        expect(nextStringId(b)).toBe(4);
        expect(diffXdbStrings(a, a)).toEqual([]);
    });

    it('collects string references of class defaults and skips id 0 and arrays', () => {
        const c: OdbClass = {
            id: 9,
            name: 'Thing',
            group: 1,
            runtimeClass: null,
            fields: [
                { type: FIELD_STRING, name: 'DisplayName' },
                { type: FIELD_STRING, name: 'Other' },
                { type: FIELD_STRING | 0x1000, name: 'List' },
            ],
            data: [11, 0, 12],
        };
        const refs = classStringRefs('RESOURES', [c]);
        expect([...refs.keys()]).toEqual([11]);
        expect(refs.get(11)![0]).toMatchObject({ odb: 'RESOURES', classId: 9, field: 'DisplayName' });
    });
});

describe('odb class record writing', () => {
    it('sizes the name area like the disc (2 + n is a multiple of 4)', () => {
        expect([0, 1, 2, 3, 4, 5, 6].map(nameAreaSize)).toEqual([2, 2, 2, 6, 6, 6, 6]);
        expect(nameAreaSize(16)).toBe(18);
        expect(nameAreaSize(19)).toBe(22);
        expect(nameAreaSize(26)).toBe(26);
    });

    it('renames and patches dwords without touching the rest', () => {
        const rec = questRecord('Old Name', [1, 0, 22, 0, 5, 100, 200]);
        const renamed = renameClassRecord(rec, 'A longer developer name');
        expect(splitClassRecord(renamed).name).toBe('A longer developer name');
        expect(parseClassBody(splitClassRecord(renamed).body)!.data).toEqual([1, 0, 22, 0, 5, 100, 200]);
        const p = patchClassData(rec, new Map([[2, 99]]));
        expect(parseClassBody(splitClassRecord(p).body)!.data).toEqual([1, 0, 99, 0, 5, 100, 200]);
        expect(() => patchClassData(rec, new Map([[7, 1]]))).toThrow(/no data dword/);
        expect(() => patchClassData(new Uint8Array([4, 0, 65, 0, 0, 0]), new Map())).toThrow();
    });

    it('round trips a field list and appends one to a zlib stored entry', async () => {
        const raw = new Uint8Array([...encodeFieldList(QUEST_DEFS), ...encodeFieldList(QUEST_DEFS.slice(0, 2))]);
        const lists = parseFieldLists(raw)!;
        expect(lists.length).toBe(2);
        expect(lists[0]).toEqual(QUEST_DEFS);
        // stored form: zlib via the platform codec
        const cs = new CompressionStream('deflate');
        const w = cs.writable.getWriter();
        void w.write(raw as Uint8Array<ArrayBuffer>).then(() => w.close());
        const stored = new Uint8Array(await new Response(cs.readable).arrayBuffer());
        const appended = await appendFieldList(stored, QUEST_DEFS.slice(2));
        const ds = new DecompressionStream('deflate');
        const w2 = ds.writable.getWriter();
        void w2.write(appended as Uint8Array<ArrayBuffer>).then(() => w2.close());
        const back = parseFieldLists(new Uint8Array(await new Response(ds.readable).arrayBuffer()))!;
        expect(back.length).toBe(3);
        expect(back[2]).toEqual(QUEST_DEFS.slice(2));
    });
});

describe('quest drafts', () => {
    const draft = { kind: 'both' as const, optional: true, journalId: 30, mapTextId: 31, mapX: 12.4, mapY: 99 };

    it('maps a draft onto the class fields', () => {
        const e = draftEdits(QUEST_DEFS, draft);
        expect([...e]).toEqual([
            [0, 2],
            [1, 1],
            [2, 30],
            [3, 31],
            [5, 12],
            [6, 99],
        ]);
        expect(() => draftEdits(QUEST_DEFS.slice(1), draft)).toThrow(/Type/);
    });

    it('edits a record in place and renames it', () => {
        const rec = questRecord('Quest A', [0, 0, 22, 0, 5, 1, 2]);
        const out = editQuestRecord(rec, QUEST_DEFS, draft, 'Quest B');
        const parsed = parseClassBody(splitClassRecord(out).body)!;
        expect(parsed.data).toEqual([2, 1, 30, 31, 5, 12, 99]);
        expect(splitClassRecord(out).name).toBe('Quest B');
    });

    it('chooses a free class id inside the used range', () => {
        expect(freeClassId(new Set([1, 4000, 4001, 4003]), 4000)).toBe(4002);
        expect(freeClassId(new Set([1, 2, 3, 4000]), 4000)).toBe(4); // below the preferred start, still inside the range
        expect(freeClassId(new Set([4000]), 4000)).toBe(1);
        expect(freeClassId(new Set([1]), 4000)).toBeNull(); // nothing free below the maximum
    });
});

describe('quest placements', () => {
    const header = {
        dependencies: [
            { dbIndex: 2, zero: 0, path: { raw: new Uint8Array(), text: '..\\..\\Common\\System\\System' } },
            { dbIndex: 7, zero: 0, path: { raw: new Uint8Array(), text: '..\\Level 1 - Common\\Level 1 - Common' } },
        ],
    } as unknown as LvlHeader;
    const obj = (
        id: number,
        classId: number,
        dbIndex: number,
        links: number[],
        over: Partial<LvlObject> = {},
    ): LvlObject =>
        ({ id, classId, dbIndex, pos: [id, 0, 0], links, params: [], data: [], ...over }) as unknown as LvlObject;

    it('lists quest objects with the roles of what links to them', () => {
        const trigger: OdbClass = {
            id: 128,
            name: 'Timer',
            group: 1,
            runtimeClass: null,
            fields: [{ type: FIELD_INT, name: 'Trigger Message' }],
            data: [1],
        };
        const giver: OdbClass = {
            id: 445,
            name: 'Quest Giver',
            group: 1,
            runtimeClass: null,
            fields: [
                { type: FIELD_INT, name: 'Message to send after Beginning dialog' },
                { type: FIELD_INT, name: 'Message to send after Complete dialog' },
            ],
            data: [1, 18],
        };
        const odbs = new Map([
            [
                'LEVEL1ON',
                new Map([
                    [128, trigger],
                    [445, giver],
                ]),
            ],
        ]);
        const list = {
            objects: [
                obj(10, 4150, 2, []),
                obj(11, 128, 7, [10]),
                obj(12, 128, 7, [10], {
                    params: [{ fieldIndex: 0, type: FIELD_INT, nameRaw: new Uint8Array(), name: 'Trigger Message' }],
                    data: [18],
                }),
                obj(13, 445, 7, [10]),
                obj(14, 4150, 7, []), // same class id but another database: not a quest object
            ],
            warnings: [],
        };
        // resolve db 7 -> LEVEL1ON through the dependency path
        header.dependencies[1]!.path.text = '..\\Level 1 - Common\\LEVEL1ON';
        const m = questPlacements(header, list, odbs, new Set([4150]));
        const pl = m.get(4150)!;
        expect(pl.length).toBe(1);
        expect(pl[0]!.objectId).toBe(10);
        expect(pl[0]!.sources.map((s) => [s.id, s.role, s.message])).toEqual([
            [11, 'start', 1],
            [12, 'complete', 18],
            [13, 'giver', null],
        ]);
        expect(pl[0]!.sources[2]!.giverMessages.map((g) => g.value)).toEqual([1, 18]);
    });
});

describe('srsc patch sanity', () => {
    it('keeps SrscReader importable alongside the writers', () => {
        expect(typeof SrscReader.open).toBe('function');
    });
});

describe('setClassArray / handler phases / new dialog lines (synthetic)', () => {
    // fields: 0 array (base 5, FIELD_ARRAY), 1 scalar; data: [word0, 7, off=2 len=2 -> 100, 200]
    const defs: ClassFieldDef[] = [
        { type: 0x1005, name: 'Beginning Dialog Exchange' },
        { type: 7, name: 'Other' },
    ];
    const rec = (): Uint8Array => questRecord('Handler', [(2 << 16) | 2, 7, 100, 200]);
    it('replaces an array with a different length and keeps the rest', async () => {
        const { setClassArray, handlerPhaseRecord } = await import('../src/index.ts');
        const grown = setClassArray(rec(), 0, [1, 2, 3]);
        const b = parseClassBody(splitClassRecord(grown).body)!;
        expect(b.data.length).toBe(7);
        expect(b.data[1]).toBe(7);
        expect(b.data[0]! >>> 16).toBe(3);
        const off = b.data[0]! & 0xffff;
        expect(b.data.slice(off, off + 3)).toEqual([1, 2, 3]);
        const viaPhase = handlerPhaseRecord(rec(), defs, 'beginning', []);
        expect(parseClassBody(splitClassRecord(viaPhase).body)!.data[0]! >>> 16).toBe(0);
        expect(() => handlerPhaseRecord(rec(), defs, 'done', [1])).toThrow();
    });
});
