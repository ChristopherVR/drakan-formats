// Synthetic data only; no game bytes.
import { describe, expect, it } from 'vitest';
import { skinnedLodPolygons } from '../src/ootfassets.ts';

type Cap = { values: [number, number, number, number, number]; weights: never[] };
const cap = (values: [number, number, number, number, number]): Cap => ({ values, weights: [] });
const lod = (firstPoly: number, polyCount: number) => ({
    distance: 0,
    usage: 1,
    node: 0,
    firstVertex: 0,
    vertexCount: 10,
    firstPoly,
    polyCount,
});

describe('skinnedLodPolygons', () => {
    // LOD 0 holds polygons 0..11: body 0..5, an arm 6..8 with its stump 9..10, a hand 11 whose stump (12) is not counted in
    // polyCount; LOD 1 starts at 13. polyCount (10) leaves out the 3 stump polygons, so slicing it cut the hand and the arm's end.
    const polygons = Array.from({ length: 16 }, (_, i) => i);
    const sk = {
        lods: [lod(0, 10), lod(13, 3)],
        channels: [
            { joint: 0, caps: [cap([0, 0, 0, 6, 0])] },
            { joint: 3, caps: [cap([9, 2, 6, 3, 2])] },
            { joint: 4, caps: [cap([12, 1, 11, 1, 1])] },
        ],
    };

    it('keeps the whole LOD run up to the next LOD and leaves the stump caps out', () => {
        expect(skinnedLodPolygons(polygons, sk)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 11]);
    });

    it('ends at the last channel cap when the model has a single LOD', () => {
        expect(skinnedLodPolygons(polygons, { ...sk, lods: [lod(0, 10)] })).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 11]);
    });

    it('takes polyCount polygons when no channel has caps (a model that cannot be dismembered)', () => {
        expect(skinnedLodPolygons(polygons, { lods: [lod(0, 5), lod(5, 3)], channels: [] })).toEqual([0, 1, 2, 3, 4]);
    });
});
