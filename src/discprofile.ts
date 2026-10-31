/**
 * Disc profile of a PS2 image, as the mod loader sees it (docs/reference/modding.md "Disc profile and hash").
 * The hash is FNV-1a 64 of `"<serial>|<saveId>"` (runtime/hle/src/ModPack.cpp `profileHash`); it names the release,
 * not the image bytes. PAL SCES-500.06 gives `b9f60ba118125a54`.
 */

export interface DiscProfile {
    /** `SCES_500.06` as written in SYSTEM.CNF. */
    bootFile: string;
    /** `SCES-50006`. */
    serial: string;
    /** Memory card id, `BESCES-50006` (PAL) or `BASCUS-97128` (USA); null for a region the runtime has no id for. */
    saveId: string | null;
    /** Mod manifest `target.profile` id when the release is one the runtime knows (`pal`, `usa`). */
    profile: 'pal' | 'usa' | null;
    /** 16 lower-case hex digits, or null when `saveId` is unknown. */
    hash: string | null;
}

const FNV_OFFSET = 1469598103934665603n;
const FNV_PRIME = 1099511628211n;
const MASK = 0xffffffffffffffffn;

/** The runtime's profile hash (a zero result becomes 1, as in C++). */
export function discProfileHash(serial: string, saveId: string): string {
    let h = FNV_OFFSET;
    for (const c of new TextEncoder().encode(`${serial}|${saveId}`)) {
        h ^= BigInt(c);
        h = (h * FNV_PRIME) & MASK;
    }
    if (h === 0n) h = 1n;
    return h.toString(16).padStart(16, '0');
}

/** `BOOT2 = cdrom0:\SCES_500.06;1` -> profile. Returns null if SYSTEM.CNF has no recognisable boot file. */
export function parseSystemCnf(text: string): DiscProfile | null {
    const m = /^\s*BOOT2?\s*=\s*cdrom0?:[\\/]?([A-Z]{4})_(\d{3})\.(\d{2})/im.exec(text);
    if (!m) return null;
    const [, prefix, a, b] = m as unknown as [string, string, string, string];
    const p = prefix.toUpperCase();
    const serial = `${p}-${a}${b}`;
    const region = p === 'SCES' || p === 'SLES' ? 'BE' : p === 'SCUS' || p === 'SLUS' ? 'BA' : null;
    const saveId = region ? `${region}${serial}` : null;
    // The runtime only builds PAL SCES-50006 and USA SCUS-97128; other releases have no profile id.
    const profile = serial === 'SCES-50006' ? 'pal' : serial === 'SCUS-97128' ? 'usa' : null;
    return {
        bootFile: `${p}_${a}.${b}`,
        serial,
        saveId,
        profile,
        hash: saveId ? discProfileHash(serial, saveId) : null,
    };
}
