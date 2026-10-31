import { latin1, view } from './bytes.ts';
import { decodeFieldValue, type ClassFieldDef, type ClassFieldValue } from './fields.ts';
import { mangleComponent } from './levellist.ts';
import type { SrscReader } from './srsc.ts';

/** ODB 0x0102: class record (SRSC `id` = class id, `sub` = group id). Layout: docs/reference/level-format.md sections 1 and 5. */
export const ODB_CLASS_TYPE = 0x0102;

export interface OdbClass {
    id: number;
    name: string;
    /** SRSC `sub` of the record (group id; 0x0101 records name the groups). */
    group: number;
    /** Engine runtime class id from the record body (u32 at +80 when u16 at +14 is non-zero, else u32 at +16), or null. */
    runtimeClass: number | null;
    /** Model reference (`id`, `db` index in the ODB's own .DB dependency list); null for classes without a model. */
    model?: { id: number; db: number } | null;
    /** Class id the engine's RFL library knows the class by (the low 16 bits of `runtimeClass`). */
    rflClass?: number;
    /** Editor icon number (no gameplay effect). */
    icon?: number;
    /**
     * Field definitions in class order (name and type word, from the 0x0103 list that belongs to this record) and the
     * class data area: `data[i]` is the default of field i, strings and arrays point further into `data`
     * (level-format.md section 12). Absent when the record or its field list did not decode.
     */
    fields?: ClassFieldDef[];
    data?: number[];
}

/** Default value of field `i` of a class. */
export function classFieldDefault(c: Pick<OdbClass, 'fields' | 'data'>, i: number): ClassFieldValue | undefined {
    const f = c.fields?.[i];
    const dword = c.data?.[i];
    if (!f || dword === undefined) return undefined;
    return decodeFieldValue(f.type, dword, c.data!);
}

function nulTerminated(b: Uint8Array): string {
    const z = b.indexOf(0);
    return latin1(b, 0, z < 0 ? b.length : z);
}

/** Runtime class id from a 0x0102 body (the bytes after the name field). */
export function odbRuntimeClass(body: Uint8Array): number | null {
    if (body.length < 20) return null;
    const dv = view(body);
    const at = dv.getUint16(14, true) === 0 ? 16 : 80;
    return at + 4 <= body.length ? dv.getUint32(at, true) : null;
}

/** ODB 0x0103: the field-definition lists, zlib compressed, one list per 0x0102 record in record order. */
export const ODB_FIELDS_TYPE = 0x0103;
/** Offset (after the name string) of the field count in a class record with / without a model. */
const FIELD_COUNT_AT_MODEL = 86;
const FIELD_COUNT_AT_PLAIN = 22;

/** Parse the inflated 0x0103 blob into per-class definition lists; null unless it is consumed exactly. */
export function parseFieldLists(blob: Uint8Array): ClassFieldDef[][] | null {
    const dv = view(blob);
    const lists: ClassFieldDef[][] = [];
    let o = 0;
    while (o < blob.length) {
        if (o + 4 > blob.length) return null;
        const n = dv.getUint32(o, true);
        o += 4;
        if (n * 6 > blob.length - o) return null;
        const defs: ClassFieldDef[] = [];
        for (let i = 0; i < n; i++) {
            if (o + 6 > blob.length) return null;
            const type = dv.getUint32(o, true);
            const len = dv.getUint16(o + 4, true);
            if (o + 6 + len > blob.length) return null;
            defs.push({ type, name: nulTerminated(blob.subarray(o + 6, o + 6 + len)) });
            o += 6 + len;
        }
        lists.push(defs);
    }
    return lists;
}

export interface ClassBody {
    model: { id: number; db: number } | null;
    rflClass: number;
    icon: number;
    fieldCount: number;
    data: number[];
}

/** The class header and data area of a 0x0102 body (the bytes after the name field); null when it does not fit. */
export function parseClassBody(body: Uint8Array): ClassBody | null {
    if (body.length < 8) return null;
    const dv = view(body);
    const modelId = dv.getUint16(2, true);
    const at = modelId ? FIELD_COUNT_AT_MODEL : FIELD_COUNT_AT_PLAIN;
    if (at + 8 > body.length) return null;
    const fieldCount = dv.getUint32(at, true);
    const dwords = dv.getUint32(at + 4, true);
    if (at + 8 + dwords * 4 !== body.length) return null;
    const data: number[] = [];
    for (let i = 0; i < dwords; i++) data.push(dv.getUint32(at + 8 + i * 4, true));
    const hdr = modelId ? 80 : 16;
    return {
        model: modelId ? { id: modelId, db: dv.getUint16(4, true) } : null,
        rflClass: dv.getUint16(hdr, true),
        icon: dv.getUint16(hdr + 4, true),
        fieldCount,
        data,
    };
}

/** Class records of one ODB, keyed by class id (a later record with the same id wins, as in lvl_objects.py). */
export async function parseOdbClasses(odb: SrscReader): Promise<Map<number, OdbClass>> {
    const out = new Map<number, OdbClass>();
    const records = odb.entries.filter((e) => e.type === ODB_CLASS_TYPE);
    const fieldEntry = odb.entries.find((e) => e.type === ODB_FIELDS_TYPE);
    let lists: ClassFieldDef[][] | null = null;
    if (fieldEntry) {
        lists = parseFieldLists((await odb.read(fieldEntry)).data);
        if (lists && lists.length !== records.length) lists = null;
    }
    for (const [k, e] of records.entries()) {
        const p = await odb.readRaw(e);
        if (p.length < 2) continue;
        const nl = view(p).getUint16(0, true);
        if (2 + nl > p.length) continue;
        const body = p.subarray(2 + nl);
        const cls: OdbClass = {
            id: e.id,
            name: nulTerminated(p.subarray(2, 2 + nl)),
            group: e.sub,
            runtimeClass: odbRuntimeClass(body),
        };
        const parsed = lists ? parseClassBody(body) : null;
        const defs = lists?.[k];
        if (parsed && defs && parsed.fieldCount === defs.length) {
            cls.model = parsed.model;
            cls.rflClass = parsed.rflClass;
            cls.icon = parsed.icon;
            cls.fields = defs;
            cls.data = parsed.data;
        }
        out.set(e.id, cls);
    }
    return out;
}

/** ODB file stem for a dependency path (`..\..\Common\NPC\NPCs` -> `NPCS`): last component, disc-mangled. */
export function odbStemForDependency(path: string): string {
    const parts = path.split(/[\\/]/).filter((c) => c !== '');
    return mangleComponent(parts[parts.length - 1] ?? '');
}

/** All ODB class tables keyed by upper-case stem (`NPCS`, `SYSTEM`, ...). */
export type OdbIndex = ReadonlyMap<string, ReadonlyMap<number, OdbClass>>;

export async function buildOdbIndex(
    odbs: ReadonlyMap<string, SrscReader>,
): Promise<Map<string, Map<number, OdbClass>>> {
    const out = new Map<string, Map<number, OdbClass>>();
    for (const [stem, r] of odbs) out.set(stem.toUpperCase(), await parseOdbClasses(r));
    return out;
}
