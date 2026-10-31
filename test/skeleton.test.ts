// Synthetic data only; no game bytes.
import { describe, expect, it } from 'vitest';
import {
    type Ps2Anim,
    type Skeleton,
    buildRig,
    clipLoops,
    clipTime,
    invertMat12,
    localToWorld,
    mat12ToQuat,
    mulMat12,
    quatToMat12,
    restPose,
    rootMotion,
    sampleClip,
    skinMatrices,
    skinVertices,
} from '../src/index.ts';

const I = [1, 0, 0, 0, 1, 0, 0, 0, 1];
/** Root (joint 0, identity) and one child at (1, 0, 0). The mesh has 4 vertices in one LOD. */
function skeleton(): Skeleton {
    const childBind = [...I, 1, 0, 0]; // bind world: translation (1,0,0)
    const joint = (xform: number[], firstChild: number, weights: { vertex: number; weight: number }[]) => ({
        xform,
        mesh: 0,
        firstChild,
        nextSibling: 0,
        weights: [weights],
    });
    return {
        platform: 'ps2',
        bounds: new Uint8Array(64),
        lodNames: [],
        nodes: [
            { name: 'root', joint: 0 },
            { name: 'arm', joint: 1 },
        ],
        totalVertices: 4,
        joints: [
            joint([...I, 0, 0, 0], 1, []),
            // stored matrix = inverse of the bind world transform
            joint(Array.from(invertMat12(childBind)), 0, [
                { vertex: 1, weight: 1 },
                { vertex: 2, weight: 1 },
                { vertex: 3, weight: 3 },
            ]),
        ],
        lods: [{ distance: 0, usage: 1, node: 0, firstVertex: 0, vertexCount: 4, firstPoly: 0, polyCount: 1 }],
        animIds: [7],
        channels: [],
        spheres: [],
        spheresPerLod: [],
    };
}
// vertex 3 is shared 25 / 75 between root (weight 1) and arm (weight 3)
function withShared(): Skeleton {
    const s = skeleton();
    s.joints[0]!.weights = [[{ vertex: 3, weight: 1 }]];
    return s;
}

describe('rig and skinning', () => {
    const pos = new Float32Array([0, 0, 0, 1, 0, 0, 2, 0, 0, 2, 1, 0]);
    it('builds hierarchy, bind pose and normalised weights', () => {
        const rig = buildRig(withShared(), 4);
        expect(rig.parents).toEqual([-1, 0]);
        expect(rig.names).toEqual(['root', 'arm']);
        expect(rig.unweighted).toBe(1); // vertex 0
        expect(Array.from(rig.bindLocal.subarray(12 + 9))).toEqual([1, 0, 0]);
        const k = 3 * 4;
        expect(Array.from(rig.jointWeight.subarray(k, k + 2)).map((x) => +x.toFixed(2))).toEqual([0.25, 0.75]);
        expect(rig.animIds).toEqual([7]);
    });
    it('reproduces the mesh in the rest pose', () => {
        const rig = buildRig(withShared(), 4);
        const out = new Float32Array(12);
        skinVertices(rig, skinMatrices(rig, localToWorld(rig, restPose(rig))), pos, null, 0, 4, out, null);
        out.forEach((v, i) => expect(v).toBeCloseTo(pos[i]!, 5));
    });
    it('rotates the arm and moves only its vertices', () => {
        const rig = buildRig(skeleton(), 4);
        const local = restPose(rig);
        // 90 degrees about z, parent relative, keeping the translation
        quatToMat12([0, 0, Math.SQRT1_2, Math.SQRT1_2], [1, 0, 0], local.subarray(12, 24));
        const out = new Float32Array(12);
        skinVertices(rig, skinMatrices(rig, localToWorld(rig, local)), pos, null, 0, 4, out, null);
        expect(Array.from(out.subarray(0, 3))).toEqual([0, 0, 0]); // unweighted: root
        // vertex 1 sits at the joint (1,0,0): unmoved; vertex 2 is one unit along the arm: now one unit up (+y)
        expect(out[3]).toBeCloseTo(1);
        expect(out[6]).toBeCloseTo(1);
        expect(out[7]).toBeCloseTo(1);
    });
    it('round-trips quaternions and inverts rigid matrices', () => {
        const q = [0.1, -0.5, 0.3, 0.8];
        const l = Math.hypot(...q);
        const qn = q.map((v) => v / l);
        const m = quatToMat12(qn, [1, 2, 3]);
        const back = mat12ToQuat(m);
        const sign = Math.sign(back[3]!) === Math.sign(qn[3]!) ? 1 : -1;
        back.forEach((v, i) => expect(v * sign).toBeCloseTo(qn[i]!, 5));
        const id = mulMat12(m, invertMat12(m));
        [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0].forEach((v, i) => expect(id[i]).toBeCloseTo(v, 5));
    });
});

describe('clip sampling', () => {
    const q0: [number, number, number, number] = [0, 0, 0, 1];
    const q90: [number, number, number, number] = [0, 0, Math.SQRT1_2, Math.SQRT1_2];
    const clip = (flags = 0): Ps2Anim => ({
        name: 'x',
        duration: 2,
        flags,
        frames: 2,
        channels: 1,
        thresholds: { rotation: 0.2, scale: 1, translation: 1 },
        tracks: [
            {
                base: [0, 0, 0],
                hasPos: true,
                keys: [
                    { time: 0, q: q0, pos: [5, 0, 0] },
                    { time: 2, q: q0, pos: [9, 0, 0] },
                ],
            },
            {
                base: [1, 0, 0],
                hasPos: false,
                keys: [
                    { time: 0, q: q0, pos: null },
                    { time: 2, q: q90, pos: null },
                ],
            },
        ],
    });
    it('wraps looping clips and clamps one-shots', () => {
        expect(clipLoops(clip())).toBe(true);
        expect(clipTime(clip(), 2.5)).toBeCloseTo(0.5);
        expect(clipTime(clip(1), 2.5)).toBe(2);
        expect(clipTime(clip(1), -1)).toBe(0);
    });
    it('interpolates rotation and keyed translation, base elsewhere', () => {
        const rig = buildRig(skeleton(), 4);
        const l = sampleClip(rig, clip(), 1);
        expect(Array.from(l.subarray(9, 12))).toEqual([7, 0, 0]);
        expect(Array.from(l.subarray(21, 24))).toEqual([1, 0, 0]);
        const half = mat12ToQuat(l.subarray(12, 24));
        expect(Math.abs(half[2]!)).toBeCloseTo(Math.sin(Math.PI / 8), 3); // 45 degrees about z
    });
    it('plays in place and reports root motion', () => {
        const rig = buildRig(skeleton(), 4);
        const l = sampleClip(rig, clip(), 1, { inPlace: true });
        expect(Array.from(l.subarray(9, 12))).toEqual([2, 0, 0]);
        expect(rootMotion(clip(), rig).delta).toEqual([4, 0, 0]);
    });
});
