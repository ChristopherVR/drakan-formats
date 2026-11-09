// Synthetic data only; no game bytes.
import { describe, expect, it } from 'vitest';
import type { SrscEntry, SrscReader } from '../src/srsc.ts';
import { parseSkeleton, writePs2Anim, writePs2Skeleton, type Ps2Anim, type Skeleton } from '../src/ootfanim.ts';
import { hangingHairOverrides, locateJoints } from '../src/ootfhair.ts';
import { MOD_CHARACTER, MOD_VERTICES } from '../src/model.ts';
import { buildRig, invertMat12, localToWorld, quatToMat12 } from '../src/skeleton.ts';

const NAMES = ['root', 'head', 'hair1', 'hair2', 'hair3'];
const PARENTS = [-1, 0, 1, 2, 3];
// bind: every joint upright, the head one unit up, the ponytail chain running 0.1 backwards (+z) per joint
const WORLD_POS = [
    [0, 0, 0],
    [0, 1, 0],
    [0, 1, 0.1],
    [0, 1, 0.2],
    [0, 1, 0.3],
];
const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1];

function skeleton(weights: [number, number][][], names = NAMES): Skeleton {
    return {
        platform: 'ps2',
        bounds: new Uint8Array(64),
        lodNames: [],
        nodes: names.map((name, joint) => ({ name, joint })),
        totalVertices: 5,
        joints: names.map((_, j) => ({
            xform: Array.from(invertMat12([...IDENTITY, ...WORLD_POS[j]!])),
            mesh: 0,
            firstChild: j + 1 < names.length ? j + 1 : -1,
            nextSibling: -1,
            weights: [weights[j]!.map(([vertex, weight]) => ({ vertex, weight }))],
        })),
        lods: [{ distance: 0, usage: 0, node: 0, firstVertex: 0, vertexCount: 5, firstPoly: 0, polyCount: 0 }],
        animIds: [],
        channels: [],
        spheres: [],
        spheresPerLod: [[]],
    };
}

/** Five vertices, one per joint, except v2 which sits half on the head and half on hair1. */
const WEIGHTS: [number, number][][] = [
    [[0, 1]],
    [
        [1, 1],
        [2, 0.5],
    ],
    [[2, 0.5]],
    [[3, 1]],
    [[4, 1]],
];
const VERTS = [
    [0, 0, 0],
    [0, 1, 0],
    [0, 1, 0.1],
    [0, 1, 0.2],
    [0, 1, 0.3],
];

function verticesRecord(): Uint8Array {
    const b = new Uint8Array(2 + VERTS.length * 16);
    const dv = new DataView(b.buffer);
    dv.setUint16(0, VERTS.length, true);
    VERTS.forEach((v, i) => v.forEach((x, c) => dv.setFloat32(2 + i * 12 + c * 4, x, true)));
    for (let i = 0; i < VERTS.length; i++) dv.setInt8(2 + VERTS.length * 12 + i * 4 + 2, 127);
    return b;
}

/** The hanging clip: hair1 turned 90 degrees so that +z (backwards) runs along -y (down). */
function idleClip(): Ps2Anim {
    let q: [number, number, number, number] = [Math.SQRT1_2, 0, 0, Math.SQRT1_2];
    if (quatToMat12(q, [0, 0, 0])[7]! > 0) q = [-q[0], 0, 0, q[3]];
    return {
        name: 'NCIdle',
        duration: 1,
        flags: 0,
        frames: NAMES.length,
        channels: 0,
        thresholds: { rotation: 0.2, scale: 1, translation: 1 },
        tracks: NAMES.map((_, j) => ({
            base:
                j === 0
                    ? [0, 0, 0]
                    : ([...WORLD_POS[j]!].map((x, c) => x - WORLD_POS[PARENTS[j]!]![c]!) as [number, number, number]),
            hasPos: false,
            keys: [{ time: 0, q: j === 2 ? q : ([0, 0, 0, 1] as [number, number, number, number]), pos: null }],
        })),
    };
}

/** Just enough of a container for `hangingHairOverrides`. */
function fakeReader(records: { type: number; id: number; sub: number; data: Uint8Array }[]): SrscReader {
    const entries: SrscEntry[] = records.map((r, index) => ({
        index,
        type: r.type,
        id: r.id,
        sub: r.sub,
        offset: 0,
        size: r.data.length,
    }));
    return {
        entries,
        find: (type: number, id: number) => entries.find((e) => e.type === type && e.id === id),
        readRaw: async (e: SrscEntry) => records[e.index]!.data,
    } as unknown as SrscReader;
}

describe('hangingHairOverrides', () => {
    const raw = writePs2Skeleton(skeleton(WEIGHTS), null);
    const anim = writePs2Anim(idleClip());
    const mod = fakeReader([
        { type: MOD_CHARACTER, id: 7, sub: 3, data: raw },
        { type: MOD_VERTICES, id: 7, sub: 3, data: verticesRecord() },
    ]);
    const adb = fakeReader([
        { type: 0x0501, id: 9, sub: 0, data: anim.info },
        { type: 0x0502, id: 9, sub: 0, data: anim.data },
    ]);

    it('locates the joint spans of a record the way the parser reads it', () => {
        const spans = locateJoints(raw);
        expect(spans).toHaveLength(NAMES.length);
        // v2 is shared: the head list has two entries, hair1 one
        expect(raw[spans[1]!.lists[0]!.at]).toBe(2);
        expect(raw[spans[2]!.lists[0]!.at]).toBe(1);
        expect(spans[1]!.xform).toBeGreaterThan(0);
    });

    it('moves the hair strips to the head joint and hangs the vertices from the hair pivot', async () => {
        const res = await hangingHairOverrides(mod, adb, 'SYSTEM');
        expect(res.models).toEqual([7]);
        const char = res.files['overrides/SYSTEM.MOD/0208_7_3.bin']!;
        const verts = res.files['overrides/SYSTEM.MOD/0203_7_3.bin']!;
        expect(char).toBeDefined();
        const sk = parseSkeleton(char, 'ps2');
        // hair lists are empty, the head carries every hair vertex with the weight the hair had
        for (const j of [2, 3, 4]) expect(sk.joints[j]!.weights[0]).toHaveLength(0);
        const head = new Map(sk.joints[1]!.weights[0]!.map((w) => [w.vertex, w.weight]));
        const root = new Map(sk.joints[0]!.weights[0]!.map((w) => [w.vertex, w.weight]));
        const both = (v: number) => (head.get(v) ?? 0) + (root.get(v) ?? 0);
        // head and root together carry every hair vertex with the weight the hair (and the head) had
        for (const v of [1, 2, 3, 4]) expect(both(v)).toBeCloseTo(1, 6);
        expect(root.get(0)).toBe(1);
        // towards the tip the weight moves from the head to the root: v2 is at the tie, v4 at the tip
        expect(head.get(4) ?? 0).toBeLessThan(1e-6);
        expect(root.get(4)).toBeCloseTo(1, 5);
        expect(head.get(3)!).toBeGreaterThan(0);
        expect(head.get(3)!).toBeLessThan(1);
        // nothing else of the record changed: the matrices and the LOD table
        const before = parseSkeleton(raw, 'ps2');
        sk.joints.forEach((j, i) => expect(j.xform).toEqual(before.joints[i]!.xform));
        expect(sk.lods).toEqual(before.lods);
        // vertices: the hair hangs (y below the head) and keeps its distance from the hair1 pivot
        const dv = new DataView(verts.buffer, verts.byteOffset);
        const at = (v: number) => [0, 1, 2].map((c) => dv.getFloat32(2 + v * 12 + c * 4, true));
        expect(at(0)).toEqual([0, 0, 0]);
        expect(at(1)).toEqual([0, 1, 0]);
        for (const [v, back] of [
            [3, 0.1],
            [4, 0.2],
        ] as const) {
            const p = at(v);
            expect(p[1]!).toBeLessThan(1 - back * 0.9);
            expect(Math.hypot(p[0]!, p[1]! - 1, p[2]! - 0.1)).toBeCloseTo(back, 4);
        }
        expect(verts.length).toBe(verticesRecord().length);
    });

    it('keeps the strips on the head alone without the root blend', async () => {
        const res = await hangingHairOverrides(mod, adb, 'SYSTEM', { rootBlend: false });
        const sk = parseSkeleton(res.files['overrides/SYSTEM.MOD/0208_7_3.bin']!, 'ps2');
        expect(sk.joints[0]!.weights[0]!.map((w) => w.vertex)).toEqual([0]);
        expect(sk.joints[1]!.weights[0]!.map((w) => w.vertex)).toEqual([1, 2, 3, 4]);
    });

    it("keeps a joint's strip on the joint when it is left out of toHead", async () => {
        const res = await hangingHairOverrides(mod, adb, 'SYSTEM', { toHead: [0, 1] });
        const sk = parseSkeleton(res.files['overrides/SYSTEM.MOD/0208_7_3.bin']!, 'ps2');
        expect(sk.joints[2]!.weights[0]).toHaveLength(0);
        expect(sk.joints[3]!.weights[0]).toHaveLength(0);
        expect(sk.joints[4]!.weights[0]).toHaveLength(1);
    });

    it('skips records without hair joints and warns when the idle clip is missing', async () => {
        const noHair = fakeReader([
            {
                type: MOD_CHARACTER,
                id: 8,
                sub: 0,
                data: writePs2Skeleton(
                    skeleton(
                        WEIGHTS,
                        NAMES.map((_, i) => `bone${i}`),
                    ),
                    null,
                ),
            },
            { type: MOD_VERTICES, id: 8, sub: 0, data: verticesRecord() },
        ]);
        expect((await hangingHairOverrides(noHair, adb, 'SYSTEM')).models).toEqual([]);
        const res = await hangingHairOverrides(mod, fakeReader([]), 'SYSTEM');
        expect(res.models).toEqual([]);
        expect(res.warnings.join()).toContain('NCIdle');
        // the synthetic rig is consistent: its bind world positions are the ones listed above
        const rig = buildRig(skeleton(WEIGHTS), 5);
        const world = localToWorld(rig, rig.bindLocal);
        expect(world[4 * 12 + 11]).toBeCloseTo(0.3, 5);
    });
});
