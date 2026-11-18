import { describe, expect, it } from 'vitest';
import {
    offsetModelFaces,
    separateBackToBackFaces,
    touchingModelOffsets,
    type SeamPlacement,
} from '../src/ootfcoincident.ts';
import type { PcModel } from '../src/ootfmodel.ts';
import { MODEL_UNIT } from '../src/ootfshell.ts';

const opaque = new Map([
    [0, 10],
    [1, 11],
]);

function opposingFaces(depth = 0.00005, height = 1.2): PcModel {
    return {
        id: 14,
        name: 'Two-sided wall',
        shading: 0,
        textures: [
            { id: 88, db: 0 },
            { id: 90, db: 0 },
        ],
        positions: Float32Array.from(
            [
                [0, 0, 0],
                [0, 1, 0],
                [0, 1, 1],
                [0, 0, 1],
                [depth, height, 0.05],
                [depth, height, 0.95],
            ].flat(),
        ),
        polygons: [
            { flags: 0, texture: 0, indices: [0, 1, 2, 3], uvs: [0, 0, 1, 0, 1, 1, 0, 1] },
            { flags: 0, texture: 1, indices: [3, 5, 0], uvs: [0, 0, 1, 0, 1, 1] },
            { flags: 0, texture: 1, indices: [0, 5, 4], uvs: [0, 0, 1, 0, 1, 1] },
        ],
        lodLinks: [],
        bounds: new Uint8Array([1, 2, 3]),
        character: false,
    };
}

describe('separating back-to-back surfaces', () => {
    it('moves the opaque quad toward its PC front, retaining both materials and adjacent vertices', () => {
        const wall = opposingFaces();
        const repaired = separateBackToBackFaces(wall, opaque);
        const quad = repaired.polygons[0]!;
        expect(repaired.positions.slice(0, wall.positions.length)).toEqual(wall.positions);
        expect(quad.indices).toEqual([6, 7, 8, 9]);
        for (const [i, v] of quad.indices.entries()) {
            expect(repaired.positions[v * 3]).toBe(-16 / MODEL_UNIT);
            expect(repaired.positions.slice(v * 3 + 1, v * 3 + 3)).toEqual(wall.positions.slice(i * 3 + 1, i * 3 + 3));
        }
        expect(quad.uvs).toEqual(wall.polygons[0]!.uvs);
        expect(quad.texture).toBe(0);
        expect(repaired.polygons.slice(1)).toEqual(wall.polygons.slice(1));
        expect(repaired.bounds).toEqual(wall.bounds);
        expect(separateBackToBackFaces(repaired, opaque)).toBe(repaired);
    });

    it('keeps corner contact, a tilted face, and faces with matching winding', () => {
        const corner = opposingFaces(0, 0.4);
        expect(separateBackToBackFaces(corner, opaque)).toBe(corner);
        const tilted = opposingFaces(0.01);
        expect(separateBackToBackFaces(tilted, opaque)).toBe(tilted);
        const sameWinding = opposingFaces();
        sameWinding.polygons[1]!.indices.reverse();
        sameWinding.polygons[2]!.indices.reverse();
        expect(separateBackToBackFaces(sameWinding, opaque)).toBe(sameWinding);
    });

    it('keeps double-sided, transparent, removed and same-material faces', () => {
        const twoSided = opposingFaces();
        twoSided.polygons[0]!.flags = 2;
        expect(separateBackToBackFaces(twoSided, opaque)).toBe(twoSided);
        const wall = opposingFaces();
        expect(separateBackToBackFaces(wall, new Map([[0, 10]]))).toBe(wall);
        expect(separateBackToBackFaces(wall, opaque, new Set([2]))).toBe(wall);
        expect(
            separateBackToBackFaces(
                wall,
                new Map([
                    [0, 10],
                    [1, 10],
                ]),
            ),
        ).toBe(wall);
    });
});

function placedWalls(): [SeamPlacement, SeamPlacement] {
    const left = opposingFaces();
    const right = opposingFaces();
    const face = [
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 1],
    ];
    // Model coordinates are turned through -90 degrees by stored yaw 0, so the touching world axis is Z.
    left.positions = Float32Array.from([...face.map(([y, z]) => [1, y, z]), [0, 0, 0]].flat());
    right.positions = Float32Array.from([...face.map(([y, z]) => [0, y, z]), [2, 0, 0]].flat());
    left.polygons = [
        { ...left.polygons[1]!, texture: 0, indices: [0, 1, 2] },
        { ...left.polygons[1]!, indices: [0, 2, 3] },
    ];
    right.polygons = [
        { ...right.polygons[1]!, indices: [2, 1, 0] },
        { ...right.polygons[1]!, indices: [3, 2, 0] },
    ];
    return [
        { source: 'walls', model: left, at: { pos: [0, 0, 0], rot: [0, 0, 0], scale: null } },
        { source: 'walls', model: right, at: { pos: [0, 0, MODEL_UNIT], rot: [0, 0, 0], scale: null } },
    ];
}

describe('seams between placed static models', () => {
    it('separates both material regions of the smaller boundary toward its PC front', () => {
        const [left, right] = placedWalls();
        const offsets = touchingModelOffsets([left, right]);
        expect([...offsets.keys()]).toEqual([left]);
        const moved = offsets.get(left)!;
        expect([...moved.values()]).toEqual([
            { axis: 0, delta: -16 / MODEL_UNIT },
            { axis: 0, delta: -16 / MODEL_UNIT },
        ]);
        const fixed = offsetModelFaces(left.model, moved);
        expect(fixed.positions.length / 3).toBe(9);
        expect(fixed.polygons[0]!.indices).toEqual([5, 6, 7]);
        expect(fixed.polygons[1]!.indices).toEqual([5, 7, 8]);
        expect(fixed.positions[5 * 3]).toBe(1 - 16 / MODEL_UNIT);
    });

    it('keeps gaps, scaled placements and boundaries without a material conflict', () => {
        const [left, right] = placedWalls();
        right.at.pos[2] += 8;
        expect(touchingModelOffsets([left, right]).size).toBe(0);
        right.at.pos[2] -= 8;
        right.at.scale = [2, 1, 1];
        expect(touchingModelOffsets([left, right]).size).toBe(0);
        right.at.scale = null;
        left.model.polygons[0]!.texture = 1;
        expect(touchingModelOffsets([left, right]).size).toBe(0);
    });
});
