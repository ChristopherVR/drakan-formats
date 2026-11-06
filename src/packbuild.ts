/**
 * Pack build identity: the `build` key a converter or editor writes into a mod pack's manifest. The game stores the
 * build of every active content pack next to each save and refuses a save whose packs are missing or have another
 * build (docs/reference/modding.md "Saves and pack builds"). The runtime computes the same value itself for a pack
 * without the key (`hle::mods::packContentHash` in runtime/hle), so both sides must keep this algorithm identical.
 *
 * The hash covers only the content the game loads from a pack (`files/`, `new/`, `overrides/`): FNV-1a 64 over one
 * line per file, sorted by lower-case path, `<lower-case path>\0<size>\0<crc32 as 8 hex digits>\n`. The manifest,
 * pictures, map definitions and menu skins do not count, so changing a cover or a description keeps old saves.
 */

/** A pack build id: 1 to 64 of letters, digits, `.`, `_`, `-` (the converter writes 16 hex digits). */
export const PACK_BUILD_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

const CONTENT_ROOTS = ['files/', 'new/', 'overrides/'] as const;

/** True for a pack path whose bytes the game loads (and whose change can make old saves unloadable). */
export const isPackContentPath = (path: string): boolean => {
    const p = asciiLower(path.replace(/\\/g, '/'));
    return CONTENT_ROOTS.some((r) => p.startsWith(r) && p.length > r.length && !p.endsWith('/'));
};

const asciiLower = (s: string): string => s.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));

const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        t[n] = c >>> 0;
    }
    return t;
})();

/** CRC-32 (IEEE, the zip one). */
export function crc32(data: Uint8Array): number {
    let c = 0xffffffff;
    for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]!) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}

const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const MASK64 = 0xffffffffffffffffn;

/** One content file as the hash sees it (the runtime reads size and CRC from the zip directory). */
export interface PackContentItem {
    path: string;
    size: number;
    crc: number;
}

/** The build id of a pack from its content items: 16 lower-case hex digits. */
export function packContentHash(items: readonly PackContentItem[]): string {
    const lines = items
        .filter((i) => isPackContentPath(i.path))
        .map((i) => ({ key: asciiLower(i.path.replace(/\\/g, '/')), size: i.size, crc: i.crc >>> 0 }))
        .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    let h = FNV_OFFSET;
    const enc = new TextEncoder();
    for (const l of lines) {
        const line = enc.encode(`${l.key}\0${l.size}\0${l.crc.toString(16).padStart(8, '0')}\n`);
        for (const b of line) h = ((h ^ BigInt(b)) * FNV_PRIME) & MASK64;
    }
    return h.toString(16).padStart(16, '0');
}

/** The build id of a pack's files (keyed by path inside the pack, as zipped). */
export function packBuildId(files: Readonly<Record<string, Uint8Array>>): string {
    return packContentHash(
        Object.entries(files).map(([path, data]) => ({ path, size: data.length, crc: crc32(data) })),
    );
}
