// Faders that only an unconverted cut scene starts. Synthetic sequences; no game bytes.
import { describe, expect, it } from 'vitest';
import { unplayedSceneActors, type PcSequence } from '../src/ootfseq.ts';

function seq(id: number, objectIds: number[], actorType = 1): PcSequence {
    return {
        id,
        group: 1,
        name: `s${id}`,
        flags: 0,
        modifyRunState: 0,
        unk2: 0,
        actors: objectIds.map((objectId, i) => ({
            name: `a${i}`,
            id: i,
            actorType,
            assignedAs: 0,
            objectId,
            actions: [],
        })),
    };
}

describe('unplayedSceneActors', () => {
    it('returns candidates that only an unplayed sequence uses', () => {
        const out = unplayedSceneActors([{ key: 'book|1', seq: seq(1, [10, 11, 12]) }], new Set(), new Set([10, 11]));
        expect([...out].sort()).toEqual([10, 11]);
    });

    it('keeps candidates a played sequence also uses', () => {
        const out = unplayedSceneActors(
            [
                { key: 'book|1', seq: seq(1, [10, 11]) },
                { key: 'book|2', seq: seq(2, [11]) },
            ],
            new Set(['book|2']),
            new Set([10, 11]),
        );
        expect([...out]).toEqual([10]);
    });

    it('ignores candidates no sequence names and non-object actors', () => {
        expect(unplayedSceneActors([{ key: 'a|1', seq: seq(1, [10]) }], new Set(), new Set([99])).size).toBe(0);
        expect(unplayedSceneActors([{ key: 'a|1', seq: seq(1, [10], 2) }], new Set(), new Set([10])).size).toBe(0);
    });
});
