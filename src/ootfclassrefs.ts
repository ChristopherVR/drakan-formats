import { decodeFieldValue, FIELD_CLASS, fieldBase, fieldIsArray } from './fields.ts';
import type { OdbClass } from './odb.ts';
import { cloneClassRecord, type ClassPlan } from './ootfclass.ts';

export interface OwnedPcClass {
    owner: string;
    id: number;
    cls: OdbClass;
}

export const ownedClassKey = (owner: string, id: number): string => `${owner.replace(/\\/g, '/').toLowerCase()}#${id}`;

export function classDefaultReferences(cls: OdbClass): number[] {
    return (cls.fields ?? []).flatMap((f, i) => {
        if (fieldBase(f.type) !== FIELD_CLASS) return [];
        const value = decodeFieldValue(f.type, cls.data?.[i] ?? 0, cls.data ?? []);
        return (Array.isArray(value) ? value : [value]).filter((v): v is number => typeof v === 'number' && v !== 0);
    });
}

/** Discover referenced-only classes before allocating target ids; cycles and shared references terminate by owner/id. */
export async function classReferenceClosure(
    initial: readonly OwnedPcClass[],
    resolve: (source: OwnedPcClass, ref: number) => Promise<OwnedPcClass | null>,
): Promise<OwnedPcClass[]> {
    const out: OwnedPcClass[] = [];
    const seen = new Set<string>();
    const add = (c: OwnedPcClass): void => {
        const key = ownedClassKey(c.owner, c.id);
        if (seen.has(key)) return;
        seen.add(key);
        out.push(c);
    };
    initial.forEach(add);
    for (let i = 0; i < out.length; ++i)
        for (const ref of classDefaultReferences(out[i]!.cls)) {
            const c = await resolve(out[i]!, ref);
            if (c) add(c);
        }
    return out;
}

/**
 * Class defaults use the owning ODB's dependency numbers, not a level's database numbers. Relocate only after the
 * complete plan exists, so forward and cyclic references work. An unresolved reference is explicitly reported and
 * left empty (zeroed); retaining a template's unrelated spawn list can create real native effects indefinitely.
 */
export function relocateClassDefaultReferences(
    plan: ClassPlan,
    sourceOf: (key: string) => OdbClass | undefined,
    map: (sourceKey: string, ref: number, targetFile: string) => number | null,
    /**
     * For an unresolved reference: the family of a PC-only effect it points at (`REFERENCE_ENGINES`, "projectile trail"),
     * which is expected to stay empty. Those are summed into one note per family instead of one warning per reference.
     */
    familyOf?: (sourceKey: string, ref: number) => string | undefined,
    /** The PC name of the referenced class, for the itemised notes. */
    nameOf?: (sourceKey: string, ref: number) => string | undefined,
): string[] {
    const warnings: string[] = [];
    const families = new Map<string, { refs: number; classes: Set<string> }>();
    for (const s of plan.synthesized) {
        const sourceKey = s.pcKeys[0]!;
        const pc = sourceOf(sourceKey);
        if (!pc) continue;
        const data = [...(s.cls.data ?? [])];
        for (let i = 0; i < (pc.fields?.length ?? 0); ++i) {
            const f = pc.fields![i]!;
            if (fieldBase(f.type) !== FIELD_CLASS) continue;
            const j =
                s.cls.fields?.findIndex(
                    (t) =>
                        t.name === f.name &&
                        fieldBase(t.type) === FIELD_CLASS &&
                        fieldIsArray(t.type) === fieldIsArray(f.type),
                ) ?? -1;
            if (j < 0) continue;
            const value = decodeFieldValue(f.type, pc.data?.[i] ?? 0, pc.data ?? []);
            const refs = (Array.isArray(value) ? value : [value]) as number[];
            const mapped: number[] = [];
            for (const ref of refs) {
                const target = ref === 0 ? 0 : map(sourceKey, ref, s.file);
                if (target === null) {
                    const family = familyOf?.(sourceKey, ref);
                    if (family) {
                        const fam =
                            families.get(family) ?? families.set(family, { refs: 0, classes: new Set() }).get(family)!;
                        fam.refs++;
                        fam.classes.add(s.name);
                    } else {
                        const name = nameOf?.(sourceKey, ref)?.trim();
                        warnings.push(
                            `class ${s.name}: ${f.name}: PC class ${name ? `"${name}" ` : ''}0x${ref.toString(16)} has no PS2 counterpart; the reference is left empty`,
                        );
                    }
                } else mapped.push(target >>> 0);
            }
            if (fieldIsArray(f.type)) {
                data[j] = mapped.length ? ((mapped.length << 16) | data.length) >>> 0 : 0;
                data.push(...mapped);
            } else data[j] = mapped[0] ?? 0;
            if (!s.copied.includes(f.name)) s.copied.push(f.name);
            s.skipped = s.skipped.filter((name) => name !== f.name);
        }
        s.cls.data = data;
        s.record = cloneClassRecord(s.record, s.name, data);
    }
    for (const [family, { refs, classes }] of [...families].sort(
        (a, b) => b[1].refs - a[1].refs || a[0].localeCompare(b[0]),
    ))
        warnings.push(
            `PC-only ${family} references left empty: ${refs} in ${classes.size} converted class${classes.size === 1 ? '' : 'es'} (the PC effect has no PS2 class)`,
        );
    return warnings;
}
