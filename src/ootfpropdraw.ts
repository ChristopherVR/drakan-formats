import type { ClassPlan } from './ootfclass.ts';

interface ModelDrawOwner {
    requireDisplayList(id: number): boolean;
}

/**
 * PS2 engine ids of drawn rigid objects whose native models all carry the strip display list (0x0211): on the disc every
 * RESOURES / NPCS / LEVEL1ON / MOUNTAON / WORLDCON model of a generic prop (17, 81 of 86), item (10), switch (13), boulder or
 * push block (16, 134 of 134), door (19, 17 of 17), flame (20, 32 of 32), key or book (33, 46 of 47), lock (34), mechanism
 * (35, 39 of 39), armour (45), power-up (57, 8 of 9), rope (73), pressure plate (29, both: LEVEL4ON, LEVEL8OS) and soul
 * crystal (117) has one. A converted model without it draws nothing while its collision stays: Ruined Village's doors, swing
 * blades, waterfall rocks, keys and locks were invisible obstacles (journal 2026-11-08/ootf-ruined-village-ambush-props.md),
 * and the native pressure plates of the campaign were invisible tiles over the holes the floor models leave for them
 * (2026-11-14/ootf-ruined-crystal-plates.md). Effect classes whose native models have no list (blurs 60, lightning 58,
 * explosions 134, arrows 39, detectors and sound boxes) are left alone.
 */
export const DRAWN_RIGID_RFL: ReadonlySet<number> = new Set([10, 13, 16, 17, 19, 20, 29, 33, 34, 35, 45, 57, 73, 117]);

/** Native drawn props need this representation regardless of the source class selected for their conversion. */
export function requireGenericPropDrawLists(
    plan: Pick<ClassPlan, 'synthesized'>,
    owner: (file: string, db: number) => ModelDrawOwner | undefined,
): void {
    for (const target of plan.synthesized) {
        const model = target.cls.model;
        if (!DRAWN_RIGID_RFL.has(target.rfl) || !model) continue;
        owner(target.file, model.db)?.requireDisplayList(model.id);
    }
}

interface RigidWeaponDrawOwner {
    requireRigidWeaponDisplayList(id: number): boolean;
}

/** Rigid weapon eligibility is separate from props: only the owning builder can validate its authored sphere chain. */
export function requireRigidWeaponDrawLists(
    plan: Pick<ClassPlan, 'synthesized'>,
    owner: (file: string, db: number) => RigidWeaponDrawOwner | undefined,
): void {
    for (const target of plan.synthesized) {
        const model = target.cls.model;
        if (!model || (target.rfl !== 14 && !(target.rfl === 79 && target.rigidBowTemplate === true))) continue;
        owner(target.file, model.db)?.requireRigidWeaponDisplayList(model.id);
    }
}
