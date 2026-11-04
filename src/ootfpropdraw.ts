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
