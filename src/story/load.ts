// Reads the story content of one level folder (`LEVELS\<STEM>\<STEM>.{ODB,SSD,SDB,DB}`) through a minimal file system, so
// the same code serves the browser (Iso9660 over a File), the desktop shell and tests. No decoding is hidden here: the
// parsers it calls are the ones in this folder.

import { SrscReader, type SrscEntry } from '../srsc.ts';
import { parseDb, resolveDependencyStem } from '../levellist.ts';
import { ODB_CLASS_TYPE, ODB_FIELDS_TYPE, odbStemForDependency, parseOdbClasses, type OdbClass } from '../odb.ts';
import { SDB_DESCRIPTOR, SDB_SAMPLES, adpcmSamples, parseSoundDescriptor } from '../resources.ts';
import { bufferSource } from '../bytes.ts';
import {
    parseConversationHandler,
    parseDialogLine,
    type ConversationHandler,
    type DialogLine,
} from './conversation.ts';
import { parseFolderName, parseSequence, SSD_FOLDER, type SsdSequence } from './ssd.ts';
import { SSD_SEQUENCE } from '../resources.ts';

/** What the loader needs from a disc: a language-relative path (`LEVELS\LEVEL1ON\LEVEL1ON.SSD`) to its bytes, or null. */
export interface StoryFs {
    read(path: string): Promise<Uint8Array | null>;
}

export interface StorySound {
    id: number;
    sub: number;
    name: string;
    text: string;
    rate: number;
    /** Seconds of audio (0 when the SDB has no samples for the id). */
    seconds: number;
    /** The 0x302 descriptor as stored, for rewriting the subtitle. */
    descriptor: Uint8Array;
}

export interface StorySequence {
    id: number;
    folder: number;
    /** Stored bytes. */
    raw: Uint8Array;
    /** Null when the record does not follow the sequence layout (kept raw, not editable). */
    seq: SsdSequence | null;
}

export interface LevelStory {
    stem: string;
    language: string;
    /** `.DB` dependency list: index -> container stem (SDB / ODB references with a db number are relative to it). */
    deps: Record<number, string>;
    folders: { id: number; parent: number; name: string }[];
    sequences: StorySequence[];
    sounds: Map<number, StorySound>;
    lines: DialogLine[];
    handlers: ConversationHandler[];
    classes: Map<number, OdbClass>;
    /** Entry keys of the containers (for exporting changes as overrides). */
    files: { ssd: string; sdb: string; odb: string };
    /** The SDB entry key of each sound id (type 0x302). */
    soundEntry: Map<number, SrscEntry>;
    sequenceEntry: Map<number, SrscEntry>;
    /** ODB class records (0x0102) as stored, by class id, for patching with `patchClassData`. */
    classRecord: Map<number, { sub: number; raw: Uint8Array }>;
    /** The 0x0103 field-list entry of the level ODB as stored (needed to add classes), null without an ODB. */
    fieldLists: { id: number; sub: number; stored: Uint8Array } | null;
}

/** Level folders of a language tree that carry story data (an .SSD, .SDB or .ODB named like the folder). */
export interface StoryFsList extends StoryFs {
    stems(): Promise<string[]>;
}

async function openSrsc(fs: StoryFs, path: string): Promise<SrscReader | null> {
    const b = await fs.read(path);
    if (!b) return null;
    try {
        return await SrscReader.open(bufferSource(b));
    } catch {
        return null;
    }
}

export async function loadLevelStory(fs: StoryFs, language: string, stem: string): Promise<LevelStory> {
    const dir = `LEVELS\\${stem}\\${stem}`;
    const out: LevelStory = {
        stem,
        language,
        deps: {},
        folders: [],
        sequences: [],
        sounds: new Map(),
        lines: [],
        handlers: [],
        classes: new Map(),
        files: { ssd: `${stem}.SSD`, sdb: `${stem}.SDB`, odb: `${stem}.ODB` },
        soundEntry: new Map(),
        sequenceEntry: new Map(),
        classRecord: new Map(),
        fieldLists: null,
    };
    const db = await fs.read(`${dir}.DB`);
    if (db) {
        for (const d of parseDb(new TextDecoder('latin1').decode(db)).dependencies)
            out.deps[d.index] = odbStemForDependency(resolveDependencyStem(`LEVELS\\${stem}`, d.path));
    }
    const ssd = await openSrsc(fs, `${dir}.SSD`);
    if (ssd) {
        for (const e of ssd.entries) {
            if (e.type === SSD_FOLDER) {
                out.folders.push({ id: e.id, parent: e.sub, name: parseFolderName(await ssd.readRaw(e)) });
            } else if (e.type === SSD_SEQUENCE) {
                const raw = await ssd.readRaw(e);
                out.sequences.push({ id: e.id, folder: e.sub, raw, seq: parseSequence(e.id, e.sub, raw) });
                out.sequenceEntry.set(e.id, e);
            }
        }
    }
    const sdb = await openSrsc(fs, `${dir}.SDB`);
    if (sdb) {
        const sample = new Map<number, number>();
        for (const e of sdb.entries) if (e.type === SDB_SAMPLES && !sample.has(e.id)) sample.set(e.id, e.size);
        for (const e of sdb.entries) {
            if (e.type !== SDB_DESCRIPTOR || out.sounds.has(e.id)) continue;
            const descriptor = await sdb.readRaw(e);
            const d = parseSoundDescriptor(descriptor);
            const bytes = sample.get(e.id);
            out.sounds.set(e.id, {
                id: e.id,
                sub: e.sub,
                name: d.name,
                text: d.text,
                rate: d.rate,
                seconds: bytes === undefined ? 0 : adpcmSamples(bytes) / d.rate,
                descriptor,
            });
            out.soundEntry.set(e.id, e);
        }
    }
    const odb = await openSrsc(fs, `${dir}.ODB`);
    if (odb) {
        out.classes = await parseOdbClasses(odb);
        const fl = odb.entries.find((e) => e.type === ODB_FIELDS_TYPE);
        if (fl) out.fieldLists = { id: fl.id, sub: fl.sub, stored: (await odb.readRaw(fl)).slice() };
        for (const e of odb.entries)
            if (e.type === ODB_CLASS_TYPE && !out.classRecord.has(e.id))
                out.classRecord.set(e.id, { sub: e.sub, raw: await odb.readRaw(e) });
        for (const c of out.classes.values()) {
            const l = parseDialogLine(c);
            if (l) out.lines.push(l);
            const h = parseConversationHandler(c);
            if (h) out.handlers.push(h);
        }
    }
    return out;
}
