import { zlibSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import {
    Iso9660,
    SrscReader,
    blobSource,
    bufferSource,
    decodeTxd,
    looksLikeZlib,
    mangleComponent,
    parseDb,
    parseLevelList,
    resolveDependencyStem,
    writeSrsc,
} from '../src/index.ts';
import { buildIso, buildSrsc, buildTxd } from './fixtures.ts';

const bytes = (...n: number[]): Uint8Array => Uint8Array.from(n);

describe('Iso9660', () => {
    const lst = new TextEncoder().encode('\\Levels\\Level 5 - Shiverbane\\Level 5 - Shiverbane.lvl\r\n');
    const big = new Uint8Array(5000).map((_, i) => i & 255); // spans 3 sectors
    const iso = buildIso([
        { path: 'ENGLISH/LEVELLST.TXT', data: lst },
        { path: 'ENGLISH/LEVELS/LEVEL5NE/LEVEL5NE.LVL', data: big },
        { path: 'SYSTEM.CNF', data: bytes(1, 2, 3) },
    ]);

    it('reads the volume id and lists directories', async () => {
        const fs = await Iso9660.open(bufferSource(iso));
        expect(fs.volumeId).toBe('SYNTHETIC');
        const names = (await fs.list('')).map((e) => e.name).sort();
        expect(names).toEqual(['ENGLISH', 'SYSTEM.CNF']);
    });

    it('looks paths up case-insensitively, ignoring ;1 and prefixes', async () => {
        const fs = await Iso9660.open(bufferSource(iso));
        const a = await fs.find('english\\levellst.txt;1');
        const b = await fs.find('cdrom0:\\ENGLISH\\LEVELLST.TXT');
        expect(a?.size).toBe(lst.length);
        expect(b?.extent).toBe(a?.extent);
        expect(await fs.find('ENGLISH/NOPE.TXT')).toBeNull();
        expect((await fs.find('ENGLISH'))?.isDir).toBe(true);
    });

    it('reads whole files, ranges and sub-sources', async () => {
        const fs = await Iso9660.open(bufferSource(iso));
        const p = 'ENGLISH/LEVELS/LEVEL5NE/LEVEL5NE.LVL';
        expect(await fs.read(p)).toEqual(big);
        expect(await fs.read(p, 2040, 20)).toEqual(big.subarray(2040, 2060));
        const src = await fs.openFile(p);
        expect(src.size).toBe(big.length);
        expect(await src.read(4090, 100)).toEqual(big.subarray(4090, 4190));
        expect((await fs.walk()).map((e) => e.path).sort()).toEqual([
            'ENGLISH\\LEVELLST.TXT',
            'ENGLISH\\LEVELS\\LEVEL5NE\\LEVEL5NE.LVL',
            'SYSTEM.CNF',
        ]);
    });

    it('works over a Blob-backed source', async () => {
        const fs = await Iso9660.open(blobSource(new Blob([iso.buffer as ArrayBuffer])));
        expect(await fs.read('SYSTEM.CNF')).toEqual(bytes(1, 2, 3));
    });

    it('rejects non-ISO data', async () => {
        await expect(Iso9660.open(bufferSource(new Uint8Array(40 * 2048)))).rejects.toThrow();
    });
});

describe('Srsc', () => {
    const specs = [
        { type: 0x402, id: 0, sub: 0, data: bytes(1, 2, 3, 4, 5) },
        { type: 0x40, id: 7, sub: 1, data: new Uint8Array(100).fill(9) },
        { type: 0x401, id: 3, sub: 0, data: zlibSync(new Uint8Array(64).fill(7)) },
    ];

    it('parses header and index', async () => {
        const r = await SrscReader.fromBytes(buildSrsc(specs));
        expect(r.version).toBe(0x0101);
        expect(r.entries.map((e) => [e.type, e.id, e.sub, e.size])).toEqual([
            [0x402, 0, 0, 5],
            [0x40, 7, 1, 100],
            [0x401, 3, 0, specs[2]!.data.length],
        ]);
        expect(r.warnings).toEqual([]);
        expect(r.find(0x40, 7)?.index).toBe(1);
        expect(r.find(0x40, 7, 2)).toBeUndefined();
        expect(await r.readRaw(r.entries[0]!)).toEqual(bytes(1, 2, 3, 4, 5));
    });

    it('detects and inflates zlib entries', async () => {
        const r = await SrscReader.fromBytes(buildSrsc(specs));
        expect(await r.isCompressed(r.entries[2]!)).toBe(true);
        expect(await r.isCompressed(r.entries[0]!)).toBe(false);
        const { data, compressed } = await r.read(r.entries[2]!);
        expect(compressed).toBe(true);
        expect(data).toEqual(new Uint8Array(64).fill(7));
        expect(looksLikeZlib(bytes(0x78, 0x01))).toBe(true);
        expect(looksLikeZlib(bytes(0x78, 0x02))).toBe(false);
    });

    it('batches zlib detection for all entries with the same answers as per-entry checks', async () => {
        const many = [
            ...specs,
            { type: 0x41, id: 9, sub: 0, data: bytes(0x78) }, // size 1: never compressed
            { type: 0x42, id: 1, sub: 0, data: bytes(0x78, 0x9c, 1, 2) }, // valid-looking zlib header, junk stream
            ...Array.from({ length: 40 }, (_, i) => ({
                type: 0x43,
                id: i,
                sub: 0,
                data: i % 3 === 0 ? zlibSync(new Uint8Array(30 + i).fill(i)) : new Uint8Array(20 + i).fill(i),
            })),
        ];
        const src = bufferSource(buildSrsc(many));
        let reads = 0;
        const counting = {
            size: src.size,
            read(o: number, l: number) {
                reads++;
                return src.read(o, l);
            },
        };
        const r = await SrscReader.open(counting);
        const expected: boolean[] = [];
        for (const e of r.entries) expected.push(await r.isCompressed(e));
        // specs' zlib entry, the 0x78 0x9c junk entry (header test only), and 14 of the 40 generated entries
        expect(expected.filter(Boolean).length).toBe(1 + 1 + 14);

        reads = 0;
        expect(await r.zlibFlags()).toEqual(expected);
        expect(reads).toBeLessThanOrEqual(2); // one window covers this container
        expect(await r.zlibFlags(16)).toEqual(expected); // tiny windows force many reads, same answers
    });

    it('does not treat a bogus 0x78 header as compressed data', async () => {
        const bogus = bytes(0x78, 0x01, 0xff, 0xff, 0xff);
        const r = await SrscReader.fromBytes(buildSrsc([{ type: 1, id: 1, sub: 0, data: bogus }]));
        const out = await r.read(r.entries[0]!);
        expect(out.compressed).toBe(false);
        expect(out.data).toEqual(bogus);
    });

    it('rejects bad magic and out-of-range indexes', async () => {
        await expect(SrscReader.fromBytes(new Uint8Array(32))).rejects.toThrow(/magic/);
        const f = buildSrsc(specs);
        f[10] = 0xff; // count too large
        await expect(SrscReader.fromBytes(f)).rejects.toThrow(/index/);
    });

    it('re-serialises byte-identically (incl. pad bytes and alignment gaps)', async () => {
        for (const pad of [
            [0, 0],
            [0xaa, 0xbb],
        ]) {
            const orig = buildSrsc(specs, pad);
            const r = await SrscReader.fromBytes(orig);
            expect(await writeSrsc(r)).toEqual(orig);
        }
    });

    it('keeps trailing bytes after the index', async () => {
        const orig = Uint8Array.from([...buildSrsc(specs), 1, 2, 3]);
        const r = await SrscReader.fromBytes(orig);
        expect(r.warnings.some((w) => w.includes('trailing'))).toBe(true);
        expect(await writeSrsc(r)).toEqual(orig);
    });

    it('applies replacements and the result re-parses', async () => {
        const r = await SrscReader.fromBytes(buildSrsc(specs));
        const bigger = new Uint8Array(333).fill(0x42);
        const out = await writeSrsc(r, new Map([[0, bigger]]));
        const r2 = await SrscReader.fromBytes(out);
        expect(r2.entries).toHaveLength(3);
        expect(r2.entries[0]!.offset % 8).toBe(0);
        expect(await r2.readRaw(r2.entries[0]!)).toEqual(bigger);
        expect(await r2.readRaw(r2.entries[1]!)).toEqual(specs[1]!.data);
        expect(r2.warnings).toEqual([]);
    });
});

describe('Txd', () => {
    it('decodes 8 bpp kind 1 (BGRA palette, PS2 alpha) bottom-up to upright', () => {
        const pal = [
            [255, 0, 0, 0x80],
            [0, 255, 0, 0x40],
        ];
        // stored rows: bottom row first. Row0(bottom) = [0,1], row1(top) = [1,0]
        const blob = buildTxd({ bpp: 8, kind: 1, w: 2, h: 2, pal, idx: [0, 1, 1, 0] });
        const stored = decodeTxd(blob, { upright: false });
        expect(Array.from(stored.rgba.subarray(0, 8))).toEqual([255, 0, 0, 255, 0, 255, 0, 128]);
        const up = decodeTxd(blob);
        expect(Array.from(up.rgba.subarray(0, 8))).toEqual([0, 255, 0, 128, 255, 0, 0, 255]);
        expect(up.paletteKind).toBe(1);
        expect(up.width).toBe(2);
    });

    it('decodes 8 bpp kind 2 (ARGB1555 palette)', () => {
        const pal = [0x7fff | 0x8000, 0x001f];
        const t = decodeTxd(buildTxd({ bpp: 8, kind: 2, w: 2, h: 1, pal, idx: [0, 1] }));
        expect(Array.from(t.rgba)).toEqual([255, 255, 255, 255, 255, 0, 0, 0]);
    });

    it('decodes the zlib index plane variant', () => {
        const pal = [[1, 2, 3, 0x80]];
        const t = decodeTxd(buildTxd({ bpp: 8, kind: 1, w: 4, h: 4, pal, idx: new Array(16).fill(0), zlibIdx: true }));
        expect(t.zlibPlane).toBe(true);
        expect(Array.from(t.rgba.subarray(0, 4))).toEqual([1, 2, 3, 255]);
    });

    it('decodes 16, 24 and 32 bpp', () => {
        const t16 = decodeTxd(buildTxd({ bpp: 16, w: 1, h: 1, px: [0x8000 | (31 << 10)] }));
        expect(Array.from(t16.rgba)).toEqual([0, 0, 255, 255]);
        const t24 = decodeTxd(buildTxd({ bpp: 24, w: 1, h: 1, px: [10, 20, 30] }));
        expect(Array.from(t24.rgba)).toEqual([10, 20, 30, 255]);
        const t32 = decodeTxd(buildTxd({ bpp: 32, w: 1, h: 1, px: [10, 20, 30, 0x20] }));
        expect(Array.from(t32.rgba)).toEqual([10, 20, 30, 64]);
    });

    it('decodes compressed 16 and 32 bpp planes (DRAKAN2.RRC style)', () => {
        const a = decodeTxd(buildTxd({ bpp: 16, w: 2, h: 1, px: [0x8000 | 31, 0], zlibPlane: true }));
        expect(a.zlibPlane).toBe(true);
        expect(Array.from(a.rgba)).toEqual([255, 0, 0, 255, 0, 0, 0, 0]);
        const b = decodeTxd(buildTxd({ bpp: 32, w: 1, h: 2, px: [1, 2, 3, 0x80, 4, 5, 6, 0], zlibPlane: true }));
        expect(Array.from(b.rgba.subarray(0, 4))).toEqual([4, 5, 6, 0]); // upright: stored bottom row comes last
        expect(Array.from(b.rgba.subarray(4, 8))).toEqual([1, 2, 3, 255]);
    });

    it('throws on layout mismatches', () => {
        const ok = buildTxd({ bpp: 24, w: 2, h: 2, px: new Array(12).fill(0) });
        expect(() => decodeTxd(ok.subarray(0, ok.length - 1))).toThrow(/size mismatch/);
        expect(() => decodeTxd(new Uint8Array(8))).toThrow();
        const weird = buildTxd({ bpp: 24, w: 1, h: 1, px: [0, 0, 0] });
        weird[12] = 12; // bpp 12
        expect(() => decodeTxd(weird)).toThrow(/bpp/);
    });
});

describe('LevelList / DB', () => {
    it('mangles like iop_mangle.py', () => {
        expect(mangleComponent('Level 1A - Surdana')).toBe('LEVEL1NA');
        expect(mangleComponent('Level 0 - Intro.lvl')).toBe('LEVEL0RO.LVL');
        expect(mangleComponent('Interface')).toBe('INTERFCE');
        expect(mangleComponent('Mountain World Common')).toBe('MOUNTAON');
        expect(mangleComponent('Drakan 2.rrc')).toBe('DRAKAN2.RRC');
        expect(mangleComponent('Magic')).toBe('MAGIC');
    });

    it('parses the level list', () => {
        const txt = [
            '\\Levels\\Level 0 - Intro\\Level 0 - Intro.lvl',
            "\\Levels\\Level 1E - Inquisitor's Lair\\Level 1E - Inquisitor's Lair.lvl",
            '',
        ].join('\r\n');
        const l = parseLevelList(txt);
        expect(l).toHaveLength(2);
        expect(l[0]).toMatchObject({
            name: 'Level 0 - Intro',
            lvlPath: 'LEVELS\\LEVEL0RO\\LEVEL0RO.LVL',
            dirPath: 'LEVELS\\LEVEL0RO',
        });
        expect(l[1]!.dirPath).toBe('LEVELS\\LEVEL1IR');
    });

    it('parses a DB and resolves dependencies', () => {
        const db = parseDb(
            'version 1\r\ndependencies 2\r\n1 ..\\Resources\\Resources\r\n2 ..\\..\\World Common\\World Common\\World Common\r\n',
        );
        expect(db).toMatchObject({ version: 1, declaredCount: 2 });
        expect(db.dependencies).toHaveLength(2);
        expect(resolveDependencyStem('COMMON\\FX', db.dependencies[0]!.path)).toBe('COMMON\\RESOURES\\RESOURES');
        expect(resolveDependencyStem('LEVELS\\LEVEL5NE', db.dependencies[1]!.path)).toBe(
            'WORLDCON\\WORLDCON\\WORLDCON',
        );
    });
});
