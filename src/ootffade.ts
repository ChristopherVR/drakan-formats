// Order of the Flame scenes on the PS2 engine: how the screen fades at a level start and at a scene start.
//
// The PS2 engine fades every level in by itself: the Level Properties' "Starting Fader" (SYSTEM "Start Fader": black,
// held, then cleared over 3 s). When a scene takes the camera, the engine puts up its "Stomp Fader" (SYSTEM "Stomp
// Fader": black, cleared over 0.5 s) in place of the screen fader that is up, and only one screen fader is drawn at a
// time. The PC engine has neither; the OotF scenes fade with their own Fader objects. Evidence:
// docs/journal/2026-11-17/ootf-scene-start-fade.md.
//
// * A PC level that opens on a scene places its own level-start Fader (Start Mode 0, Fade In 0, Faded 0, Fade Out 2 s).
//   In the converted Ruined Village it was drawn only once the Stomp Fader was gone, 0.3 s in: the picture went dark at
//   once and came back over 1.2 s. Such a fader is set to Start Mode 1 (run on a message): it does nothing at the start,
//   a scene that messages it still runs it, and the engine's Starting Fader does the job (no disc level places a Start
//   Mode 0 screen fader).
// * The Stomp Fader replaced the Starting Fader when Ruined Village's opening scene took the camera just after the
//   loading screen (two frames of the unprepared shot, then a 0.5 s fade), and it replaced the black of the PC fader that
//   ends scene 1.1 (and 1.2a) when the next scene took the camera (the picture came up, dipped under the next scene's own
//   fader, and came back). A converted level with scenes gets "Stomp Fader" 0: its scenes fade only with their own
//   faders, as on the PC, and the Starting Fader stays up until it has faded the level in.

import type { LvlObject, LvlObjectList } from './lvl.ts';
import type { ClassFieldDef } from './fields.ts';
import type { OdbClass } from './odb.ts';
import { FADER_RFL } from './ootfclass.ts';
import { pcFieldNumber, setNamedParam } from './ootfpuzzle.ts';
import type { PcLevel } from './pc.ts';

/** The fader fields that decide what it does at the level start (PC and PS2 field names are the same). */
export interface FaderTimes {
    fadeIn: number;
    /** -1 = hold until a second message. */
    faded: number;
    fadeOut: number;
    /** 0 = run at level start, 1 = run on a message. */
    startMode: number;
}

export const FADER_FIELDS = {
    fadeIn: 'Fade In Time (s)',
    faded: 'Faded Time (-1.0s = trigger)',
    fadeOut: 'Fade Out Time (s)',
    startMode: 'Start Mode',
} as const;

/** Start Mode of a fader that waits for a message. */
export const FADER_START_ON_MESSAGE = 1;

/**
 * True for a fader that only fades the level in from black at its start: it runs at once, is black at once (no fade in),
 * clears by itself (Faded Time not -1) over a fade out. That is what the PS2 engine already does for every level.
 */
export function isLevelStartFadeIn(t: FaderTimes): boolean {
    return t.startMode === 0 && t.fadeIn <= 0 && t.faded >= 0 && t.fadeOut > 0;
}

/** Times of a PC fader object (its parameters, else its class defaults); undefined for anything else or a model fader. */
export function pcFaderTimes(pc: PcLevel, o: LvlObject): FaderTimes | undefined {
    const cls = pc.classes.get(o.dbIndex)?.get(o.classId);
    if (cls?.rflClass !== FADER_RFL || cls.model) return undefined;
    const get = (name: string): number | undefined => pcFieldNumber(pc, o, name);
    const fadeIn = get(FADER_FIELDS.fadeIn);
    const faded = get(FADER_FIELDS.faded);
    const fadeOut = get(FADER_FIELDS.fadeOut);
    const startMode = get(FADER_FIELDS.startMode);
    if (fadeIn === undefined || faded === undefined || fadeOut === undefined || startMode === undefined)
        return undefined;
    return { fadeIn, faded, fadeOut, startMode };
}

/** PC ids of the level's model-less faders that fade the level in at its start (`isLevelStartFadeIn`). */
export function levelStartFaders(pc: PcLevel): number[] {
    return pc.list.objects
        .filter((o) => {
            const t = pcFaderTimes(pc, o);
            return !!t && isLevelStartFadeIn(t);
        })
        .map((o) => o.id);
}

/**
 * Make the converted copies of the PC level-start faders wait for a message (Start Mode 1), leaving the fade-in to the
 * engine. `idMap` maps PC object ids to converted ones; `classOf` gives a converted object's class. Returns the PS2 ids
 * changed.
 */
export function holdLevelStartFaders(
    pc: PcLevel,
    list: LvlObjectList,
    idMap: { get(id: number): number | undefined },
    classOf: (o: LvlObject) => Pick<OdbClass, 'fields'> | undefined,
): number[] {
    const done: number[] = [];
    for (const id of levelStartFaders(pc)) {
        const ps2Id = idMap.get(id);
        const o = ps2Id === undefined ? undefined : list.objects.find((x) => x.id === ps2Id);
        if (!o) continue;
        if (setNamedParam(list, o, classOf(o)?.fields, FADER_FIELDS.startMode, FADER_START_ON_MESSAGE)) done.push(o.id);
    }
    return done;
}

/** Engine id of the Stomp Player (plays the sequences of its list). */
export const STOMP_PLAYER_RFL = 51;
/** Level Properties field naming the fader the PS2 engine puts up when a scene takes the camera. */
export const STOMP_FADER_FIELD = 'Stomp Fader';

/** True when the PC level has a Stomp Player (it plays scenes). */
export function hasScenes(pc: PcLevel): boolean {
    return pc.list.objects.some((o) => pc.classes.get(o.dbIndex)?.get(o.classId)?.rflClass === STOMP_PLAYER_RFL);
}

/**
 * For a level with scenes: clear the converted Level Properties' Stomp Fader, so a scene that takes the camera does not
 * replace the screen fader that is up (the engine's level fade-in, or a scene fader's black). Returns whether it changed
 * the object.
 */
export function dropStompFader(
    pc: PcLevel,
    list: LvlObjectList,
    levelProperties: LvlObject | undefined,
    fields: readonly ClassFieldDef[] | undefined,
): boolean {
    if (!levelProperties || !hasScenes(pc)) return false;
    return setNamedParam(list, levelProperties, fields, STOMP_FADER_FIELD, 0);
}
