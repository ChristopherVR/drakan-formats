// Stomp Players (cut scene players, engine class 51) of converted Order of the Flame levels: the PC and PS2 engines number
// "List Play Order" differently and start scenes differently, so the PC values are translated, not copied
// (docs/journal/2026-11-06/ootf-stomp-play-order.md).
//
// PC (Dragon.rfl, handler of class 0x33, read in Ghidra): items "In Order Once, In Order Loop, Randomly, All at Once". Only a
// message equal to "Message To Play Next" plays, one step per message; "Initial State" On plays one step at level load.
//   0 In Order Once   stops this player's previous scene if it still runs, plays the next one; after the last the player
//                     deletes itself.
//   1 In Order Loop   plays the next one and wraps: every trigger plays a scene, for good.
//   2 Randomly        every trigger plays a random one.
//   3 All at Once     plays every scene of the list together, then the player deletes itself.
//
// PS2 (SCES-500.06 handler 0x4091a0): items "In Order Once, In Order Loop, One Scene Per Trigger And Looped, Randomly, All at
// Once". Off (0) stops it, On (1) arms it, Blow Up (5) deletes it and Load (23) preloads; only other messages are compared
// with "Message To Play Next". That message plays a step at once and arms the player for every order except 2; an armed
// player keeps stepping by itself whenever its last scene has finished:
//   0 In Order Once   the trigger plays the first scene and the rest follow back to back; after the last it deletes itself.
//   1 In Order Loop   like 0 but wraps: one trigger replays the list for good (Volcanic "Arrow No Flame" every 5 s).
//   2 One Scene Per Trigger And Looped   a trigger plays the next scene once the previous one has ended, and wraps; never
//                     arms itself, so On does nothing.
//   3 Randomly        a random scene, and it arms itself.
//   4 All at Once     every scene together, then it deletes itself.

import {
    objectParamSpecs,
    paramValue,
    setObjectParams,
    type LvlObject,
    type LvlObjectList,
    type ParamSpec,
} from './lvl.ts';
import type { OdbClass } from './odb.ts';
import { classFieldDefault } from './odb.ts';
import type { PcLevel } from './pc.ts';
import { fieldIndexByName, pcFieldNumber } from './ootfpuzzle.ts';

/** PC "List Play Order" items. */
export const PC_ORDER_IN_ORDER_ONCE = 0;
export const PC_ORDER_IN_ORDER_LOOP = 1;
export const PC_ORDER_RANDOMLY = 2;
export const PC_ORDER_ALL_AT_ONCE = 3;

/** PS2 "List Play Order" items. */
export const PS2_ORDER_IN_ORDER_ONCE = 0;
export const PS2_ORDER_IN_ORDER_LOOP = 1;
export const PS2_ORDER_ONE_PER_TRIGGER = 2;
export const PS2_ORDER_RANDOMLY = 3;
export const PS2_ORDER_ALL_AT_ONCE = 4;

/** Messages the PS2 player handles itself before it compares "Message To Play Next": Off, On, Blow Up, Load. */
export const PS2_STOMP_OWN_MESSAGES: ReadonlySet<number> = new Set([0, 1, 5, 23]);
/** The message the PS2 player can always be started with (Play Sequence). */
export const PS2_STOMP_PLAY_MESSAGE = 4;

/** Effective settings of a PC Stomp Player (object parameter, else the class default). */
export interface PcStompPlayer {
    /** Sequence refs of its list (non-zero entries kept in order). */
    sequences: number[];
    /** True when the list is the class default (the object has no "Sequence List" of its own). */
    sequencesFromClass: boolean;
    order: number;
    initialOn: boolean;
    message: number;
}

const ENGINE_STOMP_PLAYER = 51;

/** The PC object's Stomp Player settings, or null when it is not a Stomp Player. */
export function pcStompPlayer(pc: PcLevel, o: LvlObject): PcStompPlayer | null {
    const cls = pc.classes.get(o.dbIndex)?.get(o.classId);
    if (cls?.rflClass !== ENGINE_STOMP_PLAYER) return null;
    const i = fieldIndexByName(cls.fields, 'Sequence List');
    const own = i >= 0 ? o.params.findIndex((p) => p.fieldIndex === i) : -1;
    const raw: unknown = own >= 0 ? paramValue(o, own) : i >= 0 ? classFieldDefault(cls, i) : undefined;
    const list = Array.isArray(raw) ? raw : typeof raw === 'number' ? [raw] : [];
    return {
        sequences: list.filter((v): v is number => typeof v === 'number' && v !== 0).map((v) => v >>> 0),
        sequencesFromClass: own < 0,
        order: pcFieldNumber(pc, o, 'List Play Order') ?? PC_ORDER_IN_ORDER_ONCE,
        initialOn: (pcFieldNumber(pc, o, 'Initial State') ?? 0) === 1,
        message: pcFieldNumber(pc, o, 'Message To Play Next') ?? PS2_STOMP_PLAY_MESSAGE,
    };
}

export interface Ps2PlayOrder {
    order: number;
    /** Set when the PS2 engine cannot reproduce the PC behaviour exactly. */
    note?: string;
}

/**
 * PS2 "List Play Order" for a PC player: `pcOrder`, `scenes` = list length, `initialOn`, `message` = its "Message To Play
 * Next" (what its senders send).
 */
export function ps2PlayOrder(pcOrder: number, scenes: number, initialOn: boolean, message: number): Ps2PlayOrder {
    const ownMessage = PS2_STOMP_OWN_MESSAGES.has(message);
    switch (pcOrder) {
        case PC_ORDER_ALL_AT_ONCE:
            return { order: PS2_ORDER_ALL_AT_ONCE };
        case PC_ORDER_RANDOMLY:
            return {
                order: PS2_ORDER_RANDOMLY,
                note: 'Randomly: the PS2 player also keeps picking scenes by itself once triggered',
            };
        case PC_ORDER_IN_ORDER_LOOP:
            // One scene per trigger, wrapping: PS2 2. It needs a message the player compares and does nothing at load.
            if (!ownMessage && !initialOn) return { order: PS2_ORDER_ONE_PER_TRIGGER };
            return {
                order: PS2_ORDER_IN_ORDER_ONCE,
                note: `In Order Loop ${initialOn ? 'starting at load' : `played by message ${message}`}: plays once on the PS2 engine`,
            };
        default:
            if (scenes <= 1) return { order: PS2_ORDER_IN_ORDER_ONCE };
            // PC: one scene per trigger, the player ends after the last. PS2 0 would run the whole list on the first trigger.
            if (!ownMessage && !initialOn)
                return {
                    order: PS2_ORDER_ONE_PER_TRIGGER,
                    note: 'In Order Once with several scenes: one per trigger, but a trigger during a scene is ignored and the list wraps after the last',
                };
            return {
                order: PS2_ORDER_IN_ORDER_ONCE,
                note: 'In Order Once with several scenes started at load or by Off / On: the PS2 player runs them back to back',
            };
    }
}

export interface StompEnv {
    pc: PcLevel;
    /** The converted PS2 object list (object ids = PC object ids). */
    list: LvlObjectList;
    title: string;
    classOf(o: LvlObject): OdbClass | undefined;
    /** Converted ref of a PC sequence ref of `o` (in the PS2 player's SSD frame), or null when it was not converted. */
    mapSequence(o: LvlObject, ref: number): number | null;
    warnings: string[];
}

export interface StompChange {
    id: number;
    name: string;
    pcOrder: number;
    ps2Order: number;
    /** What the converter wrote before this mapping (the PC value copied, or the PS2 class default when the PC value was a class default). */
    before: number;
    scenes: number;
    classList: boolean;
    note?: string;
}

/**
 * Writes the PS2 settings of every converted PC Stomp Player: the translated List Play Order, the PC Initial State and
 * Message To Play Next (class defaults included, the PS2 class defaults differ) and, for a player that relies on its PC
 * class's default Sequence List, that list converted (the PS2 class default names a Drakan 2 scene; unconverted refs
 * become an empty entry, which plays nothing). Returns one entry per player.
 */
export function convertStompPlayers(env: StompEnv): StompChange[] {
    const out: StompChange[] = [];
    for (const o of env.pc.list.objects) {
        const s = pcStompPlayer(env.pc, o);
        if (!s) continue;
        const dst = env.list.objects.find((x) => x.id === o.id);
        const cls = dst && env.classOf(dst);
        if (!dst || !cls?.fields) continue;
        const fields = cls.fields;
        const specs = new Map<number, ParamSpec>(objectParamSpecs(dst).map((p) => [p.fieldIndex, p]));
        const put = (name: string, value: number | number[]): void => {
            const i = fieldIndexByName(fields, name);
            if (i < 0) {
                env.warnings.push(`${env.title}: Stomp Player class has no field "${name}"`);
                return;
            }
            specs.set(i, { fieldIndex: i, type: fields[i]!.type, name: fields[i]!.name, value });
        };
        const orderField = fieldIndexByName(fields, 'List Play Order');
        const before = numberAt(dst, orderField) ?? numberOf(classFieldDefault(cls, orderField)) ?? 0;
        const m = ps2PlayOrder(s.order, s.sequences.length, s.initialOn, s.message);
        if (s.sequencesFromClass) {
            const refs = s.sequences.map((r) => env.mapSequence(o, r) ?? 0).filter((r) => r !== 0);
            if (refs.length < s.sequences.length)
                env.warnings.push(
                    `${env.title}: Stomp Player ${o.id} class list: ${s.sequences.length - refs.length} of ${s.sequences.length} scene(s) not converted`,
                );
            put('Sequence List', refs.length ? refs : [0]);
        }
        put('List Play Order', m.order);
        put('Initial State', s.initialOn ? 1 : 0);
        put('Message To Play Next', s.message);
        setObjectParams(env.list, dst.id, [...specs.values()]);
        if (m.note) env.warnings.push(`${env.title}: Stomp Player ${o.id}: ${m.note}`);
        out.push({
            id: o.id,
            name: (env.pc.classes.get(o.dbIndex)?.get(o.classId)?.name ?? '').trim(),
            pcOrder: s.order,
            ps2Order: m.order,
            before,
            scenes: s.sequences.length,
            classList: s.sequencesFromClass,
            ...(m.note ? { note: m.note } : {}),
        });
    }
    return out;
}

function numberAt(o: LvlObject, fieldIndex: number): number | undefined {
    if (fieldIndex < 0) return undefined;
    const i = o.params.findIndex((p) => p.fieldIndex === fieldIndex);
    return i >= 0 ? o.data[i]! | 0 : undefined;
}

function numberOf(v: unknown): number | undefined {
    return typeof v === 'number' ? v : undefined;
}
