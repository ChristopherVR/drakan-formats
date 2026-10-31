import { latin1, view } from './bytes.ts';
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

/** Class records of one ODB, keyed by class id (a later record with the same id wins, as in lvl_objects.py). */
export async function parseOdbClasses(odb: SrscReader): Promise<Map<number, OdbClass>> {
    const out = new Map<number, OdbClass>();
    for (const e of odb.entries) {
        if (e.type !== ODB_CLASS_TYPE) continue;
        const p = await odb.readRaw(e);
        if (p.length < 2) continue;
        const nl = view(p).getUint16(0, true);
        if (2 + nl > p.length) continue;
        out.set(e.id, {
            id: e.id,
            name: nulTerminated(p.subarray(2, 2 + nl)),
            group: e.sub,
            runtimeClass: odbRuntimeClass(p.subarray(2 + nl)),
        });
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
