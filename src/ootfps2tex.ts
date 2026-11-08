import { view } from './bytes.ts';
import { SrscReader } from './srsc.ts';
import { TXD_ENTRY_TYPE, parseTxdHeader } from './txd.ts';

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
 * Object textures only: no OotF terrain texture has a better Drakan 2 `Proc Textures` counterpart (the identical ones are a
 * placeholder and lava, which the terrain converter already maps to the native liquid entries).
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

/** The rows a conversion uses: table minus `off`, `extra` replacing rows of the same OotF texture; empty when disabled. */
export function effectiveSubstitutions(o: Ps2TextureSwapOptions = {}): Ps2TextureSubstitution[] {
    if (o.enabled === false) return [];
    const off = new Set((o.off ?? []).map(ootfTextureKey));
    const rows = new Map<string, Ps2TextureSubstitution>();
    for (const r of [...(o.table ?? DEFAULT_PS2_TEXTURE_SUBSTITUTIONS), ...(o.extra ?? [])])
        rows.set(ootfTextureKey(r.ootf), r);
    return [...rows.entries()].filter(([k]) => !off.has(k)).map(([, r]) => r);
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
