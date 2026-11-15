import { describe, expect, it } from 'vitest';
import type { Skeleton } from '../src/ootfanim.ts';
import { sampleClip } from '../src/anim.ts';
import { buildRig, localToWorld, skinMatrices, skinVertices } from '../src/skeleton.ts';
import {
    addJaw,
    jawClip,
    mixWeights,
    skinUpgradeFor,
    speechOpenings,
    subdivideSkin,
    upgradeSkin,
    vertexWeights,
    withJawTrack,
    type SkinPoly,
    type VertexWeights,
} from '../src/ootfskinupgrade.ts';

// Synthetic fixtures only: an icosahedron and a stick figure made up here.

function icosahedron(): { positions: Float32Array; polygons: SkinPoly[] } {
    const t = (1 + Math.sqrt(5)) / 2;
    const v = [
        [-1, t, 0],
        [1, t, 0],
        [-1, -t, 0],
        [1, -t, 0],
        [0, -1, t],
        [0, 1, t],
        [0, -1, -t],
        [0, 1, -t],
        [t, 0, -1],
        [t, 0, 1],
        [-t, 0, -1],
        [-t, 0, 1],
    ];
    const f = [
        [0, 11, 5],
        [0, 5, 1],
        [0, 1, 7],
        [0, 7, 10],
        [0, 10, 11],
        [1, 5, 9],
        [5, 11, 4],
        [11, 10, 2],
        [10, 7, 6],
        [7, 1, 8],
        [3, 9, 4],
        [3, 4, 2],
        [3, 2, 6],
        [3, 6, 8],
        [3, 8, 9],
        [4, 9, 5],
        [2, 4, 11],
        [6, 2, 10],
        [8, 6, 7],
        [9, 8, 1],
    ];
    return {
        positions: Float32Array.from(v.flat()),
        polygons: f.map((indices, i) => ({ flags: 0, texture: i < 10 ? 0 : 1, indices, uvs: [0, 0, 1, 0, 0, 1] })),
    };
}

const radius = (p: Float32Array, i: number) => Math.hypot(p[i * 3]!, p[i * 3 + 1]!, p[i * 3 + 2]!);

describe('subdivideSkin', () => {
    it('splits every triangle in four, keeps the original vertices and curves soft edges outwards', () => {
        const ico = icosahedron();
        const weights: VertexWeights[] = Array.from({ length: 12 }, (_, i) => [{ j: i % 2, w: 1 }]);
        const out = subdivideSkin({ ...ico, weights });
        expect(out.polygons).toHaveLength(80);
        expect(out.positions.length / 3).toBe(12 + 30);
        expect(Array.from(out.positions.slice(0, 36))).toEqual(Array.from(ico.positions));
        const r0 = radius(ico.positions, 0);
        // a straight midpoint of an icosahedron edge lies at 0.85 of the radius; the curved one further out
        for (let i = 12; i < 42; i++) expect(radius(out.positions, i)).toBeGreaterThan(0.9 * r0);
        // UVs: one corner per vertex, split linearly
        expect(out.polygons[0]!.uvs).toEqual([0, 0, 0.5, 0, 0, 0.5]);
    });

    it('splits kept (alpha card) triangles and their edges straight', () => {
        const ico = icosahedron();
        const weights: VertexWeights[] = Array.from({ length: 12 }, () => [{ j: 0, w: 1 }]);
        const out = subdivideSkin({ ...ico, weights }, { keepTextures: new Set([0, 1]) });
        const r0 = radius(ico.positions, 0);
        for (let i = 12; i < 42; i++) expect(radius(out.positions, i)).toBeLessThan(0.86 * r0);
    });

    it('skins a new vertex with the mean of its edge, at most four joints, renormalised', () => {
        const ico = icosahedron();
        const weights: VertexWeights[] = Array.from({ length: 12 }, (_, i) => [{ j: i, w: 1 }]);
        const out = subdivideSkin({ ...ico, weights });
        for (const w of out.weights.slice(12)) {
            expect(w).toHaveLength(2);
            expect(w[0]!.w).toBeCloseTo(0.5);
        }
        const mixed = mixWeights(
            [
                { j: 1, w: 0.4 },
                { j: 2, w: 0.3 },
                { j: 3, w: 0.3 },
            ],
            [
                { j: 4, w: 0.5 },
                { j: 5, w: 0.25 },
                { j: 1, w: 0.25 },
            ],
        );
        expect(mixed.map((x) => x.j)).toEqual([1, 4, 2, 3]);
        expect(mixed.reduce((s, x) => s + x.w, 0)).toBeCloseTo(1);
    });
});

/**
 * A stick figure facing -z: root at the origin, a head joint at y 10 with a ball of vertices (radius 1, a nose at the front)
 * and a foot joint at y 0 whose vertices lie ahead of it.
 */
function figure(): { sk: Skeleton; positions: Float32Array; polygons: SkinPoly[] } {
    const pts: number[][] = [];
    const tris: number[][] = [];
    const rings = 6,
        segs = 8;
    // head ball: rings x segs, poles at top and bottom
    pts.push([0, 11, 0]);
    for (let r = 1; r < rings; r++) {
        const a = (Math.PI * r) / rings;
        for (let s = 0; s < segs; s++) {
            const b = (2 * Math.PI * s) / segs;
            pts.push([Math.sin(a) * Math.sin(b), 10 + Math.cos(a), -Math.sin(a) * Math.cos(b)]);
        }
    }
    pts.push([0, 9, 0]);
    const ring = (r: number, s: number) => 1 + (r - 1) * segs + (s % segs);
    for (let s = 0; s < segs; s++) tris.push([0, ring(1, s), ring(1, s + 1)]);
    for (let r = 1; r < rings - 1; r++)
        for (let s = 0; s < segs; s++) {
            tris.push([ring(r, s), ring(r + 1, s), ring(r + 1, s + 1)]);
            tris.push([ring(r, s), ring(r + 1, s + 1), ring(r, s + 1)]);
        }
    const bottom = pts.length - 1;
    for (let s = 0; s < segs; s++) tris.push([bottom, ring(rings - 1, s + 1), ring(rings - 1, s)]);
    // the nose: the front vertex of the middle ring pushed out
    const nose = ring(3, 0);
    pts[nose] = [0, 10, -1.6];
    const headCount = pts.length;
    // foot: a flat triangle ahead of the foot joint (front = -z)
    pts.push([-0.3, 0, 0], [0.3, 0, 0], [0, 0, -1.5]);
    tris.push([headCount, headCount + 1, headCount + 2]);
    const positions = Float32Array.from(pts.flat());
    const polygons = tris.map((indices) => ({ flags: 0, texture: 0, indices, uvs: [0, 0, 1, 0, 0, 1] }));
    const inv = (o: number[]) => [1, 0, 0, 0, 1, 0, 0, 0, 1, -o[0]!, -o[1]!, -o[2]!];
    const sk: Skeleton = {
        platform: 'pc',
        bounds: new Uint8Array(64),
        lodNames: [],
        nodes: [
            { name: 'root', joint: 0 },
            { name: 'head', joint: 1 },
            { name: 'Lfoot', joint: 2 },
        ],
        totalVertices: 0,
        joints: [
            { xform: inv([0, 0, 0]), mesh: 0, firstChild: 1, nextSibling: -1, weights: [[]] },
            {
                xform: inv([0, 9, 0]),
                mesh: 0,
                firstChild: -1,
                nextSibling: 2,
                weights: [Array.from({ length: headCount }, (_, vertex) => ({ vertex, weight: 1 }))],
            },
            {
                xform: inv([0, 0, 0]),
                mesh: 0,
                firstChild: -1,
                nextSibling: -1,
                weights: [[0, 1, 2].map((k) => ({ vertex: headCount + k, weight: 1 }))],
            },
        ],
        lods: [
            {
                distance: 0,
                usage: 1,
                node: 0,
                firstVertex: 0,
                vertexCount: pts.length,
                firstPoly: 0,
                polyCount: tris.length,
            },
        ],
        animIds: [],
        channels: [{ joint: 0, caps: [] }],
        spheres: [],
        spheresPerLod: [[]],
    };
    return { sk, positions, polygons };
}

describe('addJaw', () => {
    it('adds a jaw joint under the head with the chin on it, facing where the feet point', () => {
        const f = figure();
        const j = addJaw(f.sk, f.positions, vertexWeights(f.sk, f.positions.length / 3))!;
        expect(j).not.toBeNull();
        expect(j.joint).toBe(3);
        expect(j.channel).toBe(1);
        expect(j.axis).toEqual([-1, 0, 0]);
        expect(j.skeleton.channels[1]!.joint).toBe(3);
        expect(j.skeleton.nodes.at(-1)).toEqual({ name: 'jaw', joint: 3 });
        // the head's last child (the foot is its sibling here) links to the jaw
        expect(j.skeleton.joints[1]!.firstChild).toBe(3);
        // a leaf whose lists end with 0, as in the data (the engine follows -1)
        expect([j.skeleton.joints[3]!.firstChild, j.skeleton.joints[3]!.nextSibling]).toEqual([0, 0]);
        // chin vertices (below the mouth, at the front) move; the nose, the back of the head and the top stay
        const jawOf = (v: number) => j.weights[v]!.find((x) => x.j === 3)?.w ?? 0;
        const nose = 1 + 2 * 8;
        expect(jawOf(nose)).toBe(0);
        expect(jawOf(0)).toBe(0);
        expect(jawOf(1 + 3 * 8)).toBeGreaterThan(0.5); // ring under the nose, front
        expect(jawOf(1 + 3 * 8 + 4)).toBe(0); // the same ring, back
        for (const w of j.weights) expect(w.reduce((s, x) => s + x.w, 0)).toBeCloseTo(1);
    });

    it('returns null without a head joint or when the model has a jaw already', () => {
        const f = figure();
        const w = vertexWeights(f.sk, f.positions.length / 3);
        expect(
            addJaw({ ...f.sk, nodes: f.sk.nodes.map((n) => ({ ...n, name: n.name + 'x' })) }, f.positions, w),
        ).toBeNull();
        expect(addJaw({ ...f.sk, nodes: [...f.sk.nodes, { name: 'Jaw', joint: 1 }] }, f.positions, w)).toBeNull();
    });

    it('opens the mouth with a jaw clip: the chin moves down and back, the rest of the body stays', () => {
        const f = figure();
        const u = upgradeSkin(
            { positions: f.positions, polygons: f.polygons, skeleton: f.sk },
            { smooth: false, jaw: true },
            new Set(),
        );
        const jaw = u.jaw!;
        const clip = jawClip(jaw, [0, 1, 1], 'talk');
        expect(clip.tracks).toHaveLength(4);
        expect(clip.channels).toBe(2);
        expect(clip.flags).toBe(1);
        expect(clip.duration).toBeCloseTo(3 / 25);
        const nv = u.positions.length / 3;
        const rig = buildRig({ ...u.skeleton, lods: [{ ...u.skeleton.lods[0]!, vertexCount: nv }] }, nv);
        const pose = (t: number) => {
            const out = new Float32Array(nv * 3);
            skinVertices(
                rig,
                skinMatrices(rig, localToWorld(rig, sampleClip(rig, clip, t))),
                u.positions,
                null,
                0,
                nv,
                out,
                null,
            );
            return out;
        };
        const closed = pose(0);
        const open = pose(0.06);
        const chin = 1 + 3 * 8;
        for (let k = 0; k < 3; k++) expect(closed[chin * 3 + k]).toBeCloseTo(u.positions[chin * 3 + k]!);
        expect(open[chin * 3 + 1]).toBeLessThan(u.positions[chin * 3 + 1]! - 0.05);
        expect(open[chin * 3 + 2]).toBeGreaterThan(u.positions[chin * 3 + 2]!);
        expect(open[0 * 3 + 1]).toBeCloseTo(u.positions[1]!); // top of the head
    });

    it('gives a clip converted before the jaw a resting jaw track', () => {
        const f = figure();
        const u = upgradeSkin(
            { positions: f.positions, polygons: f.polygons, skeleton: f.sk },
            { smooth: true, jaw: true },
            new Set(),
        );
        const base = jawClip(u.jaw!, [0], 'x');
        const pcClip = { ...base, tracks: base.tracks.slice(0, 3), frames: 3, channels: 1 };
        const withJaw = withJawTrack(pcClip, u.jaw!);
        expect(withJaw.tracks).toHaveLength(4);
        expect(withJaw.channels).toBe(2);
        expect(withJaw.tracks[3]!.keys).toHaveLength(1);
        expect(u.polygons).toHaveLength(f.polygons.length * 4);
        expect(u.pcJoints).toBe(3);
    });
});

describe('model upgrade table and speech', () => {
    it('finds rows by PC model name, ignoring case and blanks', () => {
        expect(skinUpgradeFor(' delon(H) ')?.jaw).toBe(true);
        expect(skinUpgradeFor('Banded Rynn(h) Multi')).toBeNull();
        // a jaw not looked at in game only when asked for; the mesh either way
        expect(skinUpgradeFor('farmer')).toMatchObject({ smooth: true, jaw: false });
        expect(skinUpgradeFor('farmer', undefined, true)?.jaw).toBe(true);
    });

    it('turns speech peaks into mouth openings with quiet frames shut', () => {
        const rate = 1000;
        const pcm = new Int16Array(rate); // 25 frames of 40 samples
        for (let i = 400; i < 800; i++) pcm[i] = i % 2 ? 12000 : -12000;
        const o = speechOpenings(pcm, rate);
        expect(o).toHaveLength(25);
        expect(o[0]).toBe(0);
        expect(o[12]).toBeCloseTo(0.8);
        expect(o[24]).toBe(0);
    });
});
