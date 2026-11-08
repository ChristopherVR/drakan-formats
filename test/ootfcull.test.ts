// Back-face culling of cinematic scenes, done in the data. Synthetic geometry and scenes only; no game bytes.
import { describe, expect, it } from 'vitest';
import {
    applyCulling,
    cameraForward,
    keyPose,
    placementPose,
    planCinematicCulling,
    sequencePlayOrder,
    type CullTarget,
} from '../src/ootfcull.ts';
import type { LvlObject } from '../src/lvl.ts';
import type { PcPolygon } from '../src/ootfmodel.ts';
import type { PcAction, PcSequence } from '../src/ootfseq.ts';
import type { OdbClass } from '../src/odb.ts';

const apply = (m: number[][], v: number[]): number[] => m.map((r) => r[0]! * v[0]! + r[1]! * v[1]! + r[2]! * v[2]!);

/** A square in the model's YZ plane at x = `x`, two triangles; `front` = the side (+1 / -1 along X) the PC draws. */
function card(x: number, front: 1 | -1): PcPolygon[] {
    // corners 0..3 at (x, -1, -1), (x, 1, -1), (x, 1, 1), (x, -1, 1); (b - a) x (c - a) of 0,1,2 points to +X
    const base = x > 0 ? 4 : 0;
    const q = front > 0 ? [0, 2, 1, 0, 3, 2] : [0, 1, 2, 0, 2, 3];
    return [
        { flags: 0x8000, texture: 0, indices: q.slice(0, 3).map((i) => base + i), uvs: [] },
        { flags: 0x8000, texture: 0, indices: q.slice(3).map((i) => base + i), uvs: [] },
    ];
}
const corners = (x: number): number[] => [x, -1, -1, x, 1, -1, x, 1, 1, x, -1, 1];

/** A thin title box: front card at x = +0.01 facing +X, back card at x = -0.01 facing -X (the "Production" model). */
const titleBox = {
    positions: new Float32Array([...corners(-0.01), ...corners(0.01)]),
    polygons: [...card(0.01, 1), ...card(-0.01, -1)],
};
/** A single-sided plane facing +X (the "Sureal Soft 2" planes). */
const plane = { positions: new Float32Array([...corners(0), ...corners(0)]), polygons: card(0, 1) };

const cls = (name: string, rflClass = 17): OdbClass => ({
    id: 1,
    name,
    group: 0,
    runtimeClass: rflClass,
    rflClass,
    model: { id: 1, db: 0 },
});
const camCls = cls('Camera', 27);

function object(id: number, pos: [number, number, number], rotY: number, classId: number, visible = true): LvlObject {
    return {
        id,
        classId,
        dbIndex: 0,
        prefix0: 0,
        prefix1: 0,
        pos,
        flags: visible ? 1 : 0,
        initialEvents: 0,
        radius: null,
        links: [],
        rot: [0, rotY, 0],
        scale: null,
        preSentinel: 0,
        sentinel: 0xffffffff,
        data: [],
        params: [],
    } as LvlObject;
}

function transform(
    time: number,
    pos: [number, number, number],
    q: [number, number, number, number] = [0, 0, 0, 1],
): PcAction {
    const payload = new Uint8Array(36);
    const d = new DataView(payload.buffer);
    q.forEach((v, i) => d.setFloat32(i * 4, v, true));
    pos.forEach((v, i) => d.setFloat32(16 + i * 4, v, true));
    return { type: 0, time, payload };
}
function show(time: number, on: boolean): PcAction {
    const payload = new Uint8Array(4);
    new DataView(payload.buffer).setUint32(0, on ? 1 : 0, true);
    return { type: 6, time, payload };
}
const seq = (id: number, actors: PcSequence['actors']): PcSequence => ({
    id,
    group: 0,
    name: `s${id}`,
    flags: 0,
    modifyRunState: 0,
    unk2: 0,
    actors,
});
const actor = (id: number, objectId: number, actions: PcAction[]) => ({
    name: `a${id}`,
    id,
    actorType: 1,
    assignedAs: 0,
    objectId,
    actions,
});
const timeline = (a: PcAction[] | undefined): string[] =>
    (a ?? []).map((x) => `${x.time.toFixed(2)} ${new DataView(x.payload.buffer).getUint32(0, true) ? 'show' : 'hide'}`);

describe('cinematic culling', () => {
    it('reads a sequence key as the conjugate of its quaternion, like the placement minus 90 degrees', () => {
        // the Intro's D letter: stored Y 261 and keyed (0, 0.997, 0, -0.078) at its placed position
        const placed = placementPose({ pos: [0, 0, 0], rot: [0, 261, 0] })!;
        const keyed = keyPose([0, 0.997, 0, -0.078], [0, 0, 0]);
        for (const v of [
            [1, 0, 0],
            [0, 0, 1],
        ])
            apply(keyed.m, v).forEach((c, k) => expect(c).toBeCloseTo(apply(placed.m, v)[k]!, 1));
        // the owl face: stored Y 0 and keyed (0, 0.707, 0, 0.707)
        const owl = placementPose({ pos: [0, 0, 0], rot: [0, 0, 0] })!;
        apply(keyPose([0, 0.7071, 0, 0.7071], [0, 0, 0]).m, [1, 0, 0]).forEach((c, k) =>
            expect(c).toBeCloseTo(apply(owl.m, [1, 0, 0])[k]!, 3),
        );
        expect(placementPose({ pos: [0, 0, 0], rot: [10, 0, 0] })).toBeNull();
    });

    // stored Y 90 = no turn: model +X is world +X
    const camera = object(1, [0, 0, 0], 0, 2);
    const level = (objects: LvlObject[]) => ({
        list: { objects: [camera, ...objects], warnings: [] },
        classes: new Map([
            [
                0,
                new Map([
                    [1, cls('Card')],
                    [2, camCls],
                ]),
            ],
        ]),
    });

    it('leaves out the back of a title box that the camera never sees', () => {
        const box = object(10, [0, 0, 0], 90, 1);
        const pc = level([box]);
        const t: CullTarget = { id: 10, cls: pc.classes.get(0)!.get(1)!, model: titleBox, trimmable: true };
        const scene = seq(5, [actor(1, 1, [transform(0, [5000, 0, 0]), transform(4, [5000, 300, 2000])])]);
        const plan = planCinematicCulling(pc, [scene], [t]);
        expect([...(plan.drops.get(t.cls) ?? [])].sort()).toEqual([2, 3]);
        expect(plan.visibility.size).toBe(0); // its front is always seen: nothing to hide
        // not trimmable (a morph model): kept whole
        expect(planCinematicCulling(pc, [scene], [{ ...t, trimmable: false }]).drops.size).toBe(0);
    });

    it('hides a plane seen from behind and shows it again when it turns to the camera', () => {
        const card10 = object(10, [0, 0, 0], 90, 1);
        const pc = level([card10]);
        const t: CullTarget = { id: 10, cls: pc.classes.get(0)!.get(1)!, model: plane, trimmable: true };
        // scene 1: the camera stays behind the plane (-X); scene 2: it starts behind and moves round to the front
        const s1 = seq(1, [actor(1, 1, [transform(0, [-5000, 0, 0]), transform(2, [-5000, 0, 100])])]);
        const s2 = seq(2, [
            actor(1, 1, [transform(0, [-5000, 0, 0]), transform(1, [-5000, 0, 0]), transform(2, [5000, 0, 0])]),
        ]);
        const plan = planCinematicCulling(pc, [s1, s2], [t], 10);
        expect(timeline(plan.visibility.get(1)?.get(10))).toEqual(['0.00 hide']);
        // edge-on at 1.5 s (camera in the plane): not yet a front
        expect(timeline(plan.visibility.get(2)?.get(10))).toEqual(['0.00 hide', '1.60 show']);
        expect(plan.drops.size).toBe(0); // its front is seen in scene 2
    });

    it('keeps authored show / hide instants and only shows the plane while the scene shows it', () => {
        const card10 = object(10, [0, 0, 0], 90, 1, false);
        const pc = level([card10]);
        const t: CullTarget = { id: 10, cls: pc.classes.get(0)!.get(1)!, model: plane, trimmable: true };
        // the camera is in front; the scene shows the card at 0.574 s and hides it at 3 s: nothing to change
        const s = seq(3, [
            actor(1, 1, [transform(0, [5000, 0, 0])]),
            actor(2, 10, [show(0.574, true), show(3, false)]),
        ]);
        expect(planCinematicCulling(pc, [s], [t]).visibility.size).toBe(0);
        // the camera turns behind it at 2 s: hidden from then on, the authored show instant kept
        const s2 = seq(3, [
            actor(1, 1, [transform(0, [5000, 0, 0]), transform(1.9, [5000, 0, 0]), transform(2, [-5000, 0, 0])]),
            actor(2, 10, [show(0.574, true), show(3, false)]),
        ]);
        const v = planCinematicCulling(pc, [s2], [t], 10).visibility.get(3)!.get(10);
        expect(timeline(v)).toEqual(['0.00 hide', '0.57 show', '2.00 hide']);
        const out = applyCulling(s2, { visibility: new Map([[3, new Map([[10, v!]])]]) });
        expect(timeline(out.actors[1]!.actions.filter((x) => x.type === 6))).toEqual(timeline(v));
    });

    it('counts a polygon behind the camera as unseen whichever side it shows', () => {
        // the Intro's cameras: yaw -90 looks down -X
        cameraForward([0, -0.7071, 0, 0.7071]).forEach((c, k) => expect(c).toBeCloseTo([-1, 0, 0][k]!, 3));
        const card10 = object(10, [0, 0, 0], 90, 1);
        const pc = level([card10]);
        const t: CullTarget = { id: 10, cls: pc.classes.get(0)!.get(1)!, model: plane, trimmable: true };
        const look = (yw: number) => transform(0, [5000, 0, 0], [0, yw, 0, 0.7071]);
        // its front faces the camera at +X: shown while the camera looks at it, hidden while it looks away (+X)
        expect(planCinematicCulling(pc, [seq(1, [actor(1, 1, [look(-0.7071)])])], [t]).visibility.size).toBe(0);
        const past = planCinematicCulling(pc, [seq(1, [actor(1, 1, [look(0.7071)])])], [t])
            .visibility.get(1)
            ?.get(10);
        expect(timeline(past)).toEqual(['0.00 hide']);
    });

    it('adds an actor for an object the scene does not name', () => {
        const s = seq(4, [actor(3, 1, [])]);
        const out = applyCulling(
            s,
            { visibility: new Map([[4, new Map([[77, [show(0, false)]]])]]) },
            () => 'Sureal Soft 2',
        );
        expect(out.actors).toHaveLength(2);
        expect(out.actors[1]).toMatchObject({ name: 'Sureal Soft 2', id: 4, actorType: 1, objectId: 77 });
        expect(applyCulling(seq(9, []), { visibility: new Map() }).actors).toHaveLength(0);
    });

    it('orders scenes by id when no Stomp Player chains them', () => {
        expect(sequencePlayOrder(level([]), [seq(452, []), seq(450, []), seq(451, [])]).order).toEqual([450, 451, 452]);
    });
});
