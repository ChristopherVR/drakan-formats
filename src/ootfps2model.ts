/**
 * Drakan 2 models for Order of the Flame characters and weapons. Where the player's disc (Drakan: The Ancients' Gates) has the
 * same creature or the same kind of weapon, the converter can use the disc's own model (with its textures, skeleton, clips and
 * HD textures) instead of converting the PC one. A curated table of class names, never a guess at conversion time (journal
 * 2026-11-08/ootf-ps2-model-substitution.md); it holds names only, no game data.
 *
 * - Enemies: the PC creature class is played by the same-named or aliased PS2 class (`PC_CLASS_ALIASES`), so the model and its
 *   rig are the disc's. `animations: 'drakan2'` (default) keeps the disc's own clips; `'ootf'` retargets the PC clips onto the
 *   disc rig (the converter's earlier behaviour). A row turned off converts the PC model with its own rig instead.
 * - Weapons: the PC weapon class keeps its PC data (damage, reach, effects); only its model becomes the disc weapon's model
 *   (a model of the host container, so the class names it in place).
 * - Rynn and Arokh are always the disc's (the player class and the player's dragon are name-mapped); NPCs have no disc
 *   counterpart.
 */

export type Ps2ModelCategory = 'enemies' | 'weapons';

export interface Ps2ModelSubstitution {
    category: Ps2ModelCategory;
    /** The OotF class name (as in the PC ODB). */
    ootf: string;
    /** The Drakan 2 class whose model is used (enemies: the class that plays the creature). */
    ps2: string;
    /** What it is, in words a player understands (shown in the editor). */
    label: string;
    /** Why the pair matches. */
    why: string;
    /** Off unless the user turns it on (`Ps2ModelSwapOptions.on`), with the reason in `why`. */
    defaultOff?: boolean;
    /** A scene-only prop (engine class 17) shown with the disc creature's model and rig; its scene clips are retargeted. */
    scene?: boolean;
}

const tock = (pc: string, ps2: string, label: string): Ps2ModelSubstitution => ({
    category: 'enemies',
    ootf: pc,
    ps2,
    label,
    why: 'The Drakan 2 Wartok of the same armour: Drakan 2 ships the Order of the Flame troll as this creature (same skeleton).',
});
const sceneTock = (pc: string, ps2: string, label: string): Ps2ModelSubstitution => ({
    category: 'enemies',
    ootf: pc,
    ps2,
    label,
    scene: true,
    why: 'The cut-scene Wartok (a prop only scenes move) shown with the Drakan 2 Wartok model and rig of the same armour; its scene clips are retargeted onto the disc rig and its scene attach points follow the disc joints.',
});
const orc = (pc: string, ps2: string, label: string): Ps2ModelSubstitution => ({
    category: 'enemies',
    ootf: pc,
    ps2,
    label,
    why: 'The Drakan 2 orc of the same colour: Drakan 2 ships the Order of the Flame orc as this creature (same skeleton).',
});
const weapon = (pc: string, ps2: string, label: string, why: string): Ps2ModelSubstitution => ({
    category: 'weapons',
    ootf: pc,
    ps2,
    label,
    why,
});

export const DEFAULT_PS2_MODEL_SUBSTITUTIONS: readonly Ps2ModelSubstitution[] = [
    tock('Troll Leather', 'LeatherWartock : Center', 'Leather Wartok'),
    tock('Troll Leather defense side atta', 'LeatherWartock : Flank', 'Leather Wartok (flanker)'),
    tock('Troll Chain', 'ChainTock : Center', 'Chain Wartok'),
    tock('Troll Chain defense side attack', 'ChainTock : Flank', 'Chain Wartok (flanker)'),
    tock('Troll Plate', 'PlateTock : Center', 'Plate Wartok'),
    tock('Troll Plate defense side attack', 'PlateTock : Flank', 'Plate Wartok (flanker)'),
    sceneTock('Wartock Leather', 'LeatherWartock : Center', 'Scene Leather Wartok'),
    sceneTock('Wartock Chain', 'ChainTock : Center', 'Scene Chain Wartok'),
    sceneTock('Wartock Plate', 'PlateTock : Center', 'Scene Plate Wartok'),
    orc('Orc Leather (purple)', 'Purple Orc Center', 'Purple orc'),
    orc('Orc Plate (yellow)', 'Yellow Orc : Center', 'Yellow orc'),
    {
        category: 'enemies',
        ootf: 'Spider',
        ps2: 'Spider',
        label: 'Spider',
        why: 'The same creature with the same 37-joint skeleton in both games.',
    },
    {
        category: 'enemies',
        ootf: 'Scavenger',
        ps2: 'Scavenger',
        label: 'Scavenger',
        why: 'The disc Scavenger class and model. The Order of the Flame Scavenger could not be hit by melee from most sides (its PC sphere hit volumes do not suit the PS2 engine, see the 2026-11-09 journal), while the disc one is hit normally; it keeps its PC placement, takes the health and attacks of the disc class, and plays the disc clips. Turn it off to keep the converted PC model.',
    },
    weapon('Short Sword', 'Steel Short Sword', 'Short sword', 'A plain one-handed short sword in both games.'),
    weapon('Long Sword', 'Steel Longsword', 'Long sword', 'A plain one-handed long sword in both games.'),
    weapon('2-Handed', 'Steel Two Handed Sword', 'Two-handed sword', 'A plain two-handed sword in both games.'),
    weapon('Scimitar', 'Steel Scimitar', 'Scimitar', 'A plain curved sword in both games.'),
    weapon('Speed Scimitar', 'Iron Scimitar', 'Speed scimitar', 'The lighter scimitar; the Drakan 2 iron one.'),
    weapon('Mace', 'Steel Mace', 'Mace', 'A plain flanged mace in both games.'),
    weapon('Battle Axe', 'Steel Axe', 'Battle axe', 'A plain one-handed axe in both games.'),
    weapon('Battle Hammer', 'Steel Hammer', 'Battle hammer', 'A plain war hammer in both games.'),
    weapon('Troll Axe', 'Leathertock Axe - Lev [1]', 'Wartok axe', 'The axe the Drakan 2 Wartoks carry.'),
    weapon('club', 'club', 'Orc club', 'The same club (same name and model number) in both games.'),
    weapon('Goblin Club', 'Wood Club', 'Goblin club', 'A crude wooden club in both games.'),
    weapon('Long Bow', 'Wood Bow:  Long', 'Long bow', 'A plain wooden long bow in both games.'),
    weapon('Heavy Bow', 'Wood Bow:  Long', 'Heavy bow', 'Shares the long bow model in Order of the Flame.'),
    weapon('Speed Bow', 'Wood Bow:  Long', 'Speed bow', 'Shares the long bow model in Order of the Flame.'),
    weapon('Arrows', 'Wood Bow - Arrow Short', 'Arrow quiver', 'The plain quiver every Drakan 2 arrow pickup uses.'),
];

export type EnemyAnimations = 'drakan2' | 'ootf';

export interface Ps2ModelSwapOptions {
    /** Use Drakan 2 models where the table has one (default true). */
    enabled?: boolean;
    /** Categories turned off (default: all on). */
    categoriesOff?: readonly Ps2ModelCategory[];
    /** The table (default `DEFAULT_PS2_MODEL_SUBSTITUTIONS`). */
    table?: readonly Ps2ModelSubstitution[];
    /** OotF class names of rows to keep as converted OotF models. */
    off?: readonly string[];
    /** OotF class names of `defaultOff` rows to use. */
    on?: readonly string[];
    /** Rows added to the table; a row with the `ootf` of a table row replaces it. */
    extra?: readonly Ps2ModelSubstitution[];
    /** Swapped enemies: the disc's own clips (default) or the PC clips retargeted onto the disc rig. */
    enemyAnimations?: EnemyAnimations;
}

/** One user edit (the CLI's `--ps2-model-map` JSON is a list of these): `ps2: null` turns a row off. */
export interface Ps2ModelMapEdit {
    ootf: string;
    ps2: string | null;
    category?: Ps2ModelCategory;
    label?: string;
}

export class Ps2ModelMapError extends Error {}

/** Class names compare like the class planner does: case and punctuation ignored. */
export const modelKey = (name: string): string => name.toLowerCase().replace(/[^a-z0-9]+/g, '');

const CATEGORIES: readonly Ps2ModelCategory[] = ['enemies', 'weapons'];

/** Turn user edits (a parsed JSON file) into swap options over the default table. */
export function ps2ModelSwapFromEdits(edits: unknown, base: Ps2ModelSwapOptions = {}): Ps2ModelSwapOptions {
    if (!Array.isArray(edits))
        throw new Ps2ModelMapError('the model map must be a list of { "ootf": ..., "ps2": ... } rows');
    const off = [...(base.off ?? [])];
    const on = [...(base.on ?? [])];
    const extra = [...(base.extra ?? [])];
    for (const [i, e] of edits.entries()) {
        const row = e as Partial<Ps2ModelMapEdit> | null;
        if (!row || typeof row.ootf !== 'string' || !modelKey(row.ootf))
            throw new Ps2ModelMapError(`row ${i + 1}: "ootf" (an Order of the Flame class name) is missing`);
        if (row.ps2 === null) {
            off.push(row.ootf);
            continue;
        }
        if (typeof row.ps2 !== 'string' || !modelKey(row.ps2))
            throw new Ps2ModelMapError(`row ${i + 1}: "ps2" must be a Drakan 2 class name or null`);
        const known = (base.table ?? DEFAULT_PS2_MODEL_SUBSTITUTIONS).find(
            (r) => modelKey(r.ootf) === modelKey(row.ootf!),
        );
        const category = row.category ?? known?.category ?? 'weapons';
        if (!CATEGORIES.includes(category)) throw new Ps2ModelMapError(`row ${i + 1}: unknown category ${category}`);
        if (known?.defaultOff && modelKey(known.ps2) === modelKey(row.ps2)) {
            on.push(row.ootf); // the table's own row, turned on
            continue;
        }
        extra.push({ category, ootf: row.ootf, ps2: row.ps2, label: row.label ?? row.ootf, why: 'user mapping' });
    }
    return { ...base, off, on, extra };
}

/** The rows a conversion uses: table minus `off` and turned-off categories, `extra` replacing rows of the same class. */
export function effectiveModelSubstitutions(o: Ps2ModelSwapOptions = {}): Ps2ModelSubstitution[] {
    if (o.enabled === false) return [];
    const off = new Set((o.off ?? []).map(modelKey));
    const on = new Set((o.on ?? []).map(modelKey));
    const cats = new Set(o.categoriesOff ?? []);
    const rows = new Map<string, Ps2ModelSubstitution>();
    for (const r of [...(o.table ?? DEFAULT_PS2_MODEL_SUBSTITUTIONS), ...(o.extra ?? [])])
        rows.set(modelKey(r.ootf), r);
    return [...rows.entries()]
        .filter(([k, r]) => !off.has(k) && !cats.has(r.category) && (!r.defaultOff || on.has(k)))
        .map(([, r]) => r);
}

/** What the pipeline asks per PC class. */
export interface Ps2ModelPlan {
    /** An enemy row is on for this class: `drakan2` (disc clips) or `ootf` (retargeted PC clips). */
    enemy(name: string): EnemyAnimations | null;
    /** The class is an enemy row of the full table that the user turned off: convert the PC model with its own rig. */
    enemyOff(name: string): boolean;
    /** The Drakan 2 weapon class name whose model replaces this PC weapon's, or null. */
    weapon(name: string): Ps2ModelSubstitution | null;
    /** The Drakan 2 class an enemy row names for this PC class (scene-only props use its model and rig), or null. */
    enemyTarget(name: string): string | null;
}

export function planPs2Models(o: Ps2ModelSwapOptions = {}): Ps2ModelPlan {
    const rows = effectiveModelSubstitutions(o);
    const on = new Map(rows.map((r) => [modelKey(r.ootf), r]));
    const all = new Set(
        [...(o.table ?? DEFAULT_PS2_MODEL_SUBSTITUTIONS), ...(o.extra ?? [])]
            .filter((r) => r.category === 'enemies')
            .map((r) => modelKey(r.ootf)),
    );
    const anim = o.enemyAnimations ?? 'drakan2';
    return {
        enemy: (name) => (on.get(modelKey(name))?.category === 'enemies' ? anim : null),
        enemyOff: (name) => all.has(modelKey(name)) && on.get(modelKey(name))?.category !== 'enemies',
        enemyTarget: (name) => {
            const r = on.get(modelKey(name));
            return r?.category === 'enemies' ? r.ps2 : null;
        },
        weapon: (name) => {
            const r = on.get(modelKey(name));
            return r?.category === 'weapons' ? r : null;
        },
    };
}
