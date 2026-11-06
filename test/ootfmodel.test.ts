// Synthetic fixtures only; no game bytes.
import { describe, expect, it } from 'vitest';
import { SrscReader, parseModel } from '../src/index.ts';
import { writePs2Srsc } from '../src/ootfcontainer.ts';
import {
    buildPs2Mod,
    computeNormals,
    listPcModelIds,
    parsePcModel,
    pcToNeutral,
    readPs2Neutral,
    synthesizeBounds,
    sphereHierarchyCount,
    parseObbHierarchy,
    rebuildObbHierarchy,
    writePs2ModelRecords,
} from '../src/ootfmodel.ts';

class W {
    b: number[] = [];
    u16(n: number): this {
        this.b.push(n & 255, (n >> 8) & 255);
        return this;
    }
    u32(n: number): this {
        return this.u16(n & 0xffff).u16(n >>> 16);
    }
    f32(n: number): this {
        const d = new DataView(new ArrayBuffer(4));
        d.setFloat32(0, n, true);
        for (let i = 0; i < 4; i++) this.b.push(d.getUint8(i));
        return this;
    }
    str(s: string): this {
        const pad = s.length % 2 ? 1 : 0;
        return this.u16(s.length + pad).bytes([...s].map((c) => c.charCodeAt(0)).concat(pad ? [0] : []));
    }
    bytes(a: number[]): this {
        this.b.push(...a);
        return this;
    }
    get u8(): Uint8Array {
        return Uint8Array.from(this.b);
    }
}

// A flat square (one quad) plus an apex and one triangle.
const POS: number[][] = [
    [0, 0, 0],
    [0, 0, 1],
    [1, 0, 1],
    [1, 0, 0],
    [0.5, 1, 0.5],
];

function pcModelFile(opts: { character?: boolean; shading?: number } = {}): Uint8Array {
    const id = 7;
    const name = new W().str('crate').u32(opts.shading ?? 0x8001).u8;
    const tex = new W().u32(2).u16(11).u16(0).u16(12).u16(2).u8;
    const v = new W().u16(POS.length);
    for (const p of POS) for (const x of p) v.f32(x);
    const poly = new W().u16(2);
    // quad (the PC flags carry editor bits in the high byte), texture 0
    poly.u16(0x9600).u16(4).u16(0);
    [0, 1, 2, 3].forEach((i, k) =>
        poly
            .u16(i)
            .f32(k)
            .f32(k + 0.5),
    );
    // triangle, texture 1
    poly.u16(0x8000).u16(3).u16(1);
    [1, 4, 2].forEach((i, k) =>
        poly
            .u16(i)
            .f32(k * 2)
            .f32(1),
    );
    const lod = new W().u16(9).f32(300).u8;
    const entries = [
        { type: 0x200, id, sub: 0, data: name },
        { type: 0x206, id, sub: 0, data: tex },
        { type: 0x203, id, sub: 0, data: v.u8 },
        { type: 0x204, id, sub: 0, data: poly.u8 },
        { type: 0x209, id, sub: 0, data: lod },
        { type: 0x207, id, sub: 0, data: Uint8Array.from({ length: 80 }, (_, i) => i) },
    ];
    if (opts.character) entries.push({ type: 0x208, id, sub: 0, data: new Uint8Array(70) });
    return writePs2Srsc(entries);
}

describe('PC model -> PS2 model', () => {
    it('parses the PC records', async () => {
        const r = await SrscReader.fromBytes(pcModelFile());
        expect(listPcModelIds(r)).toEqual([7]);
        const m = (await parsePcModel(r, 7))!;
        expect(m.name).toBe('crate');
        expect(m.textures).toEqual([
            { id: 11, db: 0 },
            { id: 12, db: 2 },
        ]);
        expect(m.polygons.map((p) => p.indices.length)).toEqual([4, 3]);
        expect(m.polygons[0]!.uvs[2]).toBe(1);
        expect(m.lodLinks).toEqual([{ id: 9, distance: 300 }]);
        expect(m.character).toBe(false);
        expect(await parsePcModel(r, 99)).toBeNull();
    });

    it('flags skinned models', async () => {
        const r = await SrscReader.fromBytes(pcModelFile({ character: true }));
        expect((await parsePcModel(r, 7))!.character).toBe(true);
    });

    it('converts to a model the PS2 parser reads', async () => {
        const pc = (await parsePcModel(await SrscReader.fromBytes(pcModelFile()), 7))!;
        const { model, stats } = pcToNeutral(pc, {
            mapTexture: (t) => ({ id: t.id + 100, db: 0 }),
            doubleSided: (t) => t.id === 112,
        });
        expect(stats).toMatchObject({ polygonsIn: 2, trianglesOut: 3, polygonsDropped: 0, flatToSmooth: true });
        expect(model.shading).toBe(0x8002);
        expect(model.polygons.map((p) => p.flags)).toEqual([0, 0, 2]);
        const file = buildPs2Mod([{ id: 2, model }]);
        const r = await SrscReader.fromBytes(file);
        const m = (await parseModel(r, 2))!;
        expect(m.name).toBe('crate');
        expect(m.textures).toEqual([
            { id: 111, db: 0 },
            { id: 112, db: 0 },
        ]);
        expect(m.indices.length / 3).toBe(3);
        expect(Array.from(m.indices.slice(0, 6))).toEqual([0, 1, 2, 0, 2, 3]);
        expect(Array.from(m.uvs.slice(0, 6))).toEqual([0, 0.5, 1, 1.5, 2, 2.5]);
        expect(Array.from(m.triTexture)).toEqual([0, 0, 1]);
        // The 0x0207 record is the PC record behind 8 zero bytes.
        const b = await r.readRaw(r.find(0x207, 2)!);
        expect(b.length).toBe(88);
        expect(Array.from(b.slice(0, 10))).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
    });

    it('keeps the PC double sided bit (flags & 2) of a polygon', async () => {
        const pc = (await parsePcModel(await SrscReader.fromBytes(pcModelFile()), 7))!;
        pc.polygons[0]!.flags |= 2;
        const { model } = pcToNeutral(pc, { mapTexture: (t) => ({ id: t.id, db: 0 }) });
        expect(model.polygons.map((p) => p.flags)).toEqual([2, 2, 0]);
    });

    it('drops polygons of unmapped textures and keeps quads on request', async () => {
        const pc = (await parsePcModel(await SrscReader.fromBytes(pcModelFile()), 7))!;
        const a = pcToNeutral(pc, { mapTexture: (t) => (t.id === 11 ? { id: 1, db: 0 } : null) });
        expect(a.stats.polygonsDropped).toBe(1);
        expect(a.model.textures).toHaveLength(1);
        const q = pcToNeutral(pc, { keepQuads: true }).model;
        expect(q.polygons.map((p) => [p.indices.length, p.flags])).toEqual([
            [4, 4],
            [3, 0],
        ]);
        // out-of-range vertex indices are dropped, not written
        pc.polygons[1]!.indices[0] = 99;
        expect(pcToNeutral(pc).stats.polygonsDropped).toBe(1);
    });

    it('points the PC bounds lists at the triangles a split quad or a dropped polygon left', async () => {
        const pc = (await parsePcModel(await SrscReader.fromBytes(pcModelFile()), 7))!;
        // PC hierarchy (no 8-byte prefix): a root over two leaves, the first listing PC polygon 1, the second polygon 0 (the quad)
        const pcb = new Uint8Array(68 + 3 * 4 + 50 + 52 + 52);
        const dv = new DataView(pcb.buffer);
        dv.setUint16(64, 3, true);
        dv.setUint16(66, 1, true);
        dv.setUint16(68, 1, true); // root: first child 1
        dv.setUint16(72 + 2, 2, true); // leaf 1: next sibling 2
        let o = 80 + 50;
        dv.setUint16(o + 48, 1, true);
        dv.setUint16(o + 50, 1, true);
        o += 52;
        dv.setUint16(o + 48, 1, true);
        dv.setUint16(o + 50, 0, true);
        pc.bounds = pcb;
        const lists = (m: { bounds: Uint8Array | null }) => parseObbHierarchy(m.bounds!)?.map((s) => s.polygons);
        // the quad became triangles 0 and 1, the triangle is now 2
        expect(lists(pcToNeutral(pc).model)).toEqual([[], [2], [0, 1]]);
        // with the triangle's texture unmapped it is gone and its leaf lists nothing
        const dropped = pcToNeutral(pc, { mapTexture: (t) => (t.id === 11 ? { id: 1, db: 0 } : null) });
        expect(dropped.stats.polygonsDropped).toBe(1);
        expect(lists(dropped.model)).toEqual([[], [], [0, 1]]);
    });

    it('computes unit normals in the PS2 sign convention', () => {
        const pos = Float32Array.from([0, 0, 0, 1, 0, 0, 0, 0, 1]);
        // PS2 stores the opposite sign of the counter-clockwise Newell normal (checked on the disc)
        expect(Array.from(computeNormals(pos, [{ indices: [0, 1, 2] }]).slice(0, 3))).toEqual([0, 127, 0]);
        expect(Array.from(computeNormals(pos, [{ indices: [0, 1, 2] }], false).slice(0, 3))).toEqual([0, -127, 0]);
        expect(Array.from(computeNormals(pos, []).slice(0, 3))).toEqual([0, 127, 0]); // unused vertex
    });
});

describe('PS2 model records', () => {
    it('re-writes 0x0200/0x0203/0x0204/0x0207 byte for byte', async () => {
        const name = new W()
            .u16(14)
            .bytes([...'Sound Detector'].map((c) => c.charCodeAt(0)))
            .u32(0x28002)
            .u32(2)
            .f32(49000)
            .u32(1)
            .u16(5)
            .u16(0).u8;
        const v = new W().u16(3);
        for (const p of POS.slice(0, 3)) for (const x of p) v.f32(x);
        v.bytes([127, 0, 0, 0x7f, 0, 127, 0, 0, 0, 0, 127, 0x7f]);
        const poly = new W().u16(2);
        poly.u16(2).u16(3).u16(0).u16(0).u16(1).u16(2); // 12 bytes
        poly.u16(0).u16(3).u16(0).u16(2).u16(1).u16(0); // ends at 26 = 2 mod 4: pad
        poly.u16(0);
        for (const [u, vv] of [
            [0, 0],
            [1, 0],
            [1, 1],
            [0, 0],
            [0, 1],
            [1, 1],
        ] as const)
            poly.f32(u).f32(vv);
        const bounds = new Uint8Array(96);
        bounds[9] = 0x3f;
        const file = writePs2Srsc([
            { type: 0x200, id: 3, sub: 0, data: name },
            { type: 0x203, id: 3, sub: 0, data: v.u8 },
            { type: 0x204, id: 3, sub: 0, data: poly.u8 },
            { type: 0x207, id: 3, sub: 0, data: bounds },
        ]);
        const r = await SrscReader.fromBytes(file);
        const n = (await readPs2Neutral(r, 3))!;
        expect(n.name).toBe('Sound Detector');
        expect(n.reserved).toBe(2);
        expect(n.polygons).toHaveLength(2);
        for (const rec of writePs2ModelRecords(n)) {
            const orig = await r.readRaw(r.find(rec.type, 3)!);
            expect(Array.from(rec.data), `0x${rec.type.toString(16)}`).toEqual(Array.from(orig));
        }
        expect(await readPs2Neutral(r, 4)).toBeNull();
    });

    it('synthesises bounds and sizes names to the 4-byte rule', async () => {
        const b = synthesizeBounds(Float32Array.from([0, 0, 0, 2, 4, 6]), 3);
        expect(b.length).toBe(8 + 64 + 8 + 48 + 2 + 6);
        const dv = new DataView(b.buffer);
        expect(dv.getFloat32(8 + 12, true)).toBeCloseTo(Math.hypot(2, 4, 6) / 2);
        expect(dv.getUint16(72, true)).toBe(1);
        const pc = (await parsePcModel(await SrscReader.fromBytes(pcModelFile()), 7))!;
        pc.name = 'odd'; // 3 chars -> 6 byte area, (2 + 6) % 4 == 0
        pc.bounds = null;
        const r = await SrscReader.fromBytes(buildPs2Mod([{ id: 2, model: pcToNeutral(pc).model }]));
        const raw = await r.readRaw(r.find(0x200, 2)!);
        expect(new DataView(raw.buffer, raw.byteOffset).getUint16(0, true) % 4).toBe(2);
        expect((await parseModel(r, 2))!.name).toBe('odd');
        expect(r.find(0x202, 0)).toBeDefined();
        expect(r.find(0x402, 0)).toBeDefined();
        expect(r.find(0x201, 1)).toBeDefined();
    });
});

describe('sphere-only collision hierarchy recognition', () => {
    const record = (count: number): Uint8Array => {
        const b = new Uint8Array(76 + count * 20);
        const dv = new DataView(b.buffer);
        dv.setUint16(72, count, true);
        for (let i = 0; i < count; i++) {
            if (i + 1 < count) dv.setUint16(76 + i * 4, i + 1, true);
            for (let k = 0; k < 4; k++) dv.setFloat32(76 + count * 4 + i * 16 + k * 4, k === 3 ? 2 : i + k, true);
        }
        return b;
    };
    it.each([0, 1, 3])('recognizes %i authored spheres including nonzero buffer offsets', (count) => {
        const b = record(count);
        const padded = new Uint8Array(b.length + 9);
        padded.set(b, 5);
        expect(sphereHierarchyCount(padded.subarray(5, 5 + b.length))).toBe(count);
    });
    it('rejects truncated, trailing, OBB, oversized-count and out-of-range hierarchy layouts', () => {
        const b = record(3);
        expect(sphereHierarchyCount(b.slice(0, 75))).toBeNull();
        expect(sphereHierarchyCount(b.slice(0, -1))).toBeNull();
        expect(sphereHierarchyCount(new Uint8Array([...b, 0]))).toBeNull();
        const mutate = (offset: number, value: number) => {
            const x = b.slice();
            new DataView(x.buffer).setUint16(offset, value, true);
            return x;
        };
        expect(sphereHierarchyCount(mutate(74, 1))).toBeNull();
        expect(sphereHierarchyCount(mutate(72, 0x8000))).toBeNull();
        expect(sphereHierarchyCount(mutate(76, 3))).toBeNull();
    });
    it.each([NaN, Infinity, -1])('rejects a non-finite or negative sphere radius %s', (radius) => {
        const b = record(1);
        new DataView(b.buffer).setFloat32(92, radius, true);
        expect(sphereHierarchyCount(b)).toBeNull();
    });
});

describe('OBB collision hierarchy kept for rebuilt polygons', () => {
    // A hollow tunnel shell: a root box over two wall boxes (x 0..1 and x 9..10), the space between them empty.
    const box = (x: number, w: number): number[] => [x, 0, 0, w, 0, 0, 0, 10, 0, 0, 0, 10];
    const record = (lists: number[][], root: number[] = []): Uint8Array => {
        const shapes = [
            { child: 1, sibling: 0, box: box(0, 10), polygons: root },
            { child: 0, sibling: 2, box: box(0, 1), polygons: lists[0]! },
            { child: 0, sibling: 0, box: box(9, 1), polygons: lists[1]! },
        ];
        const size = 76 + shapes.length * 4 + shapes.reduce((s, x) => s + 50 + x.polygons.length * 2, 0);
        const b = new Uint8Array(size);
        const dv = new DataView(b.buffer);
        dv.setUint16(72, shapes.length, true);
        dv.setUint16(74, 1, true);
        shapes.forEach((s, i) => {
            dv.setUint16(76 + i * 4, s.child, true);
            dv.setUint16(78 + i * 4, s.sibling, true);
        });
        let o = 76 + shapes.length * 4;
        for (const s of shapes) {
            s.box.forEach((v, k) => dv.setFloat32(o + k * 4, v, true));
            dv.setUint16(o + 48, s.polygons.length, true);
            s.polygons.forEach((p, k) => dv.setUint16(o + 50 + k * 2, p, true));
            o += 50 + s.polygons.length * 2;
        }
        return b;
    };
    // Triangles: two on the left wall (x 0.5), two on the right wall (x 9.5), in a new order (as after a quad split and a
    // display-list reorder), plus one just outside the right wall's box.
    const positions = Float32Array.from([0.5, 1, 1, 0.5, 2, 1, 0.5, 1, 2, 9.5, 1, 1, 9.5, 2, 1, 9.5, 1, 2, 10.5, 5, 5]);
    const tri = (a: number, b: number, c: number) => ({
        flags: 0,
        texture: 0,
        indices: [a, b, c],
        uvs: [0, 0, 0, 0, 0, 0],
    });
    const polygons = [tri(3, 4, 5), tri(0, 1, 2), tri(3, 5, 4), tri(0, 2, 1), tri(3, 4, 6)];

    it('parses the disc layout and rejects records that do not fit', () => {
        const b = record([[0], [1, 2]]);
        expect(parseObbHierarchy(b)?.map((s) => [s.child, s.sibling, s.polygons])).toEqual([
            [1, 0, []],
            [0, 2, [0]],
            [0, 0, [1, 2]],
        ]);
        expect(parseObbHierarchy(b.slice(0, -1))).toBeNull();
        expect(parseObbHierarchy(new Uint8Array([...b, 0, 0]))).toBeNull();
        const sphere = b.slice();
        new DataView(sphere.buffer).setUint16(74, 0, true);
        expect(parseObbHierarchy(sphere)).toBeNull();
    });

    it('keeps every shape and refills the leaf lists from the new polygons', () => {
        const out = rebuildObbHierarchy(
            record([
                [0, 1],
                [2, 3],
            ]),
            positions,
            polygons,
        )!;
        const shapes = parseObbHierarchy(out)!;
        expect(shapes.map((s) => [s.child, s.sibling, s.box])).toEqual([
            [1, 0, box(0, 10)],
            [0, 2, box(0, 1)],
            [0, 0, box(9, 1)],
        ]);
        expect(shapes.map((s) => s.polygons)).toEqual([[], [1, 3], [0, 2, 4]]);
    });

    it('lists the whole subtree again on an inner shape that listed polygons (the PC convention)', () => {
        const out = rebuildObbHierarchy(
            record(
                [
                    [0, 1],
                    [2, 3],
                ],
                [0, 1, 2, 3],
            ),
            positions,
            polygons,
        )!;
        expect(parseObbHierarchy(out)!.map((s) => s.polygons)).toEqual([
            [0, 1, 2, 3, 4],
            [1, 3],
            [0, 2, 4],
        ]);
    });

    it('leaves a model without an OBB hierarchy to the caller', () => {
        expect(rebuildObbHierarchy(record([[], []]), positions, polygons)).toBeNull();
        expect(rebuildObbHierarchy(synthesizeBounds(positions, 0).slice(0, 70), positions, polygons)).toBeNull();
    });
});
