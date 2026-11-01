// Puzzle and ending logic of converted Order of the Flame levels: what the PS2 engine has no class for becomes the nearest
// working arrangement of PS2 objects (docs/journal/2026-11-01/ootf-puzzles-ending.md).
//
//   Pressure Plate (PC engine 29)    a Trigger Detector box on the plate (the plate itself stays a static prop: the only PS2 plate
//                                    classes live in LEVEL4ON / LEVEL8OS, which no template lists). Pressing = standing in the box.
//   Class Messenger (137)            the Message Relay is linked to every object of the receiver class.
//   Dr. Evil (92)                    four Giants on the altar floor, scaled, waiting for the level's trigger; the death counter
//                                    they are linked to counts the PS2 death message.
//   Map Object / Map Trigger (104)   a PS2 map marker with the PC object's name as journal entry and map label.

import { FLAG_SCALED, FLAG_VISIBLE, addObject, objectParamSpecs, setObjectParams, type LvlObject, type LvlObjectList, type ParamSpec, type Vec3 } from './lvl.ts';
import type { PcLevel } from './pc.ts';
import { terrainGroundBelow } from './terrain.ts';
import type { OdbClass } from './odb.ts';
import { fieldIsIndirect, type ClassFieldDef } from './fields.ts';
import { setExitDestinationId } from './ootfcampaign.ts';

export interface PuzzleClassRef {
    dbIndex: number;
    classId: number;
}

export interface PuzzleEnv {
    pc: PcLevel;
    /** The converted PS2 object list (object ids = PC object ids). */
    list: LvlObjectList;
    /** Title of the level, for messages. */
    title: string;
    /** PS2 class record of a converted object (template or synthesized), or undefined. */
    classOf(o: LvlObject): OdbClass | undefined;
    /** "Trigger Detector" class of the template. */
    detector?: PuzzleClassRef;
    /** "Timer" class of the template (test aid only). */
    timer?: PuzzleClassRef;
    /** XDB id of a text in the XDB of the object's class database (null: no XDB for it). */
    textId?(o: LvlObject, text: string): number | null;
    warnings: string[];
}

export interface PuzzleReport {
    plates: number;
    detectors: number;
    bossHeads: number;
    deathCounters: number;
    messengers: number;
    markers: number;
    markersSkipped: number;
}

const norm = (s: string): string => s.trim().toLowerCase();

/** Index of the field called `name` in a field list, or -1. */
export function fieldIndexByName(fields: readonly Pick<ClassFieldDef, 'name'>[] | undefined, name: string): number {
    return (fields ?? []).findIndex((f) => norm(f.name) === norm(name));
}

/** Set (or add) the object parameter of the field `name`; false when the class has no such scalar field. */
export function setNamedParam(list: LvlObjectList, o: LvlObject, fields: readonly ClassFieldDef[] | undefined, name: string, value: number): boolean {
    const i = fieldIndexByName(fields, name);
    if (i < 0) return false;
    const f = fields![i]!;
    if (fieldIsIndirect(f.type)) {
        // A string-typed field holds the XDB string id itself as a plain dword (the form of a class default and of the disc's overrides).
        setExitDestinationId(o, { fieldIndex: i, type: f.type, name: f.name }, value);
        return true;
    }
    const specs: ParamSpec[] = objectParamSpecs(o).filter((s) => s.fieldIndex !== i);
    specs.push({ fieldIndex: i, type: f.type, name: f.name, value });
    setObjectParams(list, o.id, specs);
    return true;
}

/** PC value of a field of the object's PC class or its override: number fields only. */
export function pcFieldNumber(pc: PcLevel, o: LvlObject, name: string): number | undefined {
    const cls = pc.classes.get(o.dbIndex)?.get(o.classId);
    const i = fieldIndexByName(cls?.fields, name);
    if (i < 0) return undefined;
    const pi = o.params.findIndex((p) => p.fieldIndex === i);
    const dword = pi >= 0 ? o.data[pi] : cls?.data?.[i];
    if (dword === undefined) return undefined;
    const t = cls!.fields![i]!.type & 0xff;
    if (t === 2) {
        const dv = new DataView(new ArrayBuffer(4));
        dv.setUint32(0, dword >>> 0);
        return dv.getFloat32(0);
    }
    return dword | 0;
}

const rflOf = (pc: PcLevel, o: LvlObject): number => pc.classes.get(o.dbIndex)?.get(o.classId)?.rflClass ?? -1;
const nameOf = (pc: PcLevel, o: LvlObject): string => (pc.classes.get(o.dbIndex)?.get(o.classId)?.name ?? '').trim();

function newDetector(env: PuzzleEnv, pos: Vec3, size: Vec3, params: readonly [string, number][]): LvlObject | null {
    const d = env.detector;
    if (!d) return null;
    const { object } = addObject(env.list, { classId: d.classId, dbIndex: d.dbIndex, pos, rot: [0, 0, 0] });
    object.flags = FLAG_VISIBLE | FLAG_SCALED;
    object.initialEvents = 1;
    object.radius = null;
    object.scale = size;
    object.params = [];
    object.data = [];
    const fields = env.classOf(object)?.fields;
    for (const [name, value] of params) if (!setNamedParam(env.list, object, fields, name, value)) env.warnings.push(`${env.title}: detector class has no field "${name}"`);
    return object;
}

/**
 * Pressure plates: one Trigger Detector box per plate, carrying the plate's links. A plate's "Message To Send At Bottom" is the
 * detector's message; "Stay Down When Pressed?" makes it fire once. Links to other plates (plates that reset or enable each other) and
 * links from other objects to a plate point at the plate's detector as well.
 */
function platesToDetectors(env: PuzzleEnv, rep: PuzzleReport): void {
    const { pc, list } = env;
    const plates = pc.list.objects.filter((o) => rflOf(pc, o) === 29 && list.objects.some((x) => x.id === o.id));
    if (!plates.length || !env.detector) return;
    const det = new Map<number, LvlObject>();
    for (const p of plates) {
        const when = pcFieldNumber(pc, p, 'Send Message When') ?? 1; // 0 top, 1 bottom, 2 both, 3 never
        if (when === 3 || when === 0) continue;
        const bottom = pcFieldNumber(pc, p, 'Message To Send At Bottom') ?? 1;
        const once = (pcFieldNumber(pc, p, 'Stay Down When Pressed?') ?? 1) !== 0;
        const dst = list.objects.find((x) => x.id === p.id)!;
        const sc = dst.scale ?? [1, 1, 1];
        // The plate tile is about 4000 units wide; the box covers the tile and the first 2000 units above it.
        const size: Vec3 = [Math.max(2, 2 * sc[0]), 1.5, Math.max(2, 2 * sc[2])];
        const d = newDetector(env, [dst.pos[0], dst.pos[1] + 1000, dst.pos[2]], size, [
            ['Task', 6],
            ['Trigger Message', bottom],
            ['Detect Only Once?', once ? 1 : 0],
        ]);
        if (d) det.set(p.id, d);
    }
    rep.plates += plates.length;
    for (const p of plates) {
        const d = det.get(p.id);
        const dst = list.objects.find((x) => x.id === p.id);
        if (!d || !dst) continue;
        d.links = [...new Set(dst.links.map((l) => det.get(l)?.id ?? l).filter((l) => l !== d.id))];
        rep.detectors++;
    }
    // Objects that rise / enable a plate reach its detector too.
    for (const o of list.objects) {
        if (det.has(o.id) || [...det.values()].includes(o)) continue;
        const extra = o.links.map((l) => det.get(l)?.id).filter((x): x is number => x !== undefined);
        if (extra.length) o.links = [...new Set([...o.links, ...extra])];
    }
}

/** Class Messenger: link the relay to every object of its "Receiver Class" (the PS2 Message Relay has no class field). */
function messengers(env: PuzzleEnv, rep: PuzzleReport): void {
    const { pc, list } = env;
    for (const m of pc.list.objects.filter((o) => rflOf(pc, o) === 137)) {
        const dst = list.objects.find((x) => x.id === m.id);
        if (!dst) continue;
        const recv = pcFieldNumber(pc, m, 'Receiver Class');
        if (recv === undefined) continue;
        const cid = recv & 0xffff;
        const targets = pc.list.objects.filter((o) => o.classId === cid && (recv >>> 16 === 0 || o.dbIndex === recv >>> 16) && list.objects.some((x) => x.id === o.id));
        if (!targets.length) {
            env.warnings.push(`${env.title}: Class Messenger ${m.id}: no converted object of class ${cid}`);
            continue;
        }
        dst.links = [...new Set([...dst.links, ...targets.map((t) => t.id)])];
        rep.messengers++;
    }
}

/**
 * Dr. Evil (the four boss heads of Rift World): the PS2 Giant stand-ins stand on the floor under the head's position (the PC heads
 * rise out of the rift pit below), bigger than a normal giant. The counter they are linked to counts the PS2 death message (8).
 */
function bossHeads(env: PuzzleEnv, rep: PuzzleReport): void {
    const { pc, list } = env;
    const heads = pc.list.objects.filter((o) => rflOf(pc, o) === 92);
    if (!heads.length) return;
    const counters = new Set<number>();
    for (const h of heads) {
        const dst = list.objects.find((x) => x.id === h.id);
        if (!dst) continue;
        const g = terrainGroundBelow(pc.terrain, dst.pos[0], dst.pos[2], 100000, 6000);
        if (Number.isFinite(g)) dst.pos = [dst.pos[0], g + 300, dst.pos[2]];
        dst.flags |= FLAG_SCALED;
        dst.scale = [1.6, 1.6, 1.6];
        // Face the middle of the altar (the heads stand around it).
        rep.bossHeads++;
        for (const l of dst.links) counters.add(l);
    }
    for (const id of counters) {
        const c = list.objects.find((x) => x.id === id);
        if (!c) continue;
        if (setNamedParam(list, c, env.classOf(c)?.fields, 'Decrement (-1) Message', 8)) rep.deathCounters++;
    }
}

const GENERIC_MARKER = /^map\s*(trigger|object|message|text|icon)?\s*$/i;

/** Map markers / quest entries (PC engine 104): journal entry and map label are the object's name. */
function markers(env: PuzzleEnv, rep: PuzzleReport): void {
    const { pc, list } = env;
    for (const m of pc.list.objects.filter((o) => rflOf(pc, o) === 104)) {
        const dst = list.objects.find((x) => x.id === m.id);
        if (!dst) continue;
        const label = nameOf(pc, m)
            .replace(/^map\s*(trigger|object)?\s*[-:]*\s*/i, '')
            .replace(/\s+icon$/i, '')
            .trim();
        if (!label || GENERIC_MARKER.test(nameOf(pc, m)) || !env.textId) {
            rep.markersSkipped++;
            // A generic marker has no text to show; leave the (inert) marker out.
            list.objects = list.objects.filter((x) => x.id !== m.id);
            continue;
        }
        const sound = pcFieldNumber(pc, m, 'New Quest Sound') ?? 0;
        const isQuest = sound !== 0; // quests announce themselves; icons only label a place on the map
        const text = env.textId(dst, label);
        const fields = env.classOf(dst)?.fields;
        if (text === null || text === 0 || !fields) {
            rep.markersSkipped++;
            list.objects = list.objects.filter((x) => x.id !== m.id);
            continue;
        }
        const x = pcFieldNumber(pc, m, 'Map X Coordinate') ?? 0;
        const y = pcFieldNumber(pc, m, 'Map Y Coordinate') ?? 0;
        const set: [string, number][] = [
            ['Type', isQuest ? 1 : 0],
            ['SubQuest?', 0],
            ['Journal Entry', isQuest ? text : 0],
            ['Map Text', isQuest ? 0 : text],
            ['Map X Coordinate', Math.max(0, Math.min(255, Math.round(x * 0.4)))],
            ['Map Y Coordinate', Math.max(0, Math.min(255, Math.round(y * 0.4)))],
        ];
        for (const [name, value] of set) setNamedParam(list, dst, fields, name, value);
        rep.markers++;
    }
}

/**
 * Test aid (`OOTF_TEST_ENDING=<seconds>`): four timers that send the PS2 death message to the boss death counters after that many
 * seconds, so the ending chain (counter, end timer, sequence, credits) can be run without fighting.
 */
function testEnding(env: PuzzleEnv, counterIds: ReadonlySet<number>): void {
    const sec = Number((globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.['OOTF_TEST_ENDING'] ?? 0);
    if (!sec || !env.timer || !counterIds.size) return;
    const fields = ((): readonly ClassFieldDef[] | undefined => {
        const t = env.list.objects.find((o) => o.classId === env.timer!.classId && o.dbIndex === env.timer!.dbIndex);
        return t ? env.classOf(t)?.fields : undefined;
    })();
    for (let k = 0; k < 4; k++) {
        const { object } = addObject(env.list, { classId: env.timer.classId, dbIndex: env.timer.dbIndex, pos: [0, 0, 0], rot: [0, 0, 0] });
        object.params = [];
        object.data = [];
        object.links = [...counterIds];
        const f32 = new DataView(new ArrayBuffer(4));
        f32.setFloat32(0, sec + k * 0.5);
        const f = fields ?? env.classOf(object)?.fields;
        setNamedParam(env.list, object, f, 'Time Until Trigger', f32.getUint32(0));
        setNamedParam(env.list, object, f, 'Start Mode', 0);
        setNamedParam(env.list, object, f, 'Trigger Message', 8);
    }
}

/** Apply every converter step of this module to one converted level. */
export function applyPuzzleLogic(env: PuzzleEnv): PuzzleReport {
    const rep: PuzzleReport = { plates: 0, detectors: 0, bossHeads: 0, deathCounters: 0, messengers: 0, markers: 0, markersSkipped: 0 };
    platesToDetectors(env, rep);
    messengers(env, rep);
    bossHeads(env, rep);
    markers(env, rep);
    const counters = new Set<number>();
    for (const o of env.pc.list.objects) if (rflOf(env.pc, o) === 92) for (const l of env.list.objects.find((x) => x.id === o.id)?.links ?? []) counters.add(l);
    testEnding(env, counters);
    // Links to markers that were left out would dangle.
    const ids = new Set(env.list.objects.map((o) => o.id));
    for (const o of env.list.objects) if (o.links.some((l) => !ids.has(l))) o.links = o.links.filter((l) => ids.has(l));
    return rep;
}
