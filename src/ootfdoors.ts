// Doors of converted Order of the Flame levels that the level opens by message.
//
// A PC door (engine 19) has no "Auto-Open?" field: it opens when something sends it On (a detector, a timer, a lever) or
// when Rynn pushes it. The PS2 door classes the converter clones carry "Auto-Open?" 1 with a 2 lu distance, so every
// converted door swung open as soon as Rynn came within about 4,000 units. Doors the PC level opens by message then
// opened early, before their trigger: Ruined Village's outhouse door (opened by the Generic Detector that also shows and
// sends out the orc behind it) stood open with nobody there, and the orc appeared only later, outside the door
// (journal 2026-11-08/ootf-ruined-village-ambush-props.md). Such doors keep "Auto-Open?" 0 so they wait for their
// message, which the PS2 door handler honours (On opens an unlocked door, journal 2026-11-07/door-proof.md).
//
// Only ambush doors are held: a door that a link source sends On to while the same source (directly or through the
// timers it starts) also wakes a hidden creature. Their trigger provably fires, since it is the one that sets the
// ambush off. Other doors keep the auto-open, the PS2's stand-in for the PC push: the temple's door triggers float above
// the bridge and do not fire for Rynn on the PS2 (the temple doors stayed shut when held), the tavern doors are linked
// from a Visibility Toggler and the small house's door from a detector that sends Off.

import { classFieldDefault, type OdbClass } from './odb.ts';
import { type LvlObject, type LvlObjectList, objectParamSpecs, paramValue, setObjectParams } from './lvl.ts';

/** PS2 engine id of doors and gates. */
export const DOOR_RFL = 19;
const AUTO_OPEN = 'Auto-Open?';
/** Message ordinal On (level-format.md section 15.1). */
const MSG_ON = 1;
/** The field a link source sends its message from (detectors, timers, levers, counters, relays). */
const SENT_MESSAGE = /^(trigger message|message to send|message to send when on|outgoing message|send this message)$/i;

/** The message ordinal an object sends to its links (its own value, else its class default), or null when unknown. */
export function sentMessage(o: LvlObject, cls: OdbClass | undefined): number | null {
    const i = cls?.fields?.findIndex((f) => SENT_MESSAGE.test(f.name.trim())) ?? -1;
    if (i < 0) return null;
    const own = o.params.findIndex((p) => p.fieldIndex === i);
    const v = own >= 0 ? o.data[own] : classFieldDefault(cls!, i);
    return typeof v === 'number' ? v : null;
}

/** Objects reached from `start` along links, at most `depth` steps (the start itself excluded). */
function reached(byId: ReadonlyMap<number, LvlObject>, start: LvlObject, depth: number): LvlObject[] {
    const seen = new Set<number>([start.id]);
    let front = [start];
    const out: LvlObject[] = [];
    for (let d = 0; d < depth && front.length; d++) {
        const next: LvlObject[] = [];
        for (const o of front)
            for (const id of o.links) {
                const t = byId.get(id);
                if (!t || seen.has(id)) continue;
                seen.add(id);
                out.push(t);
                next.push(t);
            }
        front = next;
    }
    return out;
}

/**
 * Give every ambush door an explicit "Auto-Open?" 0 (unless the object already sets the field): a door that a source
 * sends On to while the source also reaches a hidden creature (`isHiddenCreature`, PC visible flag clear) within three
 * links. `classOf` resolves an object's PS2 class (with its field list). Returns the ids of the doors changed.
 */
export function holdLinkedDoors(
    list: LvlObjectList,
    classOf: (o: LvlObject) => OdbClass | undefined,
    isHiddenCreature: (o: LvlObject) => boolean,
): number[] {
    const byId = new Map(list.objects.map((o) => [o.id, o]));
    const linked = new Set(
        list.objects
            .filter((s) => sentMessage(s, classOf(s)) === MSG_ON && reached(byId, s, 3).some(isHiddenCreature))
            .flatMap((s) => s.links),
    );
    const changed: number[] = [];
    for (const o of list.objects) {
        if (!linked.has(o.id)) continue;
        const cls = classOf(o);
        if (cls?.rflClass !== DOOR_RFL) continue;
        const fieldIndex = cls.fields?.findIndex((f) => f.name.trim() === AUTO_OPEN) ?? -1;
        if (fieldIndex < 0 || o.params.some((p) => p.fieldIndex === fieldIndex)) continue;
        const field = cls.fields![fieldIndex]!;
        setObjectParams(list, o.id, [
            ...objectParamSpecs(o),
            { fieldIndex, type: field.type, name: field.name, value: 0 },
        ]);
        changed.push(o.id);
    }
    return changed;
}

/** Door messages that switch the auto-open off and on again (PS2 door handler, journal 2026-11-07/door-proof.md). */
export const DOOR_AUTO_OPEN_OFF = 0x11;
export const DOOR_AUTO_OPEN_ON = 0x12;
const AUTO_OPEN_DISTANCE = /^auto-open distance/i;
/** Level units to world units. */
const LU = 2048;
/** Added to a door's auto-open distance: the player glides between keys and the door measures from its own origin. */
const SCENE_DOOR_MARGIN = 1024;

/** The object's value of a class field (its own parameter, else the class default). */
function fieldOf(o: LvlObject, cls: OdbClass, test: (name: string) => boolean): unknown {
    const i = cls.fields?.findIndex((f) => test(f.name.trim())) ?? -1;
    if (i < 0) return undefined;
    const own = o.params.findIndex((p) => p.fieldIndex === i);
    return own >= 0 ? paramValue(o, own) : classFieldDefault(cls, i);
}

/**
 * Doors that would open by themselves during a cut scene. A PC door opens only when something sends it On or Rynn pushes it,
 * and a scene's Rynn pushes nothing; the PS2 stand-in for the push, "Auto-Open?", fires for any player within its distance,
 * also while a scene moves her. In Ruined Village scene 1.3 Rynn walks up to the old man in front of his house and its door
 * swung open in the middle of the talk. Returns the doors (engine 19) whose auto-open is on and whose auto-open distance
 * (plus a margin) reaches one of the player's scene keys, so the scene can switch their auto-open off while it plays.
 */
export function sceneAutoOpenDoors(
    list: LvlObjectList,
    classOf: (o: LvlObject) => OdbClass | undefined,
    playerKeys: readonly (readonly [number, number, number])[],
): number[] {
    if (!playerKeys.length) return [];
    const out: number[] = [];
    for (const o of list.objects) {
        const cls = classOf(o);
        if (cls?.rflClass !== DOOR_RFL) continue;
        if (fieldOf(o, cls, (n) => n === AUTO_OPEN) !== 1) continue;
        const lu = fieldOf(o, cls, (n) => AUTO_OPEN_DISTANCE.test(n));
        const reach = (typeof lu === 'number' && lu > 0 ? lu : 2) * LU + SCENE_DOOR_MARGIN;
        const near = playerKeys.some((k) => Math.hypot(k[0] - o.pos[0], k[1] - o.pos[1], k[2] - o.pos[2]) <= reach);
        if (near) out.push(o.id);
    }
    return out;
}
