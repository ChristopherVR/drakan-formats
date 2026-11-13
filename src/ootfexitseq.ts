// Exit and entrance sequences of Order of the Flame level transitions.
//
// A PC Level Transition (engine class 55) can name two sequences: `ExitSequence`, the scene the engine plays before it leaves
// the level (Rynn walking down the church stair in Ruined Village, Arokh flying into the rift in Volcanic), and `Entrance
// Sequence`, played when the player comes back through that transition.
//
// The PS2 Level Transition class has the same two fields, but the converter cannot use them: the converted exits are of a
// class in SYSTEM, whose database has no SSD and does not list the level's (the refs would not resolve), and the PS2 engine
// asks for its save the moment the exit fires. So the scenes are relayed like the detector scenes (ootfpuzzle.ts
// relayDetectorSequences): whatever fired the exit by link now starts a Stomp Player with the exit scene and a Timer of the
// scene's length that fires the exit.
//
// The entrance scene follows the exit scene on the same player. The PC plays it when the player comes back, to undo what the
// exit scene left (a fader, held actors). On the PS2 the game is saved at the exit and that save is what comes back, so the
// undo has to happen before the save.
//
// The PS2 exit opens its save prompt, and the player may back out of it; on a disc level she then walks into the exit's box
// again. A relayed exit is a point and its relay has run (every PS2 Timer is destroyed after it fires unless told
// otherwise), so with only the relay the next level would never be offered again, and a save made during the exit scene
// would load without anything left to fire the exit. So, when the pipeline can rewrite the converted scenes:
//   * the last relayed scene itself sends the exit its ON at its end (a scene's progress is saved with it and a skip runs
//     its actions; a Timer's countdown did not survive a load), and starts an "arm" Timer;
//   * the arm Timer (0.5 s) enables a re-offer box where the exit scene brings the player on before her last walk onto
//     the exit (the foot of the church stair), first disabled so the exit scene cannot walk her into it;
//   * the box sends ON to the exit every time she walks into it, so a player who backs out of the save prompt gets it
//     again by walking back, as often as she backs out; its enabled state is saved with the level.
// The world is not stopped under the save prompt, so the level cannot tell a player who said yes from one who backed
// out: the runtime closes the exit in the level-change save it writes when she says yes (pack manifest `one_way_exits`,
// drakan_exit_guard.h), and the restored level after the next one never offers it again. Measured in play: journal
// 2026-11-13/ootf-book-skip-and-reload.md (a Timer that has fired is not started again by a later message, so the box
// does not re-arm itself; it does not need to).

import type { ClassFieldDef } from './fields.ts';
import { FLAG_SCALED, addObject, setObjectParams, type LvlObject, type LvlObjectList, type ParamSpec } from './lvl.ts';
import type { PcLevel } from './pc.ts';
import { pcFieldNumber } from './ootfpuzzle.ts';
import { SEQUENCE_MESSAGES, type EndMessage } from './ootfseq.ts';

export const EXIT_SEQUENCE_FIELDS = ['ExitSequence', 'Entrance Sequence'] as const;

/** One sequence a PC transition names. */
export interface TransitionSequence {
    /** PC object id of the Level Transition. */
    objectId: number;
    field: (typeof EXIT_SEQUENCE_FIELDS)[number];
    /** PC sequence ref `(db << 16) | id`. */
    ref: number;
}

/** Every exit / entrance sequence the level's transitions name (object parameter, else the class default). */
export function pcTransitionSequences(pc: PcLevel): TransitionSequence[] {
    const out: TransitionSequence[] = [];
    for (const o of pc.list.objects) {
        if (pc.classes.get(o.dbIndex)?.get(o.classId)?.rflClass !== 55) continue;
        for (const field of EXIT_SEQUENCE_FIELDS) {
            const ref = pcFieldNumber(pc, o, field);
            if (ref) out.push({ objectId: o.id, field, ref: ref >>> 0 });
        }
    }
    return out;
}

export interface ExitRelayClass {
    dbIndex: number;
    classId: number;
    fields: readonly ClassFieldDef[];
}

export interface ExitRelayEnv {
    pc: PcLevel;
    /** The converted object list (object ids = PC object ids). */
    list: LvlObjectList;
    title: string;
    /** Stomp Player class whose database holds the level's SSD. */
    player: ExitRelayClass;
    /** Timer class (waits for a message, then sends its Trigger Message to its links). */
    timer: ExitRelayClass;
    /** Converted id of a PC sequence ref of PC object `o` in the player's SSD; null when it was not converted. */
    mapSequence(o: LvlObject, ref: number): number | null;
    /** Length in seconds of that PC sequence (its last action); null when unknown. */
    seconds(o: LvlObject, ref: number): number | null;
    /** Trigger Detector class. With it, `endMessages` and `reofferAt` the exit is offered again after a backed-out save. */
    detector?: ExitRelayClass;
    /** Adds end messages to a converted sequence (by its converted id); false when it could not. */
    endMessages?(sequenceId: number, messages: readonly EndMessage[]): boolean;
    /** Where the exit scene `ref` brings the player on before her last walk onto the exit; null when unknown. */
    reofferAt?(o: LvlObject, ref: number): [number, number, number] | null;
    warnings: string[];
}

export interface ExitRelay {
    exitId: number;
    playerId: number;
    startTimerId: number;
    /** The Timer that fires the exit when the scenes are over; null when the last scene fires it itself. */
    exitTimerId: number | null;
    /** The re-offer box and its arm Timer (null without them). */
    reofferId: number | null;
    armTimerId: number | null;
    sequences: number[];
    seconds: number;
    senders: number[];
}

const PLAY_SEQUENCE = 4;
const MESSAGE_ON = 1;
/** The exit fires this long after the last relayed scene ended. */
export const EXIT_RELAY_MARGIN = 0.25;
/** Scale of a relayed exit's touch volume (see below). */
export const EXIT_RELAY_SCALE = 0.01;
/** The arm Timer enables the re-offer box this long after the exit was fired (and the world runs again). */
export const EXIT_REOFFER_ARM_SECONDS = 0.5;
/** Re-offer box size in cells (2048 units): about 820 x 1230 x 820 units around where the scene brings the player on. */
export const EXIT_REOFFER_SCALE: readonly [number, number, number] = [0.4, 0.6, 0.4];
/** Its centre is lifted this far over that point (the box's bottom then sits about 15 units under her feet). */
export const EXIT_REOFFER_LIFT = 600;

/** Relay the exit (and entrance) scenes of the level's transitions. Returns what was built. */
export function relayExitSequences(env: ExitRelayEnv): ExitRelay[] {
    const out: ExitRelay[] = [];
    const byExit = new Map<number, TransitionSequence[]>();
    for (const t of pcTransitionSequences(env.pc))
        (byExit.get(t.objectId) ?? byExit.set(t.objectId, []).get(t.objectId)!).push(t);
    const need = (cls: ExitRelayClass, name: string): { fieldIndex: number; type: number; name: string } | null => {
        const i = cls.fields.findIndex((f) => f.name.trim().toLowerCase() === name.toLowerCase());
        return i < 0 ? null : { fieldIndex: i, type: cls.fields[i]!.type, name: cls.fields[i]!.name };
    };
    for (const [exitId, named] of byExit) {
        const where = `${env.title}: transition ${exitId}`;
        const pcObject = env.pc.list.objects.find((o) => o.id === exitId)!;
        const exit = env.list.objects.find((o) => o.id === exitId);
        if (!exit) {
            env.warnings.push(`${where}: the exit was not converted; its sequences are dropped`);
            continue;
        }
        if (!named.some((x) => x.field === 'ExitSequence')) {
            env.warnings.push(`${where}: an entrance sequence without an exit sequence is not played`);
            continue;
        }
        const scenes: { id: number; seconds: number }[] = [];
        for (const field of EXIT_SEQUENCE_FIELDS) {
            const t = named.find((x) => x.field === field);
            if (!t) continue;
            const id = env.mapSequence(pcObject, t.ref);
            if (id === null)
                env.warnings.push(`${where}: ${field} 0x${t.ref.toString(16)} was not converted and does not play`);
            else scenes.push({ id, seconds: Math.max(0, env.seconds(pcObject, t.ref) ?? 0) });
        }
        if (!scenes.length) continue;
        const senders = env.list.objects.filter((o) => o.links.includes(exitId));
        if (!senders.length) {
            env.warnings.push(`${where}: nothing fires this exit by link (it is walked into); its sequences do not play`);
            continue;
        }
        const fList = need(env.player, 'Sequence List');
        const fTime = need(env.timer, 'Time Until Trigger');
        const fMsg = need(env.timer, 'Trigger Message');
        if (!fList || !fTime || !fMsg) {
            env.warnings.push(`${where}: the Stomp Player or Timer class lacks a needed field; its sequences do not play`);
            continue;
        }
        const pos: [number, number, number] = [exit.pos[0], exit.pos[1], exit.pos[2]];
        const add = (cls: ExitRelayClass): LvlObject => {
            const { object } = addObject(env.list, { classId: cls.classId, dbIndex: cls.dbIndex, pos, rot: [0, 0, 0] });
            object.flags = 1;
            object.scale = null;
            object.links = [];
            return object;
        };
        const player = add(env.player);
        const specs: ParamSpec[] = [{ ...fList, value: scenes.map((s) => s.id) }];
        for (const [name, value] of [
            ['List Play Order', 0], // In Order Once: the entrance scene follows the exit scene by itself
            ['Initial State', 0],
            ['Message To Play Next', PLAY_SEQUENCE],
        ] as const) {
            const f = need(env.player, name);
            if (f) specs.push({ ...f, value });
        }
        setObjectParams(env.list, player.id, specs);
        const timer = (seconds: number, message: number, target: number): LvlObject => {
            const t = add(env.timer);
            setObjectParams(env.list, t.id, [
                { ...fTime, value: seconds },
                { ...fMsg, value: message },
            ]);
            t.links = [target];
            return t;
        };
        const total = scenes.reduce((n, s) => n + s.seconds, 0) + EXIT_RELAY_MARGIN;
        const start = timer(0.05, PLAY_SEQUENCE, player.id);
        const reoffer = buildReoffer(env, pcObject, named, exitId, scenes[scenes.length - 1]!.id, timer);
        const leave = reoffer ? null : timer(total, MESSAGE_ON, exitId);
        for (const s of senders)
            s.links = s.links.flatMap((l) => (l === exitId ? [start.id, ...(leave ? [leave.id] : [])] : [l]));
        // The PC transition only leaves on a message; the PS2 exit also fires when the player touches it, and the exit scene
        // often walks her right onto it (the foot of the church stair). Shrunk to a point it cannot be touched and still is
        // where the engine puts her for the save.
        exit.flags |= FLAG_SCALED;
        exit.scale = [EXIT_RELAY_SCALE, EXIT_RELAY_SCALE, EXIT_RELAY_SCALE];
        out.push({
            exitId,
            playerId: player.id,
            startTimerId: start.id,
            exitTimerId: leave?.id ?? null,
            reofferId: reoffer?.boxId ?? null,
            armTimerId: reoffer?.armId ?? null,
            sequences: scenes.map((s) => s.id),
            seconds: total,
            senders: senders.map((s) => s.id),
        });
    }
    return out;
}

/**
 * The re-offer box and its arm Timer, and the end messages of the last relayed scene that fire the exit and start the arm
 * Timer (see the head of this file). Returns null, leaving the exit to the relay's Timer, when a piece is missing.
 */
function buildReoffer(
    env: ExitRelayEnv,
    pcObject: LvlObject,
    named: readonly TransitionSequence[],
    exitId: number,
    lastScene: number,
    timer: (seconds: number, message: number, target: number) => LvlObject,
): { boxId: number; armId: number } | null {
    const exitScene = named.find((x) => x.field === 'ExitSequence');
    if (!env.detector || !env.endMessages || !env.reofferAt || !exitScene) return null;
    const detector = env.detector;
    const at = env.reofferAt(pcObject, exitScene.ref);
    const dIdx = (name: string) => detector.fields.findIndex((f) => f.name.trim().toLowerCase() === name);
    const tIdx = (name: string) => env.timer.fields.findIndex((f) => f.name.trim().toLowerCase() === name);
    const detectorValues: [string, number][] = [
        ['task', 6], // Trigger Only
        ['detect which?', 0], // Rynn on foot
        ['initial state', 1], // Disabled: the arm Timer enables it
        ['can be triggered by message ?', 1], // a message enables it
        ['detect only once?', 0], // every walk into it offers the exit again (the runtime closes the exit once taken)
        ['trigger message', MESSAGE_ON],
    ];
    const timerValues: [string, number][] = [
        ['start mode', 1], // on any message
        ['destroy after timeout?', 0], // kept, so it can arm the box again
        ['repeat', 0],
    ];
    if (!at || detectorValues.some(([n]) => dIdx(n) < 0) || timerValues.some(([n]) => tIdx(n) < 0)) {
        env.warnings.push(
            `${env.title}: transition ${exitId}: no re-offer box (a field or the scene's foot point is missing)`,
        );
        return null;
    }
    const spec = (cls: ExitRelayClass, i: number, value: number): ParamSpec => ({
        fieldIndex: i,
        type: cls.fields[i]!.type,
        name: cls.fields[i]!.name,
        value,
    });
    const arm = timer(EXIT_REOFFER_ARM_SECONDS, MESSAGE_ON, 0);
    setObjectParams(env.list, arm.id, [
        spec(env.timer, tIdx('time until trigger'), EXIT_REOFFER_ARM_SECONDS),
        spec(env.timer, tIdx('trigger message'), MESSAGE_ON),
        ...timerValues.map(([n, v]) => spec(env.timer, tIdx(n), v)),
    ]);
    const { object: box } = addObject(env.list, {
        classId: detector.classId,
        dbIndex: detector.dbIndex,
        pos: [at[0], at[1] + EXIT_REOFFER_LIFT, at[2]],
        rot: [0, 0, 0],
    });
    box.flags = 1 | FLAG_SCALED;
    box.scale = [...EXIT_REOFFER_SCALE];
    box.links = [exitId];
    setObjectParams(
        env.list,
        box.id,
        detectorValues.map(([n, v]) => spec(detector, dIdx(n), v)),
    );
    arm.links = [box.id];
    const on = SEQUENCE_MESSAGES.on;
    const sent = env.endMessages(lastScene, [
        { ref: exitId, message: on, name: 'Level Exit' },
        { ref: arm.id, message: on, name: 'Exit Re-offer' },
    ]);
    if (!sent) {
        env.list.objects = env.list.objects.filter((o) => o !== arm && o !== box);
        env.warnings.push(`${env.title}: transition ${exitId}: the last scene could not be given its end messages`);
        return null;
    }
    return { boxId: box.id, armId: arm.id };
}
