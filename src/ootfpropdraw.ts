import type { ClassPlan } from './ootfclass.ts';

interface ModelDrawOwner {
    requireDisplayList(id: number): boolean;
}

/** Native generic props need this representation regardless of the source class selected for their conversion. */
export function requireGenericPropDrawLists(
    plan: Pick<ClassPlan, 'synthesized'>,
    owner: (file: string, db: number) => ModelDrawOwner | undefined,
): void {
    for (const target of plan.synthesized) {
        const model = target.cls.model;
        if (target.rfl !== 17 || !model) continue;
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
