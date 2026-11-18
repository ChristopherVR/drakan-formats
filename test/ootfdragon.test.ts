import { describe, expect, it } from 'vitest';
import type { Ps2Anim } from '../src/ootfanim.ts';
import type { OdbClass } from '../src/odb.ts';
import {
    DRAGON_JOINTS,
    dragonChannelMap,
    dragonPartners,
    dragonReadyClip,
    isDragonPair,
    nativeDragonClips,
    retargetDragonClip,
} from '../src/ootfdragon.ts';
import { localToWorld, quatToMat12, type Rig } from '../src/skeleton.ts';
import { sampleClip } from '../src/anim.ts';

/** A minimal rig: joint names, parents and local bind translations (identity rotations). */
function rig(names: string[], parents: number[], offsets: [number, number, number][]): Rig {
    const bindLocal = new Float32Array(names.length * 12);
    offsets.forEach((t, j) => bindLocal.set([1, 0, 0, 0, 1, 0, 0, 0, 1, ...t], j * 12));
    return {
        jointCount: names.length,
        parents,
        order: names.map((_, j) => j),
        names,
        invBind: new Float32Array(names.length * 12),
        bindLocal,
        jointIndex: new Uint16Array(0),
        jointWeight: new Float32Array(0),
        vertexCount: 0,
        droppedInfluences: 0,
        unweighted: 0,
        animIds: [],
    } as unknown as Rig;
}

const yaw = (deg: number): [number, number, number, number] => {
    const h = (deg * Math.PI) / 360;
    return [0, Math.sin(h), 0, Math.cos(h)];
};

const cls = (fields: [string, number][], rflClass = 28, model: OdbClass['model'] = null): OdbClass =>
    ({
        id: 1,
        name: 'c',
        rflClass,
        model,
        fields: fields.map(([name]) => ({ name, type: 7 })),
        data: fields.map(([, v]) => v),
    }) as unknown as OdbClass;

describe('ootfdragon', () => {
    it('pairs disc Arokh joints with PC dragon joints through the table', () => {
        const pc = ['Dragon', 'Neck', 'Neck0', 'head', 'saddle'];
        const disc = ['Arokh', 'NN_neck', 'neck_a', 'neck_b', 'neck_head', 'Lear', 'saddle'];
        expect(dragonPartners(pc, disc)).toEqual([0, 1, 2, -1, 3, -1, 4]);
        expect(isDragonPair(pc, disc)).toBe(false);
        // the full table pairs every listed disc joint
        const pcAll = [...new Set(DRAGON_JOINTS.values())];
        const discAll = [...DRAGON_JOINTS.keys()];
        expect(isDragonPair(pcAll, discAll)).toBe(true);
    });

    it('maps PC channels to the disc channel of the partner joint or its nearest ancestor with one', () => {
        // PC: 0 dragon, 1 wings, 2 rwing, 3 saddle; disc: 0 arokh, 1 nn_wings, 2 rwing_a, 3 saddle
        const pcNames = ['Dragon', 'Wings', 'Rwing', 'saddle'];
        const discRig = rig(
            ['Arokh', 'NN_wings', 'Rwing_a', 'saddle'],
            [-1, 0, 1, 0],
            [
                [0, 0, 0],
                [0, 0, 0],
                [0, 0, 0],
                [0, 0, 0],
            ],
        );
        const pc = { channels: [0, 1, 2, 3].map((joint) => ({ joint })) } as never;
        // the disc has channels only on the root, the wing group and the saddle
        const disc = { channels: [0, 1, 3].map((joint) => ({ joint })) } as never;
        expect([...dragonChannelMap(pc, pcNames, disc, discRig)]).toEqual([
            [0, 0],
            [1, 1],
            [2, 1],
            [3, 2],
        ]);
    });

    it('takes the disc clip of the same Dragon class field where both name one', () => {
        const pc = cls([
            ['Ready', 545],
            ['Fly', 535],
            ['Run Into Wall', 0],
            ['Bite', 846],
        ]);
        const disc = cls([
            ['Ready', 1607],
            ['Fly', 1595],
            ['Bite', 0],
        ]);
        expect(dragonReadyClip(disc)).toBe(1607);
        expect(dragonReadyClip(cls([['Ready', 0]]))).toBeUndefined();
        expect([...nativeDragonClips(pc, disc)]).toEqual([
            [545, 1607],
            [535, 1595],
        ]);
    });

    it('copies each partner joint’s model-space rotation change and the root motion onto the disc rig', () => {
        // PC: dragon -> upperbody -> neck chain; disc: arokh -> nn_neck -> neck_head (no upper body joint in between)
        const src = rig(
            ['Dragon', 'UpperBody', 'Neck', 'head'],
            [-1, 0, 1, 2],
            [
                [0, 0, 0],
                [0, 0, -0.1],
                [0, 0, -0.1],
                [0, 0.2, -0.2],
            ],
        );
        const dst = rig(
            ['Arokh', 'NN_neck', 'neck_head', 'Lear'],
            [-1, 0, 1, 2],
            [
                [0, 0, 0],
                [0, 0, -0.2],
                [0, 0.2, -0.2],
                [0.03, 0, 0],
            ],
        );
        const partner = dragonPartners(src.names, dst.names);
        expect(partner).toEqual([0, 2, 3, -1]);
        // the upper body turns 30 degrees and the neck 60 more at t = 1; the root moves 1 unit in x
        const anim: Ps2Anim = {
            name: 'turn',
            duration: 1,
            flags: 0,
            frames: 4,
            channels: 1,
            thresholds: { rotation: 0, scale: 0, translation: 0 },
            tracks: [
                {
                    base: [0, 0, 0],
                    hasPos: true,
                    keys: [
                        { time: 0, q: yaw(0), pos: [0, 0, 0] },
                        { time: 1, q: yaw(0), pos: [1, 0, 0] },
                    ],
                },
                {
                    base: [0, 0, -0.1],
                    hasPos: false,
                    keys: [
                        { time: 0, q: yaw(0), pos: null },
                        { time: 1, q: yaw(30), pos: null },
                    ],
                },
                {
                    base: [0, 0, -0.1],
                    hasPos: false,
                    keys: [
                        { time: 0, q: yaw(0), pos: null },
                        { time: 1, q: yaw(60), pos: null },
                    ],
                },
                { base: [0, 0.2, -0.2], hasPos: false, keys: [{ time: 0, q: yaw(0), pos: null }] },
            ],
        };
        const out = retargetDragonClip(anim, src, dst, partner, { channels: 7 });
        expect(out.frames).toBe(4);
        expect(out.channels).toBe(7);
        const ws = localToWorld(src, sampleClip(src, { ...anim, flags: 1 }, 1));
        const wd = localToWorld(dst, sampleClip(dst, { ...out, flags: 1 }, 1));
        // nn_neck takes the PC neck's world rotation (90 degrees: both turns), neck_head the head's, the ear follows
        for (const [d, s] of [
            [1, 2],
            [2, 3],
        ] as const)
            for (let k = 0; k < 9; k++) expect(wd[d * 12 + k]!).toBeCloseTo(ws[s * 12 + k]!, 5);
        const turned = quatToMat12(yaw(90), [0, 0, 0]);
        for (let k = 0; k < 9; k++) expect(wd[3 * 12 + k]!).toBeCloseTo(turned[k]!, 5);
        expect(wd[9]!).toBeCloseTo(1, 5);
        // the ear has no partner: a single key, its bind rotation
        expect(out.tracks[3]!.keys).toHaveLength(1);
    });

    it('keeps folded wing joints as far from the body as the source pose allows', () => {
        const src = rig(
            ['Dragon', 'Rwing', 'Rwing2'],
            [-1, 0, 1],
            [
                [0, 0, 0],
                [0.4, 0, 0],
                [1, 0, 0],
            ],
        );
        const dst = rig(
            ['Arokh', 'Rwing_a', 'Rwing_b'],
            [-1, 0, 1],
            [
                [0, 0, 0],
                [0.2, 0, 0],
                [1, 0, 0],
            ],
        );
        const clip: Ps2Anim = {
            name: 'fold',
            duration: 1,
            flags: 1,
            frames: 3,
            channels: 1,
            thresholds: { rotation: 0, scale: 0, translation: 0 },
            tracks: [
                { base: [0, 0, 0], hasPos: false, keys: [{ time: 0, q: yaw(25), pos: null }] },
                { base: [0.4, 0, 0], hasPos: false, keys: [{ time: 0, q: yaw(80), pos: null }] },
                { base: [1, 0, 0], hasPos: false, keys: [{ time: 0, q: yaw(0), pos: null }] },
            ],
        };
        const converted = retargetDragonClip(clip, src, dst, dragonPartners(src.names, dst.names));
        const originalPose = localToWorld(src, sampleClip(src, clip, 0));
        const convertedPose = localToWorld(dst, sampleClip(dst, converted, 0));
        const outFromBody = (pose: Float32Array) =>
            (pose[33]! - pose[9]!) * pose[0]! + (pose[34]! - pose[10]!) * pose[1]! + (pose[35]! - pose[11]!) * pose[2]!;
        expect(outFromBody(convertedPose)).toBeCloseTo(outFromBody(originalPose), 5);
        expect(
            Math.hypot(convertedPose[33]! - convertedPose[21]!, convertedPose[35]! - convertedPose[23]!),
        ).toBeCloseTo(1, 5);
    });
});
