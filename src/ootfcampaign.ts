// Order of the Flame campaign layer: how the 23 PC levels link, in which order they play, what they are called in the PS2
// level list, and the rewrite of every level exit so the PS2 engine finds the converted levels.
// Evidence and call order: docs/journal/2026-10-31/ootf-campaign.md. Data from the user's install (counts only here):
//
//   * PC "Level Transition" objects (engine class 55, 19 objects) carry NO destination in the level: the destination is the
//     class default of field "Transition To..." (a path text such as `islands world\islands\islands.lvl`), one exit class
//     per destination ("Level Transition 4 to 5"). An object may override it (Ruined Village Book, Volcano, Ruined Village).
//   * PS2 exits (runtime class 0x10037) read the same field as an XDB string id of the class's own database (class default
//     5 = "Levels\Level 2 - Shadowmire\Level 2 - Shadowmire.lvl" in LEVEL1ON.XDB) and an object overrides it with a plain
//     dword = the id (LEVEL3NE, LEVEL4LD ... 12 such objects on the disc). The game opens `\Levels\<name>\<name>.lvl`
//     (LEVELLST.TXT title) and then looks in the new level for the exit whose own destination text is the old level's name
//     (world-model.md section 10). No such exit: the player falls.
//   * Level order = the string id in the level header (`<0x9000>Ruined Village` ... `<0x900b>Rift World`); the intro level has
//     none and plays first. Interface.odb names the flow: "Intro Level Filename" -> "First Level Filename".

import { cp1252Byte } from './xdb.ts';
import { encodeXdbString } from './xdbwrite.ts';
import { decodeFieldValue, fieldBase, fieldIsArray, fieldIsIndirect, FIELD_STRING, type ClassFieldDef } from './fields.ts';
import { mangleComponent } from './levellist.ts';
import { FLAG_SCALED, FLAG_VISIBLE, addObject, type LvlObject, type LvlObjectList, type LvlParam, type Vec3 } from './lvl.ts';
import type { PcLevel } from './pc.ts';
import { terrainGroundBelow } from './terrain.ts';
import { pcDependencyKey, pcLevelName, resolvePcPath } from './pc.ts';

// ---------------------------------------------------------------- types

export interface CampaignOptions {
    /** Prefix of every level title in the PS2 level list (default `OotF`). */
    prefix?: string;
    /** PC path of the first level (default: the level named like `Intro` when there is one, else the lowest string id). */
    startPath?: string;
    /** PC path the intro hands over to (Interface.odb "First Level Filename"; default: the level named `Ruined Village`). */
    firstPath?: string;
    /** Offset added to the Rynn start for synthesized exits (world units; default none). */
    arrivalOffset?: readonly number[];
    /** Id of the first campaign string in the exit class's XDB (default 0x7000; raised above the XDB's largest id by the caller). */
    stringBase?: number;
}

export type ExitReason =
    | 'pc' // an exit object of the PC level
    | 'intro-next' // the intro level has no exit; Interface.odb sends it to the first level
    | 'arrival'; // the destination level has no exit back; one is added at its Rynn start so the arrival marker exists

export interface CampaignExit {
    reason: ExitReason;
    /** PC object id (0 for synthesized exits). */
    pcObjectId: number;
    pcClassName: string;
    pos: Vec3;
    rot: Vec3;
    scale: Vec3 | null;
    /** PC destination text as stored (`islands world\islands\islands.lvl`); '' when synthesized. */
    pcText: string;
    /** Destination level path (PC path as listed), or null when it names a level that is not part of this campaign. */
    destPath: string | null;
    destTitle: string | null;
    /** The exit is only meant for the player to come back by (`reason` arrival): no PC counterpart. */
    synthetic: boolean;
    /**
     * Cut-scene levels (the intro, the Ruined Village Book) have nobody to walk into the exit: a Timer fires it after this many
     * seconds (the length of the level's scenes). Unset for levels the player plays.
     */
    autoSeconds?: number;
}

/** Length of the three Intro sequences ("Intro 1", "Intro 2", "Intro 3": 14.5 + 10.2 + 16.4 s) plus a short margin. */
export const INTRO_SECONDS = 44;
/** Length of the Book's narration sequence ("The Book", 25.7 s) plus a short margin. */
export const BOOK_SECONDS = 28;

export interface CampaignLevel {
    /** PC path as listed (`Mountain World/Ruined Village/Ruined Village.lvl`). */
    path: string;
    /** 0-based position in the campaign order. */
    index: number;
    world: string;
    /** PC header name without the `<0xNNNN>` prefix. */
    pcName: string;
    /** Dragon.rrc string id of the name (`<0x9000>`), or null. */
    nameStringId: number | null;
    /** Readable name used in the title. */
    displayName: string;
    /** LEVELLST title and folder: `OotF 03 - Grimstone Mines`. */
    title: string;
    /** 8.3 folder / file stem of the title (`OOTF03ES`). */
    mangled: string;
    /** Pack path of the LVL: `files/ENGLISH/LEVELS/<M>/<M>.LVL`. */
    packPath: string;
    /** The level the player enters through the exit at the end of the previous one. */
    role: 'start' | 'level' | 'side' | 'final';
    exits: CampaignExit[];
    /** Rynn start of the PC level (for synthesized exits), or null when it has none. */
    rynn: Vec3 | null;
    /** Levels whose dependency lists name this level's folder-less shared databases (World Common). */
    sharedDeps: string[];
}

export interface CampaignEdge {
    from: string;
    to: string;
    reason: ExitReason;
    objectId: number;
}

export interface CampaignPlan {
    levels: CampaignLevel[];
    edges: CampaignEdge[];
    /** Levels not reachable from the start through exits (should be empty). */
    unreachable: string[];
    /** Distinct destination titles in id order: the strings the exits need. */
    destinationTitles: string[];
    /** `destinationTitle -> string id` (assigned from `stringBase` in the order of `destinationTitles`). */
    stringIds: Map<string, number>;
    stringBase: number;
    shared: SharedDependency[];
    warnings: string[];
    byPath: Map<string, CampaignLevel>;
}

// ---------------------------------------------------------------- helpers

/** Compare level references: case-insensitive, one separator, `.lvl` kept. */
export function normalizeLevelRef(s: string): string {
    return s
        .trim()
        .replace(/\\/g, '/')
        .replace(/^\/+/, '')
        .replace(/^levels\//i, '')
        .toLowerCase();
}

/** The destination text the PS2 engine compares and loads: `Levels\<title>\<title>.lvl` (no leading backslash, like the disc). */
export const campaignDestinationText = (title: string): string => `Levels\\${title}\\${title}.lvl`;

const TRANSITION_FIELD = /^transition to\.\.\.$/i;

export function transitionFieldIndex(fields: readonly Pick<ClassFieldDef, 'name' | 'type'>[] | undefined): number {
    if (!fields) return -1;
    const i = fields.findIndex((f) => TRANSITION_FIELD.test(f.name.trim()));
    return i >= 0 && fieldBase(fields[i]!.type) === FIELD_STRING && !fieldIsArray(fields[i]!.type) ? i : -1;
}

interface PcExit {
    obj: LvlObject;
    className: string;
    text: string;
}

/** Exits of a PC level: objects whose class has a "Transition To..." string field; an object override wins over the class default. */
export function pcExits(pc: PcLevel): PcExit[] {
    const out: PcExit[] = [];
    for (const o of pc.list.objects) {
        const cls = pc.classes.get(o.dbIndex)?.get(o.classId);
        const fi = transitionFieldIndex(cls?.fields);
        if (!cls || fi < 0) continue;
        let text = '';
        const dword = cls.data?.[fi];
        if (dword !== undefined) text = String(decodeFieldValue(cls.fields![fi]!.type, dword, cls.data!));
        const pi = o.params.findIndex((p) => TRANSITION_FIELD.test(p.name.trim()));
        if (pi >= 0) text = String(decodeFieldValue(o.params[pi]!.type, o.data[pi]!, o.data));
        // A class with the field but no destination (a scripted "Exit" object) is not a level exit.
        if (text.trim()) out.push({ obj: o, className: cls.name, text });
    }
    return out;
}

function rynnStart(pc: PcLevel): Vec3 | null {
    for (const o of pc.list.objects) {
        const cls = pc.classes.get(o.dbIndex)?.get(o.classId);
        if (cls?.name.trim().toLowerCase() === 'rynn') {
            // The converted level starts Rynn 400 units over the ground under the PC start (convert.ts); the arrival marker has to
            // match, or the respawned player hangs at the raw PC height (inside the rock or high in the sky) and the camera with her.
            const p: Vec3 = [...o.pos];
            const g = terrainGroundBelow(pc.terrain, p[0], p[2], p[1]);
            if (Number.isFinite(g)) p[1] = g + 400;
            return p;
        }
    }
    return null;
}

/** The PC intro's closing trigger: a detector object of the class "Stomp" (position grounded on the terrain), or null. */
function introEnd(pc: PcLevel | undefined): Vec3 | null {
    if (!pc) return null;
    for (const o of pc.list.objects) {
        const cls = pc.classes.get(o.dbIndex)?.get(o.classId);
        if (cls && /^stomp$/i.test(cls.name.trim())) {
            const p: Vec3 = [...o.pos];
            const g = terrainGroundBelow(pc.terrain, p[0], p[2], p[1] + 2000);
            if (Number.isFinite(g)) p[1] = g;
            return p;
        }
    }
    return null;
}

function nameStringId(h: PcLevel['header']): number | null {
    const m = /^<0x([0-9a-fA-F]+)>/.exec(h.name.text);
    return m ? parseInt(m[1]!, 16) : null;
}

function readable(name: string): string {
    const t = name.trim().replace(/\s+/g, ' ');
    return t === t.toLowerCase() ? t.replace(/\b[a-z]/g, (c) => c.toUpperCase()) : t;
}

// ---------------------------------------------------------------- shared dependencies

/**
 * A database the PC level lists (`..\Mountain World Common\Mountain World Common`). `kind`: `engine` = `Common\*` (System, FX,
 * Resources, NPCs ... : mapped onto the PS2 databases of the same role, never converted as a unit), `world` = used by two or
 * more levels of the campaign (convert once: the pipeline keeps one asset container and one id map for the whole pack, so
 * convert all levels in ONE `convertOotfLevels` call), `level` = the level's own.
 */
export interface SharedDependency {
    /** Resolved path without extension, lower case (`mountain world/mountain world common/mountain world common`). */
    key: string;
    kind: 'engine' | 'world' | 'level';
    /** Display name (last path component). */
    name: string;
    users: string[];
}

export function planSharedDependencies(levels: readonly PcLevel[]): SharedDependency[] {
    const byKey = new Map<string, SharedDependency>();
    for (const pc of levels) {
        const baseDir = pc.path.split('/').slice(0, -1).join('/');
        const seen = new Set<string>();
        for (const dep of pc.header.dependencies) {
            const key = resolvePcPath(baseDir, dep.path.text).toLowerCase();
            if (seen.has(key)) continue;
            seen.add(key);
            let s = byKey.get(key);
            if (!s) {
                s = { key, kind: 'level', name: pcDependencyKey(dep.path.text), users: [] };
                s.name = dep.path.text.split(/[\\/]/).filter(Boolean).pop() ?? s.name;
                byKey.set(key, s);
            }
            s.users.push(pc.path);
        }
    }
    for (const s of byKey.values()) {
        s.kind = s.key.startsWith('common/') ? 'engine' : s.users.length > 1 ? 'world' : 'level';
    }
    return [...byKey.values()].sort((a, b) => a.key.localeCompare(b.key));
}

// ---------------------------------------------------------------- the plan

/**
 * Plan the campaign of a set of PC levels (usually all 13 non-multiplayer levels): order, titles, exit graph, the exits
 * that must be added, the strings the exits need. Pure: nothing is written.
 */
export function planCampaign(levels: readonly PcLevel[], opt: CampaignOptions = {}): CampaignPlan {
    const warnings: string[] = [];
    const prefix = opt.prefix ?? 'OotF';
    const stringBase = opt.stringBase ?? 0x7000;
    const sorted = [...levels].sort((a, b) => {
        const ia = nameStringId(a.header) ?? -1;
        const ib = nameStringId(b.header) ?? -1;
        return ia - ib || a.path.localeCompare(b.path);
    });
    // Start: explicit, else a level called Intro, else the first.
    const startPath =
        opt.startPath ??
        sorted.find((l) => /intro/i.test(l.path) && !/book/i.test(l.path))?.path ??
        sorted[0]?.path;
    if (startPath) {
        const i = sorted.findIndex((l) => normalizeLevelRef(l.path) === normalizeLevelRef(startPath));
        if (i > 0) sorted.unshift(...sorted.splice(i, 1));
    }

    const pad = Math.max(2, String(sorted.length - 1).length);
    const out: CampaignLevel[] = [];
    const byPath = new Map<string, CampaignLevel>();
    const seenMangled = new Map<string, string>();
    sorted.forEach((pc, index) => {
        const pcName = pcLevelName(pc.header);
        const displayName = readable(pcName.replace(/\s+level$/i, '') || pcName);
        const title = `${prefix} ${String(index).padStart(pad, '0')} - ${displayName}`;
        const mangled = mangleComponent(title);
        const clash = seenMangled.get(mangled);
        if (clash) warnings.push(`"${title}" and "${clash}" both mangle to ${mangled}`);
        seenMangled.set(mangled, title);
        const lv: CampaignLevel = {
            path: pc.path,
            index,
            world: pc.path.split('/')[0] ?? '',
            pcName,
            nameStringId: nameStringId(pc.header),
            displayName,
            title,
            mangled,
            packPath: `files/ENGLISH/LEVELS/${mangled}/${mangled}.LVL`,
            role: index === 0 ? 'start' : 'level',
            exits: [],
            rynn: rynnStart(pc),
            sharedDeps: [],
        };
        out.push(lv);
        byPath.set(normalizeLevelRef(pc.path), lv);
    });
    const find = (ref: string): CampaignLevel | null => byPath.get(normalizeLevelRef(ref)) ?? null;

    // Real exits.
    const pcByPath = new Map(sorted.map((p) => [normalizeLevelRef(p.path), p]));
    for (const lv of out) {
        const pc = pcByPath.get(normalizeLevelRef(lv.path))!;
        for (const e of pcExits(pc)) {
            const dest = find(e.text);
            if (!dest) warnings.push(`${lv.title}: exit ${e.obj.id} "${e.className}" leads to "${e.text}", which is not in the campaign`);
            lv.exits.push({
                ...(/book/i.test(lv.pcName) ? { autoSeconds: BOOK_SECONDS } : {}),
                reason: 'pc',
                pcObjectId: e.obj.id,
                pcClassName: e.className,
                pos: [...e.obj.pos],
                rot: [...e.obj.rot],
                scale: e.obj.scale ? [...e.obj.scale] : null,
                pcText: e.text,
                destPath: dest?.path ?? null,
                destTitle: dest?.title ?? null,
                synthetic: false,
            });
        }
    }

    // The intro has no exit of its own: Interface.odb hands over to the first level.
    const start = out[0];
    const first = opt.firstPath ? find(opt.firstPath) : (out.find((l) => /^ruined village$/i.test(l.pcName)) ?? out[1] ?? null);
    if (start && first && start !== first && !start.exits.some((e) => e.destPath)) {
        // Where the PC intro ends: the "Stomp" detector the player walks into (it plays the closing sequence). Without one the
        // hand-over sits at the Rynn start.
        const at = introEnd(pcByPath.get(normalizeLevelRef(start.path))) ?? start.rynn ?? [0, 0, 0];
        const hand = synth(start, first, 'intro-next', at, opt.arrivalOffset);
        hand.autoSeconds = INTRO_SECONDS;
        start.exits.push(hand);
    }

    // Arrival markers: every real edge A -> B needs an exit in B whose destination is A.
    for (const a of out) {
        for (const e of [...a.exits]) {
            if (!e.destPath || e.reason === 'arrival') continue;
            const b = byPath.get(normalizeLevelRef(e.destPath))!;
            if (b === a || b.exits.some((x) => x.destPath && normalizeLevelRef(x.destPath) === normalizeLevelRef(a.path))) continue;
            const at = b.rynn ?? [0, 0, 0];
            b.exits.push(synth(b, a, 'arrival', at, opt.arrivalOffset));
        }
    }

    // Edges, reachability, roles.
    const edges: CampaignEdge[] = [];
    for (const a of out) {
        for (const e of a.exits) if (e.destPath && !e.synthetic) edges.push({ from: a.path, to: e.destPath, reason: e.reason, objectId: e.pcObjectId });
        for (const e of a.exits) if (e.reason === 'intro-next') edges.push({ from: a.path, to: e.destPath!, reason: e.reason, objectId: 0 });
    }
    const reach = new Set<string>();
    const queue = out.length ? [out[0]!] : [];
    while (queue.length) {
        const l = queue.pop()!;
        if (reach.has(l.path)) continue;
        reach.add(l.path);
        for (const e of l.exits) if (e.destPath && e.reason !== 'arrival') queue.push(byPath.get(normalizeLevelRef(e.destPath))!);
    }
    const unreachable = out.filter((l) => !reach.has(l.path)).map((l) => l.path);
    for (const l of out) {
        if (l.index === 0) continue;
        const outgoing = l.exits.filter((e) => e.destPath && e.reason !== 'arrival');
        if (!outgoing.length) l.role = 'final';
    }
    for (const l of out) {
        // A level only entered from one level and leading straight back to it (the book, Alwarren): a side level.
        const incoming = edges.filter((e) => normalizeLevelRef(e.to) === normalizeLevelRef(l.path));
        const outgoing = l.exits.filter((e) => e.destPath && e.reason !== 'arrival');
        if (l.role === 'level' && incoming.length === 1 && outgoing.length === 1 && normalizeLevelRef(outgoing[0]!.destPath!) === normalizeLevelRef(incoming[0]!.from)) {
            l.role = 'side';
        }
    }

    const destinationTitles = [...new Set(out.flatMap((l) => l.exits.map((e) => e.destTitle).filter((t): t is string => !!t)))].sort();
    const stringIds = new Map(destinationTitles.map((t, i) => [t, stringBase + i]));
    const shared = planSharedDependencies(sorted);
    for (const s of shared) {
        if (s.kind !== 'world') continue;
        for (const u of s.users) byPath.get(normalizeLevelRef(u))?.sharedDeps.push(s.name);
    }
    for (const p of unreachable) warnings.push(`${p}: not reachable from the start through exits`);
    return { levels: out, edges, unreachable, destinationTitles, stringIds, stringBase, shared, warnings, byPath };
}

function synth(at: CampaignLevel, to: CampaignLevel, reason: ExitReason, pos: readonly number[], offset?: readonly number[]): CampaignExit {
    const o = offset ?? [0, 0, 0];
    return {
        reason,
        pcObjectId: 0,
        pcClassName: 'Level Transition (added)',
        pos: [pos[0]! + (o[0] ?? 0), pos[1]! + (o[1] ?? 0), pos[2]! + (o[2] ?? 0)],
        rot: [0, 0, 0],
        scale: null,
        pcText: '',
        destPath: to.path,
        destTitle: to.title,
        synthetic: true,
    };
}

// ---------------------------------------------------------------- registrations

export interface CampaignRegistration {
    /** Mod manifest `levels = [...]`, in play order. */
    levels: string[];
    /** `LEVELLST.TXT` lines the runtime adds (informational; it rebuilds the list itself). */
    levelListLines: string[];
    /** `[title, mangled, packPath]` per level. */
    files: { title: string; mangled: string; packPath: string; path: string }[];
}

export function campaignRegistration(plan: CampaignPlan): CampaignRegistration {
    return {
        levels: plan.levels.map((l) => l.title),
        levelListLines: plan.levels.map((l) => `\\Levels\\${l.title}\\${l.title}.lvl`),
        files: plan.levels.map((l) => ({ title: l.title, mangled: l.mangled, packPath: l.packPath, path: l.path })),
    };
}

/** Title the converter should use for a PC level path (also the header name to write), or undefined. */
export const campaignTitle = (plan: CampaignPlan, pcPath: string): string | undefined =>
    plan.byPath.get(normalizeLevelRef(pcPath))?.title;

// ---------------------------------------------------------------- strings (the XDB side)

export interface CampaignEntryChange {
    file: string;
    type: number;
    id: number;
    sub: number;
    data: Uint8Array;
    isNew: boolean;
}

/** Characters of a title the game's font cannot show (it is Windows-1252 text); empty when fine. */
export function titleProblem(title: string): string {
    for (const ch of title) if (cp1252Byte(ch) < 0) return `'${ch}' is not Windows-1252`;
    return '';
}

/**
 * New XDB strings, one per destination: `new/<xdbFile>/0400_<id>_1.bin`. `xdbFile` is the XDB of the database that holds the
 * exit class the converted exits use (`LEVEL1ON.XDB` for classes of LEVEL1ON.ODB, i.e. the template's own level-common ODB).
 */
export function campaignExitStrings(plan: CampaignPlan, xdbFile: string, sub = 1): CampaignEntryChange[] {
    return plan.destinationTitles.map((title) => {
        const id = plan.stringIds.get(title)!;
        const bad = titleProblem(title);
        if (bad) throw new Error(`title "${title}": ${bad}`);
        return {
            file: xdbFile.toUpperCase(),
            type: 0x400,
            id,
            sub,
            data: encodeXdbString({ id, sub, text: [campaignDestinationText(title)] }),
            isNew: true,
        };
    });
}

// ---------------------------------------------------------------- rewriting the converted object list

export interface ExitField {
    fieldIndex: number;
    type: number;
    name: string;
}

export interface ApplyExitsContext {
    /** For an object of the converted list: its exit field when its class is an exit class, else null. */
    exitFieldOf(o: LvlObject): ExitField | null;
    /** Exit class used for added exits (`ps2ClassTables` entry whose engine class is 55; a "Level Transition from 1 to 2" class). */
    exitClass: { dbIndex: number; classId: number; field: ExitField };
    /**
     * "Trigger Detector" class of the template (engine class 0x1003d). On PS2 nothing fires an exit by the player standing on it:
     * every exit of the disc is the link target of a detector box (docs/journal/2026-11-01/level-exit-walk-in.md), while a PC exit
     * is touched itself. When given, every real exit (`reason` pc) gets a detector box centred on it that links to the exit.
     */
    detectorClass?: { dbIndex: number; classId: number };
    /** Size of that box in cells of 2048 units (default 2 x 2 x 2), centre lifted by `detectorLift` units (default 700). */
    detectorSize?: Vec3;
    detectorLift?: number;
    /**
     * "Detect Which?" field of the detector class. With it every exit gets a second detector with the value 1 (Rynn on a mount): the
     * class default does not fire while Rynn rides Arokh (the Islands hub is flown), value 1 does not fire on foot.
     */
    mountDetector?: { fieldIndex: number; type: number; name: string };
    /** Parameter overrides for the added exit detectors (e.g. Detect Which?); other fields keep the class default. */
    detectorParams?: readonly { fieldIndex: number; type: number; name: string; value: number }[];
    /** "Timer" class of the template (engine class 0x1003e): exits with `autoSeconds` get one that fires them (Trigger Message 5, as on the disc). */
    timerClass?: { dbIndex: number; classId: number; fields: readonly Pick<ClassFieldDef, 'name' | 'type'>[] };
}

export interface ApplyExitsResult {
    /** Existing converted exits whose destination was set. */
    rewritten: number;
    /** Exits added (synthesized, or PC exits whose class was dropped by the converter). */
    added: number;
    /** PC exits whose destination is not in the campaign (left as converted). */
    external: number;
    /** Trigger detectors added in front of exits. */
    detectors: number;
    /** Timers added for cut-scene levels. */
    timers: number;
    warnings: string[];
}

/**
 * Point a PS2 object's destination field at XDB string `id`: the field becomes a plain dword (length 0, offset = id), exactly
 * the form of the 12 overrides on the disc. Other parameters, including strings and arrays, are kept.
 */
export function setExitDestinationId(o: LvlObject, field: ExitField, id: number): void {
    const old = o.params.map((p, i) => ({ p, dword: o.data[i]!, i })).filter((x) => x.p.fieldIndex !== field.fieldIndex);
    const items: { p: LvlParam; dword: number; words: number[] | null }[] = old.map((x) => {
        const indirect = fieldIsIndirect(x.p.type);
        const len = x.dword >>> 16;
        const off = x.dword & 0xffff;
        return { p: x.p, dword: x.dword, words: indirect && len > 0 ? o.data.slice(off, off + len) : null };
    });
    const nameRaw = new Uint8Array(field.name.length + 1 + ((field.name.length + 1) % 2));
    for (let i = 0; i < field.name.length; i++) nameRaw[i] = field.name.charCodeAt(i) & 0xff;
    items.push({ p: { fieldIndex: field.fieldIndex, type: field.type, name: field.name, nameRaw }, dword: id >>> 0, words: null });
    items.sort((a, b) => a.p.fieldIndex - b.p.fieldIndex);
    const n = items.length;
    const data: number[] = new Array<number>(n).fill(0);
    const extra: number[] = [];
    items.forEach((it, k) => {
        if (it.words) {
            data[k] = ((it.words.length << 16) | (n + extra.length)) >>> 0;
            extra.push(...it.words);
        } else data[k] = it.dword;
    });
    o.params = items.map((it) => it.p);
    o.data = [...data, ...extra];
}

/** Give a freshly added object (no parameters yet) these plain one-dword parameters. */
export function setScalarParams(o: LvlObject, set: readonly { fieldIndex: number; type: number; name: string; value: number }[]): void {
    const sorted = [...set].sort((a, b) => a.fieldIndex - b.fieldIndex);
    o.params = sorted.map((p) => {
        const nameRaw = new Uint8Array(p.name.length + 1 + ((p.name.length + 1) % 2));
        for (let i = 0; i < p.name.length; i++) nameRaw[i] = p.name.charCodeAt(i) & 0xff;
        return { fieldIndex: p.fieldIndex, type: p.type, name: p.name, nameRaw };
    });
    o.data = sorted.map((p) => p.value >>> 0);
}

/**
 * Rewrite the exits of one converted level. `list` is the PS2 object list `convertPcLevel` produced (ids = PC ids; the
 * first occurrence of a duplicate keeps its id). Real exits get the destination string id of their destination level; exits
 * whose PC class was dropped, and the synthesized exits (intro hand-over, arrival markers), are added with the exit class.
 */
export function applyCampaignExits(list: LvlObjectList, level: CampaignLevel, plan: CampaignPlan, ctx: ApplyExitsContext): ApplyExitsResult {
    const res: ApplyExitsResult = { rewritten: 0, added: 0, external: 0, detectors: 0, timers: 0, warnings: [] };
    const converted = new Set(list.objects.map((o) => o.id)); // objects added below take ids above every PC id and must not be mistaken for one
    for (const e of level.exits) {
        if (!e.destTitle) {
            res.external++;
            continue;
        }
        const id = plan.stringIds.get(e.destTitle)!;
        const existing = !e.synthetic && converted.has(e.pcObjectId) ? list.objects.find((o) => o.id === e.pcObjectId) : undefined;
        const field = existing ? ctx.exitFieldOf(existing) : null;
        let exitObj: LvlObject | undefined;
        if (existing && field) {
            setExitDestinationId(existing, field, id);
            res.rewritten++;
            exitObj = existing;
        } else {
            const tpl = list.objects.find((o) => o.classId === ctx.exitClass.classId && o.dbIndex === ctx.exitClass.dbIndex);
            const { object } = addObject(list, {
                classId: ctx.exitClass.classId,
                dbIndex: ctx.exitClass.dbIndex,
                pos: e.pos,
                rot: e.rot,
                ...(tpl ? { templateId: tpl.id } : {}),
            });
            if (e.scale) {
                object.flags |= FLAG_SCALED;
                object.scale = [...e.scale];
            }
            // A fresh body must not inherit the template exit's destination override.
            setExitDestinationId(object, ctx.exitClass.field, id);
            if (existing) {
                // The converted object is of a synthesized class that is no exit on PS2 (a second exit at the same spot would leave an
                // inert twin with no destination). Keep its id (detectors / plates link to it), position and scale; make it the exit.
                existing.classId = object.classId;
                existing.dbIndex = object.dbIndex;
                existing.params = object.params;
                existing.data = object.data;
                list.objects.splice(list.objects.indexOf(object), 1);
                res.rewritten++;
                res.warnings.push(`${level.title}: object ${existing.id} is not an exit class on PS2; replaced it with the exit class`);
                exitObj = existing;
            } else {
                res.added++;
                exitObj = object;
            }
        }
        if (ctx.detectorClass && exitObj && (e.reason === 'pc' || e.reason === 'intro-next')) {
            // Centred on the exit's own height: the terrain function picks other layers under many exits (the real floor is the exit
            // height, 6000 to 10000 above the layer it finds); a box stretched down to that layer was not touched by a walker standing in it.
            const size: Vec3 = [...(ctx.detectorSize ?? [2, 2, 2])] as Vec3;
            const cy = exitObj.pos[1] + (ctx.detectorLift ?? 700);
            const { object: det } = addObject(list, {
                classId: ctx.detectorClass.classId,
                dbIndex: ctx.detectorClass.dbIndex,
                pos: [exitObj.pos[0], cy, exitObj.pos[2]],
                rot: [0, 0, 0],
            });
            // `addObject` copies the body of the first object of the class in the list: in levels that have converted PC detectors
            // that carried their parameters over (Trigger Message 0, Detect Only Once, Task ...) and the exit never got its message.
            det.flags = FLAG_VISIBLE | FLAG_SCALED;
            det.initialEvents = 1;
            det.radius = null;
            det.scale = size;
            setScalarParams(det, ctx.detectorParams ?? []);
            det.links = [exitObj.id];
            res.detectors++;
            if (ctx.mountDetector) {
                const { object: md } = addObject(list, {
                    classId: ctx.detectorClass.classId,
                    dbIndex: ctx.detectorClass.dbIndex,
                    pos: [exitObj.pos[0], cy, exitObj.pos[2]],
                    rot: [0, 0, 0],
                });
                md.flags = FLAG_VISIBLE | FLAG_SCALED;
                md.initialEvents = 1;
                md.radius = null;
                md.scale = [...size];
                setScalarParams(md, [{ ...ctx.mountDetector, value: 1 }]);
                md.links = [exitObj.id];
                res.detectors++;
            }
        }
        if (ctx.timerClass && exitObj && e.autoSeconds) {
            const fi = (name: string): number => ctx.timerClass!.fields.findIndex((f) => f.name.trim().toLowerCase() === name);
            const iTime = fi('time until trigger');
            const iMsg = fi('trigger message');
            const iMode = fi('start mode'); // 0 = start at once (the class default 1 waits for a message: the Intro timer never ran)
            if (iTime < 0 || iMsg < 0) res.warnings.push(`${level.title}: the Timer class lacks Time Until Trigger / Trigger Message`);
            else {
                const { object: tm } = addObject(list, {
                    classId: ctx.timerClass.classId,
                    dbIndex: ctx.timerClass.dbIndex,
                    pos: [exitObj.pos[0], exitObj.pos[1], exitObj.pos[2]],
                    rot: [0, 0, 0],
                });
                const f32 = new DataView(new ArrayBuffer(4));
                f32.setFloat32(0, e.autoSeconds);
                setScalarParams(tm, [
                    { fieldIndex: iTime, type: ctx.timerClass.fields[iTime]!.type, name: ctx.timerClass.fields[iTime]!.name, value: f32.getUint32(0) },
                    { fieldIndex: iMsg, type: ctx.timerClass.fields[iMsg]!.type, name: ctx.timerClass.fields[iMsg]!.name, value: 5 },
                    ...(iMode >= 0 ? [{ fieldIndex: iMode, type: ctx.timerClass.fields[iMode]!.type, name: ctx.timerClass.fields[iMode]!.name, value: 0 }] : []),
                ]);
                tm.links = [exitObj.id];
                res.timers++;
            }
        }
    }
    return res;
}
