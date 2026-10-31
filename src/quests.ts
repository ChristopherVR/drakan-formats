// Quest and map marker classes of the shared System object database, and the journal text that goes with them.
//
// A save keeps a table of the quests and map markers the player has discovered (type 0x401 id 893, see `listQuests`).
// Row +0x18 is the class id of an ODB class in System.ODB (group 0xbee "Maps" and its chapter groups); the class carries
//   Type        0 map marker, 1 journal entry, 2 both          (game reads it at 0x3937c8)
//   SubQuest?   1 = listed under "Optional Quests"             (0x393868)
//   Journal Entry / Map Text   string ids in System.XDB (the objective sentence / the place name)
//   Map X / Y   position on the chapter map
// Evidence: docs/reference/save-editor.md "Quests and journal".

import { latin1, view } from './bytes.ts';
import { parseOdbClasses } from './odb.ts';
import type { SrscReader } from './srsc.ts';
import { FIELD_STRING, fieldBase } from './fields.ts';
import { xdbText, type XdbStrings } from './xdb.ts';
import type { QuestRow } from './save.ts';

export type QuestKind = 'map' | 'journal' | 'both';

export interface QuestClass {
    classId: number;
    /** The developer's class name (`Hermit Quest Journal`); not shown in game. */
    name: string;
    kind: QuestKind;
    optional: boolean;
    /** System.XDB string id of the objective text, 0 when none. */
    journalId: number;
    /** System.XDB string id of the place name, 0 when none. */
    mapTextId: number;
    mapX: number;
    mapY: number;
    /** ODB group id (`0xbef` = chapter 1) and its name (`1 - Surdana`). */
    groupId: number;
    groupName: string;
    /** Chapter number from the group name (1 to 8), 0 when the group has none. */
    chapter: number;
    /** Chapter label (`Surdana`; `Kragmor` for the 1B sub group). */
    chapterName: string;
}

const KIND_OF_TYPE: QuestKind[] = ['map', 'journal', 'both'];

/** ODB group records (type 0x101): id = group id, sub = parent group id, body = `u16 length + name`. */
export async function parseOdbGroups(odb: SrscReader): Promise<Map<number, { name: string; parent: number }>> {
    const out = new Map<number, { name: string; parent: number }>();
    for (const e of odb.entries) {
        if (e.type !== 0x0101) continue;
        const p = await odb.readRaw(e);
        if (p.length < 2) continue;
        const n = view(p).getUint16(0, true);
        const z = p.indexOf(0, 2);
        out.set(e.id, { name: latin1(p, 2, Math.min(2 + n, z < 0 ? p.length : z)), parent: e.sub });
    }
    return out;
}

/** `1 - Surdana` -> {1, Surdana}; `1B - Kragmor` -> {1, Kragmor}; anything else -> {0, name}. */
export function chapterOfGroup(name: string): { chapter: number; label: string } {
    const m = /^\s*(\d+)[A-Za-z]?\s*-\s*(.+?)\s*$/.exec(name);
    return m ? { chapter: Number(m[1]), label: m[2]! } : { chapter: 0, label: name.trim() };
}

/** All quest / map marker classes of a System ODB, keyed by class id. */
export async function parseQuestClasses(odb: SrscReader): Promise<Map<number, QuestClass>> {
    const classes = await parseOdbClasses(odb);
    const groups = await parseOdbGroups(odb);
    const out = new Map<number, QuestClass>();
    for (const c of classes.values()) {
        const defs = c.fields;
        const data = c.data;
        if (!defs || !data) continue;
        const at = (name: string): number => defs.findIndex((f) => f.name === name);
        const iType = at('Type');
        const iJournal = at('Journal Entry');
        const iMap = at('Map Text');
        if (iType < 0 || iJournal < 0 || iMap < 0) continue;
        if (fieldBase(defs[iJournal]!.type) !== FIELD_STRING) continue;
        const type = data[iType]!;
        const g = groups.get(c.group);
        const ch = chapterOfGroup(g?.name ?? '');
        const num = (name: string): number => {
            const i = at(name);
            return i < 0 ? 0 : data[i]!;
        };
        out.set(c.id, {
            classId: c.id,
            name: c.name,
            kind: KIND_OF_TYPE[type] ?? 'map',
            optional: num('SubQuest?') !== 0,
            // The dword is the string id itself (not an offset/length pair as in level object parameters).
            journalId: data[iJournal]! & 0xffff,
            mapTextId: data[iMap]! & 0xffff,
            mapX: num('Map X Coordinate'),
            mapY: num('Map Y Coordinate'),
            groupId: c.group,
            groupName: g?.name ?? '',
            chapter: ch.chapter,
            chapterName: ch.label,
        });
    }
    return out;
}

export type QuestState = 'notStarted' | 'active' | 'done' | 'discovered' | 'unknown';

/** Row words with a meaning (docs/reference/save-editor.md): +0x0c done flag, +0x10 enabled, +0x1c seen flags. */
export const QUEST_SEEN_JOURNAL = 2;
export const QUEST_SEEN_MAP = 4;

export interface QuestEntry {
    /** Save row index, or -1 for a class the save has no row for ("not started"). */
    row: number;
    classId: number;
    cls: QuestClass | null;
    /** Objective sentence (journal entries) or place name (map markers). */
    title: string;
    /** Place name of a journal entry that also has a map marker, else empty. */
    place: string;
    state: QuestState;
    /** Journal or map page not opened since the row appeared (the game's "new" marker). */
    unseen: boolean;
    chapter: number;
    chapterName: string;
    raw?: QuestRow;
}

/** Low 16 bits of a row's quest id: the high half is the in-memory database index and varies between levels. */
export const questClassId = (row: QuestRow): number => row.questId & 0xffff;

/** Whether the row is a finished objective (the done flag at row +0x0c; the journal draws another icon for it). */
export const questDone = (row: QuestRow): boolean => row.icon !== 0;

function entryFor(cls: QuestClass | null, row: QuestRow | null, strings: XdbStrings, slot: number): QuestEntry {
    const journal = cls && cls.journalId ? xdbText(strings, cls.journalId, slot) : '';
    const map = cls && cls.mapTextId ? xdbText(strings, cls.mapTextId, slot) : '';
    const isJournal = cls ? cls.kind !== 'map' : false;
    let state: QuestState;
    if (!row) state = 'notStarted';
    else if (!cls) state = 'unknown';
    else if (isJournal) state = questDone(row) ? 'done' : 'active';
    else state = 'discovered';
    // The journal page marks journal rows (state bit 2) and the map page marks map rows (bit 4) when they are drawn.
    const unseen =
        !!row && !!cls && row.enabled !== 0 && !(row.state & (isJournal ? QUEST_SEEN_JOURNAL : QUEST_SEEN_MAP));
    return {
        row: row ? row.index : -1,
        classId: cls ? cls.classId : row ? questClassId(row) : 0,
        cls,
        title: isJournal ? journal || map || cls!.name : map || cls?.name || '',
        place: isJournal ? map : '',
        state,
        unseen,
        chapter: cls?.chapter ?? 0,
        chapterName: cls?.chapterName ?? '',
        raw: row ?? undefined,
    };
}

/** One entry per save row, in row order. */
export function describeQuestRows(
    rows: readonly QuestRow[],
    classes: ReadonlyMap<number, QuestClass>,
    strings: XdbStrings,
    slot = 0,
): QuestEntry[] {
    return rows.map((r) => entryFor(classes.get(questClassId(r)) ?? null, r, strings, slot));
}

/** Journal entries of the catalog that the save has no row for (still to be discovered), each sentence once. */
export function notStartedQuests(
    rows: readonly QuestRow[],
    classes: ReadonlyMap<number, QuestClass>,
    strings: XdbStrings,
    slot = 0,
): QuestEntry[] {
    const have = new Set(rows.map(questClassId));
    // Several classes share one sentence (the same objective in two chapters): list each sentence once, and not at all
    // when the save already has it.
    const texts = new Set<number>();
    for (const r of rows) {
        const c = classes.get(questClassId(r));
        if (c?.journalId) texts.add(c.journalId);
    }
    const out: QuestEntry[] = [];
    for (const c of [...classes.values()].sort((a, b) => a.classId - b.classId)) {
        if (c.kind === 'map' || have.has(c.classId)) continue;
        if (!c.journalId || !xdbText(strings, c.journalId, slot)) continue;
        if (texts.has(c.journalId)) continue;
        texts.add(c.journalId);
        out.push(entryFor(c, null, strings, slot));
    }
    return out;
}

export type QuestChange = 'same' | 'changed' | 'onlyA' | 'onlyB';

export interface QuestDiffRow {
    classId: number;
    a: QuestRow | null;
    b: QuestRow | null;
    change: QuestChange;
    /** What differs, for a changed row: `done`, `enabled`, `seen`, `region`. */
    what: string[];
}

/** Rows of two saves matched by class id (and occurrence order); order follows A, then the rows only B has. */
export function diffQuests(a: readonly QuestRow[], b: readonly QuestRow[]): QuestDiffRow[] {
    const byClass = new Map<number, QuestRow[]>();
    for (const r of b) {
        const k = questClassId(r);
        const list = byClass.get(k);
        if (list) list.push(r);
        else byClass.set(k, [r]);
    }
    const seen = new Map<number, number>();
    const used = new Set<QuestRow>();
    const out: QuestDiffRow[] = [];
    for (const ra of a) {
        const k = questClassId(ra);
        const n = seen.get(k) ?? 0;
        seen.set(k, n + 1);
        const rb = byClass.get(k)?.[n] ?? null;
        if (!rb) {
            out.push({ classId: k, a: ra, b: null, change: 'onlyA', what: [] });
            continue;
        }
        used.add(rb);
        const what: string[] = [];
        if (questDone(ra) !== questDone(rb)) what.push('done');
        if (ra.enabled !== rb.enabled) what.push('enabled');
        if (ra.state !== rb.state) what.push('seen');
        if (ra.region !== rb.region) what.push('region');
        out.push({ classId: k, a: ra, b: rb, change: what.length ? 'changed' : 'same', what });
    }
    for (const rb of b)
        if (!used.has(rb)) out.push({ classId: questClassId(rb), a: null, b: rb, change: 'onlyB', what: [] });
    return out;
}
