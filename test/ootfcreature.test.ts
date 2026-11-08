// Synthetic data only; no game bytes.
import { describe, expect, it } from 'vitest';
import type { PcAnim, Skeleton, SkelJoint } from '../src/ootfanim.ts';
import { parsePs2Anim, parseSkeleton } from '../src/ootfanim.ts';
import {
    bindBasis,
    compareAnims,
    convertCreatureAssets,
    convertPcAnimToPs2,
    pcKeyToPs2Rotation,
    quatAngle,
    reduceQuatKeys,
    sameJointTree,
} from '../src/ootfcreature.ts';
import { buildRig, invertMat12, mulMat12, quatToMat12 } from '../src/skeleton.ts';

type Rot = number[];
const rotY = (a: number): Rot => [Math.cos(a), 0, -Math.sin(a), 0, 1, 0, Math.sin(a), 0, Math.cos(a)];
const rotZ = (a: number): Rot => [Math.cos(a), Math.sin(a), 0, -Math.sin(a), Math.cos(a), 0, 0, 0, 1];
const rotX = (a: number): Rot => [1, 0, 0, 0, Math.cos(a), Math.sin(a), 0, -Math.sin(a), Math.cos(a)];

/** A tree with the given local bind rotations; `parents` lists parents before children. */
function skeleton(binds: Rot[], parents: number[], plat: 'ps2' | 'pc' = 'ps2'): Skeleton {
    const world: Float32Array[] = [];
    const joints: SkelJoint[] = binds.map((r, j) => {
        const local = Float32Array.from([...r, 0.1 * j, 0.02, 0]);
        const w = parents[j]! < 0 ? local : mulMat12(local, world[parents[j]!]!);
        world.push(w);
        return {
            xform: Array.from(invertMat12(w)),
            mesh: 0,
            firstChild: -1,
            nextSibling: -1,
            weights: [[{ vertex: j, weight: 1 }]],
        };
    });
    for (let j = binds.length - 1; j > 0; j--) {
        const p = parents[j]!;
        joints[j]!.nextSibling = joints[p]!.firstChild;
        joints[p]!.firstChild = j;
    }
    return {
        platform: plat,
        bounds: new Uint8Array(64),
        lodNames: [],
        nodes: binds.map((_, j) => ({ name: `n${j}`, joint: j })),
        totalVertices: binds.length,
        joints,
        lods: [
            { distance: 0, usage: 1, node: 0, firstVertex: 0, vertexCount: binds.length, firstPoly: 0, polyCount: 0 },
        ],
        animIds: [10],
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

describe('pc -> ps2 rotation basis', () => {
    const binds = [rotY(0), rotZ(0.9), rotX(-0.6)];
    const parents = [-1, 0, 1];
    const sk = skeleton(binds, parents);
    const basis = bindBasis(buildRig(sk, 0));

    it('identity key gives the bind pose', () => {
        for (let j = 0; j < 3; j++) {
            const q = pcKeyToPs2Rotation(basis, j, [1, 0, 0, 0, 1, 0, 0, 0, 1]);
            const m = quatToMat12(q, [0, 0, 0]);
            for (let i = 0; i < 9; i++) expect(m[i]).toBeCloseTo(binds[j]![i]!, 5);
        }
    });

    it('a key is a model-axes rotation applied after the bind world orientation', () => {
        // ancestors at rest, key K on joint 2: posed world rotation of joint 2 = bind world * K
        const K = rotY(0.4);
        const local = quatToMat12(pcKeyToPs2Rotation(basis, 2, K), [0, 0, 0]);
        const parentWorld = invertMat12(sk.joints[1]!.xform);
        const posed = mulMat12(local, parentWorld);
        const bindWorld = invertMat12(sk.joints[2]!.xform);
        const want = mulMat12(bindWorld, Float32Array.from([...K, 0, 0, 0]));
        for (let i = 0; i < 9; i++) expect(posed[i]).toBeCloseTo(want[i]!, 5);
    });
});

describe('key reduction', () => {
    it('drops keys a slerp reproduces and keeps the corner', () => {
        const keys = Array.from({ length: 21 }, (_, i) => {
            const a = i <= 10 ? i * 0.05 : 0.5 - (i - 10) * 0.05;
            return { time: i * 0.05, q: [Math.sin(a / 2), 0, 0, Math.cos(a / 2)] as [number, number, number, number] };
        });
        const out = reduceQuatKeys(keys, 0.002);
        expect(out).toHaveLength(3);
        expect(out[1]!.time).toBeCloseTo(0.5, 6);
    });
});

describe('convertPcAnimToPs2', () => {
    const sk = skeleton([rotY(0), rotZ(0.9), rotX(-0.6)], [-1, 0, 1]);
    const basis = bindBasis(buildRig(sk, 0));
    const pc = pcAnim([
        [
            { t: 0, rot: rotZ(0), pos: [0.5, 0.5, 0.5] },
            { t: 0.5, rot: rotZ(0), pos: [0.5, 0.7, 0.5] },
            { t: 1, rot: rotZ(0), pos: [0.5, 0.9, 0.5] },
        ],
        [{ t: 0, rot: rotX(0) }],
        [
            { t: 0, rot: rotY(0) },
            { t: 0.5, rot: rotY(0.5) },
            { t: 1, rot: rotY(1) },
        ],
    ]);

    it('keeps the absolute root position with the first key as base, drops others, collapses constants', () => {
        const a = convertPcAnimToPs2(pc, basis, { channels: 4 });
        expect(a.tracks[0]!.hasPos).toBe(true);
        expect(a.tracks[0]!.keys).toHaveLength(2); // linear: middle key removed
        // a clip that starts off the bind (sitting, crouching) keeps that offset: PS2 positions are absolute, base = key 0
        expect(a.tracks[0]!.base).toEqual([0.5, 0.5, 0.5]);
        expect(a.tracks[0]!.keys[0]!.pos).toEqual([0.5, 0.5, 0.5]);
        expect(a.tracks[0]!.keys[1]!.pos![1]).toBeCloseTo(0.9, 6);
        expect(a.tracks[1]!.hasPos).toBe(false);
        expect(a.tracks[1]!.keys).toHaveLength(1);
        expect(a.channels).toBe(4);
        expect(a.tracks[2]!.base).toEqual(basis.translation[2]);
    });

    it('round-trips through the ADB writer', () => {
        const a = convertPcAnimToPs2(pc, basis);
        const f = convertCreatureAssets({ pcSkeleton: sk, pcAnims: new Map([[10, pc]]) });
        const rec = f.anims[0]!;
        expect(parsePs2Anim(rec.info, rec.data).tracks).toHaveLength(a.tracks.length);
    });

    it('rejects a track count that does not match the skeleton', () => {
        expect(() => convertPcAnimToPs2(pcAnim([[{ t: 0, rot: rotX(0) }]]), basis)).toThrow(/tracks/);
    });

    it('compareAnims is zero against itself', () => {
        const a = convertPcAnimToPs2(pc, basis);
        const d = compareAnims(buildRig(sk, 0), a, a);
        expect(d.maxAngle).toBeCloseTo(0, 6);
        expect(d.maxPos).toBeCloseTo(0, 6);
        expect(quatAngle([0, 0, 0, 1], [0, 0, 0, -1])).toBeCloseTo(0, 6);
    });
});

describe('retarget strategy', () => {
    const binds = [rotY(0), rotZ(0.9), rotX(-0.6)];
    const pcSk = skeleton(binds, [-1, 0, 1], 'pc');
    const still = (name: string) =>
        pcAnim([[{ t: 0, rot: rotZ(0) }], [{ t: 0, rot: rotX(0) }], [{ t: 0, rot: rotY(0) }]], name);

    it('same tree on PS2: reuse the disc model, convert only animations the disc lacks', () => {
        const ps2Sk = skeleton(binds, [-1, 0, 1], 'ps2');
        const ps2Wave = convertPcAnimToPs2(still('wave'), bindBasis(buildRig(ps2Sk, 0)));
        const r = convertCreatureAssets({
            pcSkeleton: pcSk,
            pcAnims: new Map([
                [10, still('wave')],
                [11, still('run')],
            ]),
            ps2Skeleton: ps2Sk,
            ps2Anims: new Map([[10, ps2Wave]]),
        });
        expect(r.mode).toBe('reuse-ps2');
        expect(r.skeletonRecord).toBeNull();
        expect(r.anims.map((a) => a.id)).toEqual([11]);
        expect(r.animIds).toEqual([10, 11]);
        expect(r.animIdMap.get(10)).toBe(10);
    });

    it('different bind pose or joint count: convert the skeleton too', () => {
        const other = skeleton([rotY(0), rotZ(1.4), rotX(-0.6)], [-1, 0, 1], 'ps2');
        expect(sameJointTree(pcSk, other).same).toBe(false);
        const r = convertCreatureAssets({
            pcSkeleton: pcSk,
            pcAnims: new Map([[10, still('wave')]]),
            ps2Skeleton: other,
        });
        expect(r.mode).toBe('convert');
        expect(r.reason).toMatch(/bind pose/);
        const back = parseSkeleton(r.skeletonRecord!, 'ps2');
        expect(back.joints).toHaveLength(3);
        expect(back.animIds).toEqual([10]);
    });

    it('fails when no animation fits', () => {
        const bad = pcAnim([[{ t: 0, rot: rotX(0) }]]);
        const r = convertCreatureAssets({ pcSkeleton: pcSk, pcAnims: new Map([[1, bad]]) });
        expect(r.mode).toBe('fail');
    });
});
