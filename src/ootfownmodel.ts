/**
 * PC classes that keep their own converted model although the disc has a class of the same name and engine class.
 *
 * The class planner maps a PC class onto a same-named disc class, and the placed objects then show the disc class's
 * model. That is wrong where the level places the PC model to measure: a rope (engine class 73) is one long thin mesh that
 * each placement scales along its length and turns to hang down, so that its end meets the object it carries. The disc's
 * same-named classes have other meshes ("Rope" is a 0.2 unit stub of the rope bridges against the PC's 8.1 unit rope,
 * "Cable" and "Static Rope" a 5.06 unit rope pointing the other way), so Ruined Village's and Wartok Canyons' swinging
 * blades hung from a 50 unit stub inside the ceiling (journal 2026-11-12/ootf-axe-trap-ropes.md).
 */
import type { OdbClass } from './odb.ts';

/** Engine class of ropes and cables (swinging, carrying a linked object). */
export const ROPE_RFL = 73;

export interface OwnModelCandidate {
    cls: OdbClass;
    /** Identity of the class's PC model (container and id), or null when it has none. */
    model: string | null;
}

/**
 * The classes of `input` that must not be name-mapped: every rope class with a model, and every other class placed with
 * the same mesh as one of them (a "Static Rope" mover uses the rope mesh the same way).
 */
export function ownModelClasses(input: readonly OwnModelCandidate[]): OdbClass[] {
    const ropeModels = new Set<string>();
    for (const i of input) if (i.cls.rflClass === ROPE_RFL && i.model !== null) ropeModels.add(i.model);
    return input.filter((i) => i.model !== null && ropeModels.has(i.model)).map((i) => i.cls);
}
