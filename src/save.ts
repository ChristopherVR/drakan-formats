import { zlibSync } from 'fflate';
import { latin1, view } from './bytes.ts';
import { inflate } from './inflate.ts';

/**
 * Native `.rsg` save files: an SRSC container whose payloads are all zlib streams.
 * TypeScript port of `scripts/savetool/savetool.py`; the layout and field evidence are in
 * `docs/journal/2026-10-31/save-editor.md`. Untouched entries keep their original compressed bytes, so an
 * unedited save re-serialises byte for byte.
 */

export const SAVE_HEADER_SIZE = 16;
export const SAVE_INDEX_SIZE = 14;

export const TYPE_RECORD = 0x102;
export const TYPE_SMALL_RECORD = 0x104;
export const TYPE_LEVEL_PATH = 0x400;
export const TYPE_TEXT = 0x401;
export const TYPE_SCREENSHOT = 0x23;
export const LEVEL_NAME_ID = 891;
export const SKILL_TABLE_ID = 893;
export const SKILL_ROW_SIZE = 0x4c;
const SKILL_NAME_OFFSET = 12;
export const RYNN_CLASS = 0x17081069;
export const GOLD_CLASS = 0x19001255;
export const CLASS_OFFSET = 8;
export const POS_OFFSET = 12;
/** Resource id (u32 at +0) of Arokh's record; Rynn's is 0xa50. */
export const AROKH_RESOURCE = 0xa60;
export const PROGRESS_ROW_SIZE = 12;
/** `kind` values seen in the progress table rows (see `listProgress`). */
export const PROGRESS_KINDS: readonly number[] = [20, 50, 68, 75, 100];

export class SaveFormatError extends Error {}

/** A well-formed edit request that the field table rejects (unknown field, out of range, unrecognised layout). */
export class SaveFieldError extends Error {
    constructor(
        message: string,
        /** True when the field is verified only for one entry id and this save has another (savetool `--force`). */
        readonly needsForce = false,
    ) {
        super(message);
    }
}

export interface SaveEntry {
    /** Position in the index table. */
    index: number;
    type: number;
    id: number;
    sub: number;
    /** Rank by file offset; payloads are written in this order. */
    position: number;
    /** Bytes between the previous payload end (or the header) and this payload. */
    gap: Uint8Array;
    /** The zlib stream exactly as stored. */
    raw: Uint8Array;
    /** The inflated payload. */
    data: Uint8Array;
}

export interface SaveFile {
    version: number;
    pad: number;
    entries: SaveEntry[];
    /** Bytes between the last payload and the index table. */
    tail: Uint8Array;
}

interface IndexRow {
    type: number;
    id: number;
    sub: number;
    offset: number;
    size: number;
}

function readHeaderAndIndex(blob: Uint8Array): { version: number; pad: number; indexOffset: number; rows: IndexRow[] } {
    if (blob.length < SAVE_HEADER_SIZE) throw new SaveFormatError('file is shorter than the 16-byte SRSC header');
    if (latin1(blob, 0, 4) !== 'SRSC') throw new SaveFormatError(`bad magic "${latin1(blob, 0, 4)}", expected "SRSC"`);
    const dv = view(blob);
    const version = dv.getUint16(4, true);
    const indexOffset = dv.getUint32(6, true);
    const count = dv.getUint32(10, true);
    const pad = dv.getUint16(14, true);
    if (indexOffset < SAVE_HEADER_SIZE || indexOffset + count * SAVE_INDEX_SIZE !== blob.length) {
        throw new SaveFormatError('index table does not run to EOF (index offset or count mismatch)');
    }
    const rows: IndexRow[] = [];
    for (let i = 0; i < count; i++) {
        const o = indexOffset + i * SAVE_INDEX_SIZE;
        rows.push({
            type: dv.getUint16(o, true),
            id: dv.getUint16(o + 2, true),
            sub: dv.getUint16(o + 4, true),
            offset: dv.getUint32(o + 6, true),
            size: dv.getUint32(o + 10, true),
        });
    }
    return { version, pad, indexOffset, rows };
}

function inflateEntry(raw: Uint8Array, label: string): Uint8Array {
    const data = inflate(raw);
    if (!data) throw new SaveFormatError(`${label}: payload is not a valid zlib stream`);
    return data;
}

export function parseSave(blob: Uint8Array): SaveFile {
    const { version, pad, indexOffset, rows } = readHeaderAndIndex(blob);
    const order = rows.map((_, i) => i).sort((a, b) => rows[a]!.offset - rows[b]!.offset || a - b);
    const built = new Map<number, SaveEntry>();
    let cursor = SAVE_HEADER_SIZE;
    order.forEach((i, position) => {
        const r = rows[i]!;
        if (r.size === 0 || r.offset < cursor || r.offset + r.size > indexOffset) {
            throw new SaveFormatError(
                `entry ${i} (type 0x${r.type.toString(16)} id ${r.id}) has a bad range 0x${r.offset.toString(16)}+${r.size}`,
            );
        }
        const raw = blob.slice(r.offset, r.offset + r.size);
        built.set(i, {
            index: i,
            type: r.type,
            id: r.id,
            sub: r.sub,
            position,
            gap: blob.slice(cursor, r.offset),
            raw,
            data: inflateEntry(raw, `entry ${i}`),
        });
        cursor = r.offset + r.size;
    });
    return {
        version,
        pad,
        entries: rows.map((_, i) => built.get(i)!),
        tail: blob.slice(cursor, indexOffset),
    };
}

/** Serialise a save. Returns the file bytes and each entry's payload offset (in index order). */
export function assembleSave(save: SaveFile): { bytes: Uint8Array; offsets: number[] } {
    const byPos = [...save.entries].sort((a, b) => a.position - b.position);
    let size = SAVE_HEADER_SIZE + save.tail.length + save.entries.length * SAVE_INDEX_SIZE;
    for (const e of byPos) size += e.gap.length + e.raw.length;
    const out = new Uint8Array(size);
    const dv = view(out);
    const offsets = new Array<number>(save.entries.length).fill(0);
    let p = SAVE_HEADER_SIZE;
    for (const e of byPos) {
        out.set(e.gap, p);
        p += e.gap.length;
        offsets[e.index] = p;
        out.set(e.raw, p);
        p += e.raw.length;
    }
    out.set(save.tail, p);
    p += save.tail.length;
    const indexOffset = p;
    for (const e of save.entries) {
        dv.setUint16(p, e.type, true);
        dv.setUint16(p + 2, e.id, true);
        dv.setUint16(p + 4, e.sub, true);
        dv.setUint32(p + 6, offsets[e.index]!, true);
        dv.setUint32(p + 10, e.raw.length, true);
        p += SAVE_INDEX_SIZE;
    }
    out.set([0x53, 0x52, 0x53, 0x43], 0);
    dv.setUint16(4, save.version, true);
    dv.setUint32(6, indexOffset, true);
    dv.setUint32(10, save.entries.length, true);
    dv.setUint16(14, save.pad, true);
    return { bytes: out, offsets };
}

/** True when `a` and `b` are the same bytes. */
export function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
}

// ------------------------------------------------------------------------------------------------- field table

export type Confidence = 'high' | 'medium' | 'low';
export type FieldKind = 'u32' | 'vec3';
export type FieldValue = number | [number, number, number];

export type FieldLocator =
    | { type: 'record'; classId?: number; resourceId?: number; entryId?: number }
    | { type: 'skill' }
    | { type: 'progress' };

export interface FieldDef {
    key: string;
    label: string;
    locator: FieldLocator;
    /** Byte offset inside the record (or skill row). */
    offset: number;
    kind: FieldKind;
    confidence: Confidence;
    note: string;
    minimum?: number;
    /** Checked inside the same skill row: `skill` (level) must be <= `skill.max`, `skill.max` >= `skill`. */
    bound?: { sibling: string; op: '<=' | '>=' };
}

/** One table for every editable field; evidence and wording follow savetool.py. */
export const FIELDS: Record<string, FieldDef> = {
    hp: {
        key: 'hp',
        label: 'Health',
        locator: { type: 'record', classId: RYNN_CLASS, entryId: 56 },
        offset: 0x708,
        kind: 'u32',
        confidence: 'medium',
        note:
            'Rynn record, u32 at +0x708. Pinned to entry id 56: every such save holds 84 (the RAM HP of the same session), ' +
            'while entry id 53 saves hold other data here. Max HP not located. Only one distinct value seen; not yet ' +
            'confirmed by a controlled edit.',
    },
    gold: {
        key: 'gold',
        label: 'Gold',
        locator: { type: 'record', classId: GOLD_CLASS, entryId: 63 },
        offset: 0x448,
        kind: 'u32',
        confidence: 'medium',
        note:
            'Record class 0x19001255 entry id 63, u32 at +0x448. Holds 376 in 305 of the 403 local saves that carry it; ' +
            'the other 98 hold other values, so this record may have a second layout. Confirm with a controlled edit ' +
            'before trusting.',
        minimum: 0,
    },
    pos: {
        key: 'pos',
        label: 'Position',
        locator: { type: 'record', classId: RYNN_CLASS },
        offset: POS_OFFSET,
        kind: 'vec3',
        confidence: 'high',
        note:
            'Rynn record, float X,Y,Z at +12. Matched by class alone because entry ids vary between saves (53, 56, ...). ' +
            'The same offsets the combat fixture moves, verified in game.',
    },
    'arokh.pos': {
        key: 'arokh.pos',
        label: 'Arokh position',
        locator: { type: 'record', resourceId: AROKH_RESOURCE },
        offset: POS_OFFSET,
        kind: 'vec3',
        confidence: 'low',
        note:
            'Record whose resource id (u32 at +0) is 0xa60, float X,Y,Z at +12 like every positioned record. Arokh sits ' +
            'far from Rynn in Surdana saves. Only matches by symmetry with Rynn; never moved in game.',
    },
    progress: {
        key: 'progress',
        label: 'Progress value',
        locator: { type: 'progress' },
        offset: 8,
        kind: 'u32',
        confidence: 'low',
        note:
            'Row of the state table at the end of type 0x401 id 893: {u32 kind, u32 key, u32 value}, 12 bytes, running ' +
            'to the end of the payload. kind is one of 20, 50, 68, 75, 100; keys are unique. The table has about 100-370 ' +
            'rows, fewer after play than at the start. Meaning of kind and value is a hypothesis (per-actor state); ' +
            'only the layout is verified.',
        minimum: 0,
    },
    skill: {
        key: 'skill',
        label: 'Skill level',
        locator: { type: 'skill' },
        offset: 4,
        kind: 'u32',
        confidence: 'high',
        note: 'Level of skill row N. Row = {u32 id, u32 level, u32 max, char name[64]}, stride 0x4c. Level must not exceed max.',
        bound: { sibling: 'skill.max', op: '<=' },
    },
    'skill.max': {
        key: 'skill.max',
        label: 'Skill max',
        locator: { type: 'skill' },
        offset: 8,
        kind: 'u32',
        confidence: 'high',
        note: 'Max of skill row N. Must not be below the current level.',
        bound: { sibling: 'skill', op: '>=' },
    },
};

const SKILL_FIELD = /^skill\.(\d+)(\.max)?$/;
const PROGRESS_FIELD = /^progress\.(\d+)$/;

export function resolveField(name: string): { def: FieldDef; rowId: number | null } {
    const m = SKILL_FIELD.exec(name);
    if (m) return { def: FIELDS[m[2] ? 'skill.max' : 'skill']!, rowId: Number(m[1]) };
    const pm = PROGRESS_FIELD.exec(name);
    if (pm) return { def: FIELDS.progress!, rowId: Number(pm[1]) };
    const def = FIELDS[name];
    if (def && def.locator.type === 'record') return { def, rowId: null };
    throw new SaveFieldError(`unknown field "${name}" (skills are skill.N or skill.N.max, progress rows progress.KEY)`);
}

const u32At = (d: Uint8Array, off: number): number => view(d).getUint32(off, true);

function findRecord(
    save: SaveFile,
    loc: { classId?: number; resourceId?: number; entryId?: number },
    force: boolean,
): SaveEntry {
    const what =
        loc.classId !== undefined
            ? `class 0x${loc.classId.toString(16).padStart(8, '0')}`
            : `resource 0x${(loc.resourceId ?? 0).toString(16)}`;
    let candidates = save.entries.filter(
        (e) =>
            e.type === TYPE_RECORD &&
            e.data.length >= CLASS_OFFSET + 4 &&
            (loc.classId !== undefined
                ? u32At(e.data, CLASS_OFFSET) === loc.classId
                : u32At(e.data, 0) === loc.resourceId),
    );
    if (loc.entryId !== undefined && !force) {
        const pinned = candidates.filter((e) => e.id === loc.entryId);
        if (candidates.length && !pinned.length) {
            const ids = [...new Set(candidates.map((e) => e.id))].sort((a, b) => a - b);
            throw new SaveFieldError(
                `record ${what} has entry id ${ids.join(', ')}; ` + `this field is verified only for id ${loc.entryId}`,
                true,
            );
        }
        candidates = pinned;
    }
    if (candidates.length !== 1) {
        throw new SaveFieldError(`expected one record for ${what}, found ${candidates.length}`);
    }
    return candidates[0]!;
}

function skillTable(save: SaveFile): { entry: SaveEntry; first: number; count: number } {
    const tables = save.entries.filter((e) => e.type === TYPE_TEXT && e.id === SKILL_TABLE_ID);
    if (tables.length !== 1) {
        throw new SaveFieldError(`expected one skill table (type 0x401 id ${SKILL_TABLE_ID}), found ${tables.length}`);
    }
    const entry = tables[0]!;
    const data = entry.data;
    const needle = [0x4d, 0x65, 0x6c, 0x65, 0x65, 0x00]; // "Melee\0"
    const find = (from: number): number => {
        for (let i = from; i + needle.length <= data.length; i++) {
            if (needle.every((b, k) => data[i + k] === b)) return i;
        }
        return -1;
    };
    const anchor = find(0);
    if (anchor < SKILL_NAME_OFFSET + 4 || find(anchor + 1) >= 0) {
        throw new SaveFieldError("skill table layout not recognised (no unique 'Melee' row)");
    }
    const first = anchor - SKILL_NAME_OFFSET;
    const count = u32At(data, first - 4);
    if (count < 1 || count > 64 || first + count * SKILL_ROW_SIZE > data.length) {
        throw new SaveFieldError(`skill table row count ${count} does not fit the payload`);
    }
    return { entry, first, count };
}

export interface SkillRow {
    id: number;
    name: string;
    level: number;
    max: number;
}

export function listSkills(save: SaveFile): SkillRow[] {
    const { entry, first, count } = skillTable(save);
    const rows: SkillRow[] = [];
    for (let k = 0; k < count; k++) {
        const o = first + k * SKILL_ROW_SIZE;
        let end = o + SKILL_NAME_OFFSET;
        while (end < o + SKILL_ROW_SIZE && entry.data[end] !== 0) end++;
        rows.push({
            id: u32At(entry.data, o),
            level: u32At(entry.data, o + 4),
            max: u32At(entry.data, o + 8),
            name: latin1(entry.data, o + SKILL_NAME_OFFSET, end),
        });
    }
    return rows;
}

export interface ProgressRow {
    kind: number;
    key: number;
    value: number;
}

/**
 * The state table at the end of the skill/text payload (type 0x401 id 893): 12-byte rows {kind, key, value} that run to
 * the end of the payload. The start is found by walking back from the end while the kind is one of `PROGRESS_KINDS`,
 * never into the skill rows. Returns the entry, the payload offset of the first row and the rows.
 */
export function progressTable(save: SaveFile): { entry: SaveEntry; start: number; rows: ProgressRow[] } {
    const { entry, first, count } = skillTable(save);
    const data = entry.data;
    const floor = first + count * SKILL_ROW_SIZE;
    let start = data.length;
    while (start - PROGRESS_ROW_SIZE >= floor && PROGRESS_KINDS.includes(u32At(data, start - PROGRESS_ROW_SIZE))) {
        start -= PROGRESS_ROW_SIZE;
    }
    const rows: ProgressRow[] = [];
    for (let o = start; o + PROGRESS_ROW_SIZE <= data.length; o += PROGRESS_ROW_SIZE) {
        rows.push({ kind: u32At(data, o), key: u32At(data, o + 4), value: u32At(data, o + 8) });
    }
    return { entry, start, rows };
}

export function listProgress(save: SaveFile): ProgressRow[] {
    try {
        return progressTable(save).rows;
    } catch (e) {
        if (e instanceof SaveFieldError) return [];
        throw e;
    }
}

function locate(
    save: SaveFile,
    def: FieldDef,
    rowId: number | null,
    force: boolean,
): { entry: SaveEntry; base: number } {
    if (def.locator.type === 'record') return { entry: findRecord(save, def.locator, force), base: 0 };
    if (def.locator.type === 'progress') {
        const t = progressTable(save);
        const hits: number[] = [];
        t.rows.forEach((r, k) => {
            if (r.key === rowId) hits.push(t.start + k * PROGRESS_ROW_SIZE);
        });
        if (hits.length !== 1) throw new SaveFieldError(`no unique progress row with key ${String(rowId)}`);
        return { entry: t.entry, base: hits[0]! };
    }
    if (rowId === null) throw new SaveFieldError('skill fields need a row number, e.g. skill.1');
    const { entry, first, count } = skillTable(save);
    const rows: number[] = [];
    for (let k = 0; k < count; k++) {
        if (u32At(entry.data, first + k * SKILL_ROW_SIZE) === rowId) rows.push(first + k * SKILL_ROW_SIZE);
    }
    if (rows.length !== 1) throw new SaveFieldError(`no unique skill row with id ${rowId} (table ids are 1..${count})`);
    return { entry, base: rows[0]! };
}

const widthOf = (def: FieldDef): number => (def.kind === 'u32' ? 4 : 12);

function decodeAt(def: FieldDef, data: Uint8Array, off: number): FieldValue {
    const dv = view(data);
    if (def.kind === 'u32') return dv.getUint32(off, true);
    return [dv.getFloat32(off, true), dv.getFloat32(off + 4, true), dv.getFloat32(off + 8, true)];
}

function checkSpan(entry: SaveEntry, off: number, def: FieldDef, name: string): void {
    if (off + widthOf(def) > entry.data.length) {
        throw new SaveFieldError(`${name} is outside its payload (${entry.data.length} bytes)`);
    }
}

/** Which entry and absolute payload offset hold a field (the entry-id pin is ignored). Null when absent. */
export function locateField(save: SaveFile, name: string): { entryIndex: number; offset: number } | null {
    try {
        const { def, rowId } = resolveField(name);
        const { entry, base } = locate(save, def, rowId, true);
        return { entryIndex: entry.index, offset: base + def.offset };
    } catch (e) {
        if (e instanceof SaveFieldError) return null;
        throw e;
    }
}

export function getField(save: SaveFile, name: string, force = false): FieldValue {
    const { def, rowId } = resolveField(name);
    const { entry, base } = locate(save, def, rowId, force);
    checkSpan(entry, base + def.offset, def, name);
    return decodeAt(def, entry.data, base + def.offset);
}

export type FieldProbe =
    | { status: 'ok'; value: FieldValue }
    /** Readable only when the entry-id pin is ignored (savetool `--force`); `value` is what that read gives. */
    | { status: 'unconfirmed'; value: FieldValue; reason: string }
    | { status: 'missing'; reason: string };

/** Read a field for the UI: a value, an unconfirmed value (needs an explicit unlock to edit), or why it is absent. */
export function probeField(save: SaveFile, name: string): FieldProbe {
    try {
        return { status: 'ok', value: getField(save, name, false) };
    } catch (e) {
        if (!(e instanceof SaveFieldError)) throw e;
        if (!e.needsForce) return { status: 'missing', reason: e.message };
        try {
            return { status: 'unconfirmed', value: getField(save, name, true), reason: e.message };
        } catch (e2) {
            if (e2 instanceof SaveFieldError) return { status: 'missing', reason: e2.message };
            throw e2;
        }
    }
}

export function formatFieldValue(def: FieldDef, value: FieldValue): string {
    if (typeof value === 'number') return String(value);
    return value.map((x) => String(Number(x.toPrecision(9)))).join(',');
}

export function parseFieldValue(def: FieldDef, text: string): FieldValue {
    if (def.kind === 'u32') {
        const t = text.trim();
        const n = /^-?\d+$/.test(t) ? Number(t) : /^0x[0-9a-f]+$/i.test(t) ? Number(t) : NaN;
        if (!Number.isInteger(n)) throw new SaveFieldError(`expected an integer, got "${text}"`);
        return n;
    }
    const parts = text.split(',').map((p) => p.trim());
    if (parts.length !== 3) throw new SaveFieldError('expected X,Y,Z');
    const v = parts.map(Number);
    if (parts.some((p) => p === '') || v.some((x) => Number.isNaN(x))) {
        throw new SaveFieldError(`expected three numbers, got "${text}"`);
    }
    return [v[0]!, v[1]!, v[2]!];
}

/** Range checks that do not need a save (u32 range, minimum, finite float32). */
export function checkFieldValue(name: string, value: FieldValue): void {
    const { def } = resolveField(name);
    if (def.kind === 'u32') {
        if (typeof value === 'number' && def.minimum !== undefined && value < def.minimum) {
            throw new SaveFieldError(`${name} must be at least ${def.minimum}`);
        }
        if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 0xffffffff) {
            throw new SaveFieldError(`${name}: ${String(value)} does not fit in u32`);
        }
        return;
    }
    if (typeof value === 'number' || value.length !== 3) throw new SaveFieldError(`${name}: expected X,Y,Z`);
    for (const x of value) {
        if (!Number.isFinite(x)) throw new SaveFieldError('coordinates must be finite');
        if (!Number.isFinite(Math.fround(x))) throw new SaveFieldError('coordinate does not fit in float32');
    }
}

export interface FieldEdit {
    name: string;
    value: FieldValue;
    /** Ignore the verified entry-id pin (savetool `--force`). */
    force?: boolean;
}

/**
 * Apply edits and return a new save. Entries whose bytes do not change keep the very same objects (and so their
 * original compressed bytes); changed ones are recompressed once. Skill level/max bounds are checked on the final
 * state, so raising max and level together works in any order. The input is not modified.
 */
export function applyFieldEdits(save: SaveFile, edits: FieldEdit[]): SaveFile {
    const entries = save.entries.slice();
    const working = new Map<number, Uint8Array>();
    const current = (): SaveFile => ({
        ...save,
        entries: entries.map((e) => (working.has(e.index) ? { ...e, data: working.get(e.index)! } : e)),
    });
    const touched: { edit: FieldEdit; def: FieldDef; rowId: number | null }[] = [];
    for (const edit of edits) {
        const { def, rowId } = resolveField(edit.name);
        checkFieldValue(edit.name, edit.value);
        const { entry, base } = locate(current(), def, rowId, edit.force === true);
        const off = base + def.offset;
        checkSpan(entry, off, def, edit.name);
        const data = (working.get(entry.index) ?? entry.data).slice();
        const dv = view(data);
        if (def.kind === 'u32') dv.setUint32(off, edit.value as number, true);
        else (edit.value as number[]).forEach((x, i) => dv.setFloat32(off + 4 * i, x, true));
        working.set(entry.index, data);
        touched.push({ edit, def, rowId });
    }
    const after = current();
    for (const { def, rowId } of touched) {
        if (!def.bound || rowId === null) continue;
        const level = Number(getField(after, `skill.${rowId}`, true));
        const max = Number(getField(after, `skill.${rowId}.max`, true));
        if (level > max) throw new SaveFieldError(`skill ${rowId}: level ${level} must not exceed max ${max}`);
    }
    const out = entries.map((e) => {
        const data = working.get(e.index);
        if (!data || sameBytes(data, e.data)) return e;
        return { ...e, data, raw: zlibSync(data) };
    });
    return { ...save, entries: out };
}

// ------------------------------------------------------------------------------------------------- summaries

export interface Screenshot {
    width: number;
    height: number;
    /** RGBA8, top-down. */
    rgba: Uint8Array;
}

/**
 * Decode the CT16 (ABGR1555, little endian) screenshot stored in type 0x23: a 16-byte header of u32 width, height,
 * bits per pixel and byte size, then the rows top-down. Alpha is forced opaque (PS2 alpha is not coverage here).
 */
export function decodeScreenshot(data: Uint8Array): Screenshot | null {
    if (data.length < 16) return null;
    const dv = view(data);
    const w = dv.getUint32(0, true);
    const h = dv.getUint32(4, true);
    const bpp = dv.getUint32(8, true);
    if (bpp !== 16 || w === 0 || h === 0 || w > 1024 || h > 1024 || 16 + w * h * 2 > data.length) return null;
    const rgba = new Uint8Array(w * h * 4);
    for (let i = 0; i < w * h; i++) {
        const v = dv.getUint16(16 + i * 2, true);
        rgba[i * 4] = Math.round(((v & 31) * 255) / 31);
        rgba[i * 4 + 1] = Math.round((((v >> 5) & 31) * 255) / 31);
        rgba[i * 4 + 2] = Math.round((((v >> 10) & 31) * 255) / 31);
        rgba[i * 4 + 3] = 255;
    }
    return { width: w, height: h, rgba };
}

/** A u16-length-prefixed, NUL-padded string payload (types 0x400 and 0x401 id 891). */
export function readLengthString(data: Uint8Array): string {
    if (data.length < 2) return '';
    const n = Math.min(view(data).getUint16(0, true), data.length - 2);
    let end = 2;
    while (end < 2 + n && data[end] !== 0) end++;
    return latin1(data, 2, end);
}

export interface SaveSummary {
    entryCount: number;
    levelName: string;
    levelPath: string;
    screenshot: Screenshot | null;
}

/** Cheap listing info: reads the index and inflates only the screenshot and the two level strings. */
export function summarizeSave(blob: Uint8Array): SaveSummary {
    const { rows } = readHeaderAndIndex(blob);
    const payload = (pred: (r: IndexRow) => boolean): Uint8Array | null => {
        const r = rows.find(pred);
        if (!r || r.size === 0 || r.offset + r.size > blob.length) return null;
        return inflate(blob.subarray(r.offset, r.offset + r.size));
    };
    const shot = payload((r) => r.type === TYPE_SCREENSHOT);
    const name = payload((r) => r.type === TYPE_TEXT && r.id === LEVEL_NAME_ID);
    const path = payload((r) => r.type === TYPE_LEVEL_PATH);
    return {
        entryCount: rows.length,
        levelName: name ? readLengthString(name) : '',
        levelPath: path ? readLengthString(path) : '',
        screenshot: shot ? decodeScreenshot(shot) : null,
    };
}

/** Level display name for a full save: the stored name, else the path's folder, else empty. */
export function levelNameOf(save: SaveFile): string {
    const name = save.entries.find((e) => e.type === TYPE_TEXT && e.id === LEVEL_NAME_ID);
    if (name) return readLengthString(name.data);
    const path = save.entries.find((e) => e.type === TYPE_LEVEL_PATH);
    return path ? (readLengthString(path.data).split('/').at(-2) ?? '') : '';
}

export function screenshotOf(save: SaveFile): Screenshot | null {
    const e = save.entries.find((x) => x.type === TYPE_SCREENSHOT);
    return e ? decodeScreenshot(e.data) : null;
}

// ------------------------------------------------------------------------------------------------- records

export const KNOWN_CLASSES: Record<number, string> = {
    [RYNN_CLASS]: 'Rynn (player)',
    [GOLD_CLASS]: 'Gold counter',
};

export const TYPE_NAMES: Record<number, string> = {
    [TYPE_RECORD]: 'Object record',
    [TYPE_SMALL_RECORD]: 'Small record',
    [TYPE_LEVEL_PATH]: 'Level path',
    [TYPE_TEXT]: 'Text / skill table',
    0x402: 'Unknown (8 bytes)',
    [TYPE_SCREENSHOT]: 'Screenshot (CT16)',
};

export interface RecordInfo {
    index: number;
    type: number;
    id: number;
    sub: number;
    size: number;
    /** Object class id (type 0x102 only). */
    classId?: number;
    /** Resource id (u32 at +0, type 0x102 only): 0xa50 Rynn, 0xa60 Arokh. */
    resource?: number;
    /** World position of an object record (float32 at +12), when plausible. */
    pos?: [number, number, number];
}

export function classHex(classId: number): string {
    return `0x${classId.toString(16).padStart(8, '0')}`;
}

export function recordPosition(data: Uint8Array): [number, number, number] | undefined {
    if (data.length < POS_OFFSET + 12) return undefined;
    const dv = view(data);
    const p: [number, number, number] = [
        dv.getFloat32(POS_OFFSET, true),
        dv.getFloat32(POS_OFFSET + 4, true),
        dv.getFloat32(POS_OFFSET + 8, true),
    ];
    if (p.some((x) => !Number.isFinite(x) || Math.abs(x) > 1e8)) return undefined;
    if (p.every((x) => x === 0)) return undefined;
    return p;
}

export function describeRecords(save: SaveFile): RecordInfo[] {
    return save.entries.map((e) => {
        const info: RecordInfo = { index: e.index, type: e.type, id: e.id, sub: e.sub, size: e.data.length };
        if (e.type === TYPE_RECORD && e.data.length >= CLASS_OFFSET + 4) {
            info.resource = u32At(e.data, 0);
            info.classId = u32At(e.data, CLASS_OFFSET);
            const pos = recordPosition(e.data);
            if (pos) info.pos = pos;
        }
        return info;
    });
}

// ------------------------------------------------------------------------------------------------- compare

export interface FieldDiff {
    name: string;
    label: string;
    a: FieldValue | null;
    b: FieldValue | null;
    changed: boolean;
    confidence: Confidence;
}

export interface EntryDiff {
    type: number;
    id: number;
    sub: number;
    /** Index in A / B, or -1 when absent there. */
    indexA: number;
    indexB: number;
    status: 'unchanged' | 'changed' | 'only-a' | 'only-b';
    sizeA: number;
    sizeB: number;
    /** Differing bytes when both payloads have the same length, else -1. */
    bytesChanged: number;
    /** Payload equal but compressed bytes differ (recompressed by an editor). */
    recompressed: boolean;
}

export interface SaveDiff {
    fields: FieldDiff[];
    entries: EntryDiff[];
    counts: { changed: number; unchanged: number; onlyA: number; onlyB: number };
}

const valueEq = (x: FieldValue | null, y: FieldValue | null): boolean => {
    if (x === null || y === null) return x === y;
    if (typeof x === 'number' || typeof y === 'number') return x === y;
    return x.every((v, i) => v === y[i]);
};

function readOrNull(save: SaveFile, name: string): FieldValue | null {
    const p = probeField(save, name);
    return p.status === 'missing' ? null : p.value;
}

/** Field table and per-entry diff. Entries are matched by (type, id, sub) and occurrence order. */
export function diffSaves(a: SaveFile, b: SaveFile): SaveDiff {
    const names = ['hp', 'gold', 'pos', 'arokh.pos'];
    const skillIds = new Set<number>();
    for (const s of [a, b]) {
        try {
            for (const r of listSkills(s)) skillIds.add(r.id);
        } catch {
            /* no recognisable skill table */
        }
    }
    for (const id of [...skillIds].sort((x, y) => x - y)) names.push(`skill.${id}`, `skill.${id}.max`);
    const fields = names.map((name) => {
        const { def } = resolveField(name);
        const av = readOrNull(a, name);
        const bv = readOrNull(b, name);
        const row = name.startsWith('skill.') ? name.replace(/^skill\.(\d+)(\.max)?$/, 'skill $1$2') : name;
        return {
            name,
            label: name.startsWith('skill.') ? row : def.label,
            a: av,
            b: bv,
            changed: !valueEq(av, bv),
            confidence: def.confidence,
        };
    });

    const key = (e: SaveEntry): string => `${e.type}:${e.id}:${e.sub}`;
    const bySlot = new Map<string, SaveEntry[]>();
    for (const e of b.entries) {
        const k = key(e);
        const list = bySlot.get(k);
        if (list) list.push(e);
        else bySlot.set(k, [e]);
    }
    const seen = new Map<string, number>();
    const used = new Set<number>();
    const entries: EntryDiff[] = [];
    for (const ea of a.entries) {
        const k = key(ea);
        const n = seen.get(k) ?? 0;
        seen.set(k, n + 1);
        const eb = bySlot.get(k)?.[n];
        if (!eb) {
            entries.push({
                type: ea.type,
                id: ea.id,
                sub: ea.sub,
                indexA: ea.index,
                indexB: -1,
                status: 'only-a',
                sizeA: ea.data.length,
                sizeB: 0,
                bytesChanged: -1,
                recompressed: false,
            });
            continue;
        }
        used.add(eb.index);
        const same = sameBytes(ea.data, eb.data);
        let bytesChanged = -1;
        if (!same && ea.data.length === eb.data.length) {
            bytesChanged = 0;
            for (let i = 0; i < ea.data.length; i++) if (ea.data[i] !== eb.data[i]) bytesChanged++;
        }
        entries.push({
            type: ea.type,
            id: ea.id,
            sub: ea.sub,
            indexA: ea.index,
            indexB: eb.index,
            status: same ? 'unchanged' : 'changed',
            sizeA: ea.data.length,
            sizeB: eb.data.length,
            bytesChanged,
            recompressed: same && !sameBytes(ea.raw, eb.raw),
        });
    }
    for (const eb of b.entries) {
        if (used.has(eb.index)) continue;
        entries.push({
            type: eb.type,
            id: eb.id,
            sub: eb.sub,
            indexA: -1,
            indexB: eb.index,
            status: 'only-b',
            sizeA: 0,
            sizeB: eb.data.length,
            bytesChanged: -1,
            recompressed: false,
        });
    }
    const count = (s: EntryDiff['status']): number => entries.filter((e) => e.status === s).length;
    return {
        fields,
        entries,
        counts: {
            changed: count('changed'),
            unchanged: count('unchanged'),
            onlyA: count('only-a'),
            onlyB: count('only-b'),
        },
    };
}

// ------------------------------------------------------------------------------------------------- files

/** First free `.bak`, `.bak.1`, `.bak.2`, ... name next to `name` (never replaces an existing backup). */
export function nextBackupName(existing: Iterable<string>, name: string): string {
    const have = new Set(existing);
    let candidate = `${name}.bak`;
    for (let n = 1; have.has(candidate); n++) candidate = `${name}.bak.${n}`;
    return candidate;
}

/** `BESCES-50006Slot12` gives 12; other names give null. */
export function slotNumber(folder: string): number | null {
    const m = /slot\s*(\d+)\s*$/i.exec(folder);
    return m ? Number(m[1]) : null;
}
