// Zone culling togglers of converted Order of the Flame levels.
//
// PC levels hide scenery the player cannot see yet with a Visibility Toggler (engine 121) in "Depends on Message" mode that
// detector boxes drive from both sides of a pass: one box sends the toggler's Show message, another its Hide message
// (Ruined Village's orc camp: detectors 2685 and 2716 show the fire pit, spit, log, crates and barrels, 2683 hides them).
// The camp starts hidden and only its fire, which is not on the toggler, burns from the start. On the PS2 a player who
// reaches the camp along a path that crosses no Show box (from the lift side, south of 2716, or over the edge of a box whose
// floor stands above the ground) finds the fire and the battle axe alone; the three grunts the same detector shows were
// missing too (journal 2026-11-16/rv-campfire.md). The converted game draws far and has no need for the PC's culling, so
// such a toggler's scenery is shown from the start and its Hide senders no longer reach it.
//
// A toggler counts as zone culling only when every link source is a detector or a timer, at least one detector sends its
// Show message and one its Hide message, it has at least `MIN_LINKS` links, some of its links start hidden and every link
// that starts hidden is static scenery (props, flames, switches). Puzzle togglers (one source, Movers, boulders, a single object) are left alone.
// Hidden creatures that a Show detector of such a toggler wakes and that stand among its scenery are shown with it.

import { classFieldDefault, type OdbClass } from './odb.ts';
import { FLAG_VISIBLE, type LvlObject, type LvlObjectList } from './lvl.ts';
import { sentMessage } from './ootfdoors.ts';

/** Engine ids: Visibility Toggler, Trigger Detector, Timer. */
const TOGGLER_RFL = 121;
const DETECTOR_RFL = 61;
const TIMER_RFL = 62;
/** Engine ids a culled scenery link may have while hidden: Ground Object (17), Lever / Switch (13), Flame (20). */
export const ZONE_SCENERY_RFL: ReadonlySet<number> = new Set([13, 17, 20]);
/** A zone has a few objects at least; a toggler of one or two objects is a puzzle part. */
export const MIN_LINKS = 4;
/** A hidden creature woken by a Show detector belongs to the zone when it stands this close (x / z) to a hidden link. */
export const ZONE_CREATURE_REACH = 6144;
/** Visibility Toggler "Trigger Mode" 1: Depends on Message. */
const MODE_DEPENDS = 1;

export interface ZoneCull {
    toggler: number;
    /** Links that started hidden, now shown. */
    shown: number[];
    /** Link sources that sent the Hide message and no longer link to the toggler. */
    hideSources: number[];
    /** Hidden creatures shown with the zone. */
    creatures: number[];
}

function fieldNumber(o: LvlObject, cls: OdbClass | undefined, name: string): number | null {
    const i = cls?.fields?.findIndex((f) => f.name.trim() === name) ?? -1;
    if (i < 0) return null;
    const own = o.params.findIndex((p) => p.fieldIndex === i);
    const v = own >= 0 ? o.data[own] : classFieldDefault(cls!, i);
    return typeof v === 'number' ? v : null;
}

/**
 * Find the zone culling togglers of a PC object list (`classOf` gives the PC class with its fields; `isCreature` says
 * whether an engine id is a creature class). Pure: the list is not changed.
 */
export function findZoneCulls(
    list: LvlObjectList,
    classOf: (o: LvlObject) => OdbClass | undefined,
    isCreature: (rfl: number) => boolean,
): ZoneCull[] {
    const byId = new Map(list.objects.map((o) => [o.id, o]));
    const rfl = (o: LvlObject): number => classOf(o)?.rflClass ?? -1;
    const out: ZoneCull[] = [];
    for (const t of list.objects) {
        if (rfl(t) !== TOGGLER_RFL || t.links.length < MIN_LINKS) continue;
        const cls = classOf(t);
        if (fieldNumber(t, cls, 'Trigger Mode') !== MODE_DEPENDS) continue;
        const show = fieldNumber(t, cls, 'Show Message');
        const hide = fieldNumber(t, cls, 'Hide Message');
        if (show === null || hide === null || show === hide) continue;
        const sources = list.objects.filter((o) => o.links.includes(t.id));
        if (!sources.length || sources.some((s) => rfl(s) !== DETECTOR_RFL && rfl(s) !== TIMER_RFL)) continue;
        const sent = (s: LvlObject): number | null => sentMessage(s, classOf(s));
        const detectors = sources.filter((s) => rfl(s) === DETECTOR_RFL);
        const showers = detectors.filter((s) => sent(s) === show);
        if (!showers.length || !detectors.some((s) => sent(s) === hide)) continue;
        const links = t.links.map((id) => byId.get(id)).filter((o): o is LvlObject => !!o);
        const hidden = links.filter((o) => !(o.flags & FLAG_VISIBLE));
        // A zone that starts visible (village interiors a level-start timer hides, trees, houses) stays as authored.
        if (!hidden.length || hidden.some((o) => !ZONE_SCENERY_RFL.has(rfl(o)))) continue;
        const near = (o: LvlObject): boolean =>
            hidden.some(
                (h) =>
                    Math.abs(h.pos[0] - o.pos[0]) <= ZONE_CREATURE_REACH &&
                    Math.abs(h.pos[2] - o.pos[2]) <= ZONE_CREATURE_REACH,
            );
        const creatures = new Set<number>();
        for (const s of showers)
            for (const id of s.links) {
                const c = byId.get(id);
                if (c && !(c.flags & FLAG_VISIBLE) && isCreature(rfl(c)) && near(c)) creatures.add(c.id);
            }
        out.push({
            toggler: t.id,
            shown: hidden.map((o) => o.id),
            hideSources: sources.filter((s) => sent(s) === hide).map((s) => s.id),
            creatures: [...creatures].sort((a, b) => a - b),
        });
    }
    return out;
}

/**
 * Apply zone culls to a converted object list (object ids = PC ids): show the hidden scenery and creatures and cut the
 * Hide sources' links to the toggler. Returns the number of objects shown.
 */
export function applyZoneCulls(list: LvlObjectList, culls: readonly ZoneCull[]): number {
    const byId = new Map(list.objects.map((o) => [o.id, o]));
    let shown = 0;
    for (const z of culls) {
        for (const id of [...z.shown, ...z.creatures]) {
            const o = byId.get(id);
            if (o && !(o.flags & FLAG_VISIBLE)) {
                o.flags |= FLAG_VISIBLE;
                shown++;
            }
        }
        for (const id of z.hideSources) {
            const s = byId.get(id);
            if (s) s.links = s.links.filter((l) => l !== z.toggler);
        }
    }
    return shown;
}
