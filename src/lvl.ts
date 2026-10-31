import { latin1, view } from './bytes.ts';
import { type OdbClass, type OdbIndex, odbStemForDependency } from './odb.ts';
import { type SrscEntry, SrscError, type SrscReader, writeSrsc } from './srsc.ts';

/**
 * Level LVL reader/writer: header + dependency table (0x0000) and placed objects (0x0020).
 * Layout and evidence: docs/reference/level-format.md. Everything is retained so that an unmodified model re-serialises
 * byte for byte: both prefix words, the unknown flag bits, the zero word before the sentinel, the data dwords and the
 * raw field_def names (including NUL padding).
 *
 * The model is plain mutable data. Use the edit functions below rather than poking fields where they exist: they
 * keep the flag/optional-field invariants the writer relies on.
 */

export const LVL_TYPE_HEADER = 0x0000;
export const LVL_TYPE_OBJECTS = 0x0020;
export const FLAG_VISIBLE = 0x01;
export const FLAG_RADIUS = 0x10;
export const FLAG_SCALED = 0x100;
export const LVL_SENTINEL = 0xffffffff;

export class LvlError extends Error {}
/** An edit that cannot be applied (unknown id, flag not set, value out of range, referenced object, ...). */
export class LvlEditError extends LvlError {}

export type Vec3 = [number, number, number];

// ---------------------------------------------------------------- header (0x0000)

export interface LvlString {
    /** Bytes as stored after the u16 length (includes NUL padding). */
    raw: Uint8Array;
    /** Text up to the first NUL (latin-1). */
    text: string;
}

export interface LvlDependency {
    /** The `db_index` objects use. */
    dbIndex: number;
    /** The u16 after the index (0 on disc). */
    zero: number;
    path: LvlString;
}

export interface LvlHeader {
    name: LvlString;
    maxWidth: number;
    maxHeight: number;
    dependencies: LvlDependency[];
    /** Bytes after the dependency table (none on disc). */
    trailer: Uint8Array;
}

function textOf(raw: Uint8Array): string {
    const z = raw.indexOf(0);
    return latin1(raw, 0, z < 0 ? raw.length : z);
}

class Cursor {
    readonly dv: DataView;
    o = 0;
    constructor(readonly b: Uint8Array) {
        this.dv = view(b);
    }
    need(n: number): void {
        if (n < 0 || this.o + n > this.b.length) throw new LvlError(`read past end at 0x${this.o.toString(16)}`);
    }
    u16(): number {
        this.need(2);
        const v = this.dv.getUint16(this.o, true);
        this.o += 2;
        return v;
    }
    i16(): number {
        this.need(2);
        const v = this.dv.getInt16(this.o, true);
        this.o += 2;
        return v;
    }
    u32(): number {
        this.need(4);
        const v = this.dv.getUint32(this.o, true);
        this.o += 4;
        return v;
    }
    f32(): number {
        this.need(4);
        const v = this.dv.getFloat32(this.o, true);
        this.o += 4;
        return v;
    }
    raw(n: number): Uint8Array {
        this.need(n);
        const v = this.b.slice(this.o, this.o + n);
        this.o += n;
        return v;
    }
    string(): LvlString {
        const raw = this.raw(this.u16());
        return { raw, text: textOf(raw) };
    }
}

export function parseLevelHeader(data: Uint8Array): LvlHeader {
    const c = new Cursor(data);
    const name = c.string();
    const maxWidth = c.u32();
    const maxHeight = c.u32();
    const n = c.u32();
    if (n * 6 > data.length - c.o) throw new LvlError('dependency count exceeds the payload');
    const dependencies: LvlDependency[] = [];
    for (let i = 0; i < n; i++) {
        const dbIndex = c.u16();
        const zero = c.u16();
        dependencies.push({ dbIndex, zero, path: c.string() });
    }
    return { name, maxWidth, maxHeight, dependencies, trailer: data.slice(c.o) };
}

export function writeLevelHeader(h: LvlHeader): Uint8Array {
    let size = 2 + h.name.raw.length + 12 + h.trailer.length;
    for (const d of h.dependencies) size += 6 + d.path.raw.length;
    const out = new Uint8Array(size);
    const dv = view(out);
    let o = 0;
    const str = (s: LvlString): void => {
        dv.setUint16(o, s.raw.length, true);
        out.set(s.raw, o + 2);
        o += 2 + s.raw.length;
    };
    str(h.name);
    dv.setUint32(o, h.maxWidth, true);
    dv.setUint32(o + 4, h.maxHeight, true);
    dv.setUint32(o + 8, h.dependencies.length, true);
    o += 12;
    for (const d of h.dependencies) {
        dv.setUint16(o, d.dbIndex, true);
        dv.setUint16(o + 2, d.zero, true);
        o += 4;
        str(d.path);
    }
    out.set(h.trailer, o);
    return out;
}

/** Dependency path for a `db_index` (the last entry wins on duplicates, like lvl_objects.py). */
export function dependencyPath(h: LvlHeader, dbIndex: number): string | undefined {
    let found: string | undefined;
    for (const d of h.dependencies) if (d.dbIndex === dbIndex) found = d.path.text;
    return found;
}

// ---------------------------------------------------------------- objects (0x0020)

export interface LvlParam {
    /** Index of the field in the object's class (u16 array entry). */
    fieldIndex: number;
    /** field_def type word (low byte = type, see level-format.md section 4). */
    type: number;
    /** field_def name bytes after the u16 length (NUL padding included). */
    nameRaw: Uint8Array;
    name: string;
}

export interface LvlObject {
    /** Link-target id (unique, ascending in the table). */
    id: number;
    classId: number;
    dbIndex: number;
    /** Prefix word 0 ("lighting layer", 0 in nearly all records). */
    prefix0: number;
    /** Prefix word 1 (0 seen, meaning unknown). */
    prefix1: number;
    /** World units, y up. */
    pos: Vec3;
    /** All 32 flag bits as stored (0x01 visible, 0x10 radius word, 0x100 scale triple; others unknown). */
    flags: number;
    initialEvents: number;
    /** Present exactly when `flags & FLAG_RADIUS`. */
    radius: number | null;
    /** Ids of other objects in the list (trigger targets). */
    links: number[];
    /** Signed degrees. */
    rot: Vec3;
    /** Present exactly when `flags & FLAG_SCALED`. */
    scale: Vec3 | null;
    /** The word before the sentinel (0 on disc, probably an owner id). */
    preSentinel: number;
    /** 0xffffffff on disc. */
    sentinel: number;
    /** The raw data area (u32 dwords; strings and arrays live in the trailing part). */
    data: number[];
    /** One per parameter; parameter i uses data[i]. */
    params: LvlParam[];
}

export interface LvlObjectList {
    /** Table/body order. */
    objects: LvlObject[];
    /** Non-fatal observations (duplicate ids, unordered ids). */
    warnings: string[];
}

function parseBody(c: Cursor, entry: { id: number; classId: number; dbIndex: number }): LvlObject {
    const start = c.o;
    const prefix0 = c.u32();
    const prefix1 = c.u32();
    const pos: Vec3 = [c.f32(), c.f32(), c.f32()];
    const flags = c.u32();
    const initialEvents = c.u16();
    const radius = flags & FLAG_RADIUS ? c.f32() : null;
    const nLinks = c.u16();
    c.need(nLinks * 4);
    const links: number[] = [];
    for (let i = 0; i < nLinks; i++) links.push(c.u32());
    const rot: Vec3 = [c.i16(), c.i16(), c.i16()];
    const scale: Vec3 | null = flags & FLAG_SCALED ? [c.f32(), c.f32(), c.f32()] : null;
    const preSentinel = c.u32();
    const sentinel = c.u32();
    if (sentinel !== LVL_SENTINEL || !pos.every(Number.isFinite)) {
        throw new LvlError(`body at 0x${start.toString(16)}: bad sentinel or position`);
    }
    const dataDwords = c.u32();
    const nParams = c.u32();
    c.need(dataDwords * 4);
    const data: number[] = [];
    for (let i = 0; i < dataDwords; i++) data.push(c.u32());
    c.need(nParams * 2);
    const indices: number[] = [];
    for (let i = 0; i < nParams; i++) indices.push(c.u16());
    const params: LvlParam[] = [];
    for (let i = 0; i < nParams; i++) {
        const type = c.u32();
        const s = c.string();
        params.push({ fieldIndex: indices[i]!, type, nameRaw: s.raw, name: s.text });
    }
    return {
        ...entry,
        prefix0,
        prefix1,
        pos,
        flags,
        initialEvents,
        radius,
        links,
        rot,
        scale,
        preSentinel,
        sentinel,
        data,
        params,
    };
}

/** Parse a 0x0020 payload. Throws LvlError unless the bodies consume the payload exactly. */
export function parseObjectList(data: Uint8Array): LvlObjectList {
    const c = new Cursor(data);
    const count = c.u16();
    c.need(count * 8);
    const table: { id: number; classId: number; dbIndex: number }[] = [];
    for (let i = 0; i < count; i++) table.push({ id: c.u32(), classId: c.u16(), dbIndex: c.u16() });
    const objects: LvlObject[] = [];
    for (let i = 0; i < count; i++) {
        try {
            objects.push(parseBody(c, table[i]!));
        } catch (e) {
            if (e instanceof LvlError) throw new LvlError(`object ${i} (id ${table[i]!.id}): ${e.message}`);
            throw e;
        }
    }
    if (c.o !== data.length) throw new LvlError(`${data.length - c.o} bytes left after the last object`);
    const warnings: string[] = [];
    const seen = new Set<number>();
    table.forEach((t, i) => {
        if (seen.has(t.id)) warnings.push(`duplicate object id ${t.id} at index ${i}`);
        else if (i > 0 && t.id < table[i - 1]!.id) warnings.push(`id ${t.id} at index ${i} is not ascending`);
        seen.add(t.id);
    });
    return { objects, warnings };
}

function bodySize(o: LvlObject): number {
    let n = 8 + 12 + 4 + 2 + (o.radius !== null ? 4 : 0) + 2 + o.links.length * 4 + 6 + (o.scale ? 12 : 0) + 8 + 8;
    n += o.data.length * 4 + o.params.length * 2;
    for (const p of o.params) n += 6 + p.nameRaw.length;
    return n;
}

function checkObject(o: LvlObject): void {
    const bad = (m: string): never => {
        throw new LvlError(`object id ${o.id}: ${m}`);
    };
    if ((o.radius !== null) !== ((o.flags & FLAG_RADIUS) !== 0)) bad('radius presence does not match flag 0x10');
    if ((o.scale !== null) !== ((o.flags & FLAG_SCALED) !== 0)) bad('scale presence does not match flag 0x100');
    if (o.links.length > 0xffff) bad('too many links');
    if (o.params.length > 0xffff) bad('too many parameters');
}

/** Serialise an object list. Byte-identical to the parsed input when the model is unmodified. */
export function writeObjectList(model: LvlObjectList): Uint8Array {
    const objs = model.objects;
    if (objs.length > 0xffff) throw new LvlError('more than 65535 objects');
    let size = 2 + objs.length * 8;
    for (const o of objs) {
        checkObject(o);
        size += bodySize(o);
    }
    const out = new Uint8Array(size);
    const dv = view(out);
    let w = 0;
    const u16 = (v: number): void => {
        dv.setUint16(w, v, true);
        w += 2;
    };
    const u32 = (v: number): void => {
        dv.setUint32(w, v >>> 0, true);
        w += 4;
    };
    const f32 = (v: number): void => {
        dv.setFloat32(w, v, true);
        w += 4;
    };
    u16(objs.length);
    for (const o of objs) {
        u32(o.id);
        u16(o.classId);
        u16(o.dbIndex);
    }
    for (const o of objs) {
        u32(o.prefix0);
        u32(o.prefix1);
        o.pos.forEach(f32);
        u32(o.flags);
        u16(o.initialEvents);
        if (o.radius !== null) f32(o.radius);
        u16(o.links.length);
        o.links.forEach(u32);
        for (const r of o.rot) {
            dv.setInt16(w, r, true);
            w += 2;
        }
        if (o.scale) o.scale.forEach(f32);
        u32(o.preSentinel);
        u32(o.sentinel);
        u32(o.data.length);
        u32(o.params.length);
        o.data.forEach(u32);
        for (const p of o.params) u16(p.fieldIndex);
        for (const p of o.params) {
            u32(p.type);
            u16(p.nameRaw.length);
            out.set(p.nameRaw, w);
            w += p.nameRaw.length;
        }
    }
    return out;
}

// ---------------------------------------------------------------- editing

export function findObject(model: LvlObjectList, id: number): LvlObject | undefined {
    return model.objects.find((o) => o.id === id);
}

function need(model: LvlObjectList, id: number): LvlObject {
    const o = findObject(model, id);
    if (!o) throw new LvlEditError(`no object with id ${id}`);
    return o;
}

function finiteVec(v: readonly number[], what: string): Vec3 {
    if (v.length !== 3 || !v.every(Number.isFinite)) throw new LvlEditError(`${what} must be three finite numbers`);
    return [v[0]!, v[1]!, v[2]!];
}

/** Set the world position (f32 world units). */
export function moveObject(model: LvlObjectList, id: number, pos: readonly number[]): void {
    need(model, id).pos = finiteVec(pos, 'position').map(Math.fround) as Vec3;
}

/** Set the rotation in whole signed degrees (each -32768..32767; the Euler composition order is not decoded). */
export function rotateObject(model: LvlObjectList, id: number, rotDeg: readonly number[]): void {
    const r = finiteVec(rotDeg, 'rotation');
    if (!r.every((d) => Number.isInteger(d) && d >= -32768 && d <= 32767)) {
        throw new LvlEditError('rotation must be integer degrees in the i16 range');
    }
    need(model, id).rot = r;
}

/** Set the scale. Only allowed when flag 0x100 is already set (turning it on is not supported yet). */
export function scaleObject(model: LvlObjectList, id: number, scale: readonly number[]): void {
    const o = need(model, id);
    if (!(o.flags & FLAG_SCALED) || !o.scale) throw new LvlEditError(`object ${id} has no scale (flag 0x100 not set)`);
    o.scale = finiteVec(scale, 'scale').map(Math.fround) as Vec3;
}

/** Ids of objects whose link list contains `id`. */
export function linkedFrom(model: LvlObjectList, id: number): number[] {
    return model.objects.filter((o) => o.links.includes(id)).map((o) => o.id);
}

/** Links that point at an id not present in the list. */
export function danglingLinks(model: LvlObjectList): { from: number; to: number }[] {
    const ids = new Set(model.objects.map((o) => o.id));
    const out: { from: number; to: number }[] = [];
    for (const o of model.objects) for (const to of o.links) if (!ids.has(to)) out.push({ from: o.id, to });
    return out;
}

export type ReferencedPolicy = 'throw' | 'unlink' | 'ignore';

export interface DeleteResult {
    /** Objects that linked to the deleted one. */
    referencedBy: number[];
}

/**
 * Delete an object (table entry and body). If other objects link to it, `onReferenced` decides: `'throw'` (default,
 * nothing changes), `'unlink'` (drop the id from their link lists) or `'ignore'` (leave dangling links; the game's
 * behaviour for those is unverified). Object ids appearing inside parameter data are NOT scanned: parameter value
 * semantics per class are undecoded, so a parameter that holds an object id would be left stale.
 */
export function deleteObject(model: LvlObjectList, id: number, onReferenced: ReferencedPolicy = 'throw'): DeleteResult {
    const idx = model.objects.findIndex((o) => o.id === id);
    if (idx < 0) throw new LvlEditError(`no object with id ${id}`);
    const referencedBy = linkedFrom(model, id).filter((r) => r !== id);
    if (referencedBy.length && onReferenced === 'throw') {
        throw new LvlEditError(`object ${id} is linked from ${referencedBy.join(', ')}`);
    }
    if (onReferenced === 'unlink') for (const o of model.objects) o.links = o.links.filter((l) => l !== id);
    model.objects.splice(idx, 1);
    return { referencedBy };
}

/**
 * Duplicate an object under a new unique id (max id + 1, appended so ids stay ascending). Everything is deep-copied,
 * including the link list (the copy triggers the same targets; nothing links to the copy). `offset` shifts the copy.
 */
export function duplicateObject(model: LvlObjectList, id: number, offset: readonly number[] = [0, 0, 0]): LvlObject {
    const src = need(model, id);
    if (model.objects.length >= 0xffff) throw new LvlEditError('object list is full (65535)');
    const off = finiteVec(offset, 'offset');
    const newId = model.objects.reduce((m, o) => Math.max(m, o.id), 0) + 1;
    if (newId > 0xffffffff) throw new LvlEditError('no free id');
    const copy: LvlObject = {
        ...src,
        id: newId,
        pos: src.pos.map((v, i) => Math.fround(v + off[i]!)) as Vec3,
        links: [...src.links],
        rot: [...src.rot],
        scale: src.scale ? ([...src.scale] as Vec3) : null,
        data: [...src.data],
        params: src.params.map((p) => ({ ...p, nameRaw: p.nameRaw.slice() })),
    };
    model.objects.push(copy);
    return copy;
}

// ---------------------------------------------------------------- add / links / parameters

export interface NewObjectSpec {
    classId: number;
    dbIndex: number;
    pos: readonly number[];
    /** Signed degrees (default 0, 0, 0). */
    rot?: readonly number[];
    /** Only applied when the template (or default) body has flag 0x100. */
    scale?: readonly number[];
    /** Id to give the object; default is max id + 1 (ids must stay ascending, so it must be above every other id). */
    id?: number;
    /** Copy the body of this object instead of searching for an instance of the class. */
    templateId?: number;
}

export interface AddObjectResult {
    object: LvlObject;
    /** `template`: body copied from an existing instance of the class; `default`: minimal body (flags 0x01, no parameters). */
    from: 'template' | 'default';
    templateId?: number;
}

/**
 * Add a new object of a class. The body is templated from an existing instance of the same (class id, db index): flags,
 * radius, event count, scale, data and parameters are copied (so it carries that instance's parameter overrides), links
 * are emptied and the transform replaced. Without an instance a minimal body is written: visible flag, one initial event,
 * no parameters (every field then takes the class default). Class default values are not decoded (level-format.md
 * section 8), so a default-body object is unverified in game. Appended with the next free id so ids stay ascending.
 */
export function addObject(model: LvlObjectList, spec: NewObjectSpec): AddObjectResult {
    if (model.objects.length >= 0xffff) throw new LvlEditError('object list is full (65535)');
    if (!Number.isInteger(spec.classId) || spec.classId < 0 || spec.classId > 0xffff) {
        throw new LvlEditError('class id must be a u16');
    }
    if (!Number.isInteger(spec.dbIndex) || spec.dbIndex < 0 || spec.dbIndex > 0xffff) {
        throw new LvlEditError('db index must be a u16');
    }
    const pos = finiteVec(spec.pos, 'position').map(Math.fround) as Vec3;
    const rot = finiteVec(spec.rot ?? [0, 0, 0], 'rotation');
    if (!rot.every((d) => Number.isInteger(d) && d >= -32768 && d <= 32767)) {
        throw new LvlEditError('rotation must be integer degrees in the i16 range');
    }
    const maxId = model.objects.reduce((m, o) => Math.max(m, o.id), 0);
    const id = spec.id ?? maxId + 1;
    if (!Number.isInteger(id) || id <= maxId || id > 0xffffffff)
        throw new LvlEditError(`id ${id} is not above every existing id`);
    const tpl =
        spec.templateId !== undefined
            ? need(model, spec.templateId)
            : model.objects.find((o) => o.classId === spec.classId && o.dbIndex === spec.dbIndex);
    let obj: LvlObject;
    if (tpl) {
        obj = {
            ...tpl,
            id,
            classId: spec.classId,
            dbIndex: spec.dbIndex,
            pos,
            rot,
            links: [],
            scale: tpl.scale ? ((spec.scale ? finiteVec(spec.scale, 'scale') : [...tpl.scale]) as Vec3) : null,
            data: [...tpl.data],
            params: tpl.params.map((p) => ({ ...p, nameRaw: p.nameRaw.slice() })),
        };
        if (obj.scale) obj.scale = obj.scale.map(Math.fround) as Vec3;
    } else {
        obj = {
            id,
            classId: spec.classId,
            dbIndex: spec.dbIndex,
            prefix0: 0,
            prefix1: 0,
            pos,
            flags: FLAG_VISIBLE,
            initialEvents: 1,
            radius: null,
            links: [],
            rot,
            scale: null,
            preSentinel: 0,
            sentinel: LVL_SENTINEL,
            data: [],
            params: [],
        };
    }
    model.objects.push(obj);
    return { object: obj, from: tpl ? 'template' : 'default', ...(tpl ? { templateId: tpl.id } : {}) };
}

/** Replace the link list (ids of other objects; duplicates removed, order kept). Dangling ids are allowed (validation reports them). */
export function setObjectLinks(model: LvlObjectList, id: number, links: readonly number[]): void {
    if (!links.every((l) => Number.isInteger(l) && l >= 0 && l <= 0xffffffff)) {
        throw new LvlEditError('link ids must be u32');
    }
    need(model, id).links = [...new Set(links)];
}

/** Parameter types whose value is one plain dword in `data[i]` (not a string or an array). */
export function isScalarParam(type: number): boolean {
    return (type & 0x1000) === 0 && (type & 0xff) !== 0x0a;
}

export type ParamValue = number | string | number[];

/** Typed view of parameter `i` (strings decoded, arrays as dwords, int signed, float f32, others as stored). */
export function paramValue(o: LvlObject, i: number): ParamValue {
    const p = o.params[i];
    const dword = o.data[i];
    if (!p || dword === undefined) throw new LvlEditError(`object ${o.id} has no parameter ${i}`);
    const base = p.type & 0xff;
    if ((p.type & 0x1000) !== 0 || base === 0x0a) {
        const off = dword & 0xffff;
        const len = dword >>> 16;
        const words = o.data.slice(off, off + len);
        if (base === 0x0a && (p.type & 0x1000) === 0) {
            const bytes: number[] = [];
            for (const w of words) bytes.push(w & 255, (w >>> 8) & 255, (w >>> 16) & 255, w >>> 24);
            const z = bytes.indexOf(0);
            return String.fromCharCode(...(z < 0 ? bytes : bytes.slice(0, z)));
        }
        return words;
    }
    const dv = new DataView(new ArrayBuffer(4));
    dv.setUint32(0, dword);
    if (base === 2) return dv.getFloat32(0);
    if (base === 1) return dv.getInt32(0);
    return dword;
}

/** Overwrite a scalar parameter (int, float, bool, enum, colour, ids). Strings and arrays are not editable. */
export function setParamScalar(model: LvlObjectList, id: number, i: number, value: number): void {
    const o = need(model, id);
    const p = o.params[i];
    if (!p) throw new LvlEditError(`object ${id} has no parameter ${i}`);
    if (!isScalarParam(p.type)) throw new LvlEditError(`parameter "${p.name}" is a string or array; not editable`);
    if (!Number.isFinite(value)) throw new LvlEditError('value must be finite');
    const dv = new DataView(new ArrayBuffer(4));
    if ((p.type & 0xff) === 2) dv.setFloat32(0, value);
    else dv.setUint32(0, value >>> 0);
    o.data[i] = dv.getUint32(0);
}

/**
 * Drop parameter `i` so the field falls back to the class default. Refused when the object has any string or array
 * parameter: their offsets point into `data` and shifting them is unverified.
 */
export function removeParam(model: LvlObjectList, id: number, i: number): void {
    const o = need(model, id);
    if (!o.params[i]) throw new LvlEditError(`object ${id} has no parameter ${i}`);
    if (o.params.some((p) => !isScalarParam(p.type))) {
        throw new LvlEditError(`object ${id} has string or array parameters; resetting a parameter is not supported`);
    }
    if (o.data.length !== o.params.length) throw new LvlEditError(`object ${id} has a data area beyond its parameters`);
    o.params.splice(i, 1);
    o.data.splice(i, 1);
}

// ---------------------------------------------------------------- SRSC glue

export interface Lvl {
    header: LvlHeader;
    list: LvlObjectList;
}

function entryOf(lvl: SrscReader, type: number): SrscEntry {
    const e = lvl.entries.find((x) => x.type === type);
    if (!e) throw new SrscError(`no 0x${type.toString(16).padStart(4, '0')} entry in the LVL`);
    return e;
}

/** Read both entries of a level LVL (stored bytes, no decompression: the entries are not zlib on disc). */
export async function readLvl(lvl: SrscReader): Promise<Lvl> {
    return {
        header: parseLevelHeader(await lvl.readRaw(entryOf(lvl, LVL_TYPE_HEADER))),
        list: parseObjectList(await lvl.readRaw(entryOf(lvl, LVL_TYPE_OBJECTS))),
    };
}

/**
 * Re-pack the LVL with the edited object list (every other entry is untouched). If the list serialises to the stored
 * bytes the archive is returned unchanged, so an unmodified level re-packs byte-identically.
 */
export async function writeLvl(lvl: SrscReader, list: LvlObjectList): Promise<Uint8Array> {
    const e = entryOf(lvl, LVL_TYPE_OBJECTS);
    const payload = writeObjectList(list);
    const stored = await lvl.readRaw(e);
    const same = stored.length === payload.length && stored.every((v, i) => v === payload[i]);
    return writeSrsc(lvl, same ? new Map() : new Map([[e.index, payload]]));
}

// ---------------------------------------------------------------- class names

export interface ResolvedClass {
    /** ODB stem the dependency path maps to, e.g. `NPCS`; undefined if the db_index is not in the table. */
    db?: string;
    class?: OdbClass;
}

/** (class_id, db_index) -> dependency path -> ODB stem -> 0x0102 record. */
export function resolveClass(header: LvlHeader, odbs: OdbIndex, classId: number, dbIndex: number): ResolvedClass {
    const path = dependencyPath(header, dbIndex);
    if (path === undefined) return {};
    const db = odbStemForDependency(path);
    return { db, class: odbs.get(db)?.get(classId) };
}

// Class-name resolution (ODB 0x0102) is part of the level API.
export * from './odb.ts';
