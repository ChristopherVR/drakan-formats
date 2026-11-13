import { zlibSync } from 'fflate';
import { view } from './bytes.ts';
import {
    FIELD_ANIMATION,
    FIELD_BOOL,
    FIELD_CHANNEL,
    FIELD_CLASS,
    FIELD_ENUM,
    FIELD_FLOAT,
    FIELD_INT,
    FIELD_MODEL,
    FIELD_SEQUENCE,
    FIELD_SOUND,
    FIELD_TEXTURE,
    decodeFieldValue,
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
import {
    MAX_CHUNK_TEXTURES,
    buildPs2TerrainBlob,
    planTerrainSlots,
    ps2ChunkSplit,
    type TerrainSlot,
} from './terrainblob.ts';
import {
    CELL_FLAG_BACKSLASH,
    LVL_TYPE_LAYERS,
    TEX_HOLE,
    TEX_INVISIBLE,
    layerHeightAt,
    parsePs2Terrain,
    ps2TerrainBlockSize,
    terrainGroundBelow,
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
    /**
     * Texture ref (`id | db << 16`, PC dependency index) -> PS2 ref. Return null to use `textureFallback`. `layer` is the
     * PC layer of the cell (water layers take the native liquid textures, `TerrainTextureBuilder.addLevel`).
     */
    mapTexture?: (pcRef: number, pc: PcLevel, layer: TerrainLayer) => number | null;
    /** PS2 ref used for every cell whose texture cannot be mapped (hole and invisible cells stay as they are). */
    textureFallback: number;
    /** Level name written to the header (default: the PC level's own name). */
    name?: string;
    /** PC class (level dependency index, class id) -> PS2 class; when given it replaces `classOverrides` and name matching. */
    resolveClass?: (db: number, id: number) => ClassTarget | null;
    /**
     * PC resource reference (model, sound, animation, sequence, texture, channel; `(db << 16) | id`) of an object parameter
     * -> PS2 reference word, or null to zero it. `ownerDb` is the level dependency index of the object's class (its ODB
     * resolves `db`). Called once per array element.
     */
    mapResource?: (kind: ResourceKind, pcRef: number, ctx: ResourceContext) => number | null;
    /**
     * PC class reference of an object parameter (`(db << 16) | id`, e.g. a detector's "Trigger Only If Carrying Item...")
     * -> PS2 reference word, or null to zero it. Both games number `db` like class defaults: in the dependency list (.db) of
     * the object's class ODB (`ctx.ownerDb` on the PC side, `ctx.target` on the PS2 side), 0 being that ODB itself. Without
     * this hook the reference is read and written in the level's dependency numbering, which only matches by chance.
     */
    mapClassRef?: (pcRef: number, ctx: ResourceContext) => number | null;
    /**
     * Most distinct textures one layer may use (default 0 = unlimited; env DRAKAN_TERRAIN_LAYERTEX). The engine limit is
     * per chunk (8 refs, see `MAX_CHUNK_TEXTURES`): the blob builder cuts crowded chunks, so a layer may use any number.
     * With a limit, cells of the surplus textures take the texture of the nearest cell of a kept one.
     */
    maxTexturesPerLayer?: number;
    /**
     * True for an object class whose PC class defaults must be kept: a scalar (int, float, bool, enum) field that the
     * object leaves at its PC class default, and whose default differs from the default of the PS2 target field of the
     * same name and type, is written as an object parameter with the PC value. A class mapped onto a PS2 class by name
     * keeps the PS2 defaults otherwise (cloned classes already merge the PC defaults, so nothing changes for them).
     */
    keepPcDefaults?: (pcClass: OdbClass, target: ClassTarget) => boolean;
    /**
     * For a PC class that has no PS2 target: a note when leaving it out is the intended outcome (`deliberateOmission`,
     * ootfcoverage.ts). Its objects are counted in `omittedClasses`, not in `unmappedClasses`.
     */
    omitClass?: (db: number, id: number) => string | null;
    /** PS2 field name of a PC object parameter whose name differs on the target class (`pcParamAlias`), else undefined. */
    paramAlias?: (pcClass: OdbClass, name: string, slot: () => number) => string | undefined;
}

export type ResourceKind = 'model' | 'sound' | 'animation' | 'sequence' | 'texture' | 'channel';

export interface ResourceContext {
    pc: PcLevel;
    ownerDb: number;
    classId: number;
    field: string;
    /** The PS2 class the object was mapped to. */
    target: ClassTarget;
}

export interface ConversionReport {
    objectsIn: number;
    objectsOut: number;
    /** PC class name -> objects dropped because no PS2 class matched. */
    unmappedClasses: Map<string, number>;
    /** PC class name -> objects left out on purpose and why (`ConvertOptions.omitClass`); not a gap. */
    omittedClasses?: Map<string, { objects: number; note: string }>;
    /** PC class name -> PS2 class name it was mapped to (for the preview / review). */
    mappedClasses: Map<string, string>;
    objectsPlaceholder: number;
    linksDropped: number;
    idsRenumbered: number;
    /** Parameter name -> count dropped because the PS2 class has no field of that name / type. */
    droppedParams: Map<string, number>;
    /** Resource parameters (model, sound, texture, ...) zeroed because PC resource ids do not exist on PS2. */
    zeroedResourceParams: number;
    /** `PC class.field PC default -> PS2 default` -> objects given the PC class default explicitly (`keepPcDefaults`). */
    pcDefaultsKept?: Map<string, number>;
    cellsFallback: number;
    cellsMapped: number;
    layers: number;
    warnings: string[];
}

export interface Ps2LevelParts {
    /** PC object id -> PS2 object id for the objects that were kept (sequence actors, links). */
    objectIdMap: Map<number, number>;
    header: LvlHeader;
    objects: LvlObjectList;
    terrain: TerrainLayer[];
    report: ConversionReport;
}

const bump = <K>(m: Map<K, number>, k: K, n = 1): void => void m.set(k, (m.get(k) ?? 0) + n);

/** Field types whose PC class default `keepPcDefaults` writes into the object (one dword, no payload, no reference). */
const SCALAR_BASES: ReadonlySet<number> = new Set([FIELD_INT, FIELD_FLOAT, FIELD_BOOL, FIELD_ENUM]);

function text(raw: Uint8Array): { raw: Uint8Array; text: string } {
    const z = raw.indexOf(0);
    return { raw, text: String.fromCharCode(...raw.subarray(0, z < 0 ? raw.length : z)) };
}

export function encodeString(s: string): { raw: Uint8Array; text: string } {
    const n = s.length + 1;
    const raw = new Uint8Array(n + (n % 2));
    for (let i = 0; i < s.length; i++) raw[i] = s.charCodeAt(i) & 0xff;
    return text(raw);
}

/** Resource kinds whose ids live in PC containers and cannot be carried over by number. */
export function resourceKind(type: number): ResourceKind | null {
    switch (fieldBase(type)) {
        case FIELD_MODEL:
            return 'model';
        case FIELD_SOUND:
            return 'sound';
        case FIELD_ANIMATION:
            return 'animation';
        case FIELD_SEQUENCE:
            return 'sequence';
        case FIELD_TEXTURE:
            return 'texture';
        case FIELD_CHANNEL:
            return 'channel';
        default:
            return null;
    }
}

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
        if (opt.resolveClass) {
            t = cls ? opt.resolveClass(db, id) : null;
            if (t && cls) report.mappedClasses.set(cls.name, t.cls.name);
        } else if (cls) {
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
    const keep: { src: LvlObject; dst: LvlObject; fields: ClassFieldDef[] | undefined; t: ClassTarget }[] = [];
    for (const src of pc.list.objects) {
        let t = targetOf(src.dbIndex, src.classId);
        const name = pc.classes.get(src.dbIndex)?.get(src.classId)?.name ?? `class ${src.classId}/${src.dbIndex}`;
        let placeholder = false;
        if (!t) {
            const omit = opt.omitClass?.(src.dbIndex, src.classId) ?? null;
            if (omit !== null) {
                const om = (report.omittedClasses ??= new Map());
                const was = om.get(name);
                om.set(name, { objects: (was?.objects ?? 0) + 1, note: omit });
                continue;
            }
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
            const g = terrainGroundBelow(pc.terrain, dst.pos[0], dst.pos[2], dst.pos[1]);
            if (Number.isFinite(g)) dst.pos[1] = g + 400;
        }
        out.push(dst);
        if (!placeholder) keep.push({ src, dst, fields: t.cls.fields, t });
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
    for (const { src, dst, fields, t } of keep) {
        const pcCls = pc.classes.get(src.dbIndex)?.get(src.classId);
        const keepDefaults = !!pcCls && !!opt.keepPcDefaults?.(pcCls, t);
        if (!src.params.length && !keepDefaults) continue;
        const byName = new Map<string, number>();
        fields?.forEach((f, i) => {
            const k = f.name.trim().toLowerCase();
            if (!byName.has(k)) byName.set(k, i);
        });
        const specs: ParamSpec[] = [];
        const pcSpecs = objectParamSpecs(src);
        const slot = (): number => {
            const own = pcSpecs.find((p) => /^slot$/i.test(p.name.trim()));
            if (typeof own?.value === 'number') return own.value;
            const k = pcCls?.fields?.findIndex((f) => /^slot$/i.test(f.name.trim())) ?? -1;
            return k >= 0 ? (pcCls!.data?.[k] ?? 0) : 0;
        };
        for (const s of pcSpecs) {
            let i = byName.get(s.name.trim().toLowerCase());
            if (i === undefined && pcCls && opt.paramAlias) {
                const alias = opt.paramAlias(pcCls, s.name, slot);
                if (alias) i = byName.get(alias.toLowerCase());
            }
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
                const hook = opt.mapClassRef;
                const ctx: ResourceContext = {
                    pc,
                    ownerDb: src.dbIndex,
                    classId: src.classId,
                    field: f.name,
                    target: t,
                };
                const one = hook ? (v: number): number => (v ? (hook(v, ctx) ?? 0) : 0) : mapClassRef;
                value = Array.isArray(value) ? value.map(one) : one(value as number);
            } else if (isResourceField(f.type)) {
                const kind = resourceKind(f.type)!;
                const ctx: ResourceContext = {
                    pc,
                    ownerDb: src.dbIndex,
                    classId: src.classId,
                    field: f.name,
                    target: t,
                };
                const one = (v: number): number => {
                    const m = v ? (opt.mapResource?.(kind, v, ctx) ?? null) : null;
                    if (m === null) report.zeroedResourceParams++;
                    return m ?? 0;
                };
                value = Array.isArray(value) ? value.map(one) : fieldIsIndirect(f.type) ? '' : one(value as number);
            }
            specs.push({ fieldIndex: i, type: f.type, name: f.name, value });
        }
        if (keepDefaults) {
            // Fields the object leaves at its PC class default: the PS2 class of the same name may default differently
            // (Alwarren's "count down to zero" counts Off down and On up on the PC, the PS2 "Count down to Zero" the reverse).
            const given = new Set(pcSpecs.map((s) => s.name.trim().toLowerCase()));
            const taken = new Set(specs.map((s) => s.fieldIndex));
            pcCls!.fields?.forEach((pf, k) => {
                const key = pf.name.trim().toLowerCase();
                const base = fieldBase(pf.type);
                if (given.has(key) || fieldIsArray(pf.type) || fieldIsIndirect(pf.type) || !SCALAR_BASES.has(base))
                    return;
                const i = byName.get(key);
                const f = i === undefined ? undefined : fields![i]!;
                if (i === undefined || !f || fieldBase(f.type) !== base || fieldIsArray(f.type) || taken.has(i)) return;
                const pv = pcCls!.data?.[k];
                const tv = t.cls.data?.[i];
                if (pv === undefined || tv === undefined || pv >>> 0 === tv >>> 0) return;
                const value = decodeFieldValue(f.type, pv, pcCls!.data!) as number;
                specs.push({ fieldIndex: i, type: f.type, name: f.name, value });
                taken.add(i);
                const was = decodeFieldValue(f.type, tv, t.cls.data!) as number;
                bump(
                    (report.pcDefaultsKept ??= new Map()),
                    `${pcCls!.name.trim()}.${pf.name.trim()} ${value} (PS2 ${was})`,
                );
            });
        }
        if (specs.length) setObjectParams(list, dst.id, specs);
    }
    report.objectsOut = out.length;

    // ---- terrain
    const floors = pc.terrain.filter((L) => L.type === 0);
    const water: WaterContext = {
        pcWater: pc.terrain.filter((L) => L.type === LAYER_TYPE_WATER),
        groundAt: (x, z, y) => terrainGroundBelow(floors, x, z, y),
    };
    const terrain = linkFarWater(pc.terrain.map((L) => convertLayer(L, pc, opt, report, water)));

    // ---- header
    const name = opt.name ?? pcLevelName(pc.header);
    // The template's splat dependency names its own level (`Level 1A - Surdana_splats`); the engine opens that file next to
    // the level being loaded, so a native level transition (no start-level redirect that rewrites the name) would ask
    // for a file the pack does not have. Name it after this level: its mangled stem is the pack's `<first 6>TS`.
    const dependencies = opt.template.header.dependencies.map((d) =>
        /_splats$/i.test(d.path.text) ? { ...d, path: encodeString(`${name}_splats`) } : d,
    );
    const header: LvlHeader = {
        ...opt.template.header,
        dependencies,
        name: encodeString(name),
        maxWidth: pc.header.maxWidth,
        maxHeight: pc.header.maxHeight,
    };
    if (report.pcDefaultsKept?.size) {
        const n = [...report.pcDefaultsKept.values()].reduce((a, b) => a + b, 0);
        report.warnings.push(
            `PC class defaults kept on ${n} object field(s): ${[...report.pcDefaultsKept].map(([k, c]) => `${k} x${c}`).join('; ')}`,
        );
    }
    for (const [n, { objects, note }] of report.omittedClasses ?? []) {
        report.warnings.push(`kept out on purpose: "${n}" (${objects} object${objects === 1 ? '' : 's'}): ${note}`);
    }
    for (const [n, c] of report.unmappedClasses) {
        report.warnings.push(`no PS2 class for "${n}": ${c} object${c === 1 ? '' : 's'} dropped`);
    }
    return { header, objects: list, terrain, report, objectIdMap: idMap };
}

/** What the conversion of a water layer needs from the rest of the PC level. */
interface WaterContext {
    pcWater: readonly TerrainLayer[];
    groundAt: (x: number, z: number, y: number) => number;
}

function convertLayer(
    source: TerrainLayer,
    pc: PcLevel,
    opt: ConvertOptions,
    report: ConversionReport,
    water?: WaterContext,
): TerrainLayer {
    if (source.type === LAYER_TYPE_WATER && !hasWaterTriangle(source)) return inertWaterLayer(source);
    const L = source.type === LAYER_TYPE_WATER ? cropWaterLayer(source) : source;
    const nc = L.width * L.height;
    const cellTexLeft = new Uint32Array(nc);
    // Floors and ceilings: the PS2 hole / invisible bits of each triangle (water layers: whole-cell holes only, below).
    const triangleBits = new Uint8Array(nc);
    const cache = new Map<number, number>();
    for (let c = 0; c < nc; c++) {
        const l = L.cellTexLeft[c]!;
        const r = L.cellTexRight[c]!;
        // PS2 keeps one ref per cell: the PC left triangle decides (a hole in only one triangle keeps the hole). A water layer
        // keeps the water instead: the PC cell is water in one half (shore cells on a diagonal), and turning it into a hole
        // left stair-stepped gaps in pools and streams (418 cells in Ruined Village); the hole cell is also drawn by the water pass.
        const half = (l === TEX_HOLE) !== (r === TEX_HOLE);
        const ref = L.type === LAYER_TYPE_WATER ? (half ? (l === TEX_HOLE ? r : l) : l) : ps2CellRef(l, r);
        if (L.type !== LAYER_TYPE_WATER) triangleBits[c] = ps2TriangleBits(l, r);
        if (ref === TEX_HOLE || ref === TEX_INVISIBLE) {
            cellTexLeft[c] = ref;
            continue;
        }
        let m = cache.get(ref);
        if (m === undefined) {
            m = opt.mapTexture?.(ref, pc, L) ?? -1;
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
    const lim = opt.maxTexturesPerLayer ?? layerTexEnv() ?? MAX_LAYER_TEXTURES;
    if (lim > 0) limitLayerTextures(cellTexLeft, L.width, L.height, lim);
    if (L.type !== LAYER_TYPE_WATER) {
        limitWindowTextures(cellTexLeft, L.width, L.height);
        if (!splitChunksEnv()) limitChunkTextures(cellTexLeft, L.width, L.height);
    }
    // Collision belongs to the platform conversion, not the optional opaque/shading rewrite in the pipeline.
    // Native PS2 collision skips triangles on 0x40/0x80 even when the texture reference is a hole sentinel.
    // Floors and ceilings carry the PC's per-triangle holes in the PS2 triangle bits (see `ps2TriangleBits`).
    const cellFlags = L.cellFlags.map((flags, c) =>
        L.type === LAYER_TYPE_WATER
            ? (flags & ~0xf0) | (cellTexLeft[c] === TEX_HOLE ? 0xc0 : 0)
            : (flags & ~0xf0) | triangleBits[c]!,
    );
    return {
        ...L,
        heights:
            L.type === LAYER_TYPE_WATER
                ? waterHoleHeights(L, water && ((x, z) => otherWaterAt(water.pcWater, L, x, z)), water?.groundAt)
                : L.heights,
        cellFlags,
        cellTexLeft,
        cellTexRight: cellTexLeft,
        vertexFlags: ps2VertexTypes(L),
        vertexMask: ps2VertexMask(L.width, L.height, cellTexLeft),
        source: 'ps2',
    };
}

/**
 * How far (cells) a layer's `visible` list reaches for water. The engine draws, from the layer the camera is in, only the layers
 * of that layer's list. The PC lists were made for its 12 / 30 lu draw distance, so a coastal layer lists a handful of the 102
 * Ruined Village sea layers and the sea stops short of the horizon (a diagonal edge against the sky), while the PS2 template
 * sees 65 lu and more. Water layers within this distance of a layer are added to its list. Journal 2026-11-09/ootf-sea-sky.md.
 */
export const WATER_VISIBLE_CELLS = 96;

export function linkFarWater(layers: TerrainLayer[], reach = WATER_VISIBLE_CELLS): TerrainLayer[] {
    const water = layers.filter((L) => L.type === LAYER_TYPE_WATER);
    if (!water.length) return layers;
    // Only the sea is linked from afar: the level's most common water surface height. Rivers, pools and lakes above it are
    // drawn only where the PC lists them (linked everywhere they showed as sheets in the air over valleys and rock faces).
    const count = new Map<number, number>();
    for (const W of water) {
        const sw = W.width + 1;
        const seen = new Set<number>();
        for (let z = 0; z < W.height; z++)
            for (let x = 0; x < W.width; x++) {
                const t = W.cellTexLeft[z * W.width + x]!;
                if (t === TEX_HOLE || t === TEX_INVISIBLE) continue;
                for (const v of [z * sw + x, z * sw + x + 1, (z + 1) * sw + x, (z + 1) * sw + x + 1]) seen.add(v);
            }
        for (const v of seen) {
            const h = Math.round(W.heights[v]!);
            count.set(h, (count.get(h) ?? 0) + 1);
        }
    }
    let sea = NaN;
    let best = 0;
    for (const [h, n] of count)
        if (n > best) {
            best = n;
            sea = h;
        }
    const isSea = (W: TerrainLayer): boolean => {
        const sw = W.width + 1;
        let total = 0;
        let flat = 0;
        for (let z = 0; z < W.height; z++)
            for (let x = 0; x < W.width; x++) {
                const t = W.cellTexLeft[z * W.width + x]!;
                if (t === TEX_HOLE || t === TEX_INVISIBLE) continue;
                for (const v of [z * sw + x, z * sw + x + 1, (z + 1) * sw + x, (z + 1) * sw + x + 1]) {
                    total++;
                    if (Math.abs(W.heights[v]! - sea) <= SEA_LEVEL_TOLERANCE) flat++;
                }
            }
        return total > 0 && flat >= total * 0.8;
    };
    const sealayers = Number.isFinite(sea) ? water.filter(isSea) : [];
    return layers.map((L) => {
        const have = new Set(L.visible);
        const add: number[] = [];
        for (const W of sealayers) {
            if (have.has(W.index)) continue;
            const dx = Math.max(W.originX - (L.originX + L.width), L.originX - (W.originX + W.width), 0);
            const dz = Math.max(W.originZ - (L.originZ + L.height), L.originZ - (W.originZ + W.height), 0);
            if (Math.max(dx, dz) <= reach) add.push(W.index);
        }
        return add.length ? { ...L, visible: [...L.visible, ...add] } : L;
    });
}

/** A water layer is "the sea" when 80 % of its water vertices are within this of the level's most common water height. */
export const SEA_LEVEL_TOLERANCE = 64;

/** Layer type of water surfaces (`TerrainLayerDef.type`) on both platforms; 0 floor, 1 ceiling. */
export const LAYER_TYPE_WATER = 2;
/**
 * PC landscape vertex types that are water kinds: the Drakan 1 list is 0 Normal, 1 "Water, Still", 2..25 slow / medium /
 * fast currents, 26..36 reserved, 37..44 Water Phase, 45..49 Shallow Water 92%..60%, 53..60 Warping Phase, 61..63 Ceiling
 * Water, 64..71 Underwater 1..8, then 72..75 the Alpha..Gamma level colours.
 */
export const PC_VERTEX_WATER_LAST = 71;
/**
 * The PS2 list has 64 "Vertex Color" entries after Normal, so a water kind sits 0x40 higher: PS2 water layers use 0x41
 * (Surdana, Kragmor, Stratos: PC 1, still water) and 0x71 (Andrellian Isles, Ravenshold, Northern Tundra, Valley: PC 49, the
 * 60% shallow water PC Islands uses). Without a water kind (0, Normal) the player does not swim in a water layer: she walks on its bottom.
 */
export const PS2_VERTEX_WATER_BASE = 0x40;

/**
 * PS2 vertex words (low byte = vertex type) of a converted layer. Water layers keep their PC water kinds moved into the
 * PS2 water range; everything else stays 0 (PC floors carry no PS2 vertex colours). Journal 2026-11-08/ootf-water.md.
 */
export function ps2VertexTypes(L: Pick<TerrainLayer, 'type' | 'vertexFlags' | 'heights'>): Uint16Array {
    const out = new Uint16Array(L.heights.length);
    if (L.type !== LAYER_TYPE_WATER) return out;
    for (let v = 0; v < out.length; v++) {
        const t = L.vertexFlags[v]! & 0xff;
        if (t >= 1 && t <= PC_VERTEX_WATER_LAST) out[v] = PS2_VERTEX_WATER_BASE + t;
    }
    return out;
}

/** Corner vertices (row-major grid indices) of the left / right triangle of a cell, by its diagonal (as `layerHeightAt`). */
function triangleVertices(w: number, x: number, z: number, backslash: boolean): [number[], number[]] {
    const sw = w + 1;
    const a = z * sw + x;
    const b = a + 1;
    const c = a + sw;
    const d = c + 1;
    return backslash
        ? [
              [c, d, a],
              [b, a, d],
          ]
        : [
              [a, b, c],
              [d, c, b],
          ];
}

const isHoleRef = (t: number): boolean => t === TEX_HOLE || t === TEX_INVISIBLE;

/** PS2 cell bits that remove the first / second triangle of a cell (draw and collision). */
export const CELL_HOLE_FIRST = 0x40;
export const CELL_HOLE_SECOND = 0x80;
/** PS2 cell bits that make the first / second triangle invisible (collision kept). */
export const CELL_INVISIBLE_FIRST = 0x10;
export const CELL_INVISIBLE_SECOND = 0x20;

/**
 * PS2 hole and invisible bits of a floor or ceiling cell from the PC's two triangle refs. The PC gives each triangle its
 * own ref; the PS2 keeps one ref per cell and marks each triangle on its own: 0x40 / 0x80 remove the first / second
 * triangle from drawing and collision (seen in game), 0x10 / 0x20 mark it invisible (the disc's own use; not seen in game).
 * The disc has 0xc0 on every hole cell, 0x30 on every invisible cell and about 10,600 textured cells with only 0x40 or
 * only 0x80. The first triangle is the PC left one (a-c-d with the diagonal bit set, else a-c-b: `layerHeightAt`, PAL
 * 15a2f0). Turning a cell with one hole triangle into a whole hole took the other, drawn triangle with it: cave walls
 * and ceilings showed the sky colour through triangular gaps (Grimstone Mines 741 such cells, 11,400 in the campaign).
 */
export function ps2TriangleBits(left: number, right: number): number {
    const bits = (t: number, hole: number, inv: number): number =>
        t === TEX_HOLE ? hole : t === TEX_INVISIBLE ? inv : 0;
    return bits(left, CELL_HOLE_FIRST, CELL_INVISIBLE_FIRST) | bits(right, CELL_HOLE_SECOND, CELL_INVISIBLE_SECOND);
}

/**
 * The one PS2 ref of a floor or ceiling cell: the left triangle's texture, or the right one's when the left has none; a
 * hole only when both triangles are holes, invisible when neither has a texture. `ps2TriangleBits` removes the rest.
 */
export function ps2CellRef(left: number, right: number): number {
    if (!isHoleRef(left)) return left;
    if (!isHoleRef(right)) return right;
    return left === TEX_HOLE && right === TEX_HOLE ? TEX_HOLE : TEX_INVISIBLE;
}

/**
 * A water layer cut down to the cells around its water triangles. The PS2 water pass draws every cell of a water layer, so the
 * rows and columns of hole cells around the water (Rift World's 28 x 28 layer around a 12 cell pool in the void) stood as
 * sheets of water in the air. Nothing else refers to a layer's cells, so the layer keeps its index and lists.
 */
export function cropWaterLayer(L: TerrainLayer): TerrainLayer {
    let x0 = L.width;
    let x1 = -1;
    let z0 = L.height;
    let z1 = -1;
    for (let z = 0; z < L.height; z++)
        for (let x = 0; x < L.width; x++) {
            const c = z * L.width + x;
            if (isHoleRef(L.cellTexLeft[c]!) && isHoleRef(L.cellTexRight[c]!)) continue;
            x0 = Math.min(x0, x);
            x1 = Math.max(x1, x);
            z0 = Math.min(z0, z);
            z1 = Math.max(z1, z);
        }
    if (x1 < 0 || (x0 === 0 && z0 === 0 && x1 === L.width - 1 && z1 === L.height - 1)) return L;
    const w = x1 - x0 + 1;
    const h = z1 - z0 + 1;
    const sw = L.width + 1;
    const nv = (w + 1) * (h + 1);
    const heights = new Float32Array(nv);
    const vertexFlags = new Uint16Array(nv);
    const vertexMask = new Uint8Array(nv);
    for (let z = 0; z <= h; z++)
        for (let x = 0; x <= w; x++) {
            const from = (z0 + z) * sw + x0 + x;
            heights[z * (w + 1) + x] = L.heights[from]!;
            vertexFlags[z * (w + 1) + x] = L.vertexFlags[from]!;
            vertexMask[z * (w + 1) + x] = L.vertexMask[from]!;
        }
    const nc = w * h;
    const cellFlags = new Uint16Array(nc);
    const cellTexLeft = new Uint32Array(nc);
    const cellTexRight = new Uint32Array(nc);
    const cellUv = new Uint16Array(nc * 8);
    for (let z = 0; z < h; z++)
        for (let x = 0; x < w; x++) {
            const from = (z0 + z) * L.width + x0 + x;
            const to = z * w + x;
            cellFlags[to] = L.cellFlags[from]!;
            cellTexLeft[to] = L.cellTexLeft[from]!;
            cellTexRight[to] = L.cellTexRight[from]!;
            cellUv.set(L.cellUv.subarray(from * 8, from * 8 + 8), to * 8);
        }
    return {
        ...L,
        width: w,
        height: h,
        originX: L.originX + x0,
        originZ: L.originZ + z0,
        heights,
        vertexFlags,
        vertexMask,
        cellFlags,
        cellTexLeft,
        cellTexRight,
        cellUv,
    };
}

/** Whether a PC layer has at least one triangle that is not a hole or invisible. */
export function hasWaterTriangle(L: Pick<TerrainLayer, 'cellTexLeft' | 'cellTexRight'>): boolean {
    for (let c = 0; c < L.cellTexLeft.length; c++)
        if (!isHoleRef(L.cellTexLeft[c]!) || !isHoleRef(L.cellTexRight[c]!)) return true;
    return false;
}

/**
 * A PC water layer with no visible water triangle (every cell a hole or invisible: 43 layers in Volcanic, 23 in Rift World)
 * becomes an empty floor layer. The PS2 water pass draws every cell of a water layer whatever its texture or hole flags, so
 * such a layer stood as a sheet of water in the air where the PC draws nothing. As a floor whose cells are all holes (0xc0) it
 * has no draw data and no collision. Journal 2026-11-14/ootf-water-sheets.md.
 */
export function inertWaterLayer(L: TerrainLayer): TerrainLayer {
    const nc = L.width * L.height;
    const cellTexLeft = new Uint32Array(nc).fill(TEX_HOLE);
    return {
        ...L,
        type: 0,
        cellFlags: L.cellFlags.map((f) => (f & ~0xf0) | 0xc0),
        cellTexLeft,
        cellTexRight: cellTexLeft,
        vertexFlags: new Uint16Array(L.heights.length),
        vertexMask: ps2VertexMask(L.width, L.height, cellTexLeft),
        source: 'ps2',
    };
}

/** Surface of the water triangles of the other PC water layers at (x, z), the highest one; NaN when there is none. */
export function otherWaterAt(water: readonly TerrainLayer[], self: TerrainLayer, x: number, z: number): number {
    let best = NaN;
    for (const W of water) {
        if (W.index === self.index) continue;
        const h = layerHeightAt(W, x, z);
        if (!Number.isNaN(h) && !(h <= best)) best = h;
    }
    return best;
}

/**
 * Water layer heights for the vertices that no water triangle uses. The PS2 water pass draws every cell of a water layer: hole
 * and invisible cells too, whatever their hole flags or texture (tried in game, journal 2026-11-14/ootf-water-sheets.md). The
 * disc keeps those vertices at the surface height, where the bank covers them; the PC lifts them up the bank, in places far
 * above it (Ruined Village "Copy of Ocean 01": surface 11000, hole vertices up to 16494), and a water layer that ends at a cliff
 * lip or a ledge has open air beyond its edge. A hole cell drawn there stood as a sheet of water in the air that Rynn cannot
 * swim in (the 2026-11-08 rule kept it at most 2048 under the surface, a slanted sheet over any drop).
 *
 * Such a vertex takes the height of the nearest water vertex (breadth first over the grid), then:
 * * under another water layer's water near that height (seams between the layers of one sea or river) it sits just under
 *   that surface, so no step shows;
 * * over a bank (the highest floor under it no more than `WATER_BANK_DROP` below the water) it goes `WATER_HOLE_SINK` under
 *   that floor, as in the 2026-11-08 rule; a lower PC height is kept;
 * * over a drop (a cliff or a ledge's lip, the floor further down) it goes `WATER_HOLE_DEPTH` down, so the cell hangs almost
 *   straight down from the water's edge into the rock under it instead of standing out over the drop;
 * * with no floor at all under it (a pool whose basin is a model) it stays at the water height, as before.
 * Vertices far from the surface cost water near the camera: the engine dropped the water of a whole small pool when every hole
 * vertex of its layers stood 2048 or more above or below it (Alwarren cistern, journal 2026-11-14/ootf-water-sheets.md), so
 * only drops go deep. Each triangle of a PC cell counts on its own (shore cells are water in one triangle), so the vertex that
 * only the hole triangle of such a cell uses moves too. Water triangle vertices are untouched (sloped rivers keep their slope).
 */
export function waterHoleHeights(
    L: Pick<
        TerrainLayer,
        'width' | 'height' | 'heights' | 'originX' | 'originZ' | 'cellFlags' | 'cellTexLeft' | 'cellTexRight'
    >,
    otherWater?: (x: number, z: number) => number,
    groundAt?: (x: number, z: number, y: number) => number,
): Float32Array {
    const w = L.width;
    const h = L.height;
    const sw = w + 1;
    const out = Float32Array.from(L.heights);
    const water = new Uint8Array(out.length);
    const near = Float32Array.from(L.heights);
    const done = new Uint8Array(out.length);
    let queue: number[] = [];
    for (let z = 0; z < h; z++) {
        for (let x = 0; x < w; x++) {
            const c = z * w + x;
            const [left, right] = triangleVertices(w, x, z, (L.cellFlags[c]! & CELL_FLAG_BACKSLASH) !== 0);
            for (const [ref, tri] of [
                [L.cellTexLeft[c]!, left],
                [L.cellTexRight[c]!, right],
            ] as const) {
                if (isHoleRef(ref)) continue;
                for (const v of tri) {
                    if (!done[v]) {
                        done[v] = water[v] = 1;
                        queue.push(v);
                    }
                }
            }
        }
    }
    if (!queue.length) return out;
    while (queue.length) {
        const next: number[] = [];
        for (const v of queue) {
            const x = v % sw;
            const z = (v / sw) | 0;
            for (const [dx, dz] of [
                [1, 0],
                [-1, 0],
                [0, 1],
                [0, -1],
            ] as const) {
                const nx = x + dx;
                const nz = z + dz;
                if (nx < 0 || nz < 0 || nx > w || nz > h) continue;
                const n = nz * sw + nx;
                if (done[n]) continue;
                done[n] = 1;
                near[n] = near[v]!;
                next.push(n);
            }
        }
        queue = next;
    }
    for (let v = 0; v < out.length; v++) {
        if (water[v]) continue;
        const x = (L.originX + (v % sw)) * 2048;
        const z = (L.originZ + Math.floor(v / sw)) * 2048;
        const other = otherWater ? otherWater(x, z) : NaN;
        if (Number.isFinite(other) && Math.abs(other - near[v]!) <= WATER_SEAM_RANGE) {
            out[v] = other - WATER_SEAM_SINK;
            continue;
        }
        const pcHeight = out[v]!;
        const top = Math.min(pcHeight, near[v]!);
        const ground = groundAt ? groundAt(x, z, Math.max(pcHeight, near[v]!)) : NaN;
        if (!Number.isFinite(ground)) out[v] = top;
        else if (ground - WATER_HOLE_SINK >= near[v]! - WATER_BANK_DROP)
            out[v] = Math.min(top, ground - WATER_HOLE_SINK);
        else out[v] = near[v]! - WATER_HOLE_DEPTH;
    }
    return out;
}

/** How far below the nearest water a hole vertex over a drop goes (world units; a cell is 2048 wide). */
export const WATER_HOLE_DEPTH = 24000;
/** A floor further than this under the nearest water makes a drop. */
export const WATER_BANK_DROP = 2048;
/** How far under the bank a hole vertex over a bank goes (world units). */
export const WATER_HOLE_SINK = 64;
/** A hole vertex under another water layer's water within this height of its own nearest water joins that surface. */
export const WATER_SEAM_RANGE = 600;
/** How far under that other surface it then sits. */
export const WATER_SEAM_SINK = 16;

/**
 * Keep every 3 x 3 block of cells within `max` distinct textures (8, `MAX_CHUNK_TEXTURES`). A chunk's draw data lists the
 * textures of its cells and of the ring of cells around them; with more than 8 the blob builder cuts it down to single cells
 * and a single cell still over the limit drops the blend of some neighbour textures, which drew as a flat, lighter patch with a
 * hard edge (Grimstone Mines, where the PC paints nearly every cell with a texture of its own: 114 such cells before the
 * cells with one hole triangle were drawn, 125 after; 6,400 over the campaign). Here the texture that the fewest cells of an
 * over-full block use (then the fewest in the layer) gives way: each of its cells in the block takes the texture most of its
 * eight neighbours use. Returns the number of cells changed. Hole and invisible cells are left alone.
 */
export function limitWindowTextures(tex: Uint32Array, w: number, h: number, max = MAX_CHUNK_TEXTURES): number {
    const special = (t: number): boolean => t === TEX_HOLE || t === TEX_INVISIBLE;
    const around = (x: number, z: number, self: boolean): number[] => {
        const out: number[] = [];
        for (let dz = -1; dz <= 1; dz++)
            for (let dx = -1; dx <= 1; dx++) {
                const a = x + dx;
                const b = z + dz;
                if ((!self && !dx && !dz) || a < 0 || b < 0 || a >= w || b >= h) continue;
                const t = tex[b * w + a]!;
                if (!special(t)) out.push(b * w + a);
            }
        return out;
    };
    const layerUses = new Map<number, number>();
    for (const t of tex) if (!special(t)) layerUses.set(t, (layerUses.get(t) ?? 0) + 1);
    let changed = 0;
    for (let guard = 0; guard < 4 * tex.length; guard++) {
        let block: number[] | undefined;
        for (let c = 0; c < tex.length && !block; c++) {
            const cells = around(c % w, Math.floor(c / w), true);
            if (new Set(cells.map((i) => tex[i]!)).size > max) block = cells;
        }
        if (!block) break;
        const uses = new Map<number, number>();
        for (const i of block) uses.set(tex[i]!, (uses.get(tex[i]!) ?? 0) + 1);
        const victim = [...uses.keys()].sort(
            (a, b) => uses.get(a)! - uses.get(b)! || (layerUses.get(a) ?? 0) - (layerUses.get(b) ?? 0) || b - a,
        )[0]!;
        for (const i of block) {
            if (tex[i] !== victim) continue;
            const near = new Map<number, number>();
            for (const j of around(i % w, Math.floor(i / w), false))
                if (tex[j] !== victim) near.set(tex[j]!, (near.get(tex[j]!) ?? 0) + 1);
            const pick =
                [...near].sort(
                    (a, b) => b[1] - a[1] || (uses.get(b[0]) ?? 0) - (uses.get(a[0]) ?? 0) || a[0] - b[0],
                )[0]?.[0] ?? [...uses.keys()].find((t) => t !== victim)!;
            layerUses.set(victim, layerUses.get(victim)! - 1);
            layerUses.set(pick, (layerUses.get(pick) ?? 0) + 1);
            tex[i] = pick;
            changed++;
        }
    }
    return changed;
}

/**
 * Keep the cells each disc-sized chunk lists (its up to 12 x 12 cells and the ring around them, the same rectangles
 * `buildPs2TerrainBlob` writes) within `max` distinct textures, so no chunk has to be cut. The PC paints nearly every cell
 * with a texture of its own, and cutting chunks down to single cells gave converted layers up to 752 chunks with 5,491
 * texture entries (Wartok Canyons; the disc has at most 25 chunks and 70 entries per layer). The engine builds a draw page
 * per chunk texture and keeps the pages of every layer in view: in Wartok Canyons' lower canyon they took three times
 * the terrain budget, the guest heap ran out while a layer's pages were built (`FUN_00154060`), the page list was read from
 * a failed allocation and the game hung (docs/journal/2026-11-14/ootf-check-b.md). Here the texture that the fewest cells
 * of an over-full chunk use (then the fewest in the layer) gives way: each of its cells takes the texture most of its eight
 * neighbours use among the chunk's other textures, else the chunk's most used one. Returns the number of cells changed.
 * Hole and invisible cells are left alone. Env DRAKAN_TERRAIN_CHUNKS=split keeps the earlier cut chunks.
 */
export function limitChunkTextures(tex: Uint32Array, w: number, h: number, max = MAX_CHUNK_TEXTURES): number {
    const special = (t: number): boolean => t === TEX_HOLE || t === TEX_INVISIBLE;
    const xs = ps2ChunkSplit(w);
    const zs = ps2ChunkSplit(h);
    const windows: number[][] = [];
    for (let a = 0; a < xs.length - 1; a++)
        for (let b = 0; b < zs.length - 1; b++) {
            const cells: number[] = [];
            for (let z = Math.max(0, zs[b]! - 1); z <= Math.min(h - 1, zs[b + 1]!); z++)
                for (let x = Math.max(0, xs[a]! - 1); x <= Math.min(w - 1, xs[a + 1]!); x++) cells.push(z * w + x);
            windows.push(cells);
        }
    const layerUses = new Map<number, number>();
    for (const t of tex) if (!special(t)) layerUses.set(t, (layerUses.get(t) ?? 0) + 1);
    let changed = 0;
    for (let pass = 0; pass < 64; pass++) {
        let over = false;
        for (const cells of windows) {
            for (;;) {
                const uses = new Map<number, number>();
                for (const i of cells) if (!special(tex[i]!)) uses.set(tex[i]!, (uses.get(tex[i]!) ?? 0) + 1);
                if (uses.size <= max) break;
                over = true;
                const victim = [...uses.keys()].sort(
                    (a, b) => uses.get(a)! - uses.get(b)! || (layerUses.get(a) ?? 0) - (layerUses.get(b) ?? 0) || b - a,
                )[0]!;
                const most = [...uses.keys()]
                    .filter((t) => t !== victim)
                    .sort((a, b) => uses.get(b)! - uses.get(a)! || a - b)[0]!;
                for (const i of cells) {
                    if (tex[i] !== victim) continue;
                    const x = i % w;
                    const z = (i / w) | 0;
                    const near = new Map<number, number>();
                    for (let dz = -1; dz <= 1; dz++)
                        for (let dx = -1; dx <= 1; dx++) {
                            const a = x + dx;
                            const b = z + dz;
                            if ((!dx && !dz) || a < 0 || b < 0 || a >= w || b >= h) continue;
                            const t = tex[b * w + a]!;
                            if (t !== victim && uses.has(t)) near.set(t, (near.get(t) ?? 0) + 1);
                        }
                    const pick =
                        [...near].sort(
                            (p, q) => q[1] - p[1] || uses.get(q[0])! - uses.get(p[0])! || p[0] - q[0],
                        )[0]?.[0] ?? most;
                    layerUses.set(victim, layerUses.get(victim)! - 1);
                    layerUses.set(pick, (layerUses.get(pick) ?? 0) + 1);
                    tex[i] = pick;
                    changed++;
                }
            }
        }
        if (!over) break;
    }
    return changed;
}

function splitChunksEnv(): boolean {
    return (
        (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.[
            'DRAKAN_TERRAIN_CHUNKS'
        ] === 'split'
    );
}

/** Default for `ConvertOptions.maxTexturesPerLayer`. */
export const MAX_LAYER_TEXTURES = 0;

function layerTexEnv(): number | undefined {
    const v = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.[
        'DRAKAN_TERRAIN_LAYERTEX'
    ];
    return v ? Number(v) : undefined;
}

/**
 * Reduce a layer to at most `max` distinct textures in place: keep the `max` most used, give every other cell the
 * texture of the nearest kept cell (4-neighbour flood fill). Hole / invisible cells are left alone.
 */
export function limitLayerTextures(tex: Uint32Array, w: number, h: number, max: number): void {
    const count = new Map<number, number>();
    for (const t of tex) if (t !== TEX_HOLE && t !== TEX_INVISIBLE) count.set(t, (count.get(t) ?? 0) + 1);
    if (count.size <= max) return;
    const keep = new Set(
        [...count]
            .sort((a, b) => b[1] - a[1] || a[0] - b[0])
            .slice(0, max)
            .map((x) => x[0]),
    );
    const done = new Uint8Array(tex.length);
    let queue: number[] = [];
    for (let i = 0; i < tex.length; i++) {
        if (tex[i] === TEX_HOLE || tex[i] === TEX_INVISIBLE || keep.has(tex[i]!)) {
            done[i] = 1;
            if (tex[i] !== TEX_HOLE && tex[i] !== TEX_INVISIBLE) queue.push(i);
        }
    }
    while (queue.length) {
        const next: number[] = [];
        for (const i of queue) {
            const x = i % w;
            const z = (i / w) | 0;
            for (const [dx, dz] of [
                [1, 0],
                [-1, 0],
                [0, 1],
                [0, -1],
            ] as const) {
                const nx = x + dx;
                const nz = z + dz;
                if (nx < 0 || nz < 0 || nx >= w || nz >= h) continue;
                const j = nz * w + nx;
                if (done[j]) continue;
                done[j] = 1;
                tex[j] = tex[i]!;
                next.push(j);
            }
        }
        queue = next;
    }
    const any = [...keep][0]!;
    for (let i = 0; i < tex.length; i++) {
        if (tex[i] !== TEX_HOLE && tex[i] !== TEX_INVISIBLE && !keep.has(tex[i]!)) tex[i] = any;
    }
}

/**
 * Per-vertex adjacency mask: one bit for each surrounding cell that exists and is not a hole. Omit cellTextures for
 * a wholly solid grid. Invisible cells remain collidable; TEX_HOLE must not retain the corresponding adjacency bit.
 */
export function ps2VertexMask(w: number, h: number, cellTextures?: ArrayLike<number>): Uint8Array {
    const solid = (x: number, z: number): boolean =>
        x >= 0 && z >= 0 && x < w && z < h && (!cellTextures || cellTextures[z * w + x] !== TEX_HOLE);
    const m = new Uint8Array((w + 1) * (h + 1));
    for (let z = 0; z <= h; z++) {
        for (let x = 0; x <= w; x++) {
            // 8 down-right, 4 down-left, 2 up-right, 1 up-left, matching the native disc adjacency nibble.
            let v = 0;
            if (solid(x, z)) v |= 8;
            if (solid(x - 1, z)) v |= 4;
            if (solid(x, z - 1)) v |= 2;
            if (solid(x - 1, z - 1)) v |= 1;
            m[z * (w + 1) + x] = v;
        }
    }
    return m;
}

// ---------------------------------------------------------------- PS2 serialisation

/** `all` is the whole layer list (for builders that assign groups and slots across layers). */
export type BlobBuilder = (layer: TerrainLayer, all?: readonly TerrainLayer[]) => Uint8Array;

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
        parts.push(layerDef(L), blob(L, layers));
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

/** Another layer continues the ground at a border vertex when it holds that vertex within this height (world units). */
export const GROUND_JOIN_TOLERANCE = 64;

/**
 * The ground beyond a layer's edge, for the normals of layer border vertices (`TerrainBlobOptions.heightBeyond`). Order of
 * the Flame levels are cut into hundreds of small layers (Wartok Canyons 441, about 9 x 9 cells each), so a third of their
 * vertices lie on a layer border; with only the layer's own heights those took half the slope and drew the borders as
 * lines of flatter, brighter light. Another layer continues the ground when it holds the border vertex itself at the same
 * height (`GROUND_JOIN_TOLERANCE`), so a cave floor under an outdoor slope or a ceiling is never taken; its height at the
 * neighbouring vertex is used however steep. Water layers do not count.
 */
export function groundBeyond(
    layers: readonly TerrainLayer[],
): (x0: number, z0: number, h0: number, x: number, z: number) => number | null {
    const byVertex = new Map<number, TerrainLayer[]>();
    const key = (x: number, z: number): number => x * 65536 + z;
    for (const L of layers) {
        if (L.type === LAYER_TYPE_WATER) continue;
        for (let z = 0; z <= L.height; z++)
            for (let x = 0; x <= L.width; x++) {
                const k = key(L.originX + x, L.originZ + z);
                const list = byVertex.get(k);
                if (list) list.push(L);
                else byVertex.set(k, [L]);
            }
    }
    const heightIn = (L: TerrainLayer, x: number, z: number): number | null => {
        const lx = x - L.originX;
        const lz = z - L.originZ;
        return lx < 0 || lz < 0 || lx > L.width || lz > L.height ? null : L.heights[lz * (L.width + 1) + lx]!;
    };
    return (x0, z0, h0, x, z) => {
        for (const L of byVertex.get(key(x0, z0)) ?? []) {
            const h = heightIn(L, x0, z0);
            if (h === null || Math.abs(h - h0) > GROUND_JOIN_TOLERANCE) continue;
            const there = heightIn(L, x, z);
            if (there !== null) return there;
        }
        return null;
    };
}

/** The reduced-chunk warning is printed once per session. */
let warnedReducedChunks = false;

/**
 * Inline-blob builder for converted layers. Verified in the game (docs/journal/2026-10-31/ootf-ingame.md): the engine
 * draws regenerated blobs only when `levelTag` equals the template level's (0x18 for LEVEL1NA; 0x16 drew just some
 * layers, flat) and when every layer has the same `seq` (a unique seq per layer froze the world on converted terrain).
 */
export const ps2BlobBuilder = (levelTag: number): BlobBuilder => {
    const plans = new WeakMap<readonly TerrainLayer[], Map<number, TerrainSlot>>();
    const grounds = new WeakMap<readonly TerrainLayer[], ReturnType<typeof groundBeyond>>();
    return (L, all) => {
        const list = all ?? [L];
        let plan = plans.get(list);
        if (!plan) plans.set(list, (plan = planTerrainSlots(list)));
        let ground = grounds.get(list);
        if (!ground) grounds.set(list, (ground = groundBeyond(list)));
        const s = plan.get(L.index);
        const stats = { reducedChunks: 0 };
        const blob = buildPs2TerrainBlob(L, {
            seq: s?.seq ?? 1,
            levelTag,
            slot: s,
            stats,
            noDrawData: L.type === LAYER_TYPE_WATER,
            heightBeyond: L.type === LAYER_TYPE_WATER ? undefined : ground,
        });
        if (stats.reducedChunks > 0 && !warnedReducedChunks) {
            warnedReducedChunks = true;
            console.warn(
                `terrain layer ${L.index}: ${stats.reducedChunks} chunk(s) use more than 8 textures; some blends were dropped to stay within the engine limit`,
            );
        }
        return blob;
    };
};

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
