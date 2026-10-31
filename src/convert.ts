import { zlibSync } from 'fflate';
import { view } from './bytes.ts';
import {
    FIELD_ANIMATION,
    FIELD_CHANNEL,
    FIELD_CLASS,
    FIELD_MODEL,
    FIELD_SEQUENCE,
    FIELD_SOUND,
    FIELD_TEXTURE,
    fieldBase,
    fieldIsArray,
    fieldIsIndirect,
    refParts,
    refValue,
    type ClassFieldDef,
} from './fields.ts';
import {
    FLAG_RADIUS,
    LVL_SENTINEL,
    LVL_TYPE_HEADER,
    LVL_TYPE_OBJECTS,
    objectParamSpecs,
    setObjectParams,
    writeLevelHeader,
    writeObjectList,
    type LvlHeader,
    type LvlObject,
    type LvlObjectList,
    type ParamSpec,
} from './lvl.ts';
import { odbStemForDependency, type OdbClass, type OdbIndex } from './odb.ts';
import { pcLevelName, type PcLevel } from './pc.ts';
import { writeSrsc, type SrscReader } from './srsc.ts';
import { buildPs2TerrainBlob } from './terrainblob.ts';
import {
    LVL_TYPE_LAYERS,
    TEX_HOLE,
    TEX_INVISIBLE,
    parsePs2Terrain,
    ps2TerrainBlockSize,
    terrainHeightAt,
    type TerrainLayer,
} from './terrain.ts';

/**
 * Order of the Flame (PC) level -> PS2 level conversion. The result is a drop-in `.LVL` for a mod pack
 * (`files/ENGLISH/LEVELS/<name>/<name>.LVL`, docs/reference/modding.md): the entries that describe the level (header,
 * terrain layers, layer groups, object list) are regenerated, every other entry (0x0003, 0x0025, ...) comes from a PS2
 * *template* level, so the PS2 engine finds the structure it expects.
 *
 * What converts mechanically: placement (position, rotation, scale, links), the layer grid (heights, diagonals, UVs,
 * lighting, visibility lists) and every class parameter whose field exists on the PS2 class under the same name.
 * What does not: anything that points at PC *resources* (models, textures, sounds, animations, sequences live in PC
 * containers with different ids), and PC classes that have no PS2 class of the same name. Those are reported, never
 * silently guessed: objects of unmapped classes are dropped (or sent to `placeholder`), resource parameters become 0,
 * terrain cells take `textureFallback` unless `mapTexture` knows better. Phase 3 (model / texture conversion) fills
 * these gaps through the same two hooks.
 */

export type ClassTables = ReadonlyMap<number, ReadonlyMap<number, OdbClass>>;

/** PS2 class tables keyed by the `db_index` of the *template's* dependency table. */
export function ps2ClassTables(header: LvlHeader, odbs: OdbIndex): Map<number, ReadonlyMap<number, OdbClass>> {
    const out = new Map<number, ReadonlyMap<number, OdbClass>>();
    for (const d of header.dependencies) {
        const t = odbs.get(odbStemForDependency(d.path.text));
        if (t) out.set(d.dbIndex, t);
    }
    return out;
}

export interface ClassTarget {
    dbIndex: number;
    classId: number;
    cls: OdbClass;
}

const squash = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '');

/**
 * PC class -> PS2 class by name (exact, then ignoring case, spaces and punctuation). When several PS2 classes share the
 * name the one with the same engine class (`rflClass`) wins, then the lowest `db_index`. Returns null when none matches.
 */
export function matchClass(pc: OdbClass, ps2: ClassTables): ClassTarget | null {
    const exact = pc.name.trim().toLowerCase();
    const loose = squash(pc.name);
    let best: (ClassTarget & { score: number }) | null = null;
    for (const [dbIndex, table] of [...ps2].sort((a, b) => a[0] - b[0])) {
        for (const [classId, cls] of table) {
            const n = cls.name.trim().toLowerCase();
            let score = n === exact ? 2 : squash(cls.name) === loose && loose !== '' ? 1 : 0;
            if (!score) continue;
            if (cls.rflClass !== undefined && cls.rflClass === pc.rflClass) score += 4;
            if (!best || score > best.score) best = { dbIndex, classId, cls, score };
        }
    }
    return best && { dbIndex: best.dbIndex, classId: best.classId, cls: best.cls };
}

export interface ConvertOptions {
    /** PS2 template level header (its dependency table is kept) and the class tables for it. */
    template: { header: LvlHeader; classes: ClassTables };
    /** Explicit PC class name (lower case) -> PS2 class, checked before name matching. `null` forces a drop. */
    classOverrides?: ReadonlyMap<string, ClassTarget | null>;
    /** PS2 class that stands in for PC classes without a counterpart (default: drop the object). */
    placeholder?: ClassTarget;
    /** Texture ref (`id | db << 16`, PC dependency index) -> PS2 ref. Return null to use `textureFallback`. */
    mapTexture?: (pcRef: number, pc: PcLevel) => number | null;
    /** PS2 ref used for every cell whose texture cannot be mapped (hole and invisible cells stay as they are). */
    textureFallback: number;
    /** Level name written to the header (default: the PC level's own name). */
    name?: string;
}

export interface ConversionReport {
    objectsIn: number;
    objectsOut: number;
    /** PC class name -> objects dropped because no PS2 class matched. */
    unmappedClasses: Map<string, number>;
    /** PC class name -> PS2 class name it was mapped to (for the preview / review). */
    mappedClasses: Map<string, string>;
    objectsPlaceholder: number;
    linksDropped: number;
    idsRenumbered: number;
    /** Parameter name -> count dropped because the PS2 class has no field of that name / type. */
    droppedParams: Map<string, number>;
    /** Resource parameters (model, sound, texture, ...) zeroed because PC resource ids do not exist on PS2. */
    zeroedResourceParams: number;
    cellsFallback: number;
    cellsMapped: number;
    layers: number;
    warnings: string[];
}

export interface Ps2LevelParts {
    header: LvlHeader;
    objects: LvlObjectList;
    terrain: TerrainLayer[];
    report: ConversionReport;
}

const bump = <K>(m: Map<K, number>, k: K, n = 1): void => void m.set(k, (m.get(k) ?? 0) + n);

function text(raw: Uint8Array): { raw: Uint8Array; text: string } {
    const z = raw.indexOf(0);
    return { raw, text: String.fromCharCode(...raw.subarray(0, z < 0 ? raw.length : z)) };
}

function encodeString(s: string): { raw: Uint8Array; text: string } {
    const n = s.length + 1;
    const raw = new Uint8Array(n + (n % 2));
    for (let i = 0; i < s.length; i++) raw[i] = s.charCodeAt(i) & 0xff;
    return text(raw);
}

/** Resource kinds whose ids live in PC containers and cannot be carried over by number. */
function isResourceField(type: number): boolean {
    const b = fieldBase(type);
    return (
        b === FIELD_MODEL ||
        b === FIELD_SOUND ||
        b === FIELD_ANIMATION ||
        b === FIELD_SEQUENCE ||
        b === FIELD_TEXTURE ||
        b === FIELD_CHANNEL
    );
}

export function convertPcLevel(pc: PcLevel, opt: ConvertOptions): Ps2LevelParts {
    const report: ConversionReport = {
        objectsIn: pc.list.objects.length,
        objectsOut: 0,
        unmappedClasses: new Map(),
        mappedClasses: new Map(),
        objectsPlaceholder: 0,
        linksDropped: 0,
        idsRenumbered: 0,
        droppedParams: new Map(),
        zeroedResourceParams: 0,
        cellsFallback: 0,
        cellsMapped: 0,
        layers: pc.terrain.length,
        warnings: [...pc.warnings],
    };
    const ps2 = opt.template.classes;

    // ---- class mapping, once per (db, class)
    const targets = new Map<string, ClassTarget | null>();
    const targetOf = (db: number, id: number): ClassTarget | null => {
        const key = `${db}:${id}`;
        if (targets.has(key)) return targets.get(key)!;
        const cls = pc.classes.get(db)?.get(id);
        let t: ClassTarget | null = null;
        if (cls) {
            const ov = opt.classOverrides?.get(cls.name.trim().toLowerCase());
            t = ov !== undefined ? ov : matchClass(cls, ps2);
            if (t) report.mappedClasses.set(cls.name, t.cls.name);
        }
        targets.set(key, t);
        return t;
    };
    /** PC class ref (db, id) -> PS2 ref dword, or 0. */
    const mapClassRef = (v: number): number => {
        const { id, db } = refParts(v);
        if (!id) return 0;
        // db 0 means the owning database, which is the level's own ODB (the PC dependency with the level's name).
        const t = targetOf(db, id);
        return t ? refValue(t.dbIndex, t.classId) : 0;
    };

    // ---- objects
    const used = new Set<number>();
    let nextId = pc.list.objects.reduce((m, o) => Math.max(m, o.id), 0) + 1;
    const idMap = new Map<number, number>();
    const out: LvlObject[] = [];
    const keep: { src: LvlObject; dst: LvlObject; fields: ClassFieldDef[] | undefined }[] = [];
    for (const src of pc.list.objects) {
        let t = targetOf(src.dbIndex, src.classId);
        const name = pc.classes.get(src.dbIndex)?.get(src.classId)?.name ?? `class ${src.classId}/${src.dbIndex}`;
        let placeholder = false;
        if (!t) {
            if (opt.placeholder) {
                t = opt.placeholder;
                placeholder = true;
                report.objectsPlaceholder++;
            } else {
                bump(report.unmappedClasses, name);
                continue;
            }
        }
        let id = src.id;
        if (used.has(id)) {
            id = nextId++;
            report.idsRenumbered++;
        }
        used.add(id);
        // The first occurrence keeps its id for links (the PC format does not say which one links mean).
        if (!idMap.has(src.id)) idMap.set(src.id, id);
        const dst: LvlObject = {
            id,
            classId: t.classId,
            dbIndex: t.dbIndex,
            prefix0: src.prefix0,
            prefix1: 0,
            pos: [...src.pos],
            flags: src.flags & ~FLAG_RADIUS,
            initialEvents: src.initialEvents,
            radius: null,
            links: [],
            rot: [...src.rot],
            scale: src.scale ? [...src.scale] : null,
            preSentinel: 0,
            sentinel: LVL_SENTINEL,
            data: [],
            params: [],
        };
        if (t.cls.name === 'Rynn') {
            // The PC start can hang well above the ground (Relic: 17000 units); the PS2 engine lets Rynn fall and the
            // fall kills her (in-game test), so she starts just over the terrain.
            const g = terrainHeightAt(pc.terrain, dst.pos[0], dst.pos[2]);
            if (Number.isFinite(g)) dst.pos[1] = g + 400;
        }
        out.push(dst);
        if (!placeholder) keep.push({ src, dst, fields: t.cls.fields });
    }
    out.sort((a, b) => a.id - b.id);

    // ---- links (u16 PC ids -> new ids; links to dropped objects vanish)
    const kept = new Set(out.map((o) => o.id));
    for (const { src, dst } of keep) {
        for (const l of src.links) {
            const to = idMap.get(l);
            if (to !== undefined && kept.has(to)) dst.links.push(to);
            else report.linksDropped++;
        }
    }

    // ---- parameters, by field name
    const list: LvlObjectList = { objects: out, warnings: [] };
    for (const { src, dst, fields } of keep) {
        if (!src.params.length) continue;
        const byName = new Map<string, number>();
        fields?.forEach((f, i) => {
            const k = f.name.trim().toLowerCase();
            if (!byName.has(k)) byName.set(k, i);
        });
        const specs: ParamSpec[] = [];
        const pcSpecs = objectParamSpecs(src);
        for (const s of pcSpecs) {
            const i = byName.get(s.name.trim().toLowerCase());
            const f = i === undefined ? undefined : fields![i]!;
            if (
                i === undefined ||
                !f ||
                fieldBase(f.type) !== fieldBase(s.type) ||
                fieldIsArray(f.type) !== fieldIsArray(s.type)
            ) {
                bump(report.droppedParams, s.name);
                continue;
            }
            let value = s.value;
            if (fieldBase(f.type) === FIELD_CLASS) {
                value = Array.isArray(value) ? value.map(mapClassRef) : mapClassRef(value as number);
            } else if (isResourceField(f.type)) {
                report.zeroedResourceParams++;
                value = Array.isArray(value) ? value.map(() => 0) : fieldIsIndirect(f.type) ? '' : 0;
            }
            specs.push({ fieldIndex: i, type: f.type, name: f.name, value });
        }
        if (specs.length) setObjectParams(list, dst.id, specs);
    }
    report.objectsOut = out.length;

    // ---- terrain
    const terrain = pc.terrain.map((L) => convertLayer(L, pc, opt, report));

    // ---- header
    const name = opt.name ?? pcLevelName(pc.header);
    const header: LvlHeader = {
        ...opt.template.header,
        name: encodeString(name),
        maxWidth: pc.header.maxWidth,
        maxHeight: pc.header.maxHeight,
    };
    for (const [n, c] of report.unmappedClasses) {
        report.warnings.push(`no PS2 class for "${n}": ${c} object${c === 1 ? '' : 's'} dropped`);
    }
    return { header, objects: list, terrain, report };
}

function convertLayer(L: TerrainLayer, pc: PcLevel, opt: ConvertOptions, report: ConversionReport): TerrainLayer {
    const nc = L.width * L.height;
    const cellTexLeft = new Uint32Array(nc);
    const cache = new Map<number, number>();
    for (let c = 0; c < nc; c++) {
        // PS2 keeps one ref per cell: the PC left triangle decides (a hole in only one triangle keeps the hole).
        const l = L.cellTexLeft[c]!;
        const r = L.cellTexRight[c]!;
        const ref = l === TEX_HOLE || r === TEX_HOLE ? TEX_HOLE : l;
        if (ref === TEX_HOLE || ref === TEX_INVISIBLE) {
            cellTexLeft[c] = ref;
            continue;
        }
        let m = cache.get(ref);
        if (m === undefined) {
            m = opt.mapTexture?.(ref, pc) ?? -1;
            cache.set(ref, m);
        }
        if (m === -1 || m === null) {
            cellTexLeft[c] = opt.textureFallback;
            report.cellsFallback++;
        } else {
            cellTexLeft[c] = m;
            report.cellsMapped++;
        }
    }
    return {
        ...L,
        cellTexLeft,
        cellTexRight: cellTexLeft,
        vertexFlags: new Uint16Array(L.heights.length),
        vertexMask: ps2VertexMask(L.width, L.height),
        source: 'ps2',
    };
}

/** Per-vertex adjacency mask: one bit for each of the four surrounding cells that exist (15 = all, level-format.md s10). */
export function ps2VertexMask(w: number, h: number): Uint8Array {
    const m = new Uint8Array((w + 1) * (h + 1));
    for (let z = 0; z <= h; z++) {
        for (let x = 0; x <= w; x++) {
            // 8 top-left cell, 4 top-right, 2 bottom-left, 1 bottom-right (edges 12/10/5/3, corners 8/4/2/1 as observed)
            let v = 0;
            if (x < w && z < h) v |= 8;
            if (x > 0 && z < h) v |= 4;
            if (x < w && z > 0) v |= 2;
            if (x > 0 && z > 0) v |= 1;
            m[z * (w + 1) + x] = v;
        }
    }
    return m;
}

// ---------------------------------------------------------------- PS2 serialisation

export type BlobBuilder = (layer: TerrainLayer) => Uint8Array;

function layerDef(L: TerrainLayer): Uint8Array {
    const name = encodeString(L.name);
    const out = new Uint8Array(30 + name.raw.length + 28 + L.visible.length * 4);
    const dv = view(out);
    dv.setUint32(0, L.id, true);
    dv.setUint32(4, L.width, true);
    dv.setUint32(8, L.height, true);
    dv.setUint32(12, L.type, true);
    dv.setUint32(16, L.originX, true);
    dv.setUint32(20, L.originZ, true);
    dv.setFloat32(24, L.worldHeight, true);
    dv.setUint16(28, name.raw.length, true);
    out.set(name.raw, 30);
    let p = 30 + name.raw.length;
    dv.setUint32(p, L.flags, true);
    dv.setFloat32(p + 4, L.lightDirection, true);
    dv.setFloat32(p + 8, L.lightAscension, true);
    dv.setUint32(p + 12, L.lightColor, true);
    dv.setUint32(p + 16, L.ambientColor, true);
    dv.setUint32(p + 20, L.lightDropoff, true);
    dv.setUint32(p + 24, L.visible.length, true);
    p += 28;
    L.visible.forEach((v, i) => dv.setUint32(p + i * 4, v, true));
    return out;
}

/** The PS2 block of one layer: vertices (6 bytes), then cells (22 bytes). */
export function ps2TerrainBlock(L: TerrainLayer): Uint8Array {
    const nv = (L.width + 1) * (L.height + 1);
    const out = new Uint8Array(ps2TerrainBlockSize(L.width, L.height));
    const dv = view(out);
    for (let v = 0; v < nv; v++) {
        const raw = Math.round((L.heights[v]! - L.worldHeight) / 2) + 0x8000;
        dv.setUint16(v * 6, L.vertexFlags[v]!, true);
        dv.setUint16(v * 6 + 2, L.vertexMask[v]!, true);
        dv.setUint16(v * 6 + 4, Math.max(0, Math.min(0xffff, raw)), true);
    }
    const nc = L.width * L.height;
    for (let c = 0; c < nc; c++) {
        const o = nv * 6 + c * 22;
        dv.setUint16(o, L.cellFlags[c]!, true);
        dv.setUint32(o + 2, L.cellTexLeft[c]!, true);
        for (let k = 0; k < 8; k++) dv.setUint16(o + 6 + k * 2, L.cellUv[c * 8 + k]!, true);
    }
    return out;
}

/** LVL 0x0001 payload in the PS2 layout (definition + inline blob per layer, `u32 1`, zlib block per layer). */
export function writePs2Terrain(layers: readonly TerrainLayer[], blob: BlobBuilder): Uint8Array {
    const parts: Uint8Array[] = [];
    const head = new Uint8Array(4);
    view(head).setUint32(0, layers.length, true);
    parts.push(head);
    for (const L of layers) {
        parts.push(layerDef(L), blob(L));
    }
    const one = new Uint8Array(4);
    view(one).setUint32(0, 1, true);
    parts.push(one);
    for (const L of layers) {
        const z = zlibSync(ps2TerrainBlock(L), { level: 6 });
        const n = new Uint8Array(4);
        view(n).setUint32(0, z.length, true);
        parts.push(n, z);
    }
    return concat(parts);
}

/** LVL 0x0002: one group holding every layer (`u32 groups, {string name, u32 count, u32 layer ids}`). */
export function writeLayerGroups(layers: readonly TerrainLayer[]): Uint8Array {
    const name = encodeString('Ungrouped');
    const out = new Uint8Array(4 + 2 + name.raw.length + 4 + layers.length * 4);
    const dv = view(out);
    dv.setUint32(0, 1, true);
    dv.setUint16(4, name.raw.length, true);
    out.set(name.raw, 6);
    let p = 6 + name.raw.length;
    dv.setUint32(p, layers.length, true);
    layers.forEach((L, i) => dv.setUint32(p + 4 + i * 4, L.id, true));
    return out;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of parts) {
        out.set(p, o);
        o += p.length;
    }
    return out;
}

const LVL_TYPE_GROUPS = 0x0002;

/**
 * Build the PS2 `.LVL` file: the template container with the header, layer table, layer groups and object list
 * replaced. Entries the template has but this function does not regenerate are kept as they are.
 */
export async function buildPs2Lvl(template: SrscReader, parts: Ps2LevelParts, blob: BlobBuilder): Promise<Uint8Array> {
    const slot = (type: number): number => {
        const e = template.entries.find((x) => x.type === type);
        if (!e) throw new Error(`template LVL has no 0x${type.toString(16).padStart(4, '0')} entry`);
        return e.index;
    };
    const replace = new Map<number, Uint8Array>([
        [slot(LVL_TYPE_HEADER), writeLevelHeader(parts.header)],
        [slot(LVL_TYPE_LAYERS), writePs2Terrain(parts.terrain, blob)],
        [slot(LVL_TYPE_GROUPS), writeLayerGroups(parts.terrain)],
        [slot(LVL_TYPE_OBJECTS), writeObjectList(parts.objects)],
    ]);
    return writeSrsc(template, replace);
}

/** The most used non-special terrain texture ref of a PS2 level (a sensible `textureFallback`). */
export function dominantTexture(layers: readonly TerrainLayer[]): number {
    const n = new Map<number, number>();
    for (const L of layers) {
        for (const r of L.cellTexLeft) if (r !== TEX_HOLE && r !== TEX_INVISIBLE) bump(n, r);
    }
    let best = 0;
    let bc = -1;
    for (const [r, c] of n) {
        if (c > bc) {
            best = r;
            bc = c;
        }
    }
    return best;
}

/**
 * Inline-blob builder for converted layers. Verified in the game (docs/journal/2026-10-31/ootf-ingame.md): the engine
 * draws regenerated blobs only when `levelTag` equals the template level's (0x18 for LEVEL1NA; 0x16 drew just some
 * layers, flat) and when every layer has the same `seq` (a unique seq per layer froze the world on converted terrain).
 */
export const ps2BlobBuilder =
    (levelTag: number): BlobBuilder =>
    (L) =>
        buildPs2TerrainBlob(L, { seq: 1, levelTag });

/** The `level_tag` of a PS2 LVL 0x0001 payload (bytes 2..3 of the first layer's blob); undefined if it cannot be found. */
export function ps2LevelTag(layersPayload: Uint8Array): number | undefined {
    const layers = parsePs2Terrain(layersPayload);
    const L = layers[0];
    if (!L) return undefined;
    const dv = view(layersPayload);
    for (let p = 4; p + 34 < layersPayload.length; p++) {
        if (
            dv.getUint32(p, true) === L.id &&
            dv.getUint32(p + 4, true) === L.width &&
            dv.getUint32(p + 8, true) === L.height
        ) {
            const sl = dv.getUint16(p + 28, true);
            const nvis = dv.getUint32(p + 30 + sl + 24, true);
            const b = p + 30 + sl + 28 + nvis * 4;
            return dv.getUint16(b + 2, true);
        }
    }
    return undefined;
}

/** LEVEL1NA's tag (the default template). */
export const ps2BlobFor: BlobBuilder = ps2BlobBuilder(0x18);
