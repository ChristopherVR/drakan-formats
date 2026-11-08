// Inward shells seen from outside. Synthetic geometry only; no game bytes.
import { describe, expect, it } from 'vitest';
import {
    MODEL_UNIT,
    isCinematicLevel,
    isInwardShell,
    mergeShellDrops,
    pcViewDistance,
    shellWallsHiddenFrom,
} from '../src/ootfshell.ts';
import type { PcPolygon } from '../src/ootfmodel.ts';

/** A unit-cell cube (+-1) as 12 triangles; `inward` gives every face the PC front side toward the centre. */
function cube(inward: boolean): { positions: Float32Array; polygons: PcPolygon[] } {
    const v = [-1, 1].flatMap((x) => [-1, 1].flatMap((y) => [-1, 1].map((z) => [x, y, z])));
    const positions = new Float32Array(v.flat());
    const idx = (x: number, y: number, z: number): number => ((x + 1) / 2) * 4 + ((y + 1) / 2) * 2 + (z + 1) / 2;
    const polygons: PcPolygon[] = [];
    // each face: the 4 corners on the axis side `s`, wound so that (b - a) x (c - a) points outward (PC front = inward)
    for (const axis of [0, 1, 2])
        for (const s of [-1, 1]) {
            const corners: number[] = [];
            for (const [u, w] of [
                [-1, -1],
                [1, -1],
                [1, 1],
                [-1, 1],
            ] as const) {
                const p = [0, 0, 0];
                p[axis] = s;
                p[(axis + 1) % 3] = u;
                p[(axis + 2) % 3] = w;
                corners.push(idx(p[0]!, p[1]!, p[2]!));
            }
            // (axis+1, axis+2) is right-handed with axis: counter-clockwise seen from +axis -> normal +axis
            const ccwOutward = s > 0 ? corners : [...corners].reverse();
            const quad = inward ? ccwOutward : [...ccwOutward].reverse();
            polygons.push(
                { flags: 0x8000, texture: 0, indices: [quad[0]!, quad[1]!, quad[2]!], uvs: [] },
                { flags: 0x8000, texture: 0, indices: [quad[0]!, quad[2]!, quad[3]!], uvs: [] },
            );
        }
    return { positions, polygons };
}

describe('inward shells', () => {
    it('finds a closed box whose faces look inward, not an ordinary prop or an open or double-sided one', () => {
        expect(isInwardShell(cube(true))).toBe(true);
        expect(isInwardShell(cube(false))).toBe(false); // a crate
        const open = cube(true);
        open.polygons.splice(0, 2);
        expect(isInwardShell(open)).toBe(false);
        const twoSided = cube(true);
        twoSided.polygons[3]!.flags |= 2;
        expect(isInwardShell(twoSided)).toBe(false);
    });

    // The Intro: a black box of half size 10 cells x 0.5 around the owl, the camera starts outside its +X wall.
    const box = cube(true);
    // stored Y 90 = no turn (the engine subtracts 90 degrees)
    const at = { pos: [26625, 209899, 30379] as const, rot: [0, 90, 0] as const, scale: [5, 5, 5] as const };
    const half = 5 * MODEL_UNIT;
    const side = (m: typeof box, axis: number, sign: number): number[] =>
        m.polygons.flatMap((p, i) => (p.indices.every((k) => m.positions[k * 3 + axis]! * sign > 0) ? [i] : []));
    const plusX = (m: typeof box): number[] => side(m, 0, 1);

    it('drops only the walls the PC culls from a camera outside the box', () => {
        const hidden = shellWallsHiddenFrom(box, at, [[46821, 208887, 30653]])!;
        expect([...hidden].sort()).toEqual(plusX(box).sort());
        // a camera inside hides nothing; one beyond the draw distance is ignored
        expect(shellWallsHiddenFrom(box, at, [[30728, 210271, 30198]])!.size).toBe(0);
        expect(shellWallsHiddenFrom(box, at, [[228102, 207372, 193421]], 30 * MODEL_UNIT)!.size).toBe(0);
        expect(shellWallsHiddenFrom(box, at, [[at.pos[0] + half + 100, at.pos[1], at.pos[2]]])!.size).toBe(2);
    });

    it('turns the walls by the stored Y rotation minus 90 degrees and leaves tilted placements alone', () => {
        // stored 0 (the Intro's box): yaw -90, so the model's -Z wall faces the camera at +X
        const turned = shellWallsHiddenFrom(box, { ...at, rot: [0, 0, 0] }, [[46821, 208887, 30653]])!;
        expect([...turned].sort()).toEqual(side(box, 2, -1).sort());
        expect(shellWallsHiddenFrom(box, { ...at, rot: [10, 90, 0] }, [[46821, 208887, 30653]])).toBeNull();
    });

    it('keeps walls another placement needs', () => {
        expect(mergeShellDrops([new Set([6, 7]), new Set([7, 8])])).toEqual(new Set([7]));
        expect(mergeShellDrops([new Set([6]), null])).toBeNull();
        expect(mergeShellDrops([new Set()])).toBeNull();
    });

    it('reads the PC draw distance from the Level Properties class', () => {
        const props = {
            id: 1,
            name: 'Level Properties',
            group: 0,
            runtimeClass: 0,
            model: null,
            rflClass: 54,
            icon: 0,
            fields: [{ type: 1, name: 'Max Fog Depth (lu)' }],
            data: [20],
        };
        expect(pcViewDistance({ classes: new Map([[0, new Map([[1, props]])]]) })).toBe(20 * MODEL_UNIT);
        expect(pcViewDistance({ classes: new Map() })).toBe(30 * MODEL_UNIT);
    });
});

describe('cinematic levels', () => {
    const level = (path: string, rfls: number[]): Parameters<typeof isCinematicLevel>[0] => ({
        path,
        list: { objects: rfls.map((_, i) => ({ id: i + 1, dbIndex: 0, classId: i + 1 })) } as never,
        classes: new Map([[0, new Map(rfls.map((rflClass, i) => [i + 1, { rflClass } as never]))]]),
    });

    it('trims shells only in a level with no player that is not an arena', () => {
        expect(isCinematicLevel(level('Mountain World/Intro Level/Intro.lvl', [17, 27]))).toBe(true);
        // Succubus Lair: Rynn plays inside its "sky" shell
        expect(isCinematicLevel(level('Islands World/Succubus Lair/Succubus Lair.lvl', [17, 9, 27]))).toBe(false);
        expect(isCinematicLevel(level('Multiplayer/Air/Nemesis/Nemesis.lvl', [17, 18]))).toBe(false);
    });
});
