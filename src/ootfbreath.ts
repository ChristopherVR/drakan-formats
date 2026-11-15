import { FIELD_CLASS, fieldBase, fieldIsArray } from './fields.ts';
import type { OdbClass } from './odb.ts';
import type { Ps2OdbIn, Synthesized } from './ootfclass.ts';

/** Engine id of the Dragon Power-up on both platforms (gives Arokh a breath through its Weapon / Alt. Weapon fields). */
export const DRAGON_POWERUP_RFL = 57;

/** The two breath fields of a Dragon Power-up (same names on the PC and on the PS2). */
export const BREATH_FIELDS: readonly string[] = ['Weapon', 'Alt. Weapon'];

/**
 * PC breath projectiles that have no PS2 class (`REFERENCE_ENGINES`: fire ball 48, breath stream 21, magma shot 108, ice
 * projectile 42), by the Drakan 2 power-up whose breath of the same field stands in. A converted power-up whose breath
 * reference stayed empty gave Arokh no breath at all: the Ruined Village "Fireball Power Up" is the one the PC Dragon gets
 * his fire from, and with both its fields empty the breath key did nothing in every later level (journal
 * 2026-11-16/ootf-fire-crystal.md). Magma has no Drakan 2 power-up; fire is the nearest (a burning shot and stream).
 */
export const BREATH_STAND_INS: ReadonlyMap<number, string> = new Map([
    [48, '#1 Fireball Power Up'],
    [21, '#1 Fireball Power Up'],
    [108, '#1 Fireball Power Up'],
    [42, '#3 Ice Power Up'],
]);

/**
 * Arena power-ups (the multiplayer "Multi ... PwrUp" and "QOD ..." classes, or any class of a multiplayer ODB) keep their
 * empty breath: the converted air arenas breathe through the host (`drakan_pvp.cpp`), and a native breath on top of it
 * was never played.
 */
export function isArenaPowerUp(pc: Pick<OdbClass, 'name'>, owner: string | undefined): boolean {
    return /^\s*(multi|qod)\b/i.test(pc.name) || /(^|[\/])multiplayer([\/]|$)/i.test(owner ?? '');
}

/**
 * The PS2 reference a converted power-up's breath field takes when its PC reference has no PS2 class: the same field of
 * the Drakan 2 power-up named by `BREATH_STAND_INS` for the PC projectile's engine id. Only within the power-up's own ODB,
 * so the native reference keeps its meaning (class references are relative to the owning ODB's dependency list). Null when
 * the field is not a breath field, the PC projectile is not listed or the native power-up is missing.
 */
export function breathStandIn(
    target: Pick<Synthesized, 'rfl' | 'file'>,
    fieldName: string,
    pcProjectile: Pick<OdbClass, 'rflClass'> | undefined,
    ps2Odbs: readonly Ps2OdbIn[],
): { ref: number; powerUp: string } | null {
    if (target.rfl !== DRAGON_POWERUP_RFL || !BREATH_FIELDS.includes(fieldName)) return null;
    const powerUp = BREATH_STAND_INS.get(pcProjectile?.rflClass ?? -1);
    if (!powerUp) return null;
    const odb = ps2Odbs.find((o) => o.file.toUpperCase() === target.file.toUpperCase());
    const native =
        odb && [...odb.classes.values()].find((c) => c.name === powerUp && c.rflClass === DRAGON_POWERUP_RFL);
    const i =
        native?.fields?.findIndex(
            (f) => f.name === fieldName && fieldBase(f.type) === FIELD_CLASS && !fieldIsArray(f.type),
        ) ?? -1;
    const ref = i >= 0 ? (native!.data?.[i] ?? 0) : 0;
    return ref ? { ref: ref >>> 0, powerUp } : null;
}
