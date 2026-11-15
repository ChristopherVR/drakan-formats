/**
 * Save revisions of a content pack (runtime `hle/SaveUpgrade.h`, docs/reference/modding.md "Saves and pack builds").
 *
 * A pack keeps its `build` while its save layout only grows (savelayout.ts), so the saves of the previous pack keep
 * loading. Some changes still leave such a save with old state, because a save holds every object it restores:
 *
 *  - objects added to a level: a save lists the untouched objects by id and leaves out the ones the player destroyed,
 *    picked up or killed, so the game can neither create every unnamed object nor tell which are new;
 *  - objects a level object spawned under the old pack (a tree Mover's "Special Effect" flame the converter later
 *    cleared): the save restores them as records without a level id;
 *  - a dragon that used up a Dragon Power-up while the pack gave that power-up no breath: the save holds the dragon with
 *    its power-up link list emptied, so it never takes the breath the power-up has now;
 *  - a zone-culling Visibility Toggler (ootfzonecull.ts) the old pack left in its hidden state: the save restores that
 *    state and the toggler hides its scenery again, although the pack now shows it from the start.
 *
 * So the pack counts a `save_revision` and lists, per revision, the objects it added (`save_added_objects`), the spawned
 * effect classes it retired (`save_replaced_effects`: records of the old class at the spot get an inert twin class of the
 * same engine class), the dragons whose power-ups are linked again (`save_relinked_powerups`) and the togglers whose
 * saved state is cleared (`save_reset_togglers`). The game writes the revision into every save record and upgrades an
 * older save when it is read. The history is carried from pack to pack in the manifest; it is not part of the layout or
 * the build.
 */
import type { SaveLayout } from './savelayout.ts';

export interface SaveAddedObjects {
    revision: number;
    level: string;
    ids: number[];
    /**
     * Per id (same order), a level object that must still be named by the save for the id to be added (0 = none): a
     * blow-up generator's prop only while the generator exists (`3353@2855`), so a save made after the generator burst
     * does not get the statue back.
     */
    requires?: number[];
}
export interface SaveEffectSwap {
    level: string;
    /** Class id (in the effect's own database) the old pack spawned. */
    fromClass: number;
    /** The inert twin's class id (same database). */
    toClass: number;
    /** Where the spawning object stands (x / z, world units). */
    x: number;
    z: number;
}
export interface SaveReplacedEffects extends SaveEffectSwap {
    revision: number;
}
export interface SaveRelink {
    level: string;
    /** Level object id of the dragon. */
    dragon: number;
    /** Level object ids of the Dragon Power-ups it links. */
    powerUps: number[];
}
export interface SaveRelinkedPowerUps extends SaveRelink {
    revision: number;
}
export interface SaveResetTogglers {
    revision: number;
    level: string;
    ids: number[];
}
export interface SaveRevisions {
    revision: number;
    added: SaveAddedObjects[];
    replaced: SaveReplacedEffects[];
    relinked: SaveRelinkedPowerUps[];
    resetTogglers: SaveResetTogglers[];
}

export const NO_SAVE_REVISIONS: SaveRevisions = {
    revision: 0,
    added: [],
    replaced: [],
    relinked: [],
    resetTogglers: [],
};

const hex = (n: number): string => n.toString(16);

export function formatSaveAddedObjects(a: SaveAddedObjects): string {
    const ids = a.ids.map((id, i) => (a.requires?.[i] ? `${id}@${a.requires[i]}` : `${id}`));
    return `${a.revision} | ${a.level} | ${ids.join(' ')}`;
}
export function formatSaveReplacedEffects(r: SaveReplacedEffects): string {
    return `${r.revision} | ${r.level} | ${hex(r.fromClass)} ${hex(r.toClass)} | ${Math.round(r.x)} ${Math.round(r.z)}`;
}

export function formatSaveRelinkedPowerUps(r: SaveRelinkedPowerUps): string {
    return `${r.revision} | ${r.level} | ${r.dragon} ${r.powerUps.join(' ')}`;
}

export function formatSaveResetTogglers(r: SaveResetTogglers): string {
    return `${r.revision} | ${r.level} | ${r.ids.join(' ')}`;
}

/** The TOML string arrays of a manifest key (`key = ["a", "b"]` on one line, as `buildManifestToml` writes them). */
function tomlStrings(text: string, key: string): string[] {
    const m = new RegExp(`^${key}\\s*=\\s*\\[(.*)\\]\\s*$`, 'm').exec(text);
    if (!m) return [];
    const out: string[] = [];
    const re = /"((?:[^"\\]|\\.)*)"/g;
    for (let s = re.exec(m[1]!); s; s = re.exec(m[1]!)) out.push(JSON.parse(`"${s[1]}"`) as string);
    return out;
}

/** The save revisions a pack manifest (`mod.toml` text) declares; none for a pack written before them. */
export function readSaveRevisions(manifest: string): SaveRevisions {
    const rev = /^save_revision\s*=\s*(\d+)\s*$/m.exec(manifest);
    const revision = rev ? Number(rev[1]) : 0;
    if (!revision) return NO_SAVE_REVISIONS;
    const added: SaveAddedObjects[] = [];
    for (const line of tomlStrings(manifest, 'save_added_objects')) {
        const f = line.split('|').map((s) => s.trim());
        const tokens = (f[2] ?? '').split(/\s+/).filter(Boolean);
        const ids = tokens.map((t) => Number(t.split('@')[0]));
        const requires = tokens.map((t) => (t.includes('@') ? Number(t.split('@')[1]) : 0));
        const ok = (n: number) => Number.isInteger(n) && n >= 0;
        if (
            f.length === 3 &&
            Number(f[0]) > 0 &&
            f[1] &&
            ids.length &&
            ids.every((n) => ok(n) && n > 0) &&
            requires.every(ok)
        )
            added.push({
                revision: Number(f[0]),
                level: f[1],
                ids,
                ...(requires.some(Boolean) ? { requires } : {}),
            });
    }
    const replaced: SaveReplacedEffects[] = [];
    for (const line of tomlStrings(manifest, 'save_replaced_effects')) {
        const f = line.split('|').map((s) => s.trim());
        const cls = (f[2] ?? '').split(/\s+/).map((s) => parseInt(s, 16));
        const xz = (f[3] ?? '').split(/\s+/).map(Number);
        if (f.length === 4 && Number(f[0]) > 0 && f[1] && cls.length === 2 && cls.every((n) => n > 0 && n <= 0xffff))
            if (xz.length === 2 && xz.every(Number.isFinite))
                replaced.push({
                    revision: Number(f[0]),
                    level: f[1],
                    fromClass: cls[0]!,
                    toClass: cls[1]!,
                    x: xz[0]!,
                    z: xz[1]!,
                });
    }
    const relinked: SaveRelinkedPowerUps[] = [];
    for (const line of tomlStrings(manifest, 'save_relinked_powerups')) {
        const f = line.split('|').map((s) => s.trim());
        const ids = (f[2] ?? '').split(/\s+/).filter(Boolean).map(Number);
        if (
            f.length === 3 &&
            Number(f[0]) > 0 &&
            f[1] &&
            ids.length >= 2 &&
            ids.every((n) => Number.isInteger(n) && n > 0)
        )
            relinked.push({ revision: Number(f[0]), level: f[1], dragon: ids[0]!, powerUps: ids.slice(1) });
    }
    const resetTogglers: SaveResetTogglers[] = [];
    for (const line of tomlStrings(manifest, 'save_reset_togglers')) {
        const f = line.split('|').map((s) => s.trim());
        const ids = (f[2] ?? '').split(/\s+/).filter(Boolean).map(Number);
        if (f.length === 3 && Number(f[0]) > 0 && f[1] && ids.length && ids.every((n) => Number.isInteger(n) && n > 0))
            resetTogglers.push({ revision: Number(f[0]), level: f[1], ids });
    }
    return { revision, added, replaced, relinked, resetTogglers };
}

/** Level object ids (`obj|<level path>|<id>` layout keys) of `next` that `base` does not have, by level path. */
export function addedLevelObjects(base: SaveLayout, next: SaveLayout): Map<string, number[]> {
    const out = new Map<string, number[]>();
    for (const k of next.keys()) {
        if (!k.startsWith('obj|') || base.has(k)) continue;
        const cut = k.lastIndexOf('|');
        const level = k.slice(4, cut);
        (out.get(level) ?? out.set(level, []).get(level)!).push(Number(k.slice(cut + 1)));
    }
    for (const ids of out.values()) ids.sort((a, b) => a - b);
    return out;
}

export interface SaveRevisionPlan {
    revisions: SaveRevisions;
    /** True when this pack opened a new revision (it added objects or retired effects since the previous pack). */
    bumped: boolean;
}

/**
 * The save revisions of a new pack. `kept` = the pack keeps the previous pack's build (otherwise old saves are refused
 * anyway and the history starts again at 0). `addedObjects` = level title -> object ids the new pack has and the saves
 * of the previous revision cannot name (layout keys of the new pack missing from the previous one, or from an older
 * baseline when the previous pack predates revisions). `swaps` = the effect swaps this conversion made, `relinks` = its
 * dragons and their power-ups; one the previous revisions already list keeps its revision. Anything new opens revision
 * previous + 1.
 */
export function planSaveRevisions(
    previous: SaveRevisions,
    kept: boolean,
    addedObjects: ReadonlyMap<string, readonly number[]>,
    swaps: readonly SaveEffectSwap[],
    relinks: readonly SaveRelink[] = [],
    togglers: ReadonlyMap<string, readonly number[]> = new Map(),
    requires: ReadonlyMap<string, number> = new Map(),
): SaveRevisionPlan {
    if (!kept) return { revisions: NO_SAVE_REVISIONS, bumped: false };
    const next = previous.revision + 1;
    const known = new Set(previous.added.flatMap((a) => a.ids.map((id) => `${a.level}|${id}`)));
    const added = previous.added.map((a) => ({
        ...a,
        ids: [...a.ids],
        ...(a.requires ? { requires: [...a.requires] } : {}),
    }));
    for (const [level, ids] of addedObjects) {
        const fresh = ids.filter((id) => !known.has(`${level}|${id}`));
        if (!fresh.length) continue;
        const sorted = [...fresh].sort((a, b) => a - b);
        const req = sorted.map((id) => requires.get(`${level}|${id}`) ?? 0);
        added.push({ revision: next, level, ids: sorted, ...(req.some(Boolean) ? { requires: req } : {}) });
    }
    const same = (a: SaveEffectSwap, b: SaveEffectSwap) =>
        a.level === b.level && a.fromClass === b.fromClass && Math.abs(a.x - b.x) < 1 && Math.abs(a.z - b.z) < 1;
    const replaced = previous.replaced.map((r) => ({ ...r }));
    for (const s of swaps)
        if (!replaced.some((r) => same(r, s)))
            replaced.push({ ...s, x: Math.round(s.x), z: Math.round(s.z), revision: next });
    const relinked = previous.relinked.map((r) => ({ ...r, powerUps: [...r.powerUps] }));
    for (const l of relinks)
        if (
            !relinked.some(
                (r) => r.level === l.level && r.dragon === l.dragon && r.powerUps.join() === l.powerUps.join(),
            )
        )
            relinked.push({ ...l, powerUps: [...l.powerUps], revision: next });
    const knownTogglers = new Set(previous.resetTogglers.flatMap((t) => t.ids.map((id) => `${t.level}|${id}`)));
    const resetTogglers = previous.resetTogglers.map((t) => ({ ...t, ids: [...t.ids] }));
    for (const [level, ids] of togglers) {
        const fresh = ids.filter((id) => !knownTogglers.has(`${level}|${id}`));
        if (fresh.length) resetTogglers.push({ revision: next, level, ids: [...fresh].sort((a, b) => a - b) });
    }
    const bumped =
        added.some((a) => a.revision === next) ||
        replaced.some((r) => r.revision === next) ||
        relinked.some((r) => r.revision === next) ||
        resetTogglers.some((t) => t.revision === next);
    return {
        revisions: { revision: bumped ? next : previous.revision, added, replaced, relinked, resetTogglers },
        bumped,
    };
}
