// Quest class editing and "where is this quest used". Reading is quests.ts; the byte layout is ODB class records
// (odbwrite.ts). Evidence: docs/journal/2026-10-31/story-editing.md ("Quests").
//
// Proven on the PAL disc: the 90 quest classes of System.ODB carry fields Type, SubQuest?, Journal Entry, Map Text, New
// Quest Sound, Indicator Color, Map X/Y Coordinate; a quest class placed in a level (db index of System.ODB) is a quest
// object; level objects link to it (trigger detectors, class 128 timers, quest givers class 445).
// Inferred (not decoded in the engine): link message 1 starts and 18 completes a quest. Both values occur on the "Trigger
// Message" of class 128 / Trigger Detector and on the "Message to send after ... dialog" fields of class 445; 18 pairs with
// the completion dialogs.

import { FIELD_STRING, decodeFieldValue, fieldBase, type ClassFieldDef } from './fields.ts';
import { dependencyPath, type LvlHeader, type LvlObject, type LvlObjectList } from './lvl.ts';
import { odbStemForDependency, type OdbClass, type OdbIndex } from './odb.ts';
import { fieldIndex, patchClassData, renameClassRecord } from './odbwrite.ts';
import type { QuestClass, QuestKind } from './quests.ts';

const TYPE_OF_KIND: Record<QuestKind, number> = { map: 0, journal: 1, both: 2 };

/** The editable part of a quest class (everything the Quests panel exposes). */
export interface QuestDraft {
    kind: QuestKind;
    optional: boolean;
    journalId: number;
    mapTextId: number;
    mapX: number;
    mapY: number;
}

export const draftOf = (c: QuestClass): QuestDraft => ({
    kind: c.kind,
    optional: c.optional,
    journalId: c.journalId,
    mapTextId: c.mapTextId,
    mapX: c.mapX,
    mapY: c.mapY,
});

export const sameDraft = (a: QuestDraft, b: QuestDraft): boolean =>
    a.kind === b.kind &&
    a.optional === b.optional &&
    a.journalId === b.journalId &&
    a.mapTextId === b.mapTextId &&
    a.mapX === b.mapX &&
    a.mapY === b.mapY;

/** Dword edits of a draft for a class with these field definitions; throws when a quest field is missing. */
export function draftEdits(defs: readonly ClassFieldDef[], d: QuestDraft): Map<number, number> {
    const need = (name: string): number => {
        const i = fieldIndex(defs, name);
        if (i < 0) throw new Error(`quest class has no field '${name}'`);
        return i;
    };
    const iJournal = need('Journal Entry');
    const iMap = need('Map Text');
    if (fieldBase(defs[iJournal]!.type) !== FIELD_STRING) throw new Error('Journal Entry is not a string field');
    return new Map([
        [need('Type'), TYPE_OF_KIND[d.kind]],
        [need('SubQuest?'), d.optional ? 1 : 0],
        [iJournal, d.journalId & 0xffff],
        [iMap, d.mapTextId & 0xffff],
        [need('Map X Coordinate'), Math.max(0, Math.round(d.mapX))],
        [need('Map Y Coordinate'), Math.max(0, Math.round(d.mapY))],
    ]);
}

/** New record bytes for an edited quest class (same name unless `rename` is given). */
export function editQuestRecord(
    record: Uint8Array,
    defs: readonly ClassFieldDef[],
    d: QuestDraft,
    rename?: string,
): Uint8Array {
    const patched = patchClassData(record, draftEdits(defs, d));
    return rename ? renameClassRecord(patched, rename) : patched;
}

/** A free class id inside the ODB's existing id range (ids above the file's maximum did not spawn, modding.md). */
export function freeClassId(used: ReadonlySet<number>, from = 4000): number | null {
    let max = 0;
    for (const id of used) max = Math.max(max, id);
    for (let id = from; id < max; id++) if (!used.has(id)) return id;
    for (let id = 1; id < from && id < max; id++) if (!used.has(id)) return id;
    return null;
}

// ---- where a quest is used -----------------------------------------------------------------------------------------

export type QuestLinkRole = 'start' | 'complete' | 'giver' | 'other';

export interface QuestLinkSource {
    /** Object id in the level. */
    id: number;
    /** `STEM:class name` as the outliner shows it. */
    className: string;
    pos: [number, number, number];
    /** Message the link sends (field `Trigger Message`), null for sources without one (quest givers). */
    message: number | null;
    /** For quest givers: the `Message to send after ...` fields that are non-zero. */
    giverMessages: { field: string; value: number }[];
    role: QuestLinkRole;
}

export interface QuestPlacement {
    /** The quest object placed in the level. */
    objectId: number;
    pos: [number, number, number];
    sources: QuestLinkSource[];
}

function fieldValue(o: LvlObject, cls: OdbClass | undefined, name: string): number | null {
    const i = o.params.findIndex((p) => p.name === name);
    if (i >= 0) {
        const v = decodeFieldValue(o.params[i]!.type, o.data[i]!, o.data);
        return typeof v === 'number' ? v : null;
    }
    const j = cls?.fields?.findIndex((f) => f.name === name) ?? -1;
    if (j >= 0 && cls!.data) {
        const v = decodeFieldValue(cls!.fields![j]!.type, cls!.data[j]!, cls!.data);
        return typeof v === 'number' ? v : null;
    }
    return null;
}

const roleOf = (m: number | null): QuestLinkRole => (m === 1 ? 'start' : m === 18 ? 'complete' : 'other');

/**
 * Quest objects of a level and the objects linking to them. `systemDbs` are the dependency indices that point at
 * System.ODB (usually one). Sources resolve through `odbs` for names and for field defaults.
 */
export function questPlacements(
    header: LvlHeader,
    list: LvlObjectList,
    odbs: OdbIndex,
    quests: ReadonlySet<number>,
): Map<number, QuestPlacement[]> {
    const systemDbs = new Set(
        header.dependencies.filter((d) => odbStemForDependency(d.path.text) === 'SYSTEM').map((d) => d.dbIndex),
    );
    const byObj = new Map<number, QuestPlacement>();
    const out = new Map<number, QuestPlacement[]>();
    for (const o of list.objects) {
        if (!systemDbs.has(o.dbIndex) || !quests.has(o.classId)) continue;
        const pl: QuestPlacement = { objectId: o.id, pos: [...o.pos], sources: [] };
        byObj.set(o.id, pl);
        const l = out.get(o.classId) ?? [];
        l.push(pl);
        out.set(o.classId, l);
    }
    for (const s of list.objects) {
        const hits = s.links.filter((t) => byObj.has(t));
        if (!hits.length) continue;
        const stem = dependencyPath(header, s.dbIndex);
        const db = stem === undefined ? '?' : odbStemForDependency(stem);
        const cls = odbs.get(db)?.get(s.classId);
        const giverMessages: { field: string; value: number }[] = [];
        for (const f of cls?.fields ?? []) {
            if (!f.name.startsWith('Message to send after')) continue;
            const v = fieldValue(s, cls, f.name);
            if (v) giverMessages.push({ field: f.name, value: v });
        }
        const message = fieldValue(s, cls, 'Trigger Message');
        const src: QuestLinkSource = {
            id: s.id,
            className: `${db}:${cls?.name ?? s.classId}`,
            pos: [...s.pos],
            message,
            giverMessages,
            role: giverMessages.length ? 'giver' : roleOf(message),
        };
        for (const t of hits) byObj.get(t)!.sources.push(src);
    }
    return out;
}
