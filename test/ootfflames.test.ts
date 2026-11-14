// Drakan 2 particle fire for converted OotF flames (ootfflames.ts). Synthetic fixtures only: no game data.
import { describe, expect, it } from 'vitest';
import { flameFoot, flameOffset, isSmallFlame, moveClassRef, placedOffset } from '../src/ootfflames.ts';

describe('flame foot', () => {
    it('is the centre across and the lowest point of the flame card', () => {
        // a crossed card 0.05 wide, 0.6 to 0.75 high, 0.05 in front of the origin
        const p = [-0.025, 0.6, 0.05, 0.025, 0.75, 0.05, 0, 0.6, 0.025, 0, 0.75, 0.075];
        expect(flameFoot(p)).toEqual([0, 0.6, 0.05]);
        expect(flameFoot([])).toBeNull();
    });
});

describe('placed offset', () => {
    it('scales and turns the point as the engine places the model', () => {
        const near = (a: readonly number[] | null, b: readonly number[]) =>
            a!.forEach((v, i) => expect(v).toBeCloseTo(b[i]!, 6));
        // stored Y 90 = no turn: model +x stays +x, +z stays +z (1 model unit = 2048 world units)
        near(placedOffset({ rot: [0, 90, 0], scale: null }, [0.5, 1, 0.25]), [1024, 2048, 512]);
        // stored Y 0 = a quarter turn: x' = x cos + z sin, z' = z cos - x sin with the angle -90 degrees
        near(placedOffset({ rot: [0, 0, 0], scale: null }, [0.5, 1, 0]), [0, 2048, 1024]);
        near(placedOffset({ rot: [0, 180, 0], scale: [2, 0.5, 1] }, [0.5, 1, 0]), [0, 1024, -2048]);
        expect(placedOffset({ rot: [10, 0, 0], scale: null }, [0, 1, 0])).toBeNull();
    });
});

describe('class reference between databases', () => {
    const dbs: Record<string, Record<number, string>> = {
        HOST: { 1: 'SYSTEM', 6: 'WORLD' },
        WORLD: { 2: 'FX' },
    };
    const containerStem = (stem: string, db: number) => (db === 0 ? stem : (dbs[stem]?.[db] ?? null));
    const dbIndexIn = (from: string, to: string) => {
        if (from === to) return 0;
        const e = Object.entries(dbs[from] ?? {}).find(([, s]) => s === to);
        return e ? Number(e[0]) : null;
    };
    it('names the same class from the other database', () => {
        expect(moveClassRef(1966, 'WORLD', 'HOST', containerStem, dbIndexIn)).toBe((6 << 16) | 1966);
        expect(moveClassRef((2 << 16) | 5, 'WORLD', 'WORLD', containerStem, dbIndexIn)).toBe((2 << 16) | 5);
        expect(moveClassRef((6 << 16) | 7, 'HOST', 'WORLD', containerStem, dbIndexIn)).toBe(7);
    });
    it('gives null for an empty reference or a database the other one does not list', () => {
        expect(moveClassRef(0, 'WORLD', 'HOST', containerStem, dbIndexIn)).toBeNull();
        expect(moveClassRef((2 << 16) | 5, 'WORLD', 'HOST', containerStem, dbIndexIn)).toBeNull();
    });
});

describe('flame offset', () => {
    it('moves a near foot of a tilted flame by its turn alone and keeps a far one where it is', () => {
        expect(flameOffset({ rot: [0, 90, 10], scale: null }, [0, 0.01, 0])?.[1]).toBeCloseTo(20.48, 6);
        expect(flameOffset({ rot: [0, 90, 10], scale: null }, [0, 0.6, 0])).toBeNull();
        expect(flameOffset({ rot: [0, 90, 0], scale: null }, [0, 0.6, 0])?.[1]).toBeCloseTo(1228.8, 6);
    });
});

describe('small flames', () => {
    it('are the ones placed below half size on their largest axis', () => {
        expect(isSmallFlame({ scale: [0.2, 0.2, 0.2] })).toBe(true);
        expect(isSmallFlame({ scale: [0.2, 0.7, 0.2] })).toBe(false);
        expect(isSmallFlame({ scale: null })).toBe(false);
    });
});
