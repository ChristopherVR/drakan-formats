// Synthetic data only; no game bytes.
import { describe, expect, it } from 'vitest';
import { buildAnimMap, jointParents, parsePs2Anim, parseSkeleton, writePs2Anim, writePs2Skeleton } from '../src/ootfanim.ts';

function f32(v: number[]): number[] {
    const d = new DataView(new ArrayBuffer(4 * v.length));
    v.forEach((x, i) => d.setFloat32(i * 4, x, true));
    return [...new Uint8Array(d.buffer)];
}
const u16 = (v: number) => [v & 255, v >> 8];
const u32 = (v: number) => [v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255];
const name32 = (s: string) => Array.from({ length: 32 }, (_, i) => (i < s.length ? s.charCodeAt(i) : 0));

/** Two joints (root, child), 1 LOD, 4 vertices, one channel and one sphere. PC layout. */
function pcSkeleton(): Uint8Array {
    const b: number[] = [...new Array(64).fill(0), ...u16(1)];
    b.push(...u16(2), ...name32('root'), ...u32(0), ...name32('bone'), ...u32(1));
    b.push(...u16(2));
    const rot = [1, 0, 0, 0, 1, 0, 0, 0, 1];
    b.push(...f32([...rot, 0, 0, 0]), ...u32(0), ...u32(1), ...u32(0), ...u16(0));
    b.push(...f32([...rot, 0.5, 0.25, 0.125]), ...u32(0), ...u32(0), ...u32(0), ...u16(2));
    b.push(...u32(0), ...f32([1]), ...u32(3), ...f32([0.5]));
    b.push(...u16(1), ...f32([0]), ...u32(1), ...u32(0), ...u32(0), ...u32(4), ...u32(0), ...u32(2));
    b.push(...u16(1), ...u32(7));
    b.push(...u16(1), ...u32(1), ...f32(new Array(24).fill(0)), ...u16(0));
    b.push(...u16(1), ...u16(1), ...u16(0), ...u16(0), ...u32(2), ...f32([0.5]), ...u16(1), ...u16(0));
    return Uint8Array.from(b);
}

describe('ootfanim skeleton', () => {
    it('parses PC, writes PS2 and parses it back', () => {
        const pc = parseSkeleton(pcSkeleton(), 'pc');
        expect(pc.joints).toHaveLength(2);
        expect(jointParents(pc)).toEqual([-1, 0]);
        const ps2 = writePs2Skeleton(pc, new Float32Array([0, 0, 0, 1, 2, 3, 4, 5, 6]));
        const back = parseSkeleton(ps2, 'ps2');
        expect(back.totalVertices).toBe(4);
        expect(back.joints[1]!.xform).toEqual(pc.joints[1]!.xform);
        expect(back.joints[1]!.weights[0]).toEqual([
            { vertex: 0, weight: 1 },
            { vertex: 3, weight: 0.5 },
        ]);
        expect(back.channels[0]!.joint).toBe(1);
        expect(back.spheres[0]!.centre).toEqual([4, 5, 6]);
        expect(back.animIds).toEqual([7]);
    });
});

describe('ootfanim ps2 animation', () => {
    it('round-trips tracks of both key sizes', () => {
        const a = {
            name: 'walk',
            duration: 1.25,
            flags: 0,
            frames: 2,
            channels: 1,
            thresholds: { rotation: 0.25, scale: 1, translation: 1 },
            tracks: [
                { base: [0, 0, 0] as [number, number, number], hasPos: true, keys: [
                    { time: 0, q: [0, 0, 0, 1] as [number, number, number, number], pos: [0, 0, 0] as [number, number, number] },
                    { time: 0.5, q: [0, 0, 0, 1] as [number, number, number, number], pos: [0, 0.5, 0] as [number, number, number] },
                ] },
                { base: [0.5, 0, 0] as [number, number, number], hasPos: false, keys: [
                    { time: 0, q: [0, 0, 0, 1] as [number, number, number, number], pos: null },
                ] },
            ],
        };
        const { info, data } = writePs2Anim(a);
        expect(parsePs2Anim(info, data)).toEqual(a);
    });
});

describe('ootfanim id map', () => {
    it('maps by name, case-insensitively, lowest id wins', () => {
        const m = buildAnimMap(
            [{ id: 1, name: 'Walk' }, { id: 2, name: 'Fly' }],
            [{ id: 9, name: 'walk' }, { id: 5, name: 'WALK' }],
        );
        expect(m.get(1)).toBe(5);
        expect(m.has(2)).toBe(false);
    });
});
