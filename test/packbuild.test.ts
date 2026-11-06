// Synthetic pack files only; no game bytes.
import { describe, expect, it } from 'vitest';
import { PACK_BUILD_PATTERN, crc32, isPackContentPath, packBuildId, packContentHash } from '../src/packbuild.ts';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

// The same pack as runtime/hle/tests/save_record_test.cpp ("content hash matches the converter"): both sides must
// compute 8d3872dfe99031fa for it.
const PACK: Record<string, Uint8Array> = {
    'mod.toml': enc('id = "x"\n'),
    'overrides/INTERFCE.TXD/0040_97_0.bin': enc('abc'),
    'files/ENGLISH/LEVELS/LEVEL9AP/LEVEL9AP.LVL': new Uint8Array([0x53, 0x52, 0x53, 0x43, ...new Array(12).fill(0)]),
    'new/RESOURES.ODB/0103_7_0.bin': new Uint8Array([1, 2]),
    'previews/x.png': enc('png'),
};

describe('pack build id', () => {
    it('uses the zip CRC-32', () => {
        expect(crc32(enc('abc'))).toBe(891568578);
        expect(crc32(new Uint8Array([1, 2]))).toBe(0xb6cc4292);
    });

    it('matches the runtime vector', () => {
        expect(packBuildId(PACK)).toBe('8d3872dfe99031fa');
        expect(PACK_BUILD_PATTERN.test(packBuildId(PACK))).toBe(true);
    });

    it('is the FNV offset basis for a pack without content', () => {
        expect(packBuildId({ 'mod.toml': enc('id = "x"\n') })).toBe('cbf29ce484222325');
    });

    it('counts only files the game loads', () => {
        expect(isPackContentPath('files/A.LVL')).toBe(true);
        expect(isPackContentPath('Overrides/X.TXD/0040_1_0.bin')).toBe(true);
        expect(isPackContentPath('new/X.ODB/0103_1_0.bin')).toBe(true);
        expect(isPackContentPath('mod.toml')).toBe(false);
        expect(isPackContentPath('previews/campaign-ootf.png')).toBe(false);
        expect(isPackContentPath('maps/arena.ini')).toBe(false);
        expect(isPackContentPath('ui/menus.ini')).toBe(false);
        expect(isPackContentPath('files/')).toBe(false);
        const cover = { ...PACK, 'previews/x.png': enc('another picture'), 'mod.toml': enc('id = "y"\n') };
        expect(packBuildId(cover)).toBe(packBuildId(PACK));
    });

    it('changes with any content byte, size or path', () => {
        const base = packBuildId(PACK);
        expect(packBuildId({ ...PACK, 'overrides/INTERFCE.TXD/0040_97_0.bin': enc('abd') })).not.toBe(base);
        expect(packBuildId({ ...PACK, 'overrides/INTERFCE.TXD/0040_97_0.bin': enc('abcd') })).not.toBe(base);
        const moved = { ...PACK };
        moved['overrides/INTERFCE.TXD/0040_98_0.bin'] = moved['overrides/INTERFCE.TXD/0040_97_0.bin']!;
        delete moved['overrides/INTERFCE.TXD/0040_97_0.bin'];
        expect(packBuildId(moved)).not.toBe(base);
    });

    it('does not depend on file order, path case or separators', () => {
        const reversed = Object.fromEntries(Object.entries(PACK).reverse());
        expect(packBuildId(reversed)).toBe(packBuildId(PACK));
        const items = Object.entries(PACK).map(([path, data]) => ({ path, size: data.length, crc: crc32(data) }));
        const renamed = items.map((i) => ({ ...i, path: i.path.toLowerCase().replace(/\//g, '\\') }));
        expect(packContentHash(renamed)).toBe(packContentHash(items));
    });
});
