// Synthetic level fixtures only; no game bytes.
import { describe, expect, it } from 'vitest';
import {
    FLAG_RADIUS,
    FLAG_SCALED,
    LvlEditError,
    LvlError,
    SrscReader,
    buildOdbIndex,
    danglingLinks,
    deleteObject,
    duplicateObject,
    findObject,
    moveObject,
    odbStemForDependency,
    parseLevelHeader,
    parseObjectList,
    readLvl,
    resolveClass,
    rotateObject,
    scaleObject,
    writeLevelHeader,
    writeLvl,
    writeObjectList,
} from '../src/index.ts';
import { buildSrsc } from './fixtures.ts';

class W {
    b: number[] = [];
    u16(n: number): this {
        this.b.push(n & 255, (n >> 8) & 255);
        return this;
    }
    u32(n: number): this {
        this.b.push(n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255);
        return this;
    }
    f32(n: number): this {
        const d = new DataView(new ArrayBuffer(4));
        d.setFloat32(0, n, true);
        for (let i = 0; i < 4; i++) this.b.push(d.getUint8(i));
        return this;
    }
    str(s: string, pad = 0): this {
        const bytes = [...s].map((c) => c.charCodeAt(0));
        for (let i = 0; i < pad; i++) bytes.push(0);
        this.u16(bytes.length);
        this.b.push(...bytes);
        return this;
    }
    done(): Uint8Array {
        return Uint8Array.from(this.b);
    }
}

interface Spec {
    id: number;
    cls: number;
    db: number;
    pos: [number, number, number];
    flags: number;
    radius?: number;
    links?: number[];
    rot?: [number, number, number];
    scale?: [number, number, number];
    prefix?: [number, number];
    pre?: number;
    data?: number[];
    params?: { field: number; type: number; name: string }[];
}

function buildObjects(specs: Spec[], tail: number[] = []): Uint8Array {
    const w = new W().u16(specs.length);
    for (const s of specs) w.u32(s.id).u16(s.cls).u16(s.db);
    for (const s of specs) {
        w.u32(s.prefix?.[0] ?? 0).u32(s.prefix?.[1] ?? 0);
        s.pos.forEach((v) => w.f32(v));
        w.u32(s.flags).u16(1);
        if (s.flags & FLAG_RADIUS) w.f32(s.radius ?? 0);
        w.u16(s.links?.length ?? 0);
        (s.links ?? []).forEach((l) => w.u32(l));
        (s.rot ?? [0, 0, 0]).forEach((r) => w.u16(r & 0xffff));
        if (s.flags & FLAG_SCALED) (s.scale ?? [1, 1, 1]).forEach((v) => w.f32(v));
        w.u32(s.pre ?? 0).u32(0xffffffff);
        const data = s.data ?? [];
        const params = s.params ?? [];
        w.u32(data.length).u32(params.length);
        data.forEach((d) => w.u32(d));
        params.forEach((p) => w.u16(p.field));
        params.forEach((p) => w.u32(p.type).str(p.name, 2));
    }
    w.b.push(...tail);
    return w.done();
}

const SPECS: Spec[] = [
    { id: 2, cls: 10, db: 2, pos: [1, 2, 3], flags: 0x01, links: [5, 7], rot: [0, -89, 10] },
    {
        id: 5,
        cls: 11,
        db: 3,
        pos: [100.5, -20, 300],
        flags: 0x1 | FLAG_RADIUS | FLAG_SCALED | 0x8000,
        radius: 6144,
        scale: [1, 2, 3],
        prefix: [4, 9],
        pre: 77,
        data: [0x1234, 0xdeadbeef, 3],
        params: [
            { field: 145, type: 7, name: 'Initial Mode' },
            { field: 3, type: 0x0a, name: 'Trigger Message' },
        ],
    },
    { id: 7, cls: 10, db: 2, pos: [-5, 0, 5], flags: 0x100 | 0x01, scale: [0.5, 0.5, 0.5], links: [2] },
    { id: 9, cls: 12, db: 99, pos: [0, 0, 0], flags: 0 },
];

function header(): Uint8Array {
    return new W()
        .str('Test Level', 2)
        .u32(65536)
        .u32(32768)
        .u32(2)
        .u16(2)
        .u16(0)
        .str('..\\..\\Common\\System\\System', 1)
        .u16(3)
        .u16(0)
        .str('..\\..\\Common\\NPC\\NPCs', 1)
        .done();
}

describe('LVL 0x0000 header', () => {
    it('parses and round-trips', () => {
        const raw = header();
        const h = parseLevelHeader(raw);
        expect(h.name.text).toBe('Test Level');
        expect([h.maxWidth, h.maxHeight]).toEqual([65536, 32768]);
        expect(h.dependencies.map((d) => [d.dbIndex, d.path.text])).toEqual([
            [2, '..\\..\\Common\\System\\System'],
            [3, '..\\..\\Common\\NPC\\NPCs'],
        ]);
        expect(writeLevelHeader(h)).toEqual(raw);
    });
    it('keeps trailing bytes', () => {
        const raw = Uint8Array.from([...header(), 1, 2, 3]);
        expect(writeLevelHeader(parseLevelHeader(raw))).toEqual(raw);
    });
    it('rejects truncation and absurd counts', () => {
        const raw = header();
        expect(() => parseLevelHeader(raw.subarray(0, raw.length - 3))).toThrow(LvlError);
        const bad = raw.slice();
        new DataView(bad.buffer).setUint32(2 + 12 + 8, 0x7fffffff, true);
        expect(() => parseLevelHeader(bad)).toThrow(LvlError);
    });
});

describe('LVL 0x0020 object list', () => {
    const raw = buildObjects(SPECS);

    it('parses every field and keeps unknown bits', () => {
        const m = parseObjectList(raw);
        expect(m.objects).toHaveLength(4);
        const o = m.objects[1]!;
        expect(o).toMatchObject({
            id: 5,
            classId: 11,
            dbIndex: 3,
            prefix0: 4,
            prefix1: 9,
            radius: 6144,
            preSentinel: 77,
            sentinel: 0xffffffff,
            scale: [1, 2, 3],
            data: [0x1234, 0xdeadbeef, 3],
        });
        expect(o.flags & 0x8000).toBe(0x8000);
        expect(o.params.map((p) => [p.fieldIndex, p.type, p.name])).toEqual([
            [145, 7, 'Initial Mode'],
            [3, 0x0a, 'Trigger Message'],
        ]);
        expect(o.params[0]!.nameRaw.length).toBe('Initial Mode'.length + 2);
        expect(m.objects[0]!.links).toEqual([5, 7]);
        expect(m.objects[0]!.rot).toEqual([0, -89, 10]);
        expect(m.warnings).toEqual([]);
    });

    it('re-serialises unmodified input byte for byte', () => {
        expect(writeObjectList(parseObjectList(raw))).toEqual(raw);
        const empty = buildObjects([]);
        expect(writeObjectList(parseObjectList(empty))).toEqual(empty);
    });

    it('warns about duplicate and unordered ids', () => {
        const m = parseObjectList(buildObjects([SPECS[1]!, SPECS[0]!, SPECS[0]!]));
        expect(m.warnings.length).toBe(2);
    });

    it('moves, rotates and scales, leaving everything else identical', () => {
        const m = parseObjectList(raw);
        moveObject(m, 5, [1, 2, 3.25]);
        rotateObject(m, 5, [1, -180, 359]);
        scaleObject(m, 5, [2, 2, 2]);
        const out = writeObjectList(m);
        expect(out.length).toBe(raw.length);
        const back = parseObjectList(out);
        expect(back.objects[1]).toMatchObject({ pos: [1, 2, 3.25], rot: [1, -180, 359], scale: [2, 2, 2] });
        const orig = parseObjectList(raw);
        expect(back.objects[1]!.data).toEqual(orig.objects[1]!.data);
        expect(back.objects[1]!.preSentinel).toBe(77);
        expect(back.objects[0]).toEqual(orig.objects[0]);
        expect(back.objects[2]).toEqual(orig.objects[2]);
    });

    it('rejects invalid edits', () => {
        const m = parseObjectList(raw);
        expect(() => moveObject(m, 1234, [0, 0, 0])).toThrow(LvlEditError);
        expect(() => moveObject(m, 2, [NaN, 0, 0])).toThrow(LvlEditError);
        expect(() => moveObject(m, 2, [1, 2])).toThrow(LvlEditError);
        expect(() => rotateObject(m, 2, [0.5, 0, 0])).toThrow(LvlEditError);
        expect(() => rotateObject(m, 2, [40000, 0, 0])).toThrow(LvlEditError);
        expect(() => scaleObject(m, 2, [1, 1, 1])).toThrow(/flag 0x100/);
        expect(writeObjectList(m)).toEqual(raw);
    });

    it('deletes an unreferenced object (table and body)', () => {
        const m = parseObjectList(raw);
        expect(deleteObject(m, 9).referencedBy).toEqual([]);
        const out = writeObjectList(m);
        expect(out.length).toBeLessThan(raw.length);
        const back = parseObjectList(out);
        expect(back.objects.map((o) => o.id)).toEqual([2, 5, 7]);
    });

    it('refuses to delete a linked object by default, and can unlink or ignore', () => {
        const m = parseObjectList(raw);
        expect(() => deleteObject(m, 5)).toThrow(/linked from 2/);
        expect(m.objects).toHaveLength(4);

        expect(deleteObject(m, 5, 'unlink').referencedBy).toEqual([2]);
        expect(findObject(m, 2)!.links).toEqual([7]);
        expect(danglingLinks(m)).toEqual([]);

        const n = parseObjectList(raw);
        deleteObject(n, 7, 'ignore');
        expect(danglingLinks(n)).toEqual([{ from: 2, to: 7 }]);
        expect(parseObjectList(writeObjectList(n)).objects).toHaveLength(3);
    });

    it('duplicates with a fresh id, deep-copied state and an offset', () => {
        const m = parseObjectList(raw);
        const c = duplicateObject(m, 5, [10, 0, -10]);
        expect(c.id).toBe(10);
        expect(c.pos).toEqual([110.5, -20, 290]);
        moveObject(m, 10, [0, 0, 0]);
        expect(findObject(m, 5)!.pos).toEqual([100.5, -20, 300]);
        c.data[0] = 1;
        expect(findObject(m, 5)!.data[0]).toBe(0x1234);
        const back = parseObjectList(writeObjectList(m));
        expect(back.objects.map((o) => o.id)).toEqual([2, 5, 7, 9, 10]);
        expect(back.objects[4]).toMatchObject({ classId: 11, radius: 6144, preSentinel: 77, scale: [1, 2, 3] });
        expect(back.warnings).toEqual([]);
        expect(() => duplicateObject(m, 4242)).toThrow(LvlEditError);
    });

    it('rejects malformed input', () => {
        expect(() => parseObjectList(new Uint8Array(0))).toThrow(LvlError);
        expect(() => parseObjectList(raw.subarray(0, raw.length - 1))).toThrow(LvlError);
        expect(() => parseObjectList(raw.subarray(0, 10))).toThrow(LvlError);
        expect(() => parseObjectList(Uint8Array.from([...raw, 0]))).toThrow(/bytes left/);
        // count claims far more objects than there are bytes
        const big = raw.slice();
        big[0] = 0xff;
        big[1] = 0xff;
        expect(() => parseObjectList(big)).toThrow(LvlError);
        // corrupted sentinel of the first body: find 0xffffffff after the table
        const bad = raw.slice();
        const at = 2 + 4 * 8 + 8 + 12 + 4 + 2 + 2 + 8 + 6 + 4;
        expect(bad.subarray(at, at + 4)).toEqual(Uint8Array.from([255, 255, 255, 255]));
        bad[at] = 0;
        expect(() => parseObjectList(bad)).toThrow(/bad sentinel/);
        // non-finite position
        const nan = raw.slice();
        new DataView(nan.buffer).setUint32(2 + 4 * 8 + 8, 0x7fc00000, true);
        expect(() => parseObjectList(nan)).toThrow(/position/);
        // huge parameter count must not allocate or hang
        const hp = buildObjects([{ id: 1, cls: 1, db: 1, pos: [0, 0, 0], flags: 0 }]);
        new DataView(hp.buffer).setUint32(hp.length - 4, 0xffffffff, true);
        expect(() => parseObjectList(hp)).toThrow(LvlError);
    });

    it('writer rejects an inconsistent model', () => {
        const m = parseObjectList(raw);
        m.objects[0]!.flags |= FLAG_SCALED;
        expect(() => writeObjectList(m)).toThrow(/scale presence/);
        const k = parseObjectList(raw);
        k.objects[1]!.radius = null;
        expect(() => writeObjectList(k)).toThrow(/radius presence/);
    });
});

describe('LVL container and class names', () => {
    const lvlBytes = buildSrsc([
        { type: 0x0000, id: 0, sub: 0, data: header() },
        { type: 0x0001, id: 1, sub: 0, data: Uint8Array.from([9, 9, 9]) },
        { type: 0x0020, id: 0, sub: 0, data: buildObjects(SPECS) },
    ]);

    it('reads, re-packs unchanged and with edits', async () => {
        const srsc = await SrscReader.fromBytes(lvlBytes);
        const lvl = await readLvl(srsc);
        expect(lvl.list.objects).toHaveLength(4);
        expect(await writeLvl(srsc, lvl.list)).toEqual(lvlBytes);
        moveObject(lvl.list, 2, [9, 9, 9]);
        deleteObject(lvl.list, 9);
        const re = await SrscReader.fromBytes(await writeLvl(srsc, lvl.list));
        const again = await readLvl(re);
        expect(again.list.objects.map((o) => o.pos[0])).toEqual([9, 100.5, -5]);
        expect(await re.readRaw(re.entries[1]!)).toEqual(Uint8Array.from([9, 9, 9]));
    });

    it('resolves class names through the dependency table and mangler', async () => {
        const rec = (name: string, body: number[]): Uint8Array =>
            Uint8Array.from([...new W().str(name, 1).done(), ...body]);
        const body = new Array<number>(24).fill(0);
        body[16] = 0x1c;
        body[17] = 0x00;
        body[18] = 0x01;
        const odb = buildSrsc([
            { type: 0x0102, id: 11, sub: 2462, data: rec('Dragon', body) },
            { type: 0x0102, id: 12, sub: 1, data: rec('Short', [1, 2]) },
        ]);
        const idx = await buildOdbIndex(new Map([['npcs', await SrscReader.fromBytes(odb)]]));
        const h = parseLevelHeader(header());
        expect(odbStemForDependency('..\\..\\Common\\NPC\\NPCs')).toBe('NPCS');
        const r = resolveClass(h, idx, 11, 3);
        expect(r.db).toBe('NPCS');
        expect(r.class).toMatchObject({ name: 'Dragon', group: 2462, runtimeClass: 0x1001c });
        expect(resolveClass(h, idx, 12, 3).class).toMatchObject({ name: 'Short', runtimeClass: null });
        expect(resolveClass(h, idx, 999, 3).class).toBeUndefined();
        expect(resolveClass(h, idx, 11, 99)).toEqual({});
    });

    it('throws when an entry is missing', async () => {
        const srsc = await SrscReader.fromBytes(buildSrsc([{ type: 0x0000, id: 0, sub: 0, data: header() }]));
        await expect(readLvl(srsc)).rejects.toThrow(/0x0020/);
    });
});
