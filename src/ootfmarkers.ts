// Marker models of logic objects in converted Order of the Flame levels: what must never be drawn
// (docs/journal/2026-11-12/ootf-detector-squares.md).
//
// Two kinds of disc model exist only to give a logic object a body:
//
//   Detectors (engine 61)        a unit box scaled by the object. The System boxes (models 3725 to 3727) have polygons and
//                                bounds but no draw list record; the box of the first level's own detector class has one, with
//                                an opaque texture. The engine draws neither: a detector entity is not drawn whatever its
//                                model and object flags are (tried in game with FLAG_VISIBLE | FLAG_SCALED and with
//                                FLAG_SCALED alone). On the disc most detector objects carry FLAG_VISIBLE | FLAG_SCALED, and
//                                so do the converted ones. Nothing to change.
//   Dynamic lights (engine 133)  "Light Source" (System model 3813), a small cube with a draw list and a plain white
//                                texture. It is drawn when the object carries FLAG_VISIBLE. On the disc no placed dynamic
//                                light of a class with that model carries the flag (flags 0 or 8); only lights of a
//                                model-less class do. Static lights (132) are baked and never become entities.
//
// A PC dynamic light keeps FLAG_VISIBLE (the PC draws no light marker), and its converted class can be a clone of the
// System light class with the cube: the light then drew as a small white box in the air. Such lights lose the flag here,
// as on the disc; the light entity is still created.

import { FLAG_VISIBLE, type LvlObject, type LvlObjectList } from './lvl.ts';
import type { OdbClass } from './odb.ts';

export const DYNAMIC_LIGHT_RFL = 133;

/**
 * Clear FLAG_VISIBLE on every dynamic light whose PS2 class (template or synthesized, from `classOf`) carries a model.
 * Returns the ids of the lights changed.
 */
export function hideLightMarkers(list: LvlObjectList, classOf: (o: LvlObject) => OdbClass | undefined): number[] {
    const hidden: number[] = [];
    for (const o of list.objects) {
        if (!(o.flags & FLAG_VISIBLE)) continue;
        const cls = classOf(o);
        if (cls?.rflClass !== DYNAMIC_LIGHT_RFL || !cls.model) continue;
        o.flags &= ~FLAG_VISIBLE;
        hidden.push(o.id);
    }
    return hidden;
}
