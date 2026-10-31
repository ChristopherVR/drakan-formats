// Synthetic Order of the Flame fixtures only; no game bytes.
import { zlibSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import {
    SrscReader,
    buildOdbIndex,
    convertPcLevel,
    loadPcLevel,
    matchClass,
    parseObjectList,
    parsePcClassRecord,
    parsePcObjectList,
    parsePs2Terrain,
    pcDependencyKey,
    ps2ClassTables,
    ps2VertexMask,
    resolvePcPath,
    signedDegrees,
    writeObjectList,
    writePs2Terrain,
    writeSrsc,
    type LvlHeader,
    type PcFileSource,
} from '../src/index.ts';

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
    str(s: string): this {
        const n = s.length + 1;
        this.u16(n + (n % 2));
        for (const c of s) this.b.push(c.charCodeAt(0));
        this.b.push(0);
        if (n % 2) this.b.push(0);
        return this;
    }
    bytes(): Uint8Array {
        return Uint8Array.from(this.b);
    }
}

type Spec = { type: number; id: number; sub: number; data: Uint8Array };

/** PC container: `SRSC, u16 0x0100, u32 indexOffset, u16 count`, data, index. */
function buildPcSrsc(specs: Spec[]): Uint8Array {
    const body: number[] = [];
    const offs: number[] = [];
    let pos = 12;
    for (const s of specs) {
        offs.push(pos);
        body.push(...s.data);
        pos += s.data.length;
    }
    const w = new W();
    w.b.push(0x53, 0x52, 0x53, 0x43);
    w.u16(0x0100).u32(pos).u16(specs.length);
    w.b.push(...body);
    specs.forEach((s, i) => w.u16(s.type).u16(s.id).u16(s.sub).u32(offs[i]!).u32(s.data.length));
    return w.bytes();
}

/** PS2 container (16-byte header). */
function buildPs2Srsc(specs: Spec[]): Uint8Array {
    const body: number[] = [];
    const offs: number[] = [];
    let pos = 16;
    for (const s of specs) {
        offs.push(pos);
        body.push(...s.data);
        pos += s.data.length;
    }
    const w = new W();
    w.b.push(0x53, 0x52, 0x53, 0x43);
    w.u16(0x0101).u32(pos).u32(specs.length).u16(0);
    w.b.push(...body);
    specs.forEach((s, i) => w.u16(s.type).u16(s.id).u16(s.sub).u32(offs[i]!).u32(s.data.length));
    return w.bytes();
}

interface PcObj {
    id: number;
    cls: number;
    db: number;
    pos: [number, number, number];
    flags?: number;
    links?: number[];
    rot?: [number, number, number];
    scale?: [number, number, number];
    params?: { index: number; type: number; name: string; dword: number }[];
    extra?: number[];
}

function pcObject(o: PcObj, w: W): void {
    w.u32(o.id).u16(o.cls).u16(o.db).u32(0);
    o.pos.forEach((v) => w.f32(v));
    w.u32(o.flags ?? 0).u16(1);
    w.u16((o.links ?? []).length);
    (o.links ?? []).forEach((l) => w.u16(l));
    (o.rot ?? [0, 0, 0]).forEach((r) => w.u16(r));
    if (o.scale) o.scale.forEach((v) => w.f32(v));
    const p = o.params ?? [];
    const data = [...p.map((x) => x.dword), ...(o.extra ?? [])];
    w.u32(data.length).u32(p.length);
    data.forEach((d) => w.u32(d));
    p.forEach((x) => w.u16(x.index));
    p.forEach((x) => w.u32(x.type).str(x.name));
}

function pcClass(name: string, group: number, model: [number, number], rfl: number, fields: [number, string, number][]): Uint8Array {
    const w = new W().str(name).u16(group).u16(model[0]).u16(model[1]).u16(rfl).u16(0);
    w.u32(fields.length).u32(fields.length);
    fields.forEach((f) => w.u32(f[2]));
    fields.forEach((f) => w.u32(f[0]).str(f[1]));
    return w.bytes();
}

function pcTerrain(w: number, h: number, name: string): Uint8Array {
    const t = new W().u32(1);
    t.u32(7).u32(w).u32(h).u32(0).u32(4).u32(6).f32(1000).str(name);
    t.u32(0).f32(0).f32(0).u32(0x00ff80).u32(0x202020).u32(0).u32(0);
    t.u32(1);
    const nv = (w + 1) * (h + 1);
    const blk = new W();
    for (let v = 0; v < nv; v++) {
        blk.b.push(0, 1);
        blk.u16(0x8000 + v);
    }
    for (let c = 0; c < w * h; c++) {
        blk.u16(c & 1)
            .u32(0x00030005)
            .u32(0x00030005);
        for (let k = 0; k < 8; k++) blk.u16(k * 100);
    }
    const z = zlibSync(blk.bytes());
    t.u32(z.length);
    t.b.push(...z);
    return t.bytes();
}

describe('PC SRSC container', () => {
    it('reads the 12-byte header and rewrites it byte for byte', async () => {
        const f = buildPcSrsc([
            { type: 5, id: 1, sub: 0, data: Uint8Array.of(1, 2, 3, 4) },
            { type: 6, id: 2, sub: 1, data: Uint8Array.of(9, 9) },
        ]);
        const r = await SrscReader.fromBytes(f);
        expect(r.platform).toBe('pc');
        expect(r.entries.map((e) => e.type)).toEqual([5, 6]);
        expect([...(await r.readRaw(r.entries[1]!))]).toEqual([9, 9]);
        expect(await writeSrsc(r)).toEqual(f);
        const changed = await writeSrsc(r, new Map([[0, Uint8Array.of(7, 7, 7)]]));
        const r2 = await SrscReader.fromBytes(changed);
        expect(r2.platform).toBe('pc');
        expect([...(await r2.readRaw(r2.entries[0]!))]).toEqual([7, 7, 7]);
    });

    it('still reads the PS2 header', async () => {
        const r = await SrscReader.fromBytes(buildPs2Srsc([{ type: 1, id: 2, sub: 3, data: Uint8Array.of(1) }]));
        expect(r.platform).toBe('ps2');
        expect(r.entries[0]).toMatchObject({ type: 1, id: 2, sub: 3, size: 1 });
    });
});

describe('PC object list', () => {
    it('parses links, unsigned rotations, scale and parameters', () => {
        const w = new W().u16(2);
        pcObject({ id: 10, cls: 5, db: 2, pos: [1, 2, 3], flags: 0x101, links: [11], rot: [270, 90, 0], scale: [1, 2, 3] }, w);
        pcObject({ id: 11, cls: 6, db: 2, pos: [4, 5, 6], params: [{ index: 3, type: 2, name: 'Speed', dword: 0x40000000 }] }, w);
        const list = parsePcObjectList(w.bytes());
        expect(list.objects).toHaveLength(2);
        const a = list.objects[0]!;
        expect(a.links).toEqual([11]);
        expect(a.rot).toEqual([-90, 90, 0]);
        expect(a.scale).toEqual([1, 2, 3]);
        expect(list.objects[1]!.params[0]).toMatchObject({ name: 'Speed', fieldIndex: 3, type: 2 });
    });
    it('rejects trailing bytes', () => {
        const w = new W().u16(1);
        pcObject({ id: 1, cls: 1, db: 1, pos: [0, 0, 0] }, w);
        w.b.push(0);
        expect(() => parsePcObjectList(w.bytes())).toThrow();
    });
    it('folds angles into -180..180', () => {
        expect([signedDegrees(0), signedDegrees(180), signedDegrees(181), signedDegrees(359)]).toEqual([0, 180, -179, -1]);
    });
});

describe('PC class records', () => {
    it('parses name, model, engine class, defaults and field definitions', () => {
        const rec = pcClass('Torch', 4, [7, 1], 33, [
            [2, 'Speed', 0x3f800000],
            [1, 'Hits', 3],
        ]);
        const c = parsePcClassRecord({ id: 9, sub: 4 }, rec)!;
        expect(c).toMatchObject({ id: 9, name: 'Torch', group: 4, model: { id: 7, db: 1 }, rflClass: 33 });
        expect(c.fields!.map((f) => f.name)).toEqual(['Speed', 'Hits']);
        expect(c.data).toEqual([0x3f800000, 3]);
    });
    it('returns null for a truncated record', () => {
        expect(parsePcClassRecord({ id: 1, sub: 0 }, pcClass('X', 0, [0, 0], 1, []).subarray(0, 8))).toBeNull();
    });
});

describe('paths', () => {
    it('resolves dependency paths against the level folder', () => {
        expect(resolvePcPath('Multiplayer/Ground/Relic', '..\\..\\..\\Common\\FX\\FX')).toBe('Common/FX/FX');
        expect(pcDependencyKey('..\\..\\Common\\NPC\\NPCs')).toBe('npcs');
    });
});

// ---- conversion

/** PS2 class record without a model: name, 22 header bytes (engine class at +16), field/dword counts, defaults. */
function ps2ClassRecord(name: string, rfl: number, fields: [number, string, number][]): Uint8Array {
    const head = new Uint8Array(22);
    const dv = new DataView(head.buffer);
    dv.setUint16(16, rfl, true);
    dv.setUint16(18, 1, true);
    const body = new W();
    body.b.push(...head);
    body.u32(fields.length).u32(fields.length);
    fields.forEach((f) => body.u32(f[2]));
    return Uint8Array.from([...new W().str(name).bytes(), ...body.bytes()]);
}

async function ps2Odb(classes: { id: number; name: string; rfl: number; fields: [number, string, number][] }[]): Promise<SrscReader> {
    const specs: Spec[] = classes.map((c) => ({ type: 0x0102, id: c.id, sub: 1, data: ps2ClassRecord(c.name, c.rfl, c.fields) }));
    const lists = new W();
    for (const c of classes) {
        lists.u32(c.fields.length);
        c.fields.forEach((f) => lists.u32(f[0]).str(f[1]));
    }
    specs.push({ type: 0x0103, id: 0, sub: 0, data: zlibSync(lists.bytes()) });
    return SrscReader.fromBytes(buildPs2Srsc(specs));
}

function templateHeader(): LvlHeader {
    const str = (s: string) => ({ raw: new W().str(s).bytes().subarray(2), text: s });
    return {
        name: str('Template'),
        maxWidth: 256,
        maxHeight: 256,
        dependencies: [{ dbIndex: 1, zero: 0, path: str('..\\..\\Common\\Stuff\\Stuff') }],
        trailer: new Uint8Array(),
    };
}

async function fixture() {
    const objects = (() => {
        const w = new W().u16(4);
        pcObject(
            {
                id: 1,
                cls: 1,
                db: 1,
                pos: [100, 200, 300],
                links: [2, 3],
                rot: [270, 0, 0],
                params: [
                    { index: 0, type: 2, name: 'Speed', dword: 0x40000000 },
                    { index: 1, type: 0x0a, name: 'Tag', dword: (2 << 16) | 4 },
                    { index: 2, type: 5, name: 'Sound', dword: 0x00010004 },
                    { index: 3, type: 1, name: 'Gone', dword: 9 },
                ],
                extra: [0x00676162, 0],
            },
            w,
        );
        pcObject({ id: 2, cls: 1, db: 1, pos: [0, 0, 0] }, w);
        pcObject({ id: 3, cls: 2, db: 1, pos: [0, 0, 0] }, w); // class with no PS2 counterpart
        pcObject({ id: 2, cls: 1, db: 1, pos: [5, 5, 5] }, w); // duplicate id
        return w.bytes();
    })();
    const lvlBytes = buildPcSrsc([
        {
            type: 0,
            id: 0,
            sub: 0,
            data: new W().str('<0x0123> Test Level').u32(64).u32(64).u32(1).u16(1).u16(0).str('..\\Common\\Stuff\\Stuff').bytes(),
        },
        { type: 1, id: 0, sub: 0, data: pcTerrain(3, 2, 'layer 1') },
        { type: 0x20, id: 0, sub: 0, data: objects },
    ]);
    const odbBytes = buildPcSrsc([
        {
            type: 0x102,
            id: 1,
            sub: 1,
            data: pcClass('Lamp', 1, [0, 0], 40, [
                [2, 'Speed', 0x3f800000],
                [0x0a, 'Tag', 0],
                [5, 'Sound', 0],
                [1, 'Gone', 0],
            ]),
        },
        { type: 0x102, id: 2, sub: 1, data: pcClass('OnlyPc', 1, [0, 0], 41, []) },
    ]);
    const files = new Map<string, Uint8Array>([
        ['pack/test/test.lvl', lvlBytes],
        ['pack/common/stuff/stuff.odb', odbBytes],
    ]);
    const src: PcFileSource = {
        read: async (p) => files.get(p.toLowerCase()) ?? null,
        list: async () => [...files.keys()],
    };
    const pc = await loadPcLevel(src, 'pack/test/test.lvl');
    const odb = await ps2Odb([
        {
            id: 77,
            name: 'lamp',
            rfl: 40,
            fields: [
                [2, 'speed', 0x3f800000],
                [0x0a, 'Tag', 0],
                [5, 'Sound', 0],
            ],
        },
    ]);
    const h = templateHeader();
    const classes = ps2ClassTables(h, await buildOdbIndex(new Map([['STUFF', odb]])));
    return { pc, h, classes };
}

describe('PC -> PS2 conversion', () => {
    it('loads a PC level with its class tables', async () => {
        const { pc } = await fixture();
        expect(pc.header.name.text).toContain('Test Level');
        expect(pc.list.objects).toHaveLength(4);
        expect(pc.terrain).toHaveLength(1);
        expect(pc.classes.get(1)!.get(1)!.name).toBe('Lamp');
        expect(pc.warnings.some((w) => w.includes('duplicate'))).toBe(true);
    });

    it('matches classes by name regardless of case', async () => {
        const { pc, classes } = await fixture();
        const t = matchClass(pc.classes.get(1)!.get(1)!, classes)!;
        expect(t).toMatchObject({ dbIndex: 1, classId: 77 });
        expect(matchClass(pc.classes.get(1)!.get(2)!, classes)).toBeNull();
    });

    it('converts objects, params, links and terrain to a readable PS2 layout', async () => {
        const { pc, h, classes } = await fixture();
        const r = convertPcLevel(pc, { template: { header: h, classes }, textureFallback: 0x00090042, name: 'OotF Test' });
        const R = r.report;
        expect(R.objectsIn).toBe(4);
        expect(R.objectsOut).toBe(3);
        expect(R.unmappedClasses.get('OnlyPc')).toBe(1);
        expect(R.idsRenumbered).toBe(1);
        expect(R.zeroedResourceParams).toBe(1);
        expect(R.droppedParams.get('Gone')).toBe(1);
        expect(r.header.name.text).toBe('OotF Test');
        expect(r.header.maxWidth).toBe(64);

        const back = parseObjectList(writeObjectList(r.objects));
        const first = back.objects.find((o) => o.pos[0] === 100)!;
        expect(first.classId).toBe(77);
        expect(first.rot).toEqual([-90, 0, 0]);
        expect(first.links).toEqual([2]); // id 3 was dropped
        expect(first.params.map((p) => p.name).sort()).toEqual(['Sound', 'Tag', 'speed']);
        const ids = back.objects.map((o) => o.id);
        expect(ids).toEqual([...ids].sort((a, b) => a - b));

        const L = r.terrain[0]!;
        expect(L.source).toBe('ps2');
        expect(R.cellsFallback).toBe(6);
        expect([...L.cellTexLeft]).toEqual(new Array(6).fill(0x00090042));
        expect([...L.vertexMask]).toEqual([...ps2VertexMask(3, 2)]);
    });

    it('writes terrain that the PS2 reader decodes (two layers)', async () => {
        const { pc, h, classes } = await fixture();
        const r = convertPcLevel(pc, { template: { header: h, classes }, textureFallback: 0x00090042 });
        const first = r.terrain[0]!;
        const second = { ...first, index: 1, id: 8, name: 'layer 2' };
        const payload = writePs2Terrain([first, second], () => new Uint8Array(16));
        const back = parsePs2Terrain(payload);
        expect(back).toHaveLength(2);
        expect(back[0]!.heights[5]).toBe(first.heights[5]);
        expect(back[1]!.name).toBe('layer 2');
        expect([...back[0]!.cellUv]).toEqual([...first.cellUv]);
    });
});
