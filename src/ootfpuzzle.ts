// Puzzle and ending logic of converted Order of the Flame levels: what the PS2 engine has no class for becomes the nearest
// working arrangement of PS2 objects (docs/journal/2026-11-01/ootf-puzzles-ending.md).
//
//   Pressure Plate (PC engine 29)    a Trigger Detector box on the plate (the plate itself stays a static prop: the only PS2 plate
//                                    classes live in LEVEL4ON / LEVEL8OS, which no template lists). Pressing = standing in the box.
//   Class Messenger (137)            the Message Relay is linked to every object of the receiver class.
//   Dr. Evil (92)                    four Giants on the altar floor, scaled, waiting for the level's trigger; the death counter
//                                    they are linked to counts the PS2 death message.
//   Map Object / Map Trigger (104)   a PS2 map marker with the PC object's name as journal entry and map label.
//   Key Lock (34) of a Quest Item    a Trigger Detector column under the lock, fired by Rynn carrying the item (the Bell Hammer).
//   Play Sequence detector (61)      a Stomp Player of the template level's database runs the scene (relayDetectorSequences).

import {
    FLAG_SCALED,
    FLAG_VISIBLE,
    addObject,
    setObjectParams,
    type LvlObject,
    type LvlObjectList,
    type ParamSpec,
    type Vec3,
} from './lvl.ts';
import type { PcLevel } from './pc.ts';
import { layerHeightAt, terrainGroundBelow } from './terrain.ts';
import type { OdbClass } from './odb.ts';
import { encodeScalar, fieldIsIndirect, type ClassFieldDef } from './fields.ts';
import { setExitDestinationId, setPlainParam } from './ootfcampaign.ts';
import { GENERIC_MARKER } from './ootfclass.ts';

export interface PuzzleClassRef {
    dbIndex: number;
    classId: number;
}

export interface PuzzleEnv {
    /** Where a world position falls on the level's map texture (pixels); absent when the level keeps the template's map. */
    mapPixel?: (x: number, z: number) => [number, number];
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
    /**
     * Write class defaults (field name -> dword) into the converted object's own synthesized class record. The game reads
     * a quest's journal entry, map text and type from its class, not from the placed map marker.
     */
    setClassDefaults?(o: LvlObject, values: readonly [string, number][]): void;
    /**
     * Class-reference value of the converted class of PC class (`pcDb`, `pcClassId`) as an object parameter of a `holder`
     * class: `(db << 16) | id`, db in the frame of the holder class's own database (0 = that database), null when unreachable.
     */
    classRef?(pcDb: number, pcClassId: number, holder: PuzzleClassRef): number | null;
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
    /** Links to rift cloud rings that were removed (see `quietCloudRings`). */
    quieted: number;
    /** Key locks opened by a quest item that became a gated detector (see `questItemLocks`). */
    questLocks: number;
}

const norm = (s: string): string => s.trim().toLowerCase();

/** Index of the field called `name` in a field list, or -1. */
export function fieldIndexByName(fields: readonly Pick<ClassFieldDef, 'name'>[] | undefined, name: string): number {
    return (fields ?? []).findIndex((f) => norm(f.name) === norm(name));
}

/** Set (or add) the object parameter of the field `name`; false when the class has no such scalar field. */
export function setNamedParam(
    _list: LvlObjectList,
    o: LvlObject,
    fields: readonly ClassFieldDef[] | undefined,
    name: string,
    value: number,
): boolean {
    const i = fieldIndexByName(fields, name);
    if (i < 0) return false;
    const f = fields![i]!;
    if (fieldIsIndirect(f.type)) {
        // A string-typed field holds the XDB string id itself as a plain dword (the form of a class default and of the disc's overrides).
        setExitDestinationId(o, { fieldIndex: i, type: f.type, name: f.name }, value);
        return true;
    }
    // setPlainParam keeps the other parameters word for word. Rebuilding the list from decoded values (setObjectParams)
    // turned a string id set before (dword = id, length 0) into an empty inline string, so the text was lost.
    setPlainParam(o, { fieldIndex: i, type: f.type, name: f.name }, encodeScalar(f.type, value));
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
    for (const [name, value] of params)
        if (!setNamedParam(env.list, object, fields, name, value))
            env.warnings.push(`${env.title}: detector class has no field "${name}"`);
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
        // Test aid (`OOTF_TEST_PLATE_AT=x,y,z`): the detector goes there (where the harness player stands) instead of over the plate, so a
        // run can prove the plate -> mover chain by state without walking to the plate.
        const at = (
            (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.[
                'OOTF_TEST_PLATE_AT'
            ] ?? ''
        )
            .split(',')
            .map(Number);
        const where: Vec3 =
            at.length === 3 && at.every(Number.isFinite)
                ? [at[0]!, at[1]!, at[2]!]
                : [dst.pos[0], dst.pos[1] + 1000, dst.pos[2]];
        const d = newDetector(env, where, size, [
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
        const targets = pc.list.objects.filter(
            (o) =>
                o.classId === cid &&
                (recv >>> 16 === 0 || o.dbIndex === recv >>> 16) &&
                list.objects.some((x) => x.id === o.id),
        );
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
        // Test aid (`OOTF_TEST_HEADHP=<hp>`): heads with few hit points, so the harness can kill them with real blows and watch the
        // engine's own death message reach the counter.
        const testHp = Number(
            (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.[
                'OOTF_TEST_HEADHP'
            ] ?? 0,
        );
        if (testHp > 0) setNamedParam(list, dst, env.classOf(dst)?.fields, 'Initial Health', testHp);
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

/**
 * Test aid (`OOTF_TEST_EBONHP=<hp>`): Ebon Dragons (engine class 30) with few hit points, so a scripted run can kill them with a
 * few real breath hits and watch the death messages reach the gate counter. Not part of any release conversion.
 */
function testEbonHealth(env: PuzzleEnv): void {
    const testHp = Number(
        (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.['OOTF_TEST_EBONHP'] ??
            0,
    );
    if (!(testHp > 0)) return;
    for (const o of env.pc.list.objects) {
        if (rflOf(env.pc, o) !== 30) continue;
        const dst = env.list.objects.find((x) => x.id === o.id);
        if (dst) setNamedParam(env.list, dst, env.classOf(dst)?.fields, 'Initial Health', testHp);
    }
}

/**
 * The PS2 Death Mage, the template Delon (PC engine class 82) is cloned from, has "Invulnerable?" 1; the PC class has no such
 * field and Delon is killed with real blows (his death message 8 reaches counter 455 and scene 436). Without this the clone took
 * no damage from breath, sword or bow (issue 5, `ootf-progression-3.md` section 9).
 */
export function isVulnerableBoss(name: string, rfl: number): boolean {
    return rfl === 82 && /^delon$/i.test(name.trim());
}

function vulnerableBosses(env: PuzzleEnv): void {
    for (const o of env.pc.list.objects) {
        if (!isVulnerableBoss(nameOf(env.pc, o), rflOf(env.pc, o) ?? -1)) continue;
        const dst = env.list.objects.find((x) => x.id === o.id);
        if (dst) setNamedParam(env.list, dst, env.classOf(dst)?.fields, 'Invulnerable?', 0);
    }
}

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
        // The PC markers carry no map coordinates (0 / 0 in every level): the object's place in the world is the position, put
        // through the level's map calibration; the label shows on the map as well as in the journal (type 2 = both).
        const at = env.mapPixel ? env.mapPixel(m.pos[0], m.pos[2]) : null;
        const set: [string, number][] = [
            ['Type', at ? (isQuest ? 2 : 0) : isQuest ? 1 : 0],
            ['SubQuest?', 0],
            ['Journal Entry', isQuest ? text : 0],
            ['Map Text', at || !isQuest ? text : 0],
            ['Map X Coordinate', at ? at[0] : Math.max(0, Math.min(255, Math.round(x * 0.4)))],
            ['Map Y Coordinate', at ? at[1] : Math.max(0, Math.min(255, Math.round(y * 0.4)))],
        ];
        for (const [name, value] of set) setNamedParam(list, dst, fields, name, value);
        // The quest table keys a quest by its class and draws its text and type from the class record.
        env.setClassDefaults?.(dst, set);
        rep.markers++;
    }
}

/**
 * Test aid (`OOTF_TEST_ENDING=<seconds>`): four timers that send the PS2 death message to the boss death counters after that many
 * seconds, so the ending chain (counter, end timer, sequence, credits) can be run without fighting.
 */
function testEnding(env: PuzzleEnv, counterIds: ReadonlySet<number>): void {
    const sec = Number(
        (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.['OOTF_TEST_ENDING'] ??
            0,
    );
    if (!sec || !env.timer || !counterIds.size) return;
    const fields = ((): readonly ClassFieldDef[] | undefined => {
        const t = env.list.objects.find((o) => o.classId === env.timer!.classId && o.dbIndex === env.timer!.dbIndex);
        return t ? env.classOf(t)?.fields : undefined;
    })();
    // OOTF_TEST_DIRECT=<step>: skip the counter (1) or the counter and the end timer (2) and message the next object of the chain.
    const direct = Number(
        (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.['OOTF_TEST_DIRECT'] ??
            0,
    );
    let targets = [...counterIds];
    if (direct >= 1)
        targets = [...new Set(targets.flatMap((id) => env.list.objects.find((o) => o.id === id)?.links ?? []))];
    if (direct >= 2)
        targets = [...new Set(targets.flatMap((id) => env.list.objects.find((o) => o.id === id)?.links ?? []))];
    for (let k = 0; k < (direct ? 1 : 4); k++) {
        const { object } = addObject(env.list, {
            classId: env.timer.classId,
            dbIndex: env.timer.dbIndex,
            pos: [0, 0, 0],
            rot: [0, 0, 0],
        });
        object.params = [];
        object.data = [];
        object.links = targets;
        const f = fields ?? env.classOf(object)?.fields;
        setNamedParam(env.list, object, f, 'Time Until Trigger', sec + k * 0.5);
        setNamedParam(env.list, object, f, 'Start Mode', 0);
        setNamedParam(env.list, object, f, 'Trigger Message', direct >= 2 ? 4 : direct ? 1 : 8);
    }
}

/** Test aid (`OOTF_TEST_WAKE=<seconds>`): a timer that sends ON to whatever wakes the Dr. Evil stand-ins (the level's own trigger). */
function testWake(env: PuzzleEnv): void {
    const sec = Number(
        (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.['OOTF_TEST_WAKE'] ??
            0,
    );
    if (!sec || !env.timer) return;
    const heads = new Set(env.pc.list.objects.filter((o) => rflOf(env.pc, o) === 92).map((o) => o.id));
    const wakers = env.list.objects
        .filter((o) => !heads.has(o.id) && o.links.some((l) => heads.has(l)))
        .map((o) => o.id);
    if (!wakers.length) return;
    const { object } = addObject(env.list, {
        classId: env.timer.classId,
        dbIndex: env.timer.dbIndex,
        pos: [0, 0, 0],
        rot: [0, 0, 0],
    });
    object.params = [];
    object.data = [];
    object.links = wakers;
    const f = env.classOf(object)?.fields;
    setNamedParam(env.list, object, f, 'Time Until Trigger', sec);
    setNamedParam(env.list, object, f, 'Start Mode', 0);
    setNamedParam(env.list, object, f, 'Trigger Message', 1);
}

const CELL = 2048;

/**
 * Key locks (PC engine 34) of a Quest Item (117, the Bell Hammer). On the PC the item is used from the inventory and finds the
 * lock by its Activation Radius; the Islands bell lock hangs about 23,000 units above the bell tower floor, out of reach. The
 * PS2 Use handler only opens a lock the player stands at (it compares the code of a Key, 0x10021, in the inventory), so the lock
 * becomes a Trigger Detector column from the lowest floor under it to its top, centred on it and at least two cells wide, that
 * fires once when Rynn on foot enters it carrying the item (the item converts to a Key class). It sends the lock's "Trigger
 * To Send" to the lock's links, which move from the lock to it; objects that link to the lock reach it too.
 */
function questItemLocks(env: PuzzleEnv, rep: PuzzleReport): void {
    const { pc, list } = env;
    if (!env.detector || !env.classRef) return;
    const items = new Map<number, { db: number; id: number }>();
    for (const [db, table] of pc.classes) {
        for (const [id, c] of table) {
            if (c.rflClass !== 117) continue;
            const i = fieldIndexByName(c.fields, 'Lock Code');
            const code = i >= 0 ? (c.data?.[i] ?? 0) | 0 : 0;
            if (code && !items.has(code)) items.set(code, { db, id });
        }
    }
    // A Key (33) placed in the level with the same code opens its lock the native way (Succubus Lair: the Jail Key shares the
    // Bell Hammer's code 20).
    for (const o of pc.list.objects) if (rflOf(pc, o) === 33) items.delete(pcFieldNumber(pc, o, 'Lock Code') ?? 0);
    if (!items.size) return;
    for (const lock of pc.list.objects.filter((o) => rflOf(pc, o) === 34)) {
        const item = items.get(pcFieldNumber(pc, lock, 'Lock Code') ?? 0);
        const dst = list.objects.find((x) => x.id === lock.id);
        if (!item || !dst) continue;
        const ref = env.classRef(item.db, item.id, env.detector);
        if (!ref) {
            env.warnings.push(
                `${env.title}: lock ${lock.id} (${nameOf(pc, lock)}): its quest item class is not reachable from the detector class`,
            );
            continue;
        }
        const sc = lock.flags & FLAG_SCALED && lock.scale ? lock.scale : ([1, 1, 1] as Vec3);
        const [x, y, z] = lock.pos;
        const top = y + Math.max(sc[1], 0.5) * CELL;
        let floor = Infinity;
        for (const L of pc.terrain) {
            if (L.type !== 0) continue;
            const h = layerHeightAt(L, x, z);
            if (!Number.isNaN(h) && h <= y && h < floor) floor = h;
        }
        const bottom = Number.isFinite(floor) ? floor : y - CELL;
        const size: Vec3 = [Math.max(2, 2 * sc[0]), (top - bottom) / CELL, Math.max(2, 2 * sc[2])];
        const d = newDetector(env, [x, (top + bottom) / 2, z], size, [
            ['Task', DETECTOR_TASK_TRIGGER_ONLY],
            ['Detect Which?', 0],
            ['Initial State', 0],
            ['Trigger Message', pcFieldNumber(pc, lock, 'Trigger To Send') ?? 1],
            ['Detect Only Once?', 1],
            ['Trigger Only If Carrying Item...', ref],
        ]);
        if (!d) continue;
        d.links = [...dst.links];
        dst.links = [];
        for (const o of list.objects)
            if (o !== d && o.links.includes(dst.id)) o.links = [...new Set([...o.links, d.id])];
        rep.questLocks++;
    }
}

/** PC Trigger Detector "Task" values (the enum order of both platforms). */
export const DETECTOR_TASK_PLAY_SEQUENCE = 4;
export const DETECTOR_TASK_TRIGGER_ONLY = 6;
/** Messages the PS2 Stomp Player handles itself (Off, On, Blow Up, Load) and Play Sequence; see ootfstomp.ts. */
const PLAYER_OWN_MESSAGES: ReadonlySet<number> = new Set([0, 1, 5, 23]);
const PLAYER_PLAY_MESSAGE = 4;

export interface SequenceRelayEnv {
    pc: PcLevel;
    /** The converted PS2 object list (object ids = PC object ids). */
    list: LvlObjectList;
    title: string;
    classOf(o: LvlObject): OdbClass | undefined;
    /** Stomp Player class whose database has an SSD (the converted sequences live in that SSD). */
    player: PuzzleClassRef;
    /**
     * Converted sequence refs (in the player's SSD frame) of a PC object whose converted class lives in a database without an
     * SSD; [] for every other object.
     */
    relayed(o: LvlObject): readonly number[];
    warnings: string[];
}

/**
 * Detectors that play a cut scene ("Task" Play Sequence, "Sequence To Play"). A sequence ref of a class is read from the SSD
 * of the class's own database, and the converted detector classes live in FX / SYSTEM, which have no SSD on the disc: the
 * scene was dropped (Islands bell tower, Wartok farmer, Volcanic, ...). Each such detector keeps its box and links, becomes
 * "Trigger Only" and gets a Stomp Player of the template's level database (whose SSD holds the converted scene) as an extra
 * link, started by the detector's own Trigger Message. The PC detector sends that message to its links as well, so the
 * other links behave as before. Returns the number of players added.
 */
export function relayDetectorSequences(env: SequenceRelayEnv): number {
    const { pc, list } = env;
    let added = 0;
    for (const o of pc.list.objects) {
        const refs = env.relayed(o);
        if (!refs.length) continue;
        const dst = list.objects.find((x) => x.id === o.id);
        if (!dst) continue;
        if (rflOf(pc, o) !== 61) {
            env.warnings.push(
                `${env.title}: object ${o.id} (${nameOf(pc, o)}) names a sequence its PS2 class cannot reach; dropped`,
            );
            continue;
        }
        const fields = env.classOf(dst)?.fields;
        const message = pcFieldNumber(pc, o, 'Trigger Message') ?? 1;
        if ((pcFieldNumber(pc, o, 'Task') ?? DETECTOR_TASK_TRIGGER_ONLY) === DETECTOR_TASK_PLAY_SEQUENCE)
            setNamedParam(list, dst, fields, 'Task', DETECTOR_TASK_TRIGGER_ONLY);
        // The PS2 detector defaults differ per database (FX sends 5): write the PC message.
        setNamedParam(list, dst, fields, 'Trigger Message', message);
        const { object } = addObject(list, {
            classId: env.player.classId,
            dbIndex: env.player.dbIndex,
            pos: dst.pos,
            rot: [0, 0, 0],
        });
        object.flags = FLAG_VISIBLE;
        object.scale = null;
        object.links = [];
        const pf = env.classOf(object)?.fields;
        const specs: ParamSpec[] = [];
        const field = (name: string, value: number | number[]): void => {
            const i = fieldIndexByName(pf, name);
            if (i >= 0) specs.push({ fieldIndex: i, type: pf![i]!.type, name: pf![i]!.name, value });
            else env.warnings.push(`${env.title}: Stomp Player class has no field "${name}"`);
        };
        // The PS2 player handles Off, Blow Up and Load itself and never compares them with "Message To Play Next" (Volcanic
        // 978 sends Off: scene 9.2 never played). On arms it, which plays a one-scene list once. For the others a twin of
        // the detector (same box, gating and senders) starts the player with Play Sequence; the detector keeps its links.
        const twin = message !== 1 && PLAYER_OWN_MESSAGES.has(message);
        field('Sequence List', [...refs]);
        field('List Play Order', 0);
        field('Initial State', 0);
        field('Message To Play Next', twin ? PLAYER_PLAY_MESSAGE : message);
        setObjectParams(list, object.id, specs);
        if (twin) {
            const { object: copy } = addObject(list, {
                classId: dst.classId,
                dbIndex: dst.dbIndex,
                pos: dst.pos,
                rot: dst.rot,
                templateId: dst.id,
            });
            copy.links = [object.id];
            setNamedParam(list, copy, fields, 'Trigger Message', PLAYER_PLAY_MESSAGE);
            for (const x of list.objects)
                if (x !== copy && x.links.includes(dst.id)) x.links = [...new Set([...x.links, copy.id])];
        } else dst.links = [...new Set([...dst.links, object.id])];
        added++;
    }
    return added;
}

/** The rift's cloud rings (Volcanic, Rift World): large spinning movers that the PC engine culls but the PS2 engine animates everywhere. */
const CLOUD_RING = /^(cloud\s*ring|clowd\s*ring)\s*\d*$/i;

/**
 * Volcanic's Rift Timer (Start Mode 0, links read as positions since 2026-11-01) switches 17 rift effect objects on at the start,
 * 8 of them cloud rings: from then on the guest ran at 2 frames per second (4 flips per 2 s against 270). Dropping the timer, or only the
 * cloud rings, restored 270 and 90 flips (journal 2026-11-01/ootf-link-regression.md). The rings stay in the level as scenery; nothing
 * switches them on.
 */
function quietCloudRings(env: PuzzleEnv, rep: PuzzleReport): void {
    const rings = new Set<number>();
    for (const o of env.pc.list.objects) {
        const name = env.pc.classes.get(o.dbIndex)?.get(o.classId)?.name ?? '';
        if (CLOUD_RING.test(name.trim())) rings.add(o.id);
    }
    if (!rings.size) return;
    for (const o of env.list.objects) {
        const keep = o.links.filter((l) => !rings.has(l));
        rep.quieted += o.links.length - keep.length;
        if (keep.length !== o.links.length) o.links = keep;
    }
}

/**
 * Test aid (`OOTF_TEST_MOVE=<title part>|<object id>|x,y,z;...`): move converted objects of a level, so a run can reach an
 * item without its level's puzzle (the Islands Bell Hammer 6135 floats over a hole west of the bell tower).
 */
function testMove(env: PuzzleEnv): void {
    const spec =
        (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.['OOTF_TEST_MOVE'] ??
        '';
    for (const part of spec.split(';')) {
        const [title, id, at] = part.split('|');
        const pos = (at ?? '').split(',').map(Number);
        if (!title || !env.title.includes(title) || pos.length !== 3 || !pos.every(Number.isFinite)) continue;
        const o = env.list.objects.find((x) => x.id === Number(id));
        if (o) o.pos = [pos[0]!, pos[1]!, pos[2]!];
    }
}

/** Apply every converter step of this module to one converted level. */
export function applyPuzzleLogic(env: PuzzleEnv): PuzzleReport {
    const rep: PuzzleReport = {
        plates: 0,
        detectors: 0,
        bossHeads: 0,
        deathCounters: 0,
        messengers: 0,
        markers: 0,
        markersSkipped: 0,
        quieted: 0,
        questLocks: 0,
    };
    platesToDetectors(env, rep);
    questItemLocks(env, rep);
    messengers(env, rep);
    bossHeads(env, rep);
    testEbonHealth(env);
    vulnerableBosses(env);
    markers(env, rep);
    quietCloudRings(env, rep);
    const counters = new Set<number>();
    for (const o of env.pc.list.objects)
        if (rflOf(env.pc, o) === 92)
            for (const l of env.list.objects.find((x) => x.id === o.id)?.links ?? []) counters.add(l);
    testEnding(env, counters);
    testWake(env);
    testMove(env);
    // Links to markers that were left out would dangle.
    const ids = new Set(env.list.objects.map((o) => o.id));
    for (const o of env.list.objects) if (o.links.some((l) => !ids.has(l))) o.links = o.links.filter((l) => ids.has(l));
    return rep;
}
