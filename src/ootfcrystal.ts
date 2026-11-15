import { decodeFieldValue, FIELD_CLASS, fieldBase, fieldIsArray } from './fields.ts';
import type { OdbClass } from './odb.ts';
import type { ClassPlan, Ps2OdbIn } from './ootfclass.ts';

/** PC Magic Crystal (Fire / Ice / Lightning Crystal): an inventory item whose use casts its `Effect`. */
export const MAGIC_CRYSTAL_RFL = 91;

/** PC effect engines of the crystals and the kind the runtime logs. */
export const CRYSTAL_EFFECT_KINDS: ReadonlyMap<number, string> = new Map([
    [90, 'fire'], // Fire Crystal FX: a ring of fire running out from Rynn (PS2 engine 90, same class in FX.ODB)
    [119, 'ice'], // Ice Shield FX: a shield round Rynn (PS2 engine 119: the Frost Shield)
    [96, 'lightning'], // Lightning Crystal FX: charge, then a ground bolt (no PS2 engine 96)
]);

/**
 * Native stand-ins by PC effect engine when the PC effect class itself has no PS2 class, all played in game (journal
 * 2026-11-16/ootf-fire-crystal.md): the PS2 Frost Shield (engine 119) spawned alone draws and does nothing (Drakan 2
 * only makes it through a weapon's secondary-attack generator), so the Ice Crystal casts Rynn's Ice Ring (the ring the
 * Maulgak Maul's secondary attack spreads: it freezes and hurts what it reaches); the PC bolt of the Lightning Crystal
 * (engine 58, converted) spawned alone strikes nothing, so it casts the Lightning Blade's secondary-attack generator
 * (two seeking bolts), without the PC hold-to-charge.
 */
export const CRYSTAL_NATIVE_EFFECTS: ReadonlyMap<number, string> = new Map([
    [119, "!! Rynn's Ice Ring !!"],
    [96, '!! Lightning Secondary Gen !!'],
]);

/** A resolved class reference: the PC class it names and its PS2 target (null when it has none). */
export interface CrystalRef {
    pc: OdbClass;
    target: { dbIndex: number; classId: number } | null;
}

function classField(cls: OdbClass, name: string): number[] {
    const i = cls.fields?.findIndex((f) => f.name === name && fieldBase(f.type) === FIELD_CLASS) ?? -1;
    if (i < 0) return [];
    const f = cls.fields![i]!;
    const v = decodeFieldValue(f.type, cls.data?.[i] ?? 0, cls.data ?? []);
    return (fieldIsArray(f.type) ? (v as number[]) : [v as number]).filter((r) => typeof r === 'number' && r !== 0);
}

const resourceId = (t: { dbIndex: number; classId: number }): number => ((t.dbIndex << 16) | t.classId) >>> 0;

/**
 * `gameplay/crystals.ini` for the runtime (drakan_crystals.cpp): converted Magic Crystal class -> the PS2 effect its use
 * spawns at Rynn. The crystal is a clone of the mana power-up (171, `PS2_SUBSTITUTES`), which has no `Effect` field, so
 * without this table a crystal only refilled the hidden mana (journal 2026-11-16/ootf-fire-crystal.md). The effect is
 * the PS2 target of the PC `Effect` when it has one (Fire Crystal FX, engine 90, is a native FX.ODB class); else the
 * native class named by `CRYSTAL_NATIVE_EFFECTS` for the PC effect's engine (ice, lightning). Resource ids are `dbIndex << 16 | classId` in the level's dependency numbering, like `bows.ini`; only
 * crystals in Resources as bank 3 (the verified namespace) are written.
 */
export function buildCrystalMetadata(
    plan: Pick<ClassPlan, 'synthesized'>,
    sourceOf: (key: string) => OdbClass | undefined,
    resolve: (from: OdbClass, ref: number) => CrystalRef | null,
    ps2Odbs: readonly Pick<Ps2OdbIn, 'dbIndex' | 'file' | 'classes'>[],
): { text: string | null; warnings: string[] } {
    const rows = new Map<number, { effect: number; kind: string; name: string }>();
    const warnings: string[] = [];
    for (const s of plan.synthesized) {
        const source = s.pcKeys.map(sourceOf).find((c) => c?.rflClass === MAGIC_CRYSTAL_RFL);
        if (!source) continue;
        if (s.file !== 'RESOURES.ODB' || s.dbIndex !== 3 || s.classId <= 0 || s.classId > 0xffff) {
            warnings.push(`crystals: ${s.name}: unverified target namespace ${s.file}/${s.dbIndex}; omitted`);
            continue;
        }
        const effectRef = classField(source, 'Effect')[0];
        const effect = effectRef ? resolve(source, effectRef) : null;
        if (!effect) {
            warnings.push(`crystals: ${s.name}: no Effect; omitted`);
            continue;
        }
        const engine = effect.pc.rflClass ?? -1;
        const kind = CRYSTAL_EFFECT_KINDS.get(engine) ?? `engine ${engine}`;
        let target = effect.target;
        let how = `"${effect.pc.name.trim()}"`;
        if (!target) {
            const nativeName = CRYSTAL_NATIVE_EFFECTS.get(engine);
            for (const odb of ps2Odbs) {
                const hit = nativeName && [...odb.classes.values()].find((c) => c.name === nativeName);
                if (hit) {
                    target = { dbIndex: odb.dbIndex, classId: hit.id };
                    how = `Drakan 2's "${nativeName}" for "${effect.pc.name.trim()}"`;
                    break;
                }
            }
        }
        if (!target) {
            warnings.push(`crystals: ${s.name}: effect "${effect.pc.name.trim()}" has no PS2 class; omitted`);
            continue;
        }
        rows.set(resourceId(s), { effect: resourceId(target), kind, name: s.name });
        warnings.push(`crystals: ${s.name} casts ${how} (${kind})`);
    }
    const lines = ['format = 1'];
    for (const [crystal, r] of [...rows].sort((a, b) => a[0] - b[0]))
        lines.push(
            '',
            `[crystal 0x${crystal.toString(16)}]`,
            `effect = 0x${r.effect.toString(16)}`,
            `kind = ${r.kind}`,
            `name = ${r.name.replace(/[\r\n]/g, ' ')}`,
        );
    return { text: rows.size ? lines.join('\n') + '\n' : null, warnings };
}
