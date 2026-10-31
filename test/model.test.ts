// Synthetic model fixtures only; no game bytes.
import { describe, expect, it } from 'vitest';
import {
    ModelError,
    SrscReader,
    findCharacterLods,
    parseModel,
    parseModelName,
    parseModelPolygons,
    parseModelVertices,
} from '../src/index.ts';
import { buildSrsc } from './fixtures.ts';

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
    i8(n: number): this {
        this.b.push(n & 255);
        return this;
    }
    str(s: string): this {
        return this.u16(s.length + 1).bytes([...s].map((c) => c.charCodeAt(0)).concat([0]));
    }
    bytes(a: number[]): this {
        this.b.push(...a);
        return this;
    }
    get u8(): Uint8Array {
        return Uint8Array.from(this.b);
    }
}

const nameRec = (shading = 0x8006, refs = [[5, 0]]): Uint8Array => {
    const w = new W().str('Box').u32(shading).u32(0);
    if (shading & 0x20000) w.f32(49000);
    w.u32(refs.length);
    for (const [id, db] of refs) w.u16(id!).u16(db!);
    return w.u8;
};

// A unit square (two triangles) plus one extra quad; positions then the signed-byte normal trailer.
const verts = (): Uint8Array => {
    const w = new W().u16(4);
    for (const [x, y, z] of [
        [-0.5, 0, -0.5],
        [0.5, 0, -0.5],
        [0.5, 1, 0.5],
        [-0.5, 1, 0.5],
    ] as const)
        w.f32(x).f32(y).f32(z);
    for (let i = 0; i < 4; i++) w.i8(0).i8(127).i8(0).i8(0x7f);
    return w.u8;
};

const polys = (): Uint8Array => {
    const w = new W().u16(2);
    w.u16(2).u16(3).u16(0).u16(0).u16(1).u16(2); // triangle, double sided
    w.u16(4).u16(4).u16(1).u16(0).u16(1).u16(2).u16(3); // quad -> 2 triangles; ends on 2 mod 4 => pad? (2+12+14=28 -> aligned)
    // 28 % 4 == 0: no pad
    for (let i = 0; i < 7; i++) w.f32(i / 10).f32(1 - i / 10);
    return w.u8;
};

describe('model records', () => {
    it('0x0200 with and without the optional distance float', () => {
        expect(parseModelName(nameRec()).textures).toEqual([{ id: 5, db: 0 }]);
        const m = parseModelName(
            nameRec(0x28000, [
                [7, 3],
                [8, 0],
            ]),
        );
        expect(m.distance).toBe(49000);
        expect(m.textures).toEqual([
            { id: 7, db: 3 },
            { id: 8, db: 0 },
        ]);
        expect(() => parseModelName(nameRec().subarray(0, 10))).toThrow(ModelError);
    });
    it('0x0203 vertices are an array of vect3f followed by a normal trailer', () => {
        const v = parseModelVertices(verts());
        expect(Array.from(v.positions.subarray(6, 9))).toEqual([0.5, 1, 0.5]);
        expect(v.normals[1]).toBeCloseTo(1, 5);
    });
    it('0x0204 triangles and quads (split), UVs per corner', () => {
        const p = parseModelPolygons(polys());
        expect(p.polygons).toBe(2);
        expect(p.quads).toBe(1);
        expect(p.triTexture.length).toBe(3);
        expect(Array.from(p.indices)).toEqual([0, 1, 2, 0, 1, 2, 0, 2, 3]);
        expect(Array.from(p.triTexture)).toEqual([0, 1, 1]);
        expect(Array.from(p.flags)).toEqual([2, 4, 4]);
        // quad second triangle uses corners 0, 2, 3 => polygon corner UVs 3, 5, 6
        expect(p.uvs[12]).toBeCloseTo(3 / 10);
        expect(p.uvs[14]).toBeCloseTo(5 / 10);
        expect(p.uvs[16]).toBeCloseTo(6 / 10);
    });
    it('0x0204 pads to 4 when the polygons end on 2 mod 4', () => {
        const w = new W().u16(1).u16(0).u16(3).u16(0).u16(0).u16(1).u16(2).u16(0); // 2+12 = 14 -> pad 2
        for (let i = 0; i < 3; i++) w.f32(0.25).f32(0.5);
        expect(parseModelPolygons(w.u8).uvs[1]).toBeCloseTo(0.5);
        expect(() => parseModelPolygons(w.u8.subarray(0, w.u8.length - 4))).toThrow(ModelError);
    });
});

describe('LOD table signature', () => {
    const lod = (d: number, fv: number, nv: number, fp: number, np: number): number[] =>
        Array.from(new W().u16(1).f32(d).u32(1).u32(0).u32(fv).u32(nv).u32(fp).u32(np).u8);
    it('finds a unique table whose ranges chain and cover all triangles', () => {
        const w = new W();
        for (let i = 0; i < 16; i++) w.u32(0); // 64 bytes of bounds
        w.u16(2).bytes([1, 2, 3, 4, 5]);
        w.bytes(lod(0, 0, 3, 0, 2))
            .bytes(lod(500, 3, 1, 2, 1))
            .bytes([9, 9]);
        const l = findCharacterLods(w.u8, 4, 3);
        expect(l.map((x) => [x.firstVertex, x.vertexCount, x.firstPoly, x.polyCount])).toEqual([
            [0, 3, 0, 2],
            [3, 1, 2, 1],
        ]);
        expect(findCharacterLods(w.u8, 4, 5)).toEqual([]);
    });
});

describe('parseModel', () => {
    const mod = async (withLods: boolean): Promise<SrscReader> => {
        const specs = [
            {
                type: 0x200,
                id: 9,
                sub: 0,
                data: nameRec(0x8006, [
                    [5, 0],
                    [6, 0],
                ]),
            },
            { type: 0x203, id: 9, sub: 0, data: verts() },
            { type: 0x204, id: 9, sub: 0, data: polys() },
        ];
        if (withLods) {
            const w = new W();
            for (let i = 0; i < 16; i++) w.u32(0);
            w.u16(2).bytes([0, 0]);
            // vertices 4 / triangles 3: LOD 0 = first two triangles over 3 vertices, LOD 1 = the last over 1
            const lod = (d: number, fv: number, nv: number, fp: number, np: number): number[] =>
                Array.from(new W().u16(1).f32(d).u32(1).u32(0).u32(fv).u32(nv).u32(fp).u32(np).u8);
            w.bytes(lod(0, 0, 3, 0, 2)).bytes(lod(500, 3, 1, 2, 1));
            specs.push({ type: 0x208, id: 9, sub: 0, data: w.u8 });
        }
        return SrscReader.fromBytes(buildSrsc(specs));
    };
    it('static model: bounds over all triangles', async () => {
        const m = (await parseModel(await mod(false), 9))!;
        expect(m.name).toBe('Box');
        expect(m.skinned).toBe(false);
        expect(m.bounds).toEqual({ min: [-0.5, 0, -0.5], max: [0.5, 1, 0.5] });
        expect(m.lod0).toEqual({ firstTri: 0, triCount: 3 });
        expect(await parseModel(await mod(false), 10)).toBeNull();
    });
    it('character model: LOD 0 selects its triangle range', async () => {
        const m = (await parseModel(await mod(true), 9))!;
        expect(m.skinned).toBe(true);
        expect(m.lods).toHaveLength(2);
        expect(m.lod0).toEqual({ firstTri: 0, triCount: 2 });
    });
});
