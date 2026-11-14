import { describe, expect, it } from 'vitest';
import { bridgeMesh } from '../src/ootfbridgemodel.ts';
import { palmCrownMesh } from '../src/ootfpalm.ts';
import { composeBody } from '../src/ootfpropcompose.ts';

type Poly = { flags: number; texture: number; indices: number[]; uvs: number[] };
const mesh = (pos: number[], polygons: Poly[]) => ({
    positions: Float32Array.from(pos),
    normals: new Int8Array(pos.length).map((_, i) => (i % 3 === 1 ? 127 : 0)),
    polygons,
});
const quad = (a: number, b: number, c: number, d: number, texture: number): Poly[] => [
    { flags: 0, texture, indices: [a, b, c], uvs: [0, 0, 1, 0, 1, 1] },
    { flags: 0, texture, indices: [a, c, d], uvs: [0, 0, 1, 1, 0, 1] },
];
const box = (pos: Float32Array, idx: Iterable<number>) => {
    const lo = [Infinity, Infinity, Infinity];
    const hi = [-Infinity, -Infinity, -Infinity];
    for (const i of idx)
        for (let k = 0; k < 3; k++) {
            lo[k] = Math.min(lo[k]!, pos[i * 3 + k]!);
            hi[k] = Math.max(hi[k]!, pos[i * 3 + k]!);
        }
    return { lo, hi };
};

describe('OotF props composed with Drakan 2 parts', () => {
    // a rope (texture 0) from y 1 down to 0.6 and a body (texture 1) from 0.6 down to 0
    const ootf = mesh(
        [0, 1, 0, 0.01, 1, 0, 0.01, 0.6, 0, 0, 0.6, 0, -0.1, 0.6, 0, 0.1, 0.6, 0, 0.1, 0, 0, -0.1, 0, 0],
        [...quad(0, 1, 2, 3, 0), ...quad(4, 5, 6, 7, 1)],
    );
    // a disc body twice as tall, standing on y 5
    const disc = mesh([0, 5, 0, 0.4, 5, 0, 0.4, 6.2, 0, 0, 6.2, 0], quad(0, 1, 2, 3, 0));

    it('keeps the other parts, puts the disc model where the body was, as tall, and moves its textures behind', () => {
        const r = composeBody(ootf, disc, 2, { replace: [1] });
        expect(r.positions.subarray(0, ootf.positions.length)).toEqual(ootf.positions); // OotF vertices first
        expect(r.polygons.filter((p) => p.texture === 0)).toHaveLength(2); // the rope stays
        expect(r.polygons.filter((p) => p.texture === 1)).toHaveLength(0); // the OotF body is gone
        const added = r.polygons.filter((p) => p.texture === 2);
        expect(added).toHaveLength(2);
        const b = box(r.positions, new Set(added.flatMap((p) => p.indices)));
        expect(b.lo[1]).toBeCloseTo(0, 5);
        expect(b.hi[1]).toBeCloseTo(0.6, 5);
        expect((b.lo[0]! + b.hi[0]!) / 2).toBeCloseTo(0, 5);
    });
    it('hangs the disc model from the replaced part top and folds it forward', () => {
        const top = composeBody(ootf, disc, 2, { replace: [1], align: 'top' });
        const ids = new Set(top.polygons.filter((p) => p.texture === 2).flatMap((p) => p.indices));
        expect(box(top.positions, ids).hi[1]).toBeCloseTo(0.6, 5);
        const tall = mesh(
            [0, 0, 0, 0.1, 0, 0, 0.1, 0.5, 0, 0, 0.5, 0, 0, 1, 0, 0.1, 1, 0],
            [...quad(0, 1, 2, 3, 0), ...quad(3, 2, 5, 4, 0)],
        );
        const bent = composeBody(ootf, tall, 2, { replace: [1], bend: { at: 0.5, angle: 90, band: 0 } });
        const n = ootf.positions.length / 3;
        // the upper half now points forward (+z): the top corners lie level with the hinge, in front of it
        const z4 = bent.positions[(n + 4) * 3 + 2]!;
        const z2 = bent.positions[(n + 2) * 3 + 2]!;
        expect(z4).toBeGreaterThan(z2);
        expect(bent.positions[(n + 4) * 3 + 1]!).toBeCloseTo(bent.positions[(n + 2) * 3 + 1]!, 5);
    });
    it('refuses a model without the replaced textures', () => {
        expect(() => composeBody(ootf, disc, 2, { replace: [7] })).toThrow();
    });
});

describe('OotF rope bridges in Drakan 2 style', () => {
    // a walkway 4 long (x) and 0.4 wide (z), top face (texture 0) at y 0, bottom face at -0.02, and one rope strip (texture 1)
    const pos = [0, 0, 0, 4, 0, 0, 4, 0, 0.4, 0, 0, 0.4, 0, -0.02, 0, 4, -0.02, 0, 4, -0.02, 0.4, 0, -0.02, 0.4];
    pos.push(0, 0.5, 0, 4, 0.5, 0, 4, 0.52, 0, 0, 0.52, 0);
    const piece = mesh(pos, [...quad(0, 3, 2, 1, 0), ...quad(4, 5, 6, 7, 0), ...quad(8, 9, 10, 11, 1)]);
    const r = bridgeMesh(piece, 2, { planks: [0], ropes: [1], plankTexture: 0, ropeTexture: 1 });

    it('lays boards on the walkway top, never above it or wider than it, with gaps between them', () => {
        const boards = r.polygons.filter((p) => p.texture === 2);
        expect(boards.length).toBeGreaterThan(40);
        const b = box(r.positions, new Set(boards.flatMap((p) => p.indices)));
        expect(b.hi[1]).toBeLessThanOrEqual(1e-6);
        expect(b.hi[1]).toBeGreaterThan(-1e-6);
        expect(b.lo[2]).toBeGreaterThanOrEqual(-1e-6);
        expect(b.hi[2]).toBeLessThanOrEqual(0.4 + 1e-6);
        // board tops cover most of the walkway, not all of it
        const tops = boards.filter((p) => p.indices.every((v) => Math.abs(r.positions[v * 3 + 1]!) < 1e-6));
        let area = 0;
        for (const t of tops) {
            const [a, bb, c] = t.indices.map((v) => [r.positions[v * 3]!, r.positions[v * 3 + 2]!]) as [
                number[],
                number[],
                number[],
            ];
            area += Math.abs((bb[0]! - a[0]!) * (c[1]! - a[1]!) - (c[0]! - a[0]!) * (bb[1]! - a[1]!)) / 2;
        }
        expect(area / (4 * 0.4)).toBeGreaterThan(0.7);
        expect(area / (4 * 0.4)).toBeLessThan(0.95);
    });
    it('turns the rope strip into a round rope with the disc rope texture and drops the flat OotF walkway and rope', () => {
        expect(r.polygons.some((p) => p.texture === 0 || p.texture === 1)).toBe(false);
        const rope = r.polygons.filter((p) => p.texture === 3);
        expect(rope.length).toBeGreaterThan(12);
        const ids = new Set(rope.flatMap((p) => p.indices));
        const b = box(r.positions, ids);
        expect(b.hi[2]! - b.lo[2]!).toBeGreaterThan(0.005); // round, not flat
        expect(r.positions.subarray(0, piece.positions.length)).toEqual(piece.positions);
    });
    it('winds every new triangle clockwise seen from its normals (the disc convention)', () => {
        for (const p of r.polygons) {
            const P = (v: number) => [0, 1, 2].map((k) => r.positions[v * 3 + k]!);
            const [a, b, c] = p.indices.map(P) as [number[], number[], number[]];
            const u = [b[0]! - a[0]!, b[1]! - a[1]!, b[2]! - a[2]!];
            const w = [c[0]! - a[0]!, c[1]! - a[1]!, c[2]! - a[2]!];
            const f = [u[1]! * w[2]! - u[2]! * w[1]!, u[2]! * w[0]! - u[0]! * w[2]!, u[0]! * w[1]! - u[1]! * w[0]!];
            const n = [0, 1, 2].map((k) => p.indices.reduce((s, v) => s + r.normals[v * 3 + k]!, 0));
            expect(f[0]! * n[0]! + f[1]! * n[1]! + f[2]! * n[2]!).toBeLessThanOrEqual(1e-9);
        }
    });
});

describe('fuller palm crowns', () => {
    it('keeps every frond and adds a second, turned ring; the trunk is rounded', () => {
        // trunk: two faces of a post (texture 0) from y 0 to 2, two fronds (texture 1, with holes) at the top
        const pos = [-0.1, 0, -0.1, 0.1, 0, -0.1, 0.1, 2, -0.1, -0.1, 2, -0.1, 0.1, 0, 0.1, 0.1, 2, 0.1];
        pos.push(0, 2, 0, 1, 2, 0, 1, 2.1, 0.2, 0, 2, 0, -1, 2, 0, -1, 2.1, -0.2);
        const palm = mesh(pos, [
            ...quad(0, 1, 2, 3, 0),
            ...quad(1, 4, 5, 2, 0),
            { flags: 2, texture: 1, indices: [6, 7, 8], uvs: [0, 0, 1, 0, 1, 1] },
            { flags: 2, texture: 1, indices: [9, 10, 11], uvs: [0, 0, 1, 0, 1, 1] },
        ]);
        const r = palmCrownMesh(palm, (t) => t === 1);
        const fronds = r.polygons.filter((p) => p.texture === 1);
        expect(fronds).toHaveLength(4);
        expect(fronds.every((p) => p.flags === 2)).toBe(true);
        expect(r.polygons.filter((p) => p.texture === 0).length).toBeGreaterThan(4); // subdivided trunk
        // the second ring is turned: its tips are not where the first ring's are
        const tip = (p: { indices: number[] }) => [
            r.positions[p.indices[1]! * 3]!,
            r.positions[p.indices[1]! * 3 + 2]!,
        ];
        expect(tip(fronds[2]!)).not.toEqual(tip(fronds[0]!));
    });
});
