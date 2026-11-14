// New PS2-style drawings for OotF props without a Drakan 2 model (ootfpropremake.ts). Synthetic fixtures only: no game data.
import { describe, expect, it } from 'vitest';
import { lightBeamMesh, smoothSubdivide, unswitchedEmitters } from '../src/ootfpropremake.ts';
import {
    DEFAULT_PS2_MODEL_SUBSTITUTIONS,
    effectiveModelSubstitutions,
    planPs2Models,
    ps2ModelSwapFromEdits,
} from '../src/ootfps2model.ts';
import { withDisplayList } from '../src/ootfdisplaylist.ts';

interface Poly {
    flags: number;
    texture: number;
    indices: number[];
    uvs: number[];
}

/** An n-sided prism round the Y axis (radius 1, height h), with flat caps when `caps`; normals point outwards. */
function prism(n: number, h: number, caps: boolean, rings = 1) {
    const pos: number[] = [];
    const nrm: number[] = [];
    const polygons: Poly[] = [];
    for (let j = 0; j <= rings; j++)
        for (let s = 0; s < n; s++) {
            const a = (s / n) * Math.PI * 2;
            pos.push(Math.sin(a), (h * j) / rings, Math.cos(a));
            nrm.push(Math.round(Math.sin(a) * 127), 0, Math.round(Math.cos(a) * 127));
        }
    for (let j = 0; j < rings; j++)
        for (let s = 0; s < n; s++) {
            const a = j * n + s;
            const b = j * n + ((s + 1) % n);
            polygons.push({
                flags: 0,
                texture: 0,
                indices: [a, a + n, b + n, b],
                uvs: [s / n, j / rings, s / n, (j + 1) / rings, (s + 1) / n, (j + 1) / rings, (s + 1) / n, j / rings],
            });
        }
    if (caps) {
        const top = Array.from({ length: n }, (_, s) => rings * n + s);
        const bottom = Array.from({ length: n }, (_, s) => n - 1 - s);
        polygons.push({ flags: 0, texture: 1, indices: top, uvs: top.flatMap(() => [0, 0]) });
        polygons.push({ flags: 0, texture: 1, indices: bottom, uvs: bottom.flatMap(() => [0, 0]) });
    }
    return { positions: Float32Array.from(pos), normals: Int8Array.from(nrm), polygons, bounds: null };
}

const radii = (m: { positions: Float32Array }, y0: number, y1: number) => {
    const out: number[] = [];
    for (let i = 0; i < m.positions.length / 3; i++) {
        const y = m.positions[i * 3 + 1]!;
        if (y > y0 && y < y1) out.push(Math.hypot(m.positions[i * 3]!, m.positions[i * 3 + 2]!));
    }
    return out;
};

describe('smoothed PS2-style remakes', () => {
    it('rounds an octagonal pillar, keeps its flat caps and its textures, and draws as a display list', () => {
        const m = prism(8, 4, true, 2);
        const r = smoothSubdivide(m);
        expect(r.polygons.length).toBeGreaterThan(m.polygons.length * 8);
        // the shaft's cross-section is rounder: an octagon's points lie between cos 22.5 degrees and 1 of its radius
        const after = radii(r, 0.5, 3.5);
        expect(Math.max(...after) - Math.min(...after)).toBeLessThan((1 - Math.cos(Math.PI / 8)) / 2);
        expect(Math.max(...after)).toBeLessThan(1);
        // the caps stay flat at their heights (the edge between cap and shaft is sharp)
        for (const q of r.polygons.filter((p) => p.texture === 1))
            for (const i of q.indices) expect([0, 4]).toContain(Math.round(r.positions[i * 3 + 1]! * 1000) / 1000);
        expect(new Set(r.polygons.map((p) => p.texture))).toEqual(new Set([0, 1]));
        // normals follow the input's facing (outwards) and the model still builds a display list
        let out = 0;
        for (let i = 0; i < r.positions.length / 3; i++)
            if (r.positions[i * 3 + 1]! > 1 && r.positions[i * 3 + 1]! < 3)
                out += r.positions[i * 3]! * r.normals[i * 3]! + r.positions[i * 3 + 2]! * r.normals[i * 3 + 2]!;
        expect(out).toBeGreaterThan(0);
        expect(() => withDisplayList({ ...r, name: 'x', textures: [], shading: 0, distance: null })).not.toThrow();
    });

    it('keeps the open borders of a corridor module exactly in place with fixBorders', () => {
        const m = prism(12, 2, false);
        const r = smoothSubdivide(m, { fixBorders: true });
        // every vertex on the bottom and top border lies on the input's border polygon (on a straight edge of it)
        const corners = Array.from({ length: 12 }, (_, s) => [
            Math.sin((s / 12) * Math.PI * 2),
            Math.cos((s / 12) * Math.PI * 2),
        ]);
        const onEdge = (x: number, z: number) =>
            corners.some((a, s) => {
                const b = corners[(s + 1) % 12]!;
                const cr = (b[0]! - a[0]!) * (z - a[1]!) - (b[1]! - a[1]!) * (x - a[0]!);
                return Math.abs(cr) < 1e-4;
            });
        let border = 0;
        for (let i = 0; i < r.positions.length / 3; i++) {
            const y = r.positions[i * 3 + 1]!;
            if (Math.abs(y) < 1e-6 || Math.abs(y - 2) < 1e-6) {
                border++;
                expect(onEdge(r.positions[i * 3]!, r.positions[i * 3 + 2]!)).toBe(true);
            }
        }
        expect(border).toBeGreaterThan(12);
        // without fixBorders the border curves inwards
        const free = smoothSubdivide(m);
        expect(Math.min(...radii(free, -1, 0.001))).toBeLessThan(Math.min(...radii(r, -1, 0.001)) - 1e-3);
    });

    it('keeps the corners of a square open border (a base slab) without fixBorders', () => {
        // a flat 2 x 2 slab of four quads round a raised centre: the border turns 90 degrees at its corners
        const pos = [-1, 0, -1, 0, 0, -1, 1, 0, -1, -1, 0, 0, 0, 0.2, 0, 1, 0, 0, -1, 0, 1, 0, 0, 1, 1, 0, 1];
        const quad = (a: number, b: number, c: number, d: number): Poly => ({
            flags: 0,
            texture: 0,
            indices: [a, d, c, b],
            uvs: [0, 0, 0, 1, 1, 1, 1, 0],
        });
        const m = {
            positions: Float32Array.from(pos),
            normals: Int8Array.from(pos.map((_, i) => (i % 3 === 1 ? 127 : 0))),
            polygons: [quad(0, 1, 4, 3), quad(1, 2, 5, 4), quad(3, 4, 7, 6), quad(4, 5, 8, 7)],
            bounds: null,
        };
        const r = smoothSubdivide(m);
        for (const [x, z] of [
            [-1, -1],
            [1, -1],
            [-1, 1],
            [1, 1],
        ]) {
            let found = false;
            for (let i = 0; i < r.positions.length / 3; i++)
                if (Math.abs(r.positions[i * 3]! - x!) < 1e-6 && Math.abs(r.positions[i * 3 + 2]! - z!) < 1e-6)
                    found = true;
            expect(found).toBe(true);
        }
    });

    it('leaves the polygons of kept textures where they were', () => {
        const m = prism(8, 4, true, 2);
        const r = smoothSubdivide(m, { keepTextures: [0] });
        // the kept shaft is split flat: its corners stay at radius 1, every point on the octagon's faces
        const after = radii(r, 0.5, 3.5);
        expect(Math.max(...after)).toBeCloseTo(1, 5);
        expect(Math.min(...after)).toBeGreaterThan(Math.cos(Math.PI / 8) - 1e-6);
        expect(() => smoothSubdivide(m, { keepTextures: [0, 1] })).toThrow();
    });
});

describe('rebuilt light beam', () => {
    it('draws two nested 32-sided shafts with the beam texture, inside the beam height and halo radius', () => {
        const m = prism(16, 12, false);
        m.positions.forEach((v, i) => (m.positions[i] = i % 3 === 1 ? v : v * 0.5));
        const r = lightBeamMesh(m);
        expect(r.polygons.length).toBe(2 * 32 * 6);
        let maxR = 0;
        for (let i = 0; i < r.positions.length / 3; i++) {
            expect(r.positions[i * 3 + 1]!).toBeGreaterThanOrEqual(-1e-6);
            expect(r.positions[i * 3 + 1]!).toBeLessThanOrEqual(12 + 1e-6);
            maxR = Math.max(maxR, Math.hypot(r.positions[i * 3]!, r.positions[i * 3 + 2]!));
        }
        expect(maxR).toBeLessThan(0.5 * 1.6);
        for (const p of r.polygons) {
            expect(p.texture).toBe(0);
            for (const u of p.uvs) {
                expect(u).toBeGreaterThanOrEqual(-1e-6);
                expect(u).toBeLessThanOrEqual(1 + 1e-6);
            }
        }
    });

    it('refuses a mesh that is not a tall tube', () => {
        expect(() => lightBeamMesh(prism(8, 0.5, true))).toThrow();
    });
});

describe('harmless magic flame rings', () => {
    it('picks emitters that start on and that nothing links to', () => {
        const objects = [
            { id: 1, links: [] },
            { id: 2, links: [] },
            { id: 3, links: [] },
            { id: 9, links: [2] },
        ];
        const cands = [
            { id: 1, initialState: 1 },
            { id: 2, initialState: 1 },
            { id: 3, initialState: 0 },
        ];
        expect([...unswitchedEmitters(objects, cands)]).toEqual([1]);
    });

    it('is a table row that is off by default and turned on by the model map', () => {
        const row = DEFAULT_PS2_MODEL_SUBSTITUTIONS.find((r) => r.harmlessShow);
        expect(row?.category).toBe('effects');
        expect(planPs2Models().harmlessShow(row!.ootf)).toBeNull();
        const on = ps2ModelSwapFromEdits([{ ootf: row!.ootf, ps2: row!.ps2 }]);
        expect(planPs2Models(on).harmlessShow(row!.ootf)).toBe(row);
        // a turned-on remake row keeps its mode, and another mode can be asked for
        const r = ps2ModelSwapFromEdits([{ ootf: 'Evil Ruin Straight 01', ps2: 'x', refine: 'smooth' } as never]);
        expect(effectiveModelSubstitutions(r).find((x) => x.ootf === 'Evil Ruin Straight 01')?.refine).toBe('smooth');
        expect(planPs2Models(r).prop('Evil Ruin Straight 01', 'EvilRuinStraight01')?.refine).toBe('smooth');
        expect(planPs2Models().prop('Succubus Pillar', 'SuckPillar01')).toBeNull();
    });
});
