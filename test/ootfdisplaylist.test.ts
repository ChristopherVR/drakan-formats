// Synthetic fixtures only; no game bytes.
import { describe, expect, it } from 'vitest';
import {
    buildDisplayList,
    decodeDisplayList,
    DisplayListError,
    expandTriangles,
    remapSkeletonVertices,
    withDisplayList,
} from '../src/ootfdisplaylist.ts';
import type { Skeleton } from '../src/ootfanim.ts';
import type { NeutralModel, NeutralPoly } from '../src/ootfmodel.ts';

const key = (t: number, v: number[]): string => `${t}:${[...v].sort((a, b) => a - b).join(',')}`;

function grid(n: number, texture = 0, offset = 0): { positions: number[]; polygons: NeutralPoly[] } {
    // (n+1)^2 vertices, 2 n^2 triangles
    const positions: number[] = [];
    for (let y = 0; y <= n; y++) for (let x = 0; x <= n; x++) positions.push(x, y, 0);
    const polygons: NeutralPoly[] = [];
    const id = (x: number, y: number): number => offset + y * (n + 1) + x;
    const uv = (x: number, y: number): number[] => [x / n, y / n];
    for (let y = 0; y < n; y++) {
        for (let x = 0; x < n; x++) {
            polygons.push({
                flags: 0,
                texture,
                indices: [id(x, y), id(x + 1, y), id(x, y + 1)],
                uvs: [...uv(x, y), ...uv(x + 1, y), ...uv(x, y + 1)],
            });
            polygons.push({
                flags: 0,
                texture,
                indices: [id(x + 1, y), id(x + 1, y + 1), id(x, y + 1)],
                uvs: [...uv(x + 1, y), ...uv(x + 1, y + 1), ...uv(x, y + 1)],
            });
        }
    }
    return { positions, polygons };
}

function model(
    parts: { positions: number[]; polygons: NeutralPoly[] }[],
): Pick<NeutralModel, 'positions' | 'polygons'> {
    return {
        positions: Float32Array.from(parts.flatMap((p) => p.positions)),
        polygons: parts.flatMap((p) => p.polygons),
    };
}

function triangleSet(polys: readonly NeutralPoly[]): Map<string, number> {
    const m = new Map<string, number>();
    for (const p of polys) {
        for (let k = 1; k + 1 < p.indices.length; k++) {
            const kk = key(p.texture, [p.indices[0]!, p.indices[k]!, p.indices[k + 1]!]);
            m.set(kk, (m.get(kk) ?? 0) + 1);
        }
    }
    return m;
}

describe('0x0211 decoder', () => {
    it('reads a hand-built list: one group of 4 vertices, one strip with a UV per element', () => {
        const b: number[] = [];
        const u32 = (n: number): void => void b.push(n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255);
        const f32 = (n: number): void => {
            const d = new DataView(new ArrayBuffer(4));
            d.setFloat32(0, n, true);
            for (let i = 0; i < 4; i++) b.push(d.getUint8(i));
        };
        u32(1);
        u32(1);
        u32(0);
        u32(4); // group count
        u32(1); // batch count
        u32(7); // texture of the first batch
        u32(1); // one group load
        b.push(0, 0); // group 0 at slot 0
        u32(2); // triangles
        u32(64); // cap
        const stream = [1, 2, 3, 4, 0];
        for (let i = 0; i < 64; i++) b.push(stream[i] ?? 0);
        u32(64);
        for (let i = 0; i < 64; i++) {
            f32(i < 4 ? i * 0.25 : 0);
            f32(i < 4 ? 1 - i * 0.25 : 0);
        }
        u32(0);
        const dl = decodeDisplayList(Uint8Array.from(b));
        expect(dl.tail).toBe(0);
        expect(dl.groups).toEqual([{ count: 4, start: 0 }]);
        expect(dl.batches).toHaveLength(1);
        expect(dl.batches[0]!.texture).toBe(7);
        expect(dl.batches[0]!.triangles).toBe(2);
        const t = expandTriangles(dl);
        // strip parity: triangle 1 is drawn (e1, e0, e2)
        expect(t.map((x) => x.vertices)).toEqual([
            [0, 1, 2],
            [2, 1, 3],
        ]);
        expect(t[1]!.u).toEqual([0.5, 0.25, 0.75]);
    });

    it('rejects a damaged header and truncation', () => {
        expect(() => decodeDisplayList(new Uint8Array(12))).toThrow(DisplayListError);
        const m = model([grid(2)]);
        const rec = buildDisplayList(m).record;
        expect(() => decodeDisplayList(rec.subarray(0, rec.length - 100))).toThrow(DisplayListError);
    });
});

describe('0x0211 encoder', () => {
    it('counts internal block padding when flushing a batch and retains its vertex window', () => {
        const quad = grid(1);
        const polygons = Array.from({ length: 85 }, (_, i) =>
            quad.polygons.map((p) => ({ ...p, uvs: p.uvs.map((v) => v + i * 4) })),
        ).flat();
        const out = buildDisplayList({ positions: Float32Array.from(quad.positions), polygons }, { sameWinding: true });
        const dl = decodeDisplayList(out.record);
        // 85 four-element strips plus terminators fit 448 without padding; the native 64-element blocks do not.
        expect(dl.batches).toHaveLength(2);
        expect(dl.batches.map((b) => b.triangles)).toEqual([168, 2]);
        expect(dl.batches[0]!.loads).toEqual([{ group: 0, slot: 0 }]);
        expect(dl.batches[1]!.loads).toEqual([]);
        const triangles = expandTriangles(dl);
        expect(triangles).toHaveLength(170);
        expect(triangles.flatMap((t) => t.u).sort((a, b) => a - b)).toEqual(
            polygons.flatMap((p) => p.indices.map((_, i) => p.uvs[i * 2]!)).sort((a, b) => a - b),
        );
    });

    it.each([false, true])(
        'bounds long strips without changing oriented triangles or UVs (same winding %s)',
        (sameWinding) => {
            const oriented = (vertices: number[], u: number[], v: number[]): string => {
                const corners = vertices.map((vertex, i) => `${vertex}:${u[i]}:${v[i]}`);
                return corners.map((_, i) => [...corners.slice(i), ...corners.slice(0, i)].join('/')).sort()[0]!;
            };
            for (const count of [30, 31, 32, 58, 59, 86, 222]) {
                const positions = Float32Array.from(Array.from({ length: count }, (_, i) => [i >> 1, i % 2, 0]).flat());
                const polygons: NeutralPoly[] = Array.from({ length: count - 2 }, (_, i) => {
                    const indices = i % 2 ? [i + 1, i, i + 2] : [i, i + 1, i + 2];
                    if (!sameWinding) indices.reverse();
                    return { flags: 0, texture: 0, indices, uvs: indices.flatMap((v) => [v / 128, (v % 2) / 2]) };
                });
                const out = buildDisplayList({ positions, polygons }, { sameWinding });
                const dl = decodeDisplayList(out.record);
                const raw = new DataView(out.record.buffer, out.record.byteOffset, out.record.byteLength);
                let at = 12 + (2 * raw.getUint32(4, true) - 1) * 4;
                const batches = raw.getUint32(at, true);
                at += 8;
                for (let batch = 0; batch < batches; batch++) {
                    at += 4 + raw.getUint32(at, true) * 2;
                    const cap = raw.getUint32(at + 4, true);
                    at += 8;
                    expect(cap).toBeLessThanOrEqual(448);
                    let start = -1;
                    for (let i = 0; i < cap; i++) {
                        if (out.record[at + i]) {
                            if (start < 0) start = i;
                        } else {
                            if (start >= 0) expect(Math.floor(i / 64)).toBe(Math.floor(start / 64));
                            start = -1;
                            expect(raw.getFloat32(at + cap + 4 + i * 8, true)).toBe(0);
                            expect(raw.getFloat32(at + cap + 8 + i * 8, true)).toBe(0);
                        }
                    }
                    expect(start).toBe(-1);
                    at += cap + 4 + cap * 8 + 4;
                }
                const strips = dl.batches.flatMap((b) => b.strips);
                expect(Math.max(...strips.map((s) => s.slots.length))).toBe(30);
                expect(strips).toHaveLength(Math.ceil((count - 2) / 28));
                const actual = expandTriangles(dl)
                    .map((t) => oriented(t.vertices, t.u, t.v))
                    .sort();
                const expected = polygons
                    .map((p) => {
                        const order = sameWinding ? [0, 1, 2] : [2, 1, 0];
                        return oriented(
                            order.map((i) => p.indices[i]!),
                            order.map((i) => p.uvs[i * 2]!),
                            order.map((i) => p.uvs[i * 2 + 1]!),
                        );
                    })
                    .sort();
                expect(actual).toEqual(expected);
            }
        },
    );

    it('round-trips a small two texture model through the decoder', () => {
        const m = model([grid(3, 0), grid(2, 1, 16)]);
        const out = buildDisplayList(m);
        expect(out.groups).toBe(1);
        expect(out.source.length % 4).toBe(0);
        expect([...out.source.subarray(0, 25)]).toEqual([...Array(25).keys()]);
        const dl = decodeDisplayList(out.record);
        expect(dl.tail).toBe(0);
        expect(dl.groups[0]).toEqual({ count: 25, start: 0 });
        expect(dl.batches.map((b) => b.texture)).toEqual([0, 1]);
        expect(dl.batches[0]!.loads).toEqual([{ group: 0, slot: 0 }]);
        expect(dl.batches[1]!.loads).toEqual([]);
        const got = new Map<string, number>();
        for (const t of expandTriangles(dl))
            got.set(key(t.texture, t.vertices), (got.get(key(t.texture, t.vertices)) ?? 0) + 1);
        expect(got).toEqual(triangleSet(m.polygons));
    });

    it('uses strips, aligns capacities to 64 and counts triangles like the disc', () => {
        const m = model([grid(6)]);
        const out = buildDisplayList(m);
        const dl = decodeDisplayList(out.record);
        for (const b of dl.batches) {
            expect(b.triangles).toBe(b.strips.reduce((a, s) => a + s.slots.length - 2, 0));
        }
        const elements = dl.batches.reduce((a, b) => a + b.strips.reduce((x, s) => x + s.slots.length + 1, 0), 0);
        expect(elements).toBeLessThan(m.polygons.length * 4); // not one strip per triangle
        expect((out.record.length - 12 - 4 - 8) % 2).toBe(0);
    });

    it('keeps the UV of every corner and winds strips opposite to the polygons', () => {
        const m = model([grid(2)]);
        const dl = decodeDisplayList(buildDisplayList(m).record);
        const want = new Map<string, number[]>();
        for (const p of m.polygons) want.set(key(0, p.indices), [...p.uvs]);
        for (const t of expandTriangles(dl)) {
            const poly = m.polygons.find((p) => key(0, p.indices) === key(0, t.vertices))!;
            // drawn order is the reverse of the polygon winding: same cyclic order read backwards
            const i0 = poly.indices.indexOf(t.vertices[0]);
            expect(poly.indices[(i0 + 2) % 3]).toBe(t.vertices[1]);
            for (let k = 0; k < 3; k++) {
                const pk = poly.indices.indexOf(t.vertices[k]!);
                expect(t.u[k]).toBeCloseTo(poly.uvs[pk * 2]!, 6);
                expect(t.v[k]).toBeCloseTo(poly.uvs[pk * 2 + 1]!, 6);
            }
        }
        expect(want.size).toBe(8);
    });

    it('can wind strips like the polygons', () => {
        const m = model([grid(3)]);
        const dl = decodeDisplayList(buildDisplayList(m, { sameWinding: true }).record);
        const tris = expandTriangles(dl);
        expect(tris).toHaveLength(m.polygons.length);
        for (const t of tris) {
            const poly = m.polygons.find((p) => key(0, p.indices) === key(0, t.vertices))!;
            const i0 = poly.indices.indexOf(t.vertices[0]);
            expect(poly.indices[(i0 + 1) % 3]).toBe(t.vertices[1]);
        }
    });

    it('does not join triangles whose shared corner has a different UV (texture seam)', () => {
        const polygons: NeutralPoly[] = [
            { flags: 0, texture: 0, indices: [0, 1, 2], uvs: [0, 0, 1, 0, 0, 1] },
            { flags: 0, texture: 0, indices: [1, 3, 2], uvs: [1, 0, 1, 1, 0.5, 0.5] },
        ];
        const m = { positions: Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0]), polygons };
        const dl = decodeDisplayList(buildDisplayList(m).record);
        expect(dl.batches[0]!.strips).toHaveLength(2);
        const tris = expandTriangles(dl);
        for (const t of tris) {
            const poly = polygons.find((p) => key(0, p.indices) === key(0, t.vertices))!;
            for (let k = 0; k < 3; k++) {
                const pk = poly.indices.indexOf(t.vertices[k]!);
                expect(t.u[k]).toBeCloseTo(poly.uvs[pk * 2]!, 6);
                expect(t.v[k]).toBeCloseTo(poly.uvs[pk * 2 + 1]!, 6);
            }
        }
    });

    it('splits quads into two triangles', () => {
        const polygons: NeutralPoly[] = [
            { flags: 4, texture: 0, indices: [0, 1, 3, 2], uvs: [0, 0, 1, 0, 1, 1, 0, 1] },
        ];
        const m = { positions: Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0]), polygons };
        const dl = decodeDisplayList(buildDisplayList(m).record);
        expect(expandTriangles(dl)).toHaveLength(2);
    });

    it('splits a model larger than the vertex window into copied groups', () => {
        const m = model([grid(12, 0), grid(5, 1, 169)]); // 169 + 36 vertices
        const out = buildDisplayList(m, { maxWindow: 60 });
        expect(out.groups).toBeGreaterThan(2);
        expect(out.source.length % 4).toBe(0);
        const dl = decodeDisplayList(out.record);
        expect(Math.max(...dl.groups.map((g) => g.count))).toBeLessThanOrEqual(60);
        // every group starts on a multiple of 4 and groups do not overlap
        let end = 0;
        for (const g of dl.groups) {
            expect(g.start % 4).toBe(0);
            expect(g.start).toBeGreaterThanOrEqual(end);
            end = g.start + g.count;
        }
        expect(end).toBeLessThanOrEqual(out.source.length);
        // the stream resolves to the new polygons and, through `source`, to the input triangles
        const got = new Map<string, number>();
        const viaSource = new Map<string, number>();
        for (const t of expandTriangles(dl)) {
            const a = key(t.texture, t.vertices);
            got.set(a, (got.get(a) ?? 0) + 1);
            const b = key(
                t.texture,
                t.vertices.map((v) => out.source[v]!),
            );
            viaSource.set(b, (viaSource.get(b) ?? 0) + 1);
        }
        expect(got).toEqual(triangleSet(out.polygons));
        expect(viaSource).toEqual(triangleSet(m.polygons));
        // all batches load a group before their strips use it
        expect(dl.batches.every((b) => b.loads.length === 1 || b.loads.length === 0)).toBe(true);
        expect(dl.batches[0]!.loads).toHaveLength(1);
    });

    it('skinned models: every vertex exists once, groups are joint clusters, a batch loads the groups it touches', () => {
        const m = model([grid(14, 0), grid(4, 1, 225)]); // 225 + 25 vertices
        const nv = m.positions.length / 3;
        const vertexJoints = (v: number): number[] => [Math.floor(v / 40)];
        const out = buildDisplayList(m, { maxWindow: 100, vertexJoints, maxGroup: 40, maxJoints: 4 });
        const real = [...out.source].filter((x) => x >= 0);
        expect(real).toHaveLength(nv);
        expect(new Set(real).size).toBe(nv); // a permutation, nothing copied
        expect(out.polygons).toHaveLength(m.polygons.length); // quads and order kept
        expect(out.source.length % 4).toBe(0);
        const dl = decodeDisplayList(out.record);
        expect(dl.groups.length).toBeGreaterThan(3);
        for (const g of dl.groups) {
            expect(g.start % 4).toBe(0);
            expect(g.count).toBeLessThanOrEqual(40);
        }
        const viaSource = new Map<string, number>();
        for (const t of expandTriangles(dl)) {
            const k = key(
                t.texture,
                t.vertices.map((v) => out.source[v]!),
            );
            viaSource.set(k, (viaSource.get(k) ?? 0) + 1);
        }
        expect(viaSource).toEqual(triangleSet(m.polygons));
        // several groups are loaded before one batch, packed from slot 0 without gaps
        const multi = dl.batches.find((b) => b.loads.length > 1)!;
        expect(multi).toBeDefined();
        let slot = 0;
        for (const l of multi.loads) {
            expect(l.slot).toBe(slot);
            slot += dl.groups[l.group]!.count;
        }
        expect(slot).toBeLessThanOrEqual(100);
    });

    it('remapSkeletonVertices gives every copy the weights of its source and sorts the lists', () => {
        const sk = {
            platform: 'ps2',
            bounds: new Uint8Array(0),
            lodNames: [],
            nodes: [],
            totalVertices: 3,
            joints: [
                {
                    xform: [],
                    mesh: 0,
                    firstChild: -1,
                    nextSibling: -1,
                    weights: [
                        [
                            { vertex: 0, weight: 1 },
                            { vertex: 2, weight: 0.5 },
                        ],
                    ],
                },
                { xform: [], mesh: 0, firstChild: -1, nextSibling: -1, weights: [[{ vertex: 2, weight: 0.5 }]] },
            ],
            lods: [{ distance: 0, usage: 1, node: 0, firstVertex: 0, vertexCount: 3, firstPoly: 0, polyCount: 5 }],
            animIds: [],
            channels: [],
            spheres: [],
            spheresPerLod: [],
        } as unknown as Skeleton;
        const r = remapSkeletonVertices(sk, Int32Array.from([2, -1, 0, 2]), 9);
        expect(r.totalVertices).toBe(4);
        expect(r.joints[0]!.weights[0]).toEqual([
            { vertex: 0, weight: 0.5 },
            { vertex: 2, weight: 1 },
            { vertex: 3, weight: 0.5 },
        ]);
        expect(r.joints[1]!.weights[0]!.map((w) => w.vertex)).toEqual([0, 3]);
        expect(r.lods[0]).toMatchObject({ vertexCount: 4, polyCount: 9, firstVertex: 0 });
    });

    it('rejects out of range vertices and empty models', () => {
        const bad = {
            positions: new Float32Array(9),
            polygons: [{ flags: 0, texture: 0, indices: [0, 1, 5], uvs: [0, 0, 0, 0, 0, 0] }],
        };
        expect(() => buildDisplayList(bad)).toThrow(DisplayListError);
        expect(() => buildDisplayList({ positions: new Float32Array(9), polygons: [] })).toThrow(DisplayListError);
    });

    it('withDisplayList carries positions, normals and polygons into the padded layout', () => {
        const g = grid(2);
        const nv = g.positions.length / 3;
        const normals = new Int8Array(nv * 3).map((_, i) => (i % 3 === 2 ? 127 : 0));
        const m: NeutralModel = {
            name: 'T',
            shading: 0,
            distance: null,
            textures: [],
            positions: Float32Array.from(g.positions),
            normals,
            polygons: g.polygons,
            bounds: null,
        };
        const w = withDisplayList(m);
        expect(w.model.positions.length / 3).toBe(12); // 9 padded to a multiple of 4
        expect(w.model.positions.subarray(0, nv * 3)).toEqual(m.positions);
        expect([...w.model.positions.subarray(nv * 3)].every((x) => x === 0)).toBe(true);
        expect(w.model.normals[2]).toBe(127);
        expect(w.model.polygons).toEqual(g.polygons);
        expect(w.model.normalW![0]).toBe(0x7f);
        expect(w.model.normalW![nv]).toBe(0);
    });
});
