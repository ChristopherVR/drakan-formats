// Synthetic data only; no game bytes.
import { describe, expect, it } from 'vitest';
import type { PcAnim, Skeleton, SkelJoint } from '../src/ootfanim.ts';
import { quatAngle } from '../src/ootfcreature.ts';
import {
    chooseRetargetTarget,
    matchJoints,
    nameKeys,
    retargetCreature,
    retargetCreatureAssets,
    retargetPcAnim,
    retargetPs2Anim,
    rigSize,
} from '../src/ootfretarget.ts';
import { buildRig, invertMat12, mulMat12, quatToMat12 } from '../src/skeleton.ts';

type Rot = number[];
const rotY = (a: number): Rot => [Math.cos(a), 0, -Math.sin(a), 0, 1, 0, Math.sin(a), 0, Math.cos(a)];
const rotZ = (a: number): Rot => [Math.cos(a), Math.sin(a), 0, -Math.sin(a), Math.cos(a), 0, 0, 0, 1];
const I3: Rot = [1, 0, 0, 0, 1, 0, 0, 0, 1];

/** Skeleton with named joints, bind rotations and a local translation of `len` along +y below each root. */
function skeleton(names: string[], parents: number[], binds: Rot[], len = 1, animIds: number[] = []): Skeleton {
    const world: Float32Array[] = [];
    const joints: SkelJoint[] = names.map((_, j) => {
        const local = Float32Array.from([...binds[j]!, 0, parents[j]! < 0 ? 0 : len, 0]);
        const w = parents[j]! < 0 ? local : mulMat12(local, world[parents[j]!]!);
        world.push(w);
        return { xform: Array.from(invertMat12(w)), mesh: 0, firstChild: -1, nextSibling: -1, weights: [[]] };
    });
    for (let j = names.length - 1; j > 0; j--) {
        const p = parents[j]!;
        joints[j]!.nextSibling = joints[p]!.firstChild;
        joints[p]!.firstChild = j;
    }
    return {
        platform: 'ps2',
        bounds: new Uint8Array(64),
        lodNames: [],
        nodes: names.map((n, j) => ({ name: n, joint: j })),
        totalVertices: 0,
        joints,
        lods: [],
        animIds,
        channels: [],
        spheres: [],
        spheresPerLod: [[]],
    };
}

function pcAnim(keysPerJoint: { t: number; rot: Rot; pos?: number[] }[][], name = 'wave'): PcAnim {
    const keys: PcAnim['keys'] = [];
    const lookup: PcAnim['lookup'] = [];
    for (const ks of keysPerJoint) {
        lookup.push({ first: keys.length, count: ks.length });
        for (const k of ks) keys.push({ time: k.t, xform: [...k.rot, ...(k.pos ?? [0, 0, 0])] });
    }
    return {
        name,
        duration: 1,
        originalFrames: 30,
        frames: 30,
        flags: 0,
        nodes: keysPerJoint.length,
        channels: 0,
        keys,
        lookup,
    };
}

const still = (n: number, name: string): PcAnim =>
    pcAnim(
        Array.from({ length: n }, () => [{ t: 0, rot: I3 }]),
        name,
    );

describe('name keys', () => {
    it('maps the side and part synonyms of both games to one key', () => {
        const k = (n: string): string | undefined => nameKeys(n)[1];
        expect(k('Lbicep')).toBe('l:upperarm');
        expect(k('Luparm')).toBe('l:upperarm');
        expect(k('ArmUpL')).toBe('l:upperarm');
        expect(k('Left_Upperarm')).toBe('l:upperarm');
        expect(k('R_radius')).toBe('r:forearm');
        expect(k('Rforearm')).toBe('r:forearm');
        expect(k('lowerback')).toBeUndefined();
    });
});

describe('matchJoints', () => {
    const src = buildRig(skeleton(['root', 'Lbicep', 'Lforearm', 'Rbicep'], [-1, 0, 1, 0], [I3, I3, I3, I3]), 0);
    const dst = buildRig(
        skeleton(
            ['hips', 'Luparm', 'twist', 'Llowarm', 'Rbicep', 'tail'],
            [-1, 0, 1, 2, 0, 0],
            [I3, I3, I3, I3, I3, I3],
        ),
        0,
    );
    const m = matchJoints(src, dst);

    it('pairs by name, synonyms and the single root; extra target joints stay unmatched', () => {
        expect(m.map).toEqual([0, 1, -1, 2, 3, -1]);
        expect(m.how[0]).toBe('root');
        expect(m.how[1]).toBe('canon');
        expect(m.how[4]).toBe('name');
        expect(m.unmatchedTarget).toEqual(['twist', 'tail']);
        expect(m.unmatchedSource).toEqual([]);
    });

    it('walks the tree for the lone unmatched child', () => {
        const a = buildRig(skeleton(['r', 'a', 'x'], [-1, 0, 1], [I3, I3, I3]), 0);
        const b = buildRig(skeleton(['r', 'a', 'y'], [-1, 0, 1], [I3, I3, I3]), 0);
        const t = matchJoints(a, b);
        expect(t.map).toEqual([0, 1, 2]);
        expect(t.how[2]).toBe('tree');
    });
});

describe('retargetPcAnim', () => {
    const srcSk = skeleton(['root', 'arm', 'hand'], [-1, 0, 1], [I3, rotZ(0.3), I3], 1);
    // the target rig is twice the size, binds the arm differently and has a twist joint between arm and hand
    const dstSk = skeleton(['root', 'arm', 'twist', 'hand'], [-1, 0, 1, 2], [I3, rotZ(-0.5), I3, I3], 2);
    const src = buildRig(srcSk, 0);
    const dst = buildRig(dstSk, 0);
    const m = matchJoints(src, dst);
    const K = rotY(0.7);
    const pc = pcAnim([
        [
            { t: 0, rot: I3, pos: [1, 1, 1] },
            { t: 1, rot: I3, pos: [1, 2, 1] },
        ],
        [{ t: 0, rot: K }],
        [{ t: 0, rot: I3 }],
    ]);

    it('matches every source joint and measures the size ratio', () => {
        expect(m.map).toEqual([0, 1, -1, 2]);
        expect(rigSize(dst) / rigSize(src)).toBeGreaterThan(2); // bigger rig (and its bind lean)
    });

    it('applies the model-axes key on the target bind, keeps the twist at bind, scales the root motion', () => {
        const a = retargetPcAnim(pc, src, dst, m);
        expect(a.tracks).toHaveLength(4);
        // arm: posed world = target bind world * K (root at rest)
        const local = quatToMat12(a.tracks[1]!.keys[0]!.q, [0, 0, 0]);
        const bindWorld = invertMat12(dstSk.joints[1]!.xform);
        const want = mulMat12(bindWorld, Float32Array.from([...K, 0, 0, 0]));
        for (let i = 0; i < 9; i++) expect(local[i]).toBeCloseTo(want[i]!, 5);
        // twist has no partner: a single key at the bind rotation (identity)
        expect(a.tracks[2]!.keys).toHaveLength(1);
        expect(quatAngle(a.tracks[2]!.keys[0]!.q, [0, 0, 0, 1])).toBeCloseTo(0, 5);
        // root travel of 1 unit in the source is scaled by the size ratio
        expect(a.tracks[0]!.hasPos).toBe(true);
        expect(a.tracks[0]!.keys[1]!.pos![1]).toBeCloseTo(rigSize(dst) / rigSize(src), 5);
    });

    it('rejects an animation of another rig size', () => {
        expect(() => retargetPcAnim(pcAnim([[{ t: 0, rot: I3 }]]), src, dst, m)).toThrow(/tracks/);
    });

    it('retargetCreature converts all it can and reports the rest', () => {
        const r = retargetCreature(
            srcSk,
            dstSk,
            new Map([
                [7, pc],
                [8, pcAnim([[{ t: 0, rot: I3 }]], 'bad')],
            ]),
        );
        expect(r.anims.map((x) => x.id)).toEqual([7]);
        expect(r.skipped.map((x) => x.id)).toEqual([8]);
        expect(r.scale).toBeCloseTo(rigSize(buildRig(dstSk, 0)) / rigSize(buildRig(srcSk, 0)), 5);
    });
});

describe('choose target and assets', () => {
    const srcSk = skeleton(['root', 'Lbicep', 'Lforearm', 'Rbicep', 'head'], [-1, 0, 1, 0, 0], [I3, I3, I3, I3, I3]);
    const good = skeleton(
        ['root', 'Luparm', 'Llowarm', 'Rbicep', 'head', 'tail'],
        [-1, 0, 1, 0, 0, 0],
        [I3, I3, I3, I3, I3, I3],
        1,
        [5, 6],
    );
    const bad = skeleton(['a', 'b', 'c', 'd'], [-1, 0, 0, 0], [I3, I3, I3, I3]);

    it('prefers the rig that keeps the PC motion and refuses a poor fit', () => {
        const c = chooseRetargetTarget(srcSk, [
            { id: 1, skeleton: bad },
            { id: 2, skeleton: good },
        ]);
        expect(c?.id).toBe(2);
        expect(c!.sourceCoverage).toBe(1);
        const poor = skeleton(['x', 'y', 'z'], [-1, 0, 0], [I3, I3, I3]);
        expect(chooseRetargetTarget(srcSk, [{ id: 1, skeleton: poor }], 0.9)).toBeNull();
    });

    it('keeps same-named disc clips and allocates free ids for the rest', () => {
        const r = retargetCreatureAssets({
            pcSkeleton: srcSk,
            pcAnims: new Map([
                [5, still(5, 'idle')],
                [10, still(5, 'roar')],
                [11, still(5, 'walk')],
            ]),
            candidates: [{ id: 2, skeleton: good }],
            ps2Anims: new Map([[2, new Map([[6, { name: 'Walk' } as never]])]]),
            takenIds: new Set([5, 6, 10]),
        });
        expect(r.target).toBe(2);
        expect(r.animIdMap.get(11)).toBe(6); // the disc already has "walk"
        expect(r.anims.map((a) => [a.pcId, a.id])).toEqual([
            [5, 11],
            [10, 12],
        ]); // 5 and 10 are taken in the ADB -> next free ids
        expect(r.reason).toMatch(/5 joints matched/);
    });
});

describe('PS2 character motion retargeting', () => {
    const source = buildRig(skeleton(['root', 'Lthigh', 'Lcalf'], [-1, 0, 1], [rotY(0.3), rotZ(-0.5), rotY(0.7)]), 0);
    const target = buildRig(
        skeleton(['root', 'Lthigh', 'Lcalf', 'tail'], [-1, 0, 1, 0], [rotZ(-0.2), rotY(0.8), rotZ(0.4), I3], 2),
        0,
    );
    const pc = pcAnim([
        [
            { t: 0, rot: I3, pos: [0, 0, 0] },
            { t: 1, rot: rotZ(0.8), pos: [1, 2, 3] },
        ],
        [
            { t: 0, rot: I3 },
            { t: 1, rot: rotY(-0.9) },
        ],
        [
            { t: 0, rot: I3 },
            { t: 1, rot: rotZ(1.1) },
        ],
    ]);
    const original = retargetPcAnim(pc, source, source, matchJoints(source, source), { scale: 1 });
    it('preserves joint rotations and key times on the same rig', () => {
        const result = retargetPs2Anim(original, source, source, matchJoints(source, source), { scale: 1 });
        result.tracks.forEach((track, j) =>
            track.keys.forEach((key, k) => {
                expect(key.time).toBe(original.tracks[j]!.keys[k]!.time);
                expect(quatAngle(key.q, original.tracks[j]!.keys[k]!.q)).toBeLessThan(0.001);
            }),
        );
    });
    it('removes duplicate root translation for a controller-driven visual actor while retaining rotation', () => {
        const result = retargetPs2Anim(original, source, target, matchJoints(source, target), { inPlace: true });
        expect(result.tracks[0]!.hasPos).toBe(false);
        expect(result.tracks[0]!.keys.every((key) => key.pos === null)).toBe(true);
        expect(quatAngle(result.tracks[0]!.keys[0]!.q, result.tracks[0]!.keys.at(-1)!.q)).toBeGreaterThan(0.1);
    });
    it('matches independent delta conversion across different parent bind rotations', () => {
        const result = retargetPs2Anim(original, source, target, matchJoints(source, target), { scale: 2 });
        const expected = retargetPcAnim(pc, source, target, matchJoints(source, target), { scale: 2 });
        result.tracks.forEach((track, j) =>
            track.keys.forEach((key, k) => {
                expect(quatAngle(key.q, expected.tracks[j]!.keys[k]!.q)).toBeLessThan(0.001);
            }),
        );
        expect(result.tracks[0]!.keys.at(-1)!.pos).toEqual(expected.tracks[0]!.keys.at(-1)!.pos);
        expect(result.tracks[3]!.keys).toHaveLength(1);
    });
});
