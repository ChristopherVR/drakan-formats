import { latin1, view } from './bytes.ts';
import type { ClassFieldDef } from './fields.ts';
import {
    FLAG_SCALED,
    LVL_SENTINEL,
    LVL_TYPE_HEADER,
    LVL_TYPE_OBJECTS,
    LvlError,
    parseLevelHeader,
    type LvlHeader,
    type LvlObject,
    type LvlObjectList,
    type LvlParam,
    type Vec3,
} from './lvl.ts';
import { ODB_CLASS_TYPE, type OdbClass } from './odb.ts';
import { SrscReader } from './srsc.ts';
import { LVL_TYPE_LAYERS, parsePcTerrain, type TerrainLayer } from './terrain.ts';

/**
 * Drakan: Order of the Flame (PC) readers. The PC files use the same SRSC family as the PS2 game with a 12-byte header
 * (srsc.ts) and a different packing of the object list, class records and terrain. Layouts: docs/reference/level-format.md
 * section 9; the object and class layouts follow OpenDrakan (Zalasus, GPL-3.0, commit 6c0d499, `doc/lvl_format.txt`,
 * `doc/riot_database_format.txt`) and were checked against all 23 retail OotF level files.
 *
 * The parsers return the same model types as the PS2 readers (`LvlObjectList`, `OdbClass`, `TerrainLayer`) so the
 * editor viewport, inspector and the PC to PS2 converter (convert.ts) work on either platform.
 */

class PcCursor {
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
}

function nulText(raw: Uint8Array): string {
    const z = raw.indexOf(0);
    return latin1(raw, 0, z < 0 ? raw.length : z);
}

/** Degrees 0..359 (PC) to the signed form the PS2 list stores. */
export function signedDegrees(d: number): number {
    const m = ((d % 360) + 360) % 360;
    return m > 180 ? m - 360 : m;
}

function parsePcBody(c: PcCursor): LvlObject {
    const id = c.u32();
    const classId = c.u16();
    const dbIndex = c.u16();
    const prefix0 = c.u32();
    const pos: Vec3 = [c.f32(), c.f32(), c.f32()];
    const flags = c.u32();
    const initialEvents = c.u16();
    const nLinks = c.u16();
    c.need(nLinks * 2);
    const links: number[] = [];
    for (let i = 0; i < nLinks; i++) links.push(c.u16());
    const rot: Vec3 = [signedDegrees(c.u16()), signedDegrees(c.u16()), signedDegrees(c.u16())];
    const scale: Vec3 | null = flags & FLAG_SCALED ? [c.f32(), c.f32(), c.f32()] : null;
    const dataDwords = c.u32();
    const nParams = c.u32();
    if (!pos.every(Number.isFinite)) throw new LvlError(`object id ${id}: non-finite position`);
    c.need(dataDwords * 4);
    const data: number[] = [];
    for (let i = 0; i < dataDwords; i++) data.push(c.u32());
    c.need(nParams * 2);
    const indices: number[] = [];
    for (let i = 0; i < nParams; i++) indices.push(c.u16());
    const params: LvlParam[] = [];
    for (let i = 0; i < nParams; i++) {
        const type = c.u32();
        const nameRaw = c.raw(c.u16());
        params.push({ fieldIndex: indices[i]!, type, nameRaw, name: nulText(nameRaw) });
    }
    return {
        id,
        classId,
        dbIndex,
        prefix0,
        prefix1: 0,
        pos,
        flags,
        initialEvents,
        radius: null,
        links,
        rot,
        scale,
        preSentinel: 0,
        sentinel: LVL_SENTINEL,
        data,
        params,
    };
}

/**
 * Parse a PC LVL 0x0020 payload: `u16 count`, then self-contained bodies. Throws LvlError unless the bodies consume the
 * payload exactly. Link ids (u16 on PC) and rotations are widened to the PS2 model.
 */
export function parsePcObjectList(data: Uint8Array): LvlObjectList {
    const c = new PcCursor(data);
    const count = c.u16();
    const objects: LvlObject[] = [];
    for (let i = 0; i < count; i++) {
        try {
            objects.push(parsePcBody(c));
        } catch (e) {
            if (e instanceof LvlError) throw new LvlError(`PC object ${i}: ${e.message}`);
            throw e;
        }
    }
    if (c.o !== data.length) throw new LvlError(`${data.length - c.o} bytes left after the last PC object`);
    const warnings: string[] = [];
    const seen = new Set<number>();
    objects.forEach((o, i) => {
        if (seen.has(o.id)) warnings.push(`duplicate object id ${o.id} at index ${i}`);
        seen.add(o.id);
    });
    return { objects, warnings };
}

/**
 * Class records of a PC ODB, keyed by class id. PC 0x0102 body: `string name, u16 group, u16 model id, u16 model db,
 * u16 rfl_class_id, u16 icon, u32 field_count, u32 dword_count, u32 data[], field_count x {u32 type, string name}`.
 */
export function parsePcClassRecord(e: { id: number; sub: number }, p: Uint8Array): OdbClass | null {
    if (p.length < 2) return null;
    const dv = view(p);
    const nl = dv.getUint16(0, true);
    if (2 + nl + 18 > p.length) return null;
    const name = nulText(p.subarray(2, 2 + nl));
    const c = new PcCursor(p);
    c.o = 2 + nl;
    try {
        const group = c.u16();
        const modelId = c.u16();
        const modelDb = c.u16();
        const rflClass = c.u16();
        const icon = c.u16();
        const fieldCount = c.u32();
        const dwords = c.u32();
        c.need(dwords * 4);
        const data: number[] = [];
        for (let i = 0; i < dwords; i++) data.push(c.u32());
        const fields: ClassFieldDef[] = [];
        for (let i = 0; i < fieldCount; i++) {
            const type = c.u32();
            fields.push({ type, name: nulText(c.raw(c.u16())) });
        }
        if (c.o !== p.length) return null;
        return {
            id: e.id,
            name,
            group: group || e.sub,
            runtimeClass: rflClass,
            model: modelId ? { id: modelId, db: modelDb } : null,
            rflClass,
            icon,
            fields,
            data,
        };
    } catch {
        return null;
    }
}

export async function parsePcOdbClasses(odb: SrscReader): Promise<Map<number, OdbClass>> {
    const out = new Map<number, OdbClass>();
    for (const e of odb.entries) {
        if (e.type !== ODB_CLASS_TYPE) continue;
        const cls = parsePcClassRecord(e, await odb.readRaw(e));
        if (cls) out.set(e.id, cls);
    }
    return out;
}

/** Key of a PC dependency path: the lower-case last component (`..\..\Common\NPC\NPCs` -> `npcs`). */
export function pcDependencyKey(path: string): string {
    const parts = path.split(/[\\/]/).filter((c) => c !== '');
    return (parts[parts.length - 1] ?? '').toLowerCase();
}

/** Resolve a dependency path against the directory of the file that lists it (`..` and `.` collapse). */
export function resolvePcPath(baseDir: string, rel: string): string {
    const out = baseDir.split(/[\\/]/).filter((c) => c !== '' && c !== '.');
    for (const c of rel.split(/[\\/]/)) {
        if (c === '' || c === '.') continue;
        if (c === '..') out.pop();
        else out.push(c);
    }
    return out.join('/');
}

/** Read access to an OotF install tree (paths use `/`, case-insensitive on lookup). */
export interface PcFileSource {
    read(path: string): Promise<Uint8Array | null>;
    /** Every file path below the root (used to find levels). */
    list(): Promise<string[]>;
}

export interface PcLevel {
    /** Level file path, e.g. `Multiplayer/Ground/Relic/Relic.lvl`. */
    path: string;
    header: LvlHeader;
    list: LvlObjectList;
    terrain: TerrainLayer[];
    /** Class tables keyed by `db_index` of the level's dependency table (own ODB included when it has one). */
    classes: Map<number, Map<number, OdbClass>>;
    /** db_index -> ODB path that was read. */
    odbPaths: Map<number, string>;
    warnings: string[];
}

/** PC level display name: the `<0xNNNN>` localised-string prefix is dropped. */
export function pcLevelName(h: LvlHeader): string {
    return h.name.text.replace(/^<0x[0-9a-fA-F]+>\s*/, '');
}

/** Load a PC `.lvl` with its terrain and the class tables of every dependency whose `.odb` exists. */
export async function loadPcLevel(src: PcFileSource, lvlPath: string): Promise<PcLevel> {
    const bytes = await src.read(lvlPath);
    if (!bytes) throw new LvlError(`${lvlPath}: not found`);
    const lvl = await SrscReader.fromBytes(bytes);
    if (lvl.platform !== 'pc') throw new LvlError(`${lvlPath}: not a PC (Order of the Flame) level container`);
    const need = (type: number): Promise<Uint8Array> => {
        const e = lvl.entries.find((x) => x.type === type);
        if (!e) throw new LvlError(`${lvlPath}: no 0x${type.toString(16).padStart(4, '0')} entry`);
        return lvl.readRaw(e);
    };
    const header = parseLevelHeader(await need(LVL_TYPE_HEADER));
    const list = parsePcObjectList(await need(LVL_TYPE_OBJECTS));
    const terrain = parsePcTerrain(await need(LVL_TYPE_LAYERS));
    const warnings = [...list.warnings];
    const baseDir = lvlPath.split('/').slice(0, -1).join('/');
    const classes = new Map<number, Map<number, OdbClass>>();
    const odbPaths = new Map<number, string>();
    const cache = new Map<string, Map<number, OdbClass> | null>();
    for (const dep of header.dependencies) {
        const odbPath = `${resolvePcPath(baseDir, dep.path.text)}.odb`;
        let table = cache.get(odbPath.toLowerCase());
        if (table === undefined) {
            const raw = await src.read(odbPath);
            table = raw ? await parsePcOdbClasses(await SrscReader.fromBytes(raw)) : null;
            cache.set(odbPath.toLowerCase(), table);
        }
        if (table) {
            classes.set(dep.dbIndex, table);
            odbPaths.set(dep.dbIndex, odbPath);
        } else warnings.push(`dependency ${dep.dbIndex} (${dep.path.text}): ${odbPath} not found`);
    }
    return { path: lvlPath, header, list, terrain, classes, odbPaths, warnings };
}

/** Find every `.lvl` in an install tree (levels sit in their own folder beside their `.odb`). */
export async function findPcLevels(src: PcFileSource): Promise<string[]> {
    return (await src.list()).filter((p) => /\.lvl$/i.test(p)).sort();
}
