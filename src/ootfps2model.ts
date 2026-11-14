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
 * - Props: a placed OotF object (skeletons, a wine keg ...) keeps its class (collision type, health, messages) and its
 *   placement; it is drawn with the disc model of the named Drakan 2 class (textures copied byte for byte) while it still
 *   collides with its OotF model (`OotfAssetBuilder.useDiscModel`, ootfdiscmodel.ts). The disc model must have the PC model's size and origin
 *   (`discModelMismatch`), or the OotF model is kept and the reason is reported: a skeleton must stay on its spike.
 * - Flames: a placed OotF flame (engine class 20, the burning part of a torch, sconce or brazier) keeps its class, light,
 *   sound and messages, but burns with the particle fire of the named Drakan 2 torch class instead of the OotF flame card:
 *   its `Fire Particles` names that torch's fire generator, its model becomes the disc's invisible particle carrier and the
 *   object moves to the foot of the OotF flame, where Drakan 2 torches keep their origin (`ootfflames.ts`).
 * - Effects: a converted OotF class keeps everything but the named class references (`fields`), which become those of the
 *   named Drakan 2 class: an exploding barrel goes off with the Drakan 2 barrel's explosion (flash, fire, debris, sound).
 * - Rynn and Arokh are always the disc's (the player class and the player's dragon are name-mapped); NPCs have no disc
 *   counterpart.
 */

export type Ps2ModelCategory = 'enemies' | 'weapons' | 'props' | 'flames' | 'effects';

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
    /**
     * Enemy rows whose Drakan 2 class never runs away: each placed creature gets, as its `Initial Health`, the damage the
     * Order of the Flame creature takes before it flees (PC `Initial Health` minus PC `Flee Health Limit`), so the fight
     * ends after the same number of blows as in the original. Every other value is the disc class's.
     */
    healthUntilFlee?: boolean;
    /** Props: the ODB stem of the Drakan 2 class (`MOUNTAON`) whose model is copied; flames: of the torch class. */
    odb?: string;
    /**
     * Effects: the class reference fields copied from the Drakan 2 class: `name` (the same field in both classes) or
     * `Drakan 2 field>OotF field`.
     */
    fields?: readonly string[];
    /**
     * Flames: the Drakan 2 fire is copied into FX with its particle size, rise speed and rate multiplied by this (the OotF
     * flame card is larger than a Drakan 2 torch fire); 1 or none names the disc generator itself.
     */
    fireScale?: number;
    /** Props: the PC model name the OotF class must show (classes of one name show different models in some levels). */
    pcModel?: string;
    /** Props: stretch the disc model onto the OotF model's box (a remake a little larger or smaller than the original). */
    fit?: boolean;
    /**
     * Props without a Drakan 2 model: draw the OotF model itself refined (`normals`, `pn`, `pn2`, see ootfdiscmodel.ts
     * `refineMesh`) while it collides as converted. `ps2` and `odb` are unused then.
     */
    refine?: 'normals' | 'pn' | 'pn2' | 'round' | 'palm';
    /** Props: draw only the parts of the disc model that use these entries of its texture list (a crystal without its stand). */
    keepTextures?: readonly number[];
    /** Props: recolour the copied disc textures at convert time (`green`: the Order of the Flame crystal green). */
    tint?: 'green';
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
const sceneOrc = (pc: string, ps2: string, label: string): Ps2ModelSubstitution => ({
    category: 'enemies',
    ootf: pc,
    ps2,
    label,
    scene: true,
    why: 'The cut-scene orc (a prop only scenes move, the same model as the gameplay orc of that colour) shown with the Drakan 2 orc model and rig; its scene clips are retargeted onto the disc rig and its scene attach points follow the disc joints.',
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

const prop = (
    pc: string,
    pcModel: string,
    odb: string,
    ps2: string,
    label: string,
    why: string,
    defaultOff = false,
    fit = false,
): Ps2ModelSubstitution => ({
    category: 'props',
    ootf: pc,
    pcModel,
    odb,
    ps2,
    label,
    why,
    ...(defaultOff ? { defaultOff } : {}),
    ...(fit ? { fit } : {}),
});
const flame = (pc: string, label: string): Ps2ModelSubstitution => ({
    category: 'flames',
    ootf: pc,
    odb: 'WORLDCON',
    ps2: 'Wartok Torch',
    fireScale: FLAME_FIRE_SCALE,
    label,
    why: FLAME_WHY,
});
/** The OotF flame card is about 110 by 300 world units, the Drakan 2 torch fire about 80 by 220. */
const FLAME_FIRE_SCALE = 1.4;
const FLAME_WHY =
    "Burns with the particle fire of Drakan 2's standing torch (Ravenshold), grown to the size of the flat OotF flame card it replaces, at the foot of the OotF flame; the light, sound and on / off messages stay the OotF flame's.";
const effect = (pc: string, odb: string, ps2: string, fields: string[], label: string, why: string) => ({
    category: 'effects' as const,
    ootf: pc,
    odb,
    ps2,
    fields,
    label,
    why,
});
const BARREL_FIELD = 'Explosion Generator>Smoke Generator';
const BARREL_WHY =
    "Goes off with the Drakan 2 explosive barrel's explosion (flash, fireball, debris and sound) in its free smoke generator slot: the converted OotF explosion drew only the barrel staves, its fire parts showed nothing. The OotF explosion still runs beside it, so the blast and its damage to Rynn and enemies stay the OotF barrel's.";
const SKELETON_WHY =
    'Drakan 2 ships a remade Mountain World skeleton of the same name, pose, size and origin (about 1,000 triangles against 140).';
const BRIDGE_WHY =
    'The Drakan 2 Restoration rope bridge span has the same length and height as the OotF span but a walkway three times as wide; stretched onto the OotF span, Rynn walks on the OotF planks.';
/** Bodies on spikes, in cages and hanging: Drakan 2 has no model of them, so the OotF mesh is drawn refined. */
const BODY_REFINE: readonly [string, string, string][] = [
    ['Spiked Body', 'Body on Spike02(h)', 'Body impaled on a spike'],
    ['Spiked Torso', 'Torso on Spike01(h)', 'Torso on a spike'],
    ['Hanging torso', 'HangingTorso2(H)', 'Hanging torso'],
    ['Cage Body(L)', 'Cage02wPerson(H)', 'Body in a cage'],
    ['Hanging Guy', 'HangingBody2(H)', 'Hanged man'],
    ['Torture Gyro Victim', 'rackboy', 'Torture wheel victim'],
    ['deadpose1', 'deadpose01', 'Dead villager'],
    ['deadpose2', 'deadpose02', 'Dead villager'],
    ['deadpose3', 'deadpose03', 'Dead villager'],
    ['dead04', 'dead04', 'Dead villager'],
];
const BODY_WHY =
    'No Drakan 2 model of a body on a spike, in a cage or hanging exists. Turned on, the OotF mesh is drawn refined (smooth normals, one curved subdivision step that also rounds box-like limbs; the texture layout is kept) while it collides as converted. Off: in Wartok Canyons the refined bodies look nearly the same as the OotF ones (journal 2026-11-14/ootf-d2-models.md).';
const PINE_WHY =
    'A looser match: the Drakan 2 pine of the same kind (about 700 triangles against 46 vertices), stretched onto the OotF tree; Rynn collides with the OotF tree.';
const SNOWY_PINE_WHY =
    'A looser match: the Drakan 2 snowy pine (about 700 triangles against 46 vertices), stretched onto the OotF tree; Rynn collides with the OotF tree.';
const CRYSTAL_WHY =
    'A looser match: the crystal of the Drakan 2 Cathedral crystal (908 triangles against 9 vertices, nearly the same proportions) without its stand, its texture recoloured to the Order of the Flame green at convert time, stretched onto the OotF crystal; Rynn collides with the OotF crystal.';
const TORCH_WHY =
    'A looser match: the Drakan 2 Wartok torch of the same kind (300 to 430 triangles against 40 to 44 vertices), stretched onto the OotF torch; the OotF flame burns on it and Rynn collides with the OotF torch.';
/** OotF torch holders and their Drakan 2 analog: [class, PC model, Drakan 2 class (WORLDCON), label]. */
const TORCHES: readonly [string, string, string, string][] = [
    ['Torch Base', 'gtorchp(H)', 'Wartok Torch', 'Standing torch'],
    ['Standing Torch Base', 'gtorchp(h)', 'Wartok Torch', 'Standing torch'],
    ['Sconce', 'TSconce01', 'Wartok Wall Torch', 'Wall sconce'],
    ['Sconce Base', 'TSconce01', 'Wartok Wall Torch', 'Wall sconce'],
];
const PALM_WHY =
    'Drakan 2 has no palm: a new palm is built at convert time from the OotF one (the trunk rounded with its own bark, every frond a curved, drooping two-sided card with the OotF frond picture); Rynn collides with the OotF palm.';
/** OotF palms drawn as new palms: [class, PC model, label, off by default (not yet seen in game)]. */
const PALMS: readonly [string, string, string, boolean][] = [
    ['Fan Palm 01', 'tropical tree01', 'Fan palm', false],
    ['Large Tree', 'PalmTree_Tall01(H)', 'Tall palm', true],
    ['SmallTree', 'PalmTree_Short01(H)', 'Short palm', true],
];
/**
 * Looser Drakan 2 analogs (same kind of object, another name and size), stretched onto the OotF model: [class, PC model, ODB,
 * Drakan 2 class, label, why, off by default].
 */
const ANALOGS: readonly [string, string, string, string, string, string, boolean][] = [
    ['Large Tree', 'Large Pine(H)', 'WORLDCON', 'Pine Tree 01', 'Large pine', PINE_WHY, false],
    ['MedTree', 'Med Pine(H)', 'WORLDCON', 'Pine Tree 01', 'Medium pine', PINE_WHY, false],
    ['Small Tree', 'Small  Pine(H)', 'WORLDCON', 'Pine Tree 01', 'Small pine', PINE_WHY, false],
    [
        'Large Tree (Snowy)',
        'Large Tree LiteSnow(H)',
        'WORLDCON',
        'Snowy Pine',
        'Large snowy pine',
        SNOWY_PINE_WHY,
        false,
    ],
    [
        'MedTree (Snowy)',
        'Medium Tree LiteSnow(H)',
        'WORLDCON',
        'Snowy Pine',
        'Medium snowy pine',
        SNOWY_PINE_WHY,
        false,
    ],
];
const KEG_WHY =
    'The Drakan 2 Surdana wine keg is a remake of the same keg (945 triangles against 72) with the same origin; it is 0.1 units deeper, so it is stretched onto the OotF keg, and Rynn collides with the OotF keg.';

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
    sceneOrc('Heuge Purple', 'Purple Orc Center', 'Scene purple orc'),
    sceneOrc('Heuge Yellow', 'Yellow Orc : Center', 'Scene yellow orc'),
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
        why: 'The disc Scavenger class and model. The Order of the Flame Scavenger could not be hit by melee from most sides (its PC sphere hit volumes do not suit the PS2 engine, see the 2026-11-09 journal), while the disc one is hit normally; it keeps its PC placement, takes the attacks of the disc class, and plays the disc clips. The Order of the Flame Scavenger runs away once it is down to 20 of its 35 hit points; the disc class never flees (2026-11-12 journal), so each one gets the 15 hit points it takes to drive the original off. Turn it off to keep the converted PC model.',
        healthUntilFlee: true,
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
    prop(
        'Skeleton',
        'Skeleton02',
        'MOUNTAON',
        'Skeleton 02 - Laying On Ground',
        'Skeleton lying on the ground',
        SKELETON_WHY,
    ),
    prop(
        'Skeleton02',
        'Skeleton02',
        'MOUNTAON',
        'Skeleton 02 - Laying On Ground',
        'Skeleton lying on the ground',
        SKELETON_WHY,
    ),
    prop('Skeleton Torso', 'Skeleton06', 'MOUNTAON', 'Skeleton 06 - Torso', 'Skeleton torso', SKELETON_WHY),
    prop('Skeleton06', 'Skeleton06', 'MOUNTAON', 'Skeleton 06 - Torso', 'Skeleton torso', SKELETON_WHY),
    prop(
        'Skeleton Spike',
        'Skeleton05',
        'MOUNTAON',
        'Skeleton 05 - On Spike',
        'Skeleton impaled on a spike',
        SKELETON_WHY,
    ),
    prop('Skeleton05', 'Skeleton05', 'MOUNTAON', 'Skeleton 05 - On Spike', 'Skeleton impaled on a spike', SKELETON_WHY),
    prop('Skeleton07', 'Skeleton07', 'MOUNTAON', 'Skeleton07 - Impaled no spike', 'Impaled skeleton', SKELETON_WHY),
    prop('Skeleton01', 'Skeleton01', 'MOUNTAON', 'Skeleton 01 - Crucified', 'Crucified skeleton', SKELETON_WHY),
    prop(
        'Skeleton Hanging',
        'Skeleton04',
        'MOUNTAON',
        'Skeleton 04 - Hanging from chai',
        'Hanging skeleton',
        'Same pose, but the Drakan 2 model hangs from a point 0.59 units higher (its origin is at the chest, not at the chain), so it would hang below its chain; off, and the size and origin check refuses it.',
        true,
    ),
    prop('Bridge 02', 'SusBridge02(H)', 'LEVEL2RE', 'SusBridge02', 'Rope bridge span', BRIDGE_WHY, true, true),
    prop(
        'Solid Mid Piece',
        'SolidSusBridge02(H)',
        'LEVEL2RE',
        'SolidSusbridge02',
        'Rope bridge span (solid)',
        BRIDGE_WHY,
        true,
        true,
    ),
    prop(
        'Bridge Rope',
        'Break-awaySusBridge_rope(H)',
        'LEVEL2RE',
        'Break Away Ropes',
        'Rope bridge ropes',
        BRIDGE_WHY,
        true,
        true,
    ),
    ...BODY_REFINE.map(([pc, pcModel, label]) => ({
        category: 'props' as const,
        ootf: pc,
        pcModel,
        ps2: '(refined OotF model)',
        label,
        why: BODY_WHY,
        refine: 'round' as const,
        defaultOff: true,
    })),
    ...ANALOGS.map(([pc, pcModel, odb, ps2, label, why, off]) => prop(pc, pcModel, odb, ps2, label, why, off, true)),
    ...(['Grimstone Crystals 1', 'Grimstone Crystals 2'] as const).map((pc, i) => ({
        ...prop(pc, `GrimCrystal0${i + 1}`, 'LEVEL1ON', 'Crystal Blue', 'Grimstone crystal', CRYSTAL_WHY, false, true),
        keepTextures: [2],
        tint: 'green' as const,
    })),
    ...TORCHES.map(([pc, pcModel, ps2, label]) => prop(pc, pcModel, 'WORLDCON', ps2, label, TORCH_WHY, false, true)),
    ...PALMS.map(([pc, pcModel, label, off]) => ({
        category: 'props' as const,
        ootf: pc,
        pcModel,
        ps2: '(new palm)',
        label,
        why: PALM_WHY,
        refine: 'palm' as const,
        defaultOff: off,
    })),
    prop('Wine Keg', 'WineBarrel01(H)', 'MOUNTAON', 'Wine Keg (Surdana)', 'Wine keg', KEG_WHY, false, true),
    prop('winecask', 'WineBarrel01(H)', 'MOUNTAON', 'Wine Keg (Surdana)', 'Wine keg', KEG_WHY, false, true),
    flame('Sconce Flame', 'Wall sconce flame'), // also "SconceFlame" (names compare without spaces)
    flame('Torch Flame', 'Standing torch flame'),
    flame('Standing Torch Flame', 'Standing torch flame'),
    flame('Hanging Flame', 'Hanging torch flame'),
    flame('Hanging Torch Flame', 'Hanging torch flame'),
    flame('banner flame', 'Banner torch flame'),
    effect('Barrel (explode)', 'MOUNTAON', 'TNT Barrel', [BARREL_FIELD], 'Exploding barrel', BARREL_WHY),
    effect('Barrel (Exploding)', 'MOUNTAON', 'TNT Barrel', [BARREL_FIELD], 'Exploding barrel', BARREL_WHY),
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

const CATEGORIES: readonly Ps2ModelCategory[] = ['enemies', 'weapons', 'props', 'flames', 'effects'];

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
        const table = base.table ?? DEFAULT_PS2_MODEL_SUBSTITUTIONS;
        const same = (r: Ps2ModelSubstitution) => modelKey(r.ootf) === modelKey(row.ootf!);
        // a class name can have several prop rows (by PC model): the one naming this Drakan 2 class, else the first
        const known =
            table.find((r) => same(r) && typeof row.ps2 === 'string' && modelKey(r.ps2) === modelKey(row.ps2)) ??
            table.find(same);
        const category = row.category ?? known?.category ?? 'weapons';
        if (!CATEGORIES.includes(category)) throw new Ps2ModelMapError(`row ${i + 1}: unknown category ${category}`);
        const refine = (row as { refine?: unknown }).refine;
        if (known?.refine) {
            // a refined-body row: turned on, optionally with another refinement
            if (
                refine !== undefined &&
                refine !== 'normals' &&
                refine !== 'pn' &&
                refine !== 'pn2' &&
                refine !== 'round' &&
                refine !== 'palm'
            )
                throw new Ps2ModelMapError(`row ${i + 1}: "refine" must be normals, pn, pn2, round or palm`);
            extra.push({
                ...known,
                refine: (refine as Ps2ModelSubstitution['refine']) ?? known.refine,
                defaultOff: false,
            });
            continue;
        }
        if (known?.defaultOff && modelKey(known.ps2) === modelKey(row.ps2)) {
            on.push(row.ootf); // the table's own row, turned on
            continue;
        }
        const odb = (row as { odb?: unknown }).odb;
        const needsOdb = category === 'props' || category === 'flames' || category === 'effects';
        if (needsOdb && (typeof odb !== 'string' || !odb))
            throw new Ps2ModelMapError(
                `row ${i + 1}: a ${category} row needs "odb" (the Drakan 2 database, e.g. ${category === 'flames' ? 'WORLDCON' : 'MOUNTAON'})`,
            );
        const fields = (row as { fields?: unknown }).fields;
        const fieldList = Array.isArray(fields) ? fields.filter((f): f is string => typeof f === 'string' && !!f) : [];
        if (category === 'effects' && !fieldList.length)
            throw new Ps2ModelMapError(`row ${i + 1}: an effects row needs "fields" (class reference field names)`);
        extra.push({
            category,
            ootf: row.ootf,
            ps2: row.ps2,
            label: row.label ?? row.ootf,
            why: 'user mapping',
            ...(needsOdb ? { odb: odb as string } : {}),
            ...(category === 'effects' ? { fields: fieldList } : {}),
        });
    }
    return { ...base, off, on, extra };
}

/** The rows a conversion uses: table minus `off` and turned-off categories, `extra` replacing rows of the same class. */
export function effectiveModelSubstitutions(o: Ps2ModelSwapOptions = {}): Ps2ModelSubstitution[] {
    if (o.enabled === false) return [];
    const off = new Set((o.off ?? []).map(modelKey));
    const on = new Set((o.on ?? []).map(modelKey));
    const cats = new Set(o.categoriesOff ?? []);
    // Prop rows are per class and PC model (one class name shows a pine in one level and a palm in another).
    const rowKey = (r: Ps2ModelSubstitution) =>
        modelKey(r.ootf) + (r.category === 'props' && r.pcModel ? `|${modelKey(r.pcModel)}` : '');
    const rows = new Map<string, Ps2ModelSubstitution>();
    for (const r of [...(o.table ?? DEFAULT_PS2_MODEL_SUBSTITUTIONS), ...(o.extra ?? [])]) rows.set(rowKey(r), r);
    return [...rows.values()].filter((r) => {
        const k = modelKey(r.ootf);
        return !off.has(k) && !cats.has(r.category) && (!r.defaultOff || on.has(k));
    });
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
    /**
     * The Drakan 2 prop row for this PC class showing PC model `pcModelName`, or null (a row naming another PC model does not
     * apply).
     */
    prop(name: string, pcModelName: string): Ps2ModelSubstitution | null;
    /** The Drakan 2 flame row for this PC class (an engine class 20 flame), or null. */
    flame(name: string): Ps2ModelSubstitution | null;
    /** The Drakan 2 effects row for this PC class, or null. */
    effect(name: string): Ps2ModelSubstitution | null;
    /** The swapped enemy gets the health after which its Order of the Flame class flees (`healthUntilFlee`, disc clips only). */
    enemyHealthUntilFlee(name: string): boolean;
}

/**
 * Hit points for a creature whose Drakan 2 class cannot flee: what the Order of the Flame creature loses before it runs
 * (`health - fleeLimit`). Null when the PC creature does not flee (limit 0 or less), when the limit is not below the
 * health, or when a value is not a finite number: then the disc class's own health stands.
 */
export function healthUntilFlee(health: unknown, fleeLimit: unknown): number | null {
    if (typeof health !== 'number' || typeof fleeLimit !== 'number') return null;
    if (!Number.isFinite(health) || !Number.isFinite(fleeLimit)) return null;
    if (fleeLimit <= 0 || fleeLimit >= health) return null;
    return Math.round(health - fleeLimit);
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
        enemyHealthUntilFlee: (name) => {
            const r = on.get(modelKey(name));
            return r?.category === 'enemies' && anim === 'drakan2' && r.healthUntilFlee === true;
        },
        enemyTarget: (name) => {
            const r = on.get(modelKey(name));
            return r?.category === 'enemies' ? r.ps2 : null;
        },
        weapon: (name) => {
            const r = on.get(modelKey(name));
            return r?.category === 'weapons' ? r : null;
        },
        prop: (name, pcModelName) =>
            rows.find(
                (r) =>
                    r.category === 'props' &&
                    (r.odb || r.refine) &&
                    modelKey(r.ootf) === modelKey(name) &&
                    (!r.pcModel || modelKey(r.pcModel) === modelKey(pcModelName)),
            ) ?? null,
        flame: (name) => {
            const r = on.get(modelKey(name));
            return r?.category === 'flames' && r.odb ? r : null;
        },
        effect: (name) => {
            const r = on.get(modelKey(name));
            return r?.category === 'effects' && r.odb && r.fields?.length ? r : null;
        },
    };
}

/**
 * The auxiliary class reference of a disc class record (`raw` = the whole 0x0102 record: name field, then the body): the
 * u32 at body +10, a class id in the low word and its db index in the high word, 0 for none. On the disc 88 of the 192
 * weapon classes with a model name a child part there (engine class 203): "Steel Mace" is the handle and names "Steel Mace
 * Head", "Steel Hammer" its head, "Steel Axe" (a sheen layer) the axe itself, the steel swords their sheen layer. A PC
 * weapon shown with such a model must carry the reference, or it draws the handle alone.
 */
export function classCompanionRef(raw: Uint8Array): number {
    if (raw.length < 2) return 0;
    const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    const at = 2 + dv.getUint16(0, true) + 10;
    return at + 4 <= raw.length ? dv.getUint32(at, true) : 0;
}

/** Axis aligned box of a model, model units. */
export interface PropBox {
    min: readonly number[];
    max: readonly number[];
}

/**
 * Why a disc model cannot stand in for a PC prop model (null = it can): on every axis its extent and its box centre must lie
 * within `tolerance` of the largest extent of the two models. Objects keep their OotF placement, so a model of another size
 * or with its origin elsewhere would float, sink into the ground or leave its spike.
 */
export function discModelMismatch(pc: PropBox, disc: PropBox, tolerance = 0.2): string | null {
    const ext = (b: PropBox, k: number) => b.max[k]! - b.min[k]!;
    const mid = (b: PropBox, k: number) => (b.max[k]! + b.min[k]!) / 2;
    const size = Math.max(ext(pc, 0), ext(pc, 1), ext(pc, 2), ext(disc, 0), ext(disc, 1), ext(disc, 2));
    if (!(size > 0)) return 'empty model';
    const axis = ['x', 'y', 'z'];
    for (let k = 0; k < 3; k++) {
        const d = Math.abs(ext(pc, k) - ext(disc, k)) / size;
        if (d > tolerance) return `size along ${axis[k]} differs by ${Math.round(d * 100)} % of the model`;
        const c = Math.abs(mid(pc, k) - mid(disc, k)) / size;
        if (c > tolerance) return `origin along ${axis[k]} differs by ${Math.round(c * 100)} % of the model`;
    }
    return null;
}
