// Order of the Flame (PC) classes that have no PS2 class of their own, and what the converter does with each of them on
// purpose. The class plan (ootfclass.ts) maps or clones every PC class it can; the few placed classes left after that are
// not "unknown": each is listed here with the deliberate outcome and the message the editor and the CLI show for it.
// Census and reasons: docs/journal/2026-11-08/ootf-class-coverage.md.

import type { OdbClass } from './odb.ts';

/** Why a placed PC class has no PS2 object, by design. */
export type OmissionKind = 'arena-export' | 'sky-fog-switch' | 'no-source-model';

export interface DeliberateOmission {
    kind: OmissionKind;
    /** One sentence for the conversion notes (no "unknown", no "error": the outcome is intended). */
    note: string;
}

/** PC multiplayer-only engine ids (launch pads, Soul Crystal, dragon invulnerability) that become arena data, not objects. */
export const ARENA_EXPORT_RFL: ReadonlySet<number> = new Set([18, 86, 126, 127, 128]);

/**
 * PC "Fog + Sky Changer" (engine 143, also named Sky Trigger, Fog Transition, Fog Color Changer): a box that, crossed one
 * way or the other, switches between two Sky objects (it links to them, e.g. "Sky" and "Sky Interior") and sets the fog
 * colour of that side (fields Positive Fog / Negative Fog). The PS2 engine 143 classes have no fields; PS2 levels switch
 * sky and fog with a one-way detector pair and a day/night cycle switcher (engine 202, "Morph-To Cycle"), whose cycle
 * (engine 201) carries the fog colours and "Associated Skies". The converted level's sky and fog come from the template's
 * day/night cycle (`levelPropertiesParams`), so there is no PC fog to switch back to: the changers stay out.
 */
export const SKY_FOG_SWITCH_RFL = 143;

/** Engine classes that need a model to exist at all (the placed object is the model). */
const MODEL_RFL: ReadonlySet<number> = new Set([16, 17, 99]);

export interface OmissionContext {
    /** The level is a multiplayer arena (`isOotfArenaLevel`). */
    arena: boolean;
    /**
     * The PC class names a model the install does not contain (`model 3918 is not in Alwarren.mod`), from the asset
     * builder; undefined when the model exists or the class has none.
     */
    missingModel?: string;
}

/** The deliberate outcome for a placed PC class the plan could not map, or null when there is none (a real gap). */
export function deliberateOmission(cls: OdbClass, ctx: OmissionContext): DeliberateOmission | null {
    const rfl = cls.rflClass ?? -1;
    if (ARENA_EXPORT_RFL.has(rfl))
        return ctx.arena
            ? {
                  kind: 'arena-export',
                  note: 'becomes an arena spawn or marker in maps/<level>.ini (PS2 arenas keep these outside the level)',
              }
            : { kind: 'arena-export', note: 'multiplayer only; a campaign level does not use it' };
    if (rfl === SKY_FOG_SWITCH_RFL)
        return {
            kind: 'sky-fog-switch',
            note: 'switches between an outdoor and an indoor sky and fog on the PC; the converted level keeps one sky and fog (its day/night cycle) throughout',
        };
    if (ctx.missingModel && MODEL_RFL.has(rfl))
        return {
            kind: 'no-source-model',
            note: `the install has no model for it (${ctx.missingModel}), so the original game draws nothing here either`,
        };
    return null;
}

/**
 * Engine ids that PC classes use only *by reference* (a weapon's trail, a generator's gibs, a spell's flash): no level
 * places them, and the PS2 engine either lacks the id or registers it for something else. A reference to one of them
 * stays empty in the converted class. Names from the PC class names of each id (census in the journal note).
 */
export const REFERENCE_ENGINES: ReadonlyMap<number, string> = new Map([
    [5, 'burn effect'],
    [21, 'breath / blood stream'],
    [31, 'blood pool'],
    [32, 'freeze effect'],
    [38, 'goblin launcher'],
    [42, 'ice projectile'],
    [48, 'fire ball'],
    [50, 'gib / blood chunk'],
    [67, 'flaming weapon effect'],
    [69, 'poison gas effect'],
    [70, 'poison breath'],
    [85, 'lightning ball'],
    [90, 'weapon fire effect'],
    [96, 'lightning crystal effect'],
    [106, 'projectile trail link'],
    [107, 'projectile trail'],
    [108, 'magma shot'],
    [113, 'thrown axe'],
    [119, 'weapon secondary effect'],
    [122, 'following projectile'],
    [124, 'tornado'],
    [125, 'flash'],
    [135, 'lens flare'],
    // The PS2 has a same-named "troll shield" (name-mapped); listed so the audit does not call the id unknown.
    [139, 'shield'],
    [140, 'particle trail'],
]);

/**
 * PC object parameter names that the same-engine PS2 class calls differently. PC "Ambient Sound" (engine 131) has one
 * Front Sound / Back Sound pair and a "Slot" (0..3) saying which of the four ambient slots it fills; the PS2 Ambient
 * Transition names the slots ("Front Sound Slot 0" ... "Back Sound Slot 3"). `slot` reads the object's "Slot" parameter
 * (else the class default).
 */
export function pcParamAlias(pc: OdbClass, name: string, slot: () => number): string | undefined {
    if (pc.rflClass === 131) {
        const m = /^(front|back) sound$/i.exec(name.trim());
        if (m) {
            const s = Math.max(0, Math.min(3, Math.trunc(slot()) || 0));
            return `${m[1]![0]!.toUpperCase()}${m[1]!.slice(1).toLowerCase()} Sound Slot ${s}`;
        }
    }
    return undefined;
}
