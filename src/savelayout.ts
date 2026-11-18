/**
 * Save layout of a content pack: the part of a pack a save depends on, and the pack `build` id that follows it.
 *
 * A save (`.rsg`) restores the level's changed objects from records that name their class by `(database, class id)`,
 * and it lists the level's untouched objects by their object id (uid); the game recreates those from the level file
 * (docs/journal/2026-11-16/save-compat.md). Models, textures, sounds, animations, music, terrain, object positions and
 * class defaults are read from the pack again when a save loads. So a save stays valid across pack rebuilds as long as
 *
 *  - every class id it can name still holds the same class (name, engine class, field count) in the same database, and
 *  - every object id of a level still holds an object of the same class, and the level's database list is unchanged.
 *
 * New classes, new levels and new objects (ids no save has seen) do not hurt an old save: its records never name them,
 * and an old save simply does not recreate an object it did not list.
 *
 * The game refuses a save whose recorded pack `build` differs from the installed one (modding.md "Saves and pack
 * builds"). `chooseSaveBuild` turns that into a save-format id: a rebuilt pack keeps the previous pack's `build` while
 * its layout only grows, and gets a new one (the layout hash) as soon as a class id or an object id changes meaning.
 * `classIdPins` hands the previous pack's class ids to the converter so that a new class does not renumber the others.
 */
import { SrscReader } from './srsc.ts';
import { readLvl } from './lvl.ts';
import { odbStemForDependency, parseClassBody, parseOdbClasses } from './odb.ts';
import { splitClassRecord } from './odbwrite.ts';
import { crc32 } from './packbuild.ts';

/** Key -> signature. Keys: `class|<ODB file>|<id>`, `deps|<level path>`, `obj|<level path>|<uid>`, `entry|<path>`. */
export type SaveLayout = Map<string, string> & {
    readonly databases?: ReadonlyMap<string, ReadonlyMap<number, string>>;
};

const upper = (s: string): string => s.replace(/[a-z]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 32));
const lower = (s: string): string => s.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));
const norm = (p: string): string => p.replace(/\\/g, '/');
const baseName = (p: string): string => norm(p).split('/').pop() ?? p;

const CLASS_ENTRY = /^(?:new|overrides)\/([^/]+\.ODB)\/0102_(\d+)_\d+\.bin$/i;
const LEVEL_ENTRY = /^(?:new|overrides)\/[^/]+\.LVL\//i;

/** The signature of a class record (name, engine class, field count). Null when the record does not read. */
export function classSignature(record: Uint8Array): string | null {
    try {
        const { name, body } = splitClassRecord(record);
        const b = parseClassBody(body);
        return b ? `${name.trim()}|${b.rflClass}|${b.fieldCount}` : null;
    } catch {
        return null;
    }
}

/** The save layout of a pack's files (keyed by path inside the pack, as zipped). */
export async function packSaveLayout(files: Readonly<Record<string, Uint8Array>>): Promise<SaveLayout> {
    const databases = new Map<string, ReadonlyMap<number, string>>();
    const out = Object.assign(new Map<string, string>(), { databases });
    for (const path of Object.keys(files).sort()) {
        const data = files[path]!;
        const p = norm(path);
        const cls = CLASS_ENTRY.exec(p);
        if (cls) {
            out.set(`class|${upper(cls[1]!)}|${Number(cls[2])}`, classSignature(data) ?? `raw ${crc32(data)}`);
            continue;
        }
        if (LEVEL_ENTRY.test(p)) {
            out.set(`entry|${lower(p)}`, `raw ${crc32(data)}`);
            continue;
        }
        if (!/^files\//i.test(p)) continue;
        if (/\.ODB$/i.test(p)) {
            const file = upper(baseName(p));
            for (const [id, c] of await parseOdbClasses(await SrscReader.fromBytes(data)))
                out.set(
                    `class|${file}|${id}`,
                    `${c.name.trim()}|${c.rflClass ?? (c.runtimeClass ?? -1) & 0xffff}|${c.fields?.length ?? -1}`,
                );
        } else if (/\.LVL$/i.test(p)) {
            const level = lower(p);
            const lvl = await readLvl(await SrscReader.fromBytes(data));
            out.set(`deps|${level}`, lvl.header.dependencies.map((d) => d.path.text).join('\n'));
            databases.set(level, new Map(lvl.header.dependencies.map((d) => [d.dbIndex, d.path.text])));
            for (const o of lvl.list.objects) out.set(`obj|${level}|${o.id}`, `${o.dbIndex}:${o.classId}`);
        }
    }
    return out;
}

const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const MASK64 = 0xffffffffffffffffn;

/** FNV-1a 64 over `<key>\0<signature>\n` of every key in sorted order, as 16 hex digits. */
export function saveLayoutId(layout: SaveLayout): string {
    const enc = new TextEncoder();
    let h = FNV_OFFSET;
    for (const k of [...layout.keys()].sort()) {
        for (const b of enc.encode(`${k}\0${layout.get(k)}\n`)) h = ((h ^ BigInt(b)) * FNV_PRIME) & MASK64;
    }
    return h.toString(16).padStart(16, '0');
}

export interface SaveLayoutDiff {
    /** True when every key of the previous layout is still there with the same signature (the layout only grew). */
    compatible: boolean;
    /** Keys whose signature changed (`key: before -> after`). */
    changed: string[];
    /** Keys of the previous layout that are gone. */
    removed: string[];
    /** Number of keys that are new. */
    added: number;
}

function canRecreateObject(
    previous: SaveLayout,
    next: SaveLayout,
    key: string,
    before: string,
    after: string,
): boolean {
    if (!key.startsWith('obj|')) return false;
    const [, level = ''] = key.split('|');
    const depsKey = `deps|${level}`;
    const deps = previous.get(depsKey);
    if (!deps || deps !== next.get(depsKey)) return false;
    const [oldDb, oldId] = before.split(':');
    const [newDb, newId] = after.split(':');
    if (oldDb !== newDb) return false;
    const dependency = previous.databases?.get(level)?.get(Number(oldDb));
    if (!dependency || dependency !== next.databases?.get(level)?.get(Number(newDb))) return false;
    const odb = odbStemForDependency(dependency);
    const oldClass = `class|${odb}.ODB|${oldId}`;
    const newClass = `class|${odb}.ODB|${newId}`;
    // Untouched objects restore by UID. Written records can still use their original class after a model split.
    const signature = previous.get(oldClass);
    return (
        signature !== undefined &&
        !signature.startsWith('raw ') &&
        signature === next.get(oldClass) &&
        signature === next.get(newClass)
    );
}

function databaseSlotsChanged(previous: SaveLayout, next: SaveLayout, key: string): boolean {
    if (!key.startsWith('deps|')) return false;
    const level = key.slice('deps|'.length);
    const before = previous.databases?.get(level);
    const after = next.databases?.get(level);
    return (
        !!before &&
        !!after &&
        (before.size !== after.size || Array.from(before).some(([index, name]) => name !== after.get(index)))
    );
}

export function compareSaveLayouts(previous: SaveLayout, next: SaveLayout): SaveLayoutDiff {
    const changed: string[] = [];
    const removed: string[] = [];
    for (const [k, v] of previous) {
        const n = next.get(k);
        if (n === undefined) removed.push(k);
        else if (n !== v && !canRecreateObject(previous, next, k, v, n)) changed.push(`${k}: ${v} -> ${n}`);
        else if (databaseSlotsChanged(previous, next, k)) changed.push(`${k}: database IDs changed`);
    }
    let added = 0;
    for (const k of next.keys()) if (!previous.has(k)) added++;
    return { compatible: !changed.length && !removed.length, changed, removed, added };
}

export interface SaveBuildChoice {
    build: string;
    /** True when the previous pack's build was kept (its saves stay loadable). */
    kept: boolean;
    /** The comparison with the previous pack, when there was one. */
    diff?: SaveLayoutDiff;
}

/**
 * The `build` for a new pack: the previous pack's build when the new layout only adds to the previous one, else the
 * hash of the new layout (deterministic, so two conversions with the same layout agree without a previous pack).
 */
export function chooseSaveBuild(next: SaveLayout, previous?: { build: string; layout: SaveLayout }): SaveBuildChoice {
    if (!previous) return { build: saveLayoutId(next), kept: false };
    const diff = compareSaveLayouts(previous.layout, next);
    return diff.compatible
        ? { build: previous.build, kept: true, diff }
        : { build: saveLayoutId(next), kept: false, diff };
}

/**
 * ODB file (upper case, e.g. `RESOURES.ODB`) -> `<class name>|<engine class>` -> the ids classes of that name and engine
 * class had, ascending. The engine class is part of the key: two unrelated classes can share a name (a PC "Ebon Knight"
 * creature and a door of the same name).
 */
export type ClassIdPins = ReadonlyMap<string, ReadonlyMap<string, readonly number[]>>;

/** The class ids a previous pack gave its added classes (`new/<ODB>/0102_<id>_<group>.bin`), for `ClassIdPinner`. */
export function classIdPins(files: Readonly<Record<string, Uint8Array>>): ClassIdPins {
    const out = new Map<string, Map<string, number[]>>();
    for (const [path, data] of Object.entries(files)) {
        const m = /^new\/([^/]+\.ODB)\/0102_(\d+)_\d+\.bin$/i.exec(norm(path));
        if (!m) continue;
        let key: string;
        try {
            const { name, body } = splitClassRecord(data);
            key = `${name.trim()}|${parseClassBody(body)?.rflClass ?? -1}`;
        } catch {
            continue;
        }
        const file = upper(m[1]!);
        const byName = out.get(file) ?? out.set(file, new Map()).get(file)!;
        (byName.get(key) ?? byName.set(key, []).get(key)!).push(Number(m[2]));
    }
    for (const byName of out.values()) for (const ids of byName.values()) ids.sort((a, b) => a - b);
    return out;
}

/**
 * Hands out pinned class ids: the k-th class named N with engine class R in an ODB gets the k-th id the previous pack
 * gave such a class there. Every pinned id of a file stays reserved (`reserved`), so a fresh id never reuses one: classes the converter
 * adds go above them and the ids of the others do not move. One pinner per allocation pass.
 */
export class ClassIdPinner {
    private readonly used = new Map<string, Set<number>>();
    private readonly count = new Map<string, number>();
    constructor(private readonly pins?: ClassIdPins) {}

    /** Every pinned id of the file (upper or lower case name). */
    reserved(file: string): Set<number> {
        const out = new Set<number>();
        for (const ids of this.pins?.get(upper(file))?.values() ?? []) for (const id of ids) out.add(id);
        return out;
    }

    /** Highest pinned id of the file, 0 without pins. */
    top(file: string): number {
        let m = 0;
        for (const id of this.reserved(file)) m = Math.max(m, id);
        return m;
    }

    /**
     * The pinned id of the next class named `name` of engine class `rfl` in `file`, or undefined (no pin, or the pin is
     * taken by `taken`, a disc class of that id). Each call counts as one class of that name and engine class.
     */
    take(file: string, name: string, rfl: number, taken?: ReadonlySet<number>): number | undefined {
        const f = upper(file);
        const pin = `${name.trim()}|${rfl}`;
        const key = `${f}|${pin}`;
        const k = this.count.get(key) ?? 0;
        this.count.set(key, k + 1);
        const id = this.pins?.get(f)?.get(pin)?.[k];
        const used = this.used.get(f) ?? this.used.set(f, new Set()).get(f)!;
        if (id === undefined || used.has(id) || taken?.has(id)) return undefined;
        used.add(id);
        return id;
    }
}
