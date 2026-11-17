import { view } from './bytes.ts';
import { SrscReader } from './srsc.ts';
import { TXD_ENTRY_TYPE, parseTxdHeader } from './txd.ts';
import { WORLD_TERRAIN_FAMILIES, WORLD_TEXTURE_SUBSTITUTIONS } from './ootfps2world.ts';

/**
 * Drakan 2 textures in place of Order of the Flame ones. Some OotF objects have a Drakan: The Ancients' Gates counterpart on
 * the player's disc (a pine trunk, the tropical plant fronds): the converter can copy the disc texture into the pack instead of
 * converting the PC picture. The copy is byte for byte, so the game decodes it exactly as it decodes the disc's own texture
 * and the Drakan 2 HD texture pack (keyed by the decoded picture, docs/reference/hd-textures.md) replaces it as well.
 *
 * Matching is an explicit table (`DEFAULT_PS2_TEXTURE_SUBSTITUTIONS`), never a guess at conversion time: a picture search over
 * both games only proposed candidates (journal 2026-11-08/ootf-ps2-texture-substitution.md), and each row was checked by eye
 * for the same kind of surface and a UV layout the OotF model can use. The table holds names and ids only, no game data.
 *
 * Rules (`useSubstitute` in ootfassets.ts, `resolvePs2Substitutes` here):
 *  - the disc texture must have the OotF texture's aspect ratio (UVs are normalised, so only a different size is harmless);
 *  - textures of skinned models must stay 8 bpp and square (creature classes do not draw others), else the OotF one is kept;
 *  - an animated disc texture brings its frames (consecutive ids with the "next frame" flag), as an animated OotF one does.
 * Object textures here; ground (terrain) textures have their own family table, `DEFAULT_PS2_TERRAIN_FAMILIES` below: no OotF
 * ground texture is the same picture as a Drakan 2 `Proc Textures` entry, but whole OotF ground families (a surface's variants
 * and its transition tiles) map onto the closest Drakan 2 ground (journal 2026-11-15/ootf-ground-textures.md).
 */

export interface Ps2TextureSubstitution {
    /** The OotF texture: `<container path without extension, relative to the install>#<id>`. */
    ootf: string;
    /** The Drakan 2 texture: `<TXD path on the disc, relative to the language folder>#<id>`. */
    ps2: string;
    /** What it is, in words a player understands (shown in the editor). */
    label: string;
    /** Why the pair matches. */
    why: string;
}

const WORLDCON = 'WORLDCON/WORLDCON/WORLDCON.TXD';
const MW_COMMON = 'Mountain World/Mountain World Common/Mountain World Common';
const CHARRED_WHY =
    'Drakan 2 stone block wall blackened by fire, same square size, for the soot-black brick of the burnt OotF houses; both tile.';
/** The falling water of Surdana's falls (`SurdanaFalls02`, `SurdanaFalls_05LU`): 64 x 64, 30 frames at 30 fps, blended. */
const FALLS = `${WORLDCON}#652`;
const WATERFALL_WHY =
    'Both are the animated sheet of a waterfall model (30 frames, square, alpha blended); this one is the Drakan 2 Surdana falls.';

/**
 * The curated pairs. Every row: same kind of surface, same aspect ratio, a UV layout that works on the OotF model (tiling bark
 * on a tiling trunk, or the same model's own texture).
 */
export const DEFAULT_PS2_TEXTURE_SUBSTITUTIONS: readonly Ps2TextureSubstitution[] = [
    {
        ootf: 'Islands World/Tropical World Common/Tropical Common#5425',
        ps2: 'LEVELS/LEVEL3ON/LEVEL3ON.TXD#6041',
        label: 'Tropical plant fronds',
        why: 'Drakan 2 ships the same "tropical plant01" model (same 80 polygons and UVs) with this repainted frond texture.',
    },
    {
        ootf: 'Mountain World/Mountain World Common/Mountain World Common#4619',
        ps2: `${WORLDCON}#412`,
        label: 'Pine trunk bark',
        why: 'The trunk texture of the Drakan 2 pines (PineTree01, pine1SNOW); both tile along the trunk.',
    },
    {
        ootf: 'Mountain World/Intro Level/Intro Level Common#4619',
        ps2: `${WORLDCON}#412`,
        label: 'Pine trunk bark (Intro)',
        why: 'The Intro copy of the pine trunk texture; same Drakan 2 pine trunk.',
    },
    {
        ootf: 'Mountain World/Mountain World Common/Mountain World Common#5279',
        ps2: `${WORLDCON}#412`,
        label: 'Log bark',
        why: 'Drakan 2 wraps its own log (SnowyLog) in the pine trunk texture; both tile around the log.',
    },
    {
        ootf: 'Mountain World/Intro Level/Intro Level Common#5279',
        ps2: `${WORLDCON}#412`,
        label: 'Log bark (Intro)',
        why: 'The Intro copy of the log texture; same Drakan 2 log wood.',
    },
    {
        ootf: 'Mountain World/Ruined Village/Ruined Village#5433',
        ps2: 'LEVELS/LEVEL2RE/LEVEL2RE.TXD#545',
        label: 'Old tree trunk bark',
        why: 'Rough broadleaf bark of the Drakan 2 Restoration Tree trunk, at twice the resolution; both tile (oldtree, oldroots).',
    },
    {
        ootf: 'Mountain World/Intro Level/Intro Level#116',
        ps2: 'LEVELS/LEVEL2RE/LEVEL2RE.TXD#545',
        label: 'Oak trunk bark (Intro)',
        why: 'The same bark picture as the Ruined Village old tree; same Drakan 2 broadleaf bark.',
    },
    {
        ootf: 'Mountain World/Intro Level/Intro Objects#5024',
        ps2: FALLS,
        label: 'Waterfall (Intro)',
        why: WATERFALL_WHY,
    },
    {
        ootf: 'Mountain World/Ruined Village/Ruined Village#5024',
        ps2: FALLS,
        label: 'Waterfall (Ruined Village)',
        why: WATERFALL_WHY,
    },
    {
        ootf: 'Mountain World/Wartok Canyons/Wartok Canyons#5064',
        ps2: FALLS,
        label: 'Waterfall (Wartok Canyons)',
        why: WATERFALL_WHY,
    },
    {
        ootf: 'Islands World/Tropical World Common/Tropical Common#5663',
        ps2: FALLS,
        label: 'Waterfall (Islands)',
        why: WATERFALL_WHY,
    },
    {
        ootf: 'Islands World/Alwarren/Alwarren#5732',
        ps2: FALLS,
        label: 'Waterfall (Alwarren)',
        why: WATERFALL_WHY,
    },
    {
        ootf: `${MW_COMMON}#5334`,
        ps2: `${WORLDCON}#355`,
        label: 'Charred stone walls (burnt houses)',
        why: CHARRED_WHY,
    },
    {
        ootf: `${MW_COMMON}#5335`,
        ps2: `${WORLDCON}#355`,
        label: 'Charred stone walls (burnt houses, second picture)',
        why: CHARRED_WHY,
    },
    {
        ootf: `${MW_COMMON}#5327`,
        ps2: `${WORLDCON}#444`,
        label: 'Stone block walls (houses, stone bridges)',
        why: 'Drakan 2 dressed stone block wall, at four times the resolution, for the OotF village house walls and the arched stone bridges; both tile.',
    },
    {
        ootf: `${MW_COMMON}#5351`,
        ps2: `${WORLDCON}#469`,
        label: 'Weathered stone (stone bridge sides)',
        why: 'Drakan 2 stone blocks darkened by damp and moss, for the dirt-streaked sides of the OotF stone bridges.',
    },
    ...[5350, 5354, 5355].map((id) => ({
        ootf: `${MW_COMMON}#${id}`,
        ps2: 'LEVELS/LEVEL1ON/LEVEL1ON.TXD#690',
        label: 'Cobbled walkway (stone bridges)',
        why: 'The dark Surdana cobbles of Drakan 2, same size and tone, for the cobbled tops of the OotF stone bridges.',
    })),
    ...[
        `${MW_COMMON}#3193`,
        'Mountain World/Ruined Village/Ruined Village#3193',
        'Mountain World/Ruined Village/Ruined Village#4582',
    ].map((ootf) => ({
        ootf,
        ps2: 'LEVELS/LEVEL2RE/LEVEL2RE.TXD#497',
        label: 'Brown rock (cliffs, boulders and rock walls)',
        why: 'Drakan 2 weathered tan rock at twice the resolution, the object counterpart of the Drakan 2 ground rock the Mountain World slopes now draw (DEFAULT_PS2_TERRAIN_FAMILIES).',
    })),
    ...WORLD_TEXTURE_SUBSTITUTIONS,
];

export interface Ps2TextureSwapOptions {
    /** Use Drakan 2 textures where the table has one (default true). */
    enabled?: boolean;
    /** The table (default `DEFAULT_PS2_TEXTURE_SUBSTITUTIONS`). */
    table?: readonly Ps2TextureSubstitution[];
    /** OotF refs (`ootf` of a row) to keep as converted OotF textures. */
    off?: readonly string[];
    /** Rows added to the table; a row with the `ootf` of a table row replaces it. */
    extra?: readonly Ps2TextureSubstitution[];
    /**
     * Ground: OotF terrain textures of the families in `DEFAULT_PS2_TERRAIN_FAMILIES` draw the Drakan 2 ground entry of their
     * family (default true; false keeps every OotF ground texture). Off with `enabled: false` too.
     */
    terrain?: boolean;
}

/** One user edit of the table (the CLI's `--ps2-texture-map` JSON is an array of these): `ps2: null` turns a row off. */
export interface Ps2TextureMapEdit {
    ootf: string;
    ps2: string | null;
    label?: string;
    why?: string;
}

export class Ps2TextureMapError extends Error {}

const REF = /^(.+)#(\d{1,5})$/;

/** `<path>#<id>` -> path and id; throws `Ps2TextureMapError` on anything else. */
export function parseTextureRef(ref: string): { path: string; id: number } {
    const m = REF.exec(ref.trim().replace(/\\/g, '/'));
    const id = m ? Number(m[2]) : NaN;
    if (!m || !(id >= 0 && id <= 0xffff)) throw new Ps2TextureMapError(`not a texture reference (path#id): ${ref}`);
    return { path: m[1]!.replace(/^\/+/, ''), id };
}

/** Lower-case `path#id` key of an OotF ref (the asset builder's texture key). */
export function ootfTextureKey(ref: string): string {
    const r = parseTextureRef(ref);
    return `${r.path.toLowerCase()}#${r.id}`;
}

/** Turn user edits (`Ps2TextureMapEdit[]`, e.g. a parsed JSON file) into swap options over the default table. */
export function ps2TextureSwapFromEdits(edits: unknown, base: Ps2TextureSwapOptions = {}): Ps2TextureSwapOptions {
    if (!Array.isArray(edits))
        throw new Ps2TextureMapError('the texture map must be a list of { "ootf": ..., "ps2": ... } rows');
    const off = [...(base.off ?? [])];
    const extra = [...(base.extra ?? [])];
    for (const [i, e] of edits.entries()) {
        const row = e as Partial<Ps2TextureMapEdit> | null;
        if (!row || typeof row.ootf !== 'string') throw new Ps2TextureMapError(`row ${i + 1}: "ootf" is missing`);
        parseTextureRef(row.ootf);
        if (row.ps2 === null) {
            off.push(row.ootf);
            continue;
        }
        if (typeof row.ps2 !== 'string')
            throw new Ps2TextureMapError(`row ${i + 1}: "ps2" must be a reference or null`);
        parseTextureRef(row.ps2);
        extra.push({ ootf: row.ootf, ps2: row.ps2, label: row.label ?? row.ootf, why: row.why ?? 'user mapping' });
    }
    return { ...base, off, extra };
}

/**
 * The object rows a conversion uses: table minus `off`, `extra` replacing rows of the same OotF texture; empty when disabled. Ground
 * rows (`effectiveTerrainSubstitutions`) are keyed by terrain textures, which no object uses, so an extra row may serve both.
 */
export function effectiveSubstitutions(o: Ps2TextureSwapOptions = {}): Ps2TextureSubstitution[] {
    if (o.enabled === false) return [];
    const off = new Set((o.off ?? []).map(ootfTextureKey));
    const rows = new Map<string, Ps2TextureSubstitution>();
    for (const r of [...(o.table ?? DEFAULT_PS2_TEXTURE_SUBSTITUTIONS), ...(o.extra ?? [])])
        rows.set(ootfTextureKey(r.ootf), r);
    return [...rows.entries()].filter(([k]) => !off.has(k)).map(([, r]) => r);
}

/** The Drakan 2 ground textures (`Proc Textures`); a row whose `ps2` names this TXD is a ground row. */
export const PS2_TERRAIN_TXD = 'WORLDCON/PROCTEES/PROCTEES.TXD';

function isTerrainRow(r: Ps2TextureSubstitution): boolean {
    try {
        return parseTextureRef(r.ps2).path.toUpperCase() === PS2_TERRAIN_TXD;
    } catch {
        return false;
    }
}

/**
 * One OotF ground family drawn with one Drakan 2 ground texture: a surface's variants (the PC paints each cell with one of
 * up to six variants of a surface at random) and the transition tiles whose larger part is that surface.
 */
export interface Ps2TerrainFamily {
    /** What it is, in words a player understands. */
    label: string;
    /** The OotF texture container (install path without extension). */
    container: string;
    /** Texture ids of the family in that container. */
    ids: readonly number[];
    /** The Drakan 2 `Proc Textures` id (`PS2_TERRAIN_TXD`); its own material sets tiling, fade and foot-steps. */
    ps2: number;
    /** Why the pair matches. */
    why: string;
}

const range = (a: number, b: number): number[] => Array.from({ length: b - a + 1 }, (_, i) => a + i);
const MW_TD = 'Mountain World/Mountain World Common/Mountain World Common TD';

/**
 * The curated ground families. Why whole families: the PS2 engine blends every cell's texture into its neighbours (splats
 * from per-vertex counts of the four cells round a vertex), so where the PC paints neighbouring cells with different variants
 * of one surface no texture is ever drawn at full weight (0.6 % of the Ruined Village cells against 41 % in Surdana) and the
 * ground reads as a patchwork of half-blended squares. One Drakan 2 texture per surface, tiled in world space by its own
 * material, blends only where the surface really changes, as on the disc. Transition tiles (grass to rock, rock to snow, path
 * edges) join the surface that covers most of their pixels; snow on rock and rocky tracks in snow join the snow or the track
 * from 35 % on, so snow fields and tracks stay joined, and grass tiles crossed by a thin earth trail (60 % green or more) stay grass: one PS2 cell of earth, blended into
 * its neighbours, would draw the trail two to three times as wide as the PC. Ids: Mountain World (Intro, Ruined Village, Wartok Canyons, Grimstone Mines, Grotto). Other worlds keep
 * their OotF ground (not reviewed yet).
 */
export const DEFAULT_PS2_TERRAIN_FAMILIES: readonly Ps2TerrainFamily[] = [
    {
        label: 'Grass (Mountain World)',
        container: MW_TD,
        ids: [
            ...range(2, 7),
            21,
            22,
            24,
            30,
            31,
            34,
            ...range(151, 154),
            ...range(160, 167),
            ...range(173, 177),
            ...range(179, 192),
            361,
            363,
            364,
            365,
            408,
        ],
        ps2: 537,
        why: 'Drakan 2 "Grass" (Surdana), a meadow grass with visible blades; one cell per tile. Mossy Green, nearer in colour, read as mossy rock in the dusk light of the Ruined Village.',
    },
    {
        label: 'Brown rock ground and slopes (Mountain World)',
        container: MW_TD,
        ids: [
            ...range(9, 14),
            20,
            23,
            ...range(25, 29),
            32,
            33,
            ...range(35, 56),
            60,
            61,
            67,
            69,
            72,
            73,
            76,
            78,
            80,
            83,
            86,
            87,
            90,
            91,
            103,
            104,
            105,
            108,
            109,
            ...range(222, 241),
            ...range(254, 258),
            395,
            396,
            397,
            411,
            412,
            419,
            ...range(422, 426),
            431,
        ],
        ps2: 621,
        why: 'Drakan 2 "Brown Rock Outdoor": weathered brown rock with cracks, the same kind of surface as the OotF rock-plate ground and mountain sides, tiled over 4 x 4 cells.',
    },
    {
        label: 'Snow (Mountain World)',
        container: MW_TD,
        ids: [
            16,
            57,
            58,
            59,
            63,
            64,
            65,
            68,
            71,
            288,
            289,
            295,
            309,
            312,
            ...range(316, 319),
            ...range(390, 393),
            427,
            428,
            429,
            466,
        ],
        ps2: 563,
        why: 'Drakan 2 "Blue Snow", the snow of Surdana, Ravenshold and the Tundra.',
    },
    {
        label: 'Dark earth paths (Mountain World)',
        container: MW_TD,
        ids: [
            ...range(120, 123),
            ...range(127, 136),
            139,
            140,
            141,
            ...range(143, 145),
            156,
            159,
            ...range(168, 171),
            ...range(206, 209),
        ],
        ps2: 13719,
        why: 'Drakan 2 "Mud" (Ravenshold, Andrellian), dark wet earth of nearly the same colour as the OotF paths.',
    },
    {
        label: 'Rocky paths in snow (Mountain World)',
        container: MW_TD,
        ids: [
            ...range(272, 275),
            ...range(277, 287),
            290,
            291,
            292,
            294,
            296,
            ...range(297, 302),
            304,
            306,
            307,
            308,
            311,
            314,
            315,
            ...range(320, 323),
            ...range(325, 330),
            332,
            333,
            334,
            335,
        ],
        ps2: 535,
        why: 'Drakan 2 "Rock - Gray (Outdoor)", the grey mountain rock of every snow level, for the grey stony tracks through OotF snow.',
    },
    ...WORLD_TERRAIN_FAMILIES,
];

/** The ground families as `container#id` -> `PS2_TERRAIN_TXD#id` rows (for edits, listings and `--ps2-texture-map`). */
export function ps2TerrainRows(
    families: readonly Ps2TerrainFamily[] = DEFAULT_PS2_TERRAIN_FAMILIES,
): Ps2TextureSubstitution[] {
    return families.flatMap((f) =>
        f.ids.map((id) => ({
            ootf: `${f.container}#${id}`,
            ps2: `${PS2_TERRAIN_TXD}#${f.ps2}`,
            label: f.label,
            why: f.why,
        })),
    );
}

/**
 * Ground textures a conversion swaps: lower-case `container#id` of an OotF terrain texture -> the Drakan 2 `Proc Textures` id.
 * The family table plus `extra` rows that name `PS2_TERRAIN_TXD`, minus `off`; empty when `enabled` or `terrain` is false.
 */
export function effectiveTerrainSubstitutions(
    o: Ps2TextureSwapOptions = {},
    families: readonly Ps2TerrainFamily[] = DEFAULT_PS2_TERRAIN_FAMILIES,
): Map<string, number> {
    const out = new Map<string, number>();
    if (o.enabled === false || o.terrain === false) return out;
    for (const r of [...ps2TerrainRows(families), ...(o.extra ?? []).filter(isTerrainRow)])
        out.set(ootfTextureKey(r.ootf), parseTextureRef(r.ps2).id);
    for (const k of (o.off ?? []).map(ootfTextureKey)) out.delete(k);
    return out;
}

/** A disc texture ready to copy: its record bodies (first frame, then the animation frames) and what the checks need. */
export interface Ps2SubstituteTexture {
    row: Ps2TextureSubstitution;
    frames: Uint8Array[];
    width: number;
    height: number;
    bpp: number;
    /** Drawn with holes or blending: a colour key (+20) or the alpha flag (+37 bit 1). */
    hasAlpha: boolean;
}

export interface Ps2SubstituteSet {
    /** Lower-case `container#id` of the OotF texture -> the disc texture. */
    byOotf: Map<string, Ps2SubstituteTexture>;
    /** Rows that could not be used, with the reason. */
    skipped: { row: Ps2TextureSubstitution; reason: string }[];
}

const NEXT_FRAME = 0x20;

/**
 * Read the disc textures of `rows` through `read` (a TXD path relative to the language folder -> its bytes, or null). Async
 * work happens here so the asset builder's lookups stay synchronous.
 */
export async function resolvePs2Substitutes(
    rows: readonly Ps2TextureSubstitution[],
    read: (discPath: string) => Promise<Uint8Array | null>,
): Promise<Ps2SubstituteSet> {
    const out: Ps2SubstituteSet = { byOotf: new Map(), skipped: [] };
    const txds = new Map<string, Promise<SrscReader | null>>();
    const open = (path: string): Promise<SrscReader | null> => {
        const k = path.toUpperCase();
        let p = txds.get(k);
        if (!p) {
            p = read(path)
                .then((b) => (b ? SrscReader.fromBytes(b) : null))
                .catch(() => null);
            txds.set(k, p);
        }
        return p;
    };
    for (const row of rows) {
        let ps2;
        try {
            ootfTextureKey(row.ootf);
            ps2 = parseTextureRef(row.ps2);
        } catch (e) {
            out.skipped.push({ row, reason: (e as Error).message });
            continue;
        }
        const txd = await open(ps2.path);
        if (!txd) {
            out.skipped.push({ row, reason: `${ps2.path} is not on the disc` });
            continue;
        }
        const frames: Uint8Array[] = [];
        for (let id = ps2.id; frames.length < 64 && id <= 0xffff; id++) {
            const e = txd.find(TXD_ENTRY_TYPE, id);
            if (!e) break;
            const body = (await txd.read(e)).data;
            if (frames.length && !((body[37] ?? 0) & NEXT_FRAME)) break;
            frames.push(body);
        }
        if (!frames.length) {
            out.skipped.push({ row, reason: `${ps2.path} has no texture ${ps2.id}` });
            continue;
        }
        let h;
        try {
            h = parseTxdHeader(frames[0]!);
        } catch (e) {
            out.skipped.push({ row, reason: (e as Error).message });
            continue;
        }
        const key = view(frames[0]!).getUint32(20, true);
        out.byOotf.set(ootfTextureKey(row.ootf), {
            row,
            frames,
            width: h.width,
            height: h.height,
            bpp: h.bpp,
            hasAlpha: key !== 0xffffffff || ((frames[0]![37] ?? 0) & 0x02) !== 0,
        });
    }
    return out;
}

/**
 * Why `sub` cannot stand in for an OotF texture of `width` x `height` (null = it can). `indexed`: the texture belongs to a skinned
 * model, which needs 8 bpp and square.
 */
export function substituteMismatch(
    sub: Pick<Ps2SubstituteTexture, 'width' | 'height' | 'bpp'>,
    width: number,
    height: number,
    indexed: boolean,
): string | null {
    if (sub.width * height !== sub.height * width)
        return `aspect ${sub.width}x${sub.height} differs from the OotF ${width}x${height}`;
    if (indexed && (sub.bpp !== 8 || sub.width !== sub.height)) return 'a creature texture must stay 8 bpp and square';
    return null;
}
