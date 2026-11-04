import type { OdbClass } from './odb.ts';
import type { ClassPlan } from './ootfclass.ts';

/** Original Bow 21/23 are scalar signed integers; native Bow has no equivalent fields. */
function authoredAim(source: OdbClass): { cone: number; range: number } | null {
    if (source.rflClass !== 79 || !source.fields || !source.data) return null;
    const read = (name: string): number | null => {
        const matches = source.fields!.map((f, i) => ({ f, i })).filter(({ f }) => f.name === name);
        if (matches.length !== 1 || matches[0]!.f.type !== 1) return null;
        const word = source.data![matches[0]!.i];
        return word === undefined ? null : word | 0;
    };
    const cone = read('Cone of AutoAim (degrees)'),
        range = read('Maximum Range (wu)');
    return cone !== null && range !== null && cone >= 0 && cone <= 180 && range >= 0 ? { cone, range } : null;
}

/** Emit only synthesized original bows, never annotate a shared native class reused by name. */
export function buildBowAimMetadata(
    plan: Pick<ClassPlan, 'synthesized'>,
    sourceOf: (key: string) => OdbClass | undefined,
): { text: string | null; warnings: string[] } {
    const profiles = new Map<number, { cone: number; range: number }>();
    const ambiguous = new Set<number>(),
        warnings: string[] = [];
    for (const target of plan.synthesized) {
        if (
            target.rfl !== 79 ||
            target.classId <= 0 ||
            target.classId >= 0xffff ||
            target.dbIndex < 0 ||
            target.dbIndex > 0xffff
        )
            continue;
        // All supported converted levels retain Resources as bank 3; its registry identity is live-verified.
        // A different template dependency number is not automatically a verified global resource namespace.
        if (target.file !== 'RESOURES.ODB' || target.dbIndex !== 3) {
            warnings.push(
                `bow autoaim: unverified target namespace ${target.file}/${target.dbIndex}; metadata omitted`,
            );
            continue;
        }
        const resource = ((target.dbIndex << 16) | target.classId) >>> 0;
        for (const key of target.pcKeys) {
            const source = sourceOf(key),
                aim = source && authoredAim(source);
            if (!aim) {
                ambiguous.add(resource);
                continue;
            }
            const prior = profiles.get(resource);
            if (prior && (prior.cone !== aim.cone || prior.range !== aim.range)) ambiguous.add(resource);
            else profiles.set(resource, aim);
        }
    }
    for (const resource of ambiguous) {
        profiles.delete(resource);
        warnings.push(
            `bow autoaim: unknown or conflicting source properties for target 0x${resource.toString(16)}; metadata omitted`,
        );
    }
    const lines = ['format = 1'];
    for (const [resource, p] of [...profiles].sort((a, b) => a[0] - b[0]))
        lines.push('', `[bow 0x${resource.toString(16)}]`, `cone_degrees = ${p.cone}`, `maximum_range = ${p.range}`);
    return { text: profiles.size ? lines.join('\n') + '\n' : null, warnings };
}
