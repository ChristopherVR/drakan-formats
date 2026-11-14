import { FIELD_ANIMATION, FIELD_SOUND, decodeFieldValue, fieldBase } from './fields.ts';
import type { OdbClass } from './odb.ts';

/**
 * Campaign sound swaps (docs/journal/2026-11-15/ootf-voices.md, reference/modding.md "Campaign sound swaps").
 *
 * Rynn and Arokh are Drakan 2's own records in a converted campaign (name-mapped), and the Drakan 2 Wartok models voice
 * themselves through their clips' sound lists. Changing those records or clips would change Drakan 2 as well, because a
 * pack is installed for the whole session. Instead the pack lists sound ids in `sounds/swaps.ini`: while its campaign is
 * the current game, the runtime plays one of the listed ids (or nothing) where the game asks for a Drakan 2 id. Ids are
 * the game's play ids (`database index << 16 | sound id`, the database index of the template level's dependency table,
 * the same in every level converted from one template).
 */

/** Path of the swap table inside a pack. */
export const SOUND_SWAPS_PATH = 'sounds/swaps.ini';

/** One swap: whenever the game plays one of `from`, it plays one of `to` instead (in turn); `to` empty = nothing. */
export interface SoundSwap {
    from: number[];
    to: number[];
    /** A short note written as a comment above the line (class and field names). */
    why: string;
}

/**
 * Name-mapped PC classes whose sound fields the "Rynn and Arokh voices" option plays from the Order of the Flame sounds
 * (lower case): Rynn, Arokh ("Dragon") and Rynn's "Got Hit (Rynn)" sound object.
 */
export const PC_VOICE_CLASSES: readonly string[] = ['rynn', 'dragon', 'got hit (rynn)'];

/** Fields of those classes that keep the Drakan 2 sound under the option: loops and body sounds, not voices. */
export const PC_VOICE_SKIPPED_FIELDS: RegExp = /loop|wing flap|sheathe|push object|slide|landing/i;

/** Drakan 2 Wartok classes (the Wartock, Tock and Orc records the converted Wartoks map to). */
export const WARTOK_CLASS: RegExp = /tock|orc/i;

/** Clip names (lower case, start) whose sound lists are a creature's idle voice: standing, getting ready, walking. */
export const IDLE_CLIP_NAMES: RegExp = /^(idle|ready|walk)/i;

/** The sound refs (`db << 16 | id`, the record's own database frame) of a class field, zeros dropped. */
export function classFieldSounds(cls: OdbClass, field: number): number[] {
    const f = cls.fields?.[field];
    if (!f || fieldBase(f.type) !== FIELD_SOUND) return [];
    const v = decodeFieldValue(f.type, cls.data?.[field] ?? 0, cls.data ?? []);
    return (Array.isArray(v) ? v : [v])
        .filter((r): r is number => typeof r === 'number' && r !== 0)
        .map((r) => r >>> 0);
}

/** The animation refs (`db << 16 | id`) a class names in any animation field, zeros dropped, in field order. */
export function classAnimations(cls: OdbClass): number[] {
    const out: number[] = [];
    (cls.fields ?? []).forEach((f, i) => {
        if (fieldBase(f.type) !== FIELD_ANIMATION) return;
        const v = decodeFieldValue(f.type, cls.data?.[i] ?? 0, cls.data ?? []);
        for (const r of Array.isArray(v) ? v : [v]) if (typeof r === 'number' && r) out.push(r >>> 0);
    });
    return out;
}

/** A clip's sound list (ADB 0x0505: `u16 count, count x u32 sound id`); [] when absent or short. */
export function clipSoundList(b: Uint8Array | null | undefined): number[] {
    if (!b || b.length < 2) return [];
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    const n = dv.getUint16(0, true);
    const out: number[] = [];
    for (let i = 0; i < n && 2 + 4 * i + 4 <= b.length; i++) out.push(dv.getUint32(2 + 4 * i, true));
    return out;
}

/**
 * Merge swaps that share a `from` id: the later one's targets join the first (one id cannot play two lists). Returns the
 * merged list and the number of ids that were in more than one swap.
 */
export function mergeSoundSwaps(swaps: readonly SoundSwap[]): { swaps: SoundSwap[]; shared: number } {
    const out: SoundSwap[] = [];
    const at = new Map<number, SoundSwap>();
    let shared = 0;
    for (const s of swaps) {
        const fresh = s.from.filter((id) => !at.has(id));
        for (const id of s.from)
            if (at.has(id)) {
                shared++;
                const o = at.get(id)!;
                for (const t of s.to) if (!o.to.includes(t)) o.to.push(t);
            }
        if (!fresh.length) continue;
        const row: SoundSwap = { from: [...new Set(fresh)], to: [...new Set(s.to)], why: s.why };
        out.push(row);
        for (const id of row.from) at.set(id, row);
    }
    return { swaps: out, shared };
}

const hex = (n: number): string => `0x${(n >>> 0).toString(16)}`;

/** The text of `sounds/swaps.ini`: one `<from ids> = <to ids>` (or `= none`) line per swap, a comment above each. */
export function writeSoundSwaps(swaps: readonly SoundSwap[]): string {
    const lines = [
        '# Sounds this campaign plays in place of Drakan 2 ones while it is the current game.',
        '# <play ids> = <play ids played instead, in turn> | none',
    ];
    for (const s of swaps) {
        if (!s.from.length) continue;
        lines.push(`# ${s.why.replace(/[\r\n]+/g, ' ')}`);
        lines.push(`${s.from.map(hex).join(' ')} = ${s.to.length ? s.to.map(hex).join(' ') : 'none'}`);
    }
    return `${lines.join('\n')}\n`;
}
