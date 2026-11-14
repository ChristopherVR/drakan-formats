// Synthetic fixtures only; no game bytes.
import { describe, expect, it } from 'vitest';
import type { OdbClass } from '../src/index.ts';
import {
    PC_VOICE_SKIPPED_FIELDS,
    classAnimations,
    classFieldSounds,
    clipSoundList,
    mergeSoundSwaps,
    writeSoundSwaps,
} from '../src/ootfsoundswaps.ts';

const T_SOUND = 5;
const T_ANIM = 9;
const T_SOUND_LIST = 0x1005;
const T_ANIM_LIST = 0x1009;

function cls(fields: [number, string][], data: number[]): OdbClass {
    return {
        id: 1,
        name: 'Test',
        group: 0,
        runtimeClass: 0,
        model: null,
        rflClass: 49,
        icon: 0,
        fields: fields.map(([type, n]) => ({ type, name: n })),
        data,
    } as OdbClass;
}

describe('sound swaps', () => {
    it('reads the sounds and animations a class names', () => {
        // a list field stores (count << 16) | offset into the data area
        const c = cls(
            [
                [T_SOUND, 'Drown Sound'],
                [T_SOUND_LIST, 'Attack Grunts'],
                [T_ANIM, 'Idle'],
                [T_ANIM_LIST, 'Walks'],
            ],
            [0x2009b, (2 << 16) | 4, 0x10001, (2 << 16) | 6, 0x20191, 0x20193, 0x10002, 0],
        );
        expect(classFieldSounds(c, 0)).toEqual([0x2009b]);
        expect(classFieldSounds(c, 1)).toEqual([0x20191, 0x20193]);
        expect(classFieldSounds(c, 2)).toEqual([]); // not a sound field
        expect(classAnimations(c)).toEqual([0x10001, 0x10002]);
    });

    it('decodes a clip sound list', () => {
        const b = new Uint8Array([2, 0, 0xee, 3, 0, 0, 0xf6, 3, 0, 0]);
        expect(clipSoundList(b)).toEqual([0x3ee, 0x3f6]);
        expect(clipSoundList(b.subarray(0, 6))).toEqual([0x3ee]); // short: what is there
        expect(clipSoundList(null)).toEqual([]);
    });

    it('merges ids named twice and writes the table', () => {
        const m = mergeSoundSwaps([
            { from: [0x201a1, 0x201a2], to: [0x3025b], why: 'Rynn: HitRxn HSL' },
            { from: [0x201a2, 0x201a9], to: [0x30261], why: 'Rynn: HitRxn HSH' },
            { from: [0x503ee], to: [], why: 'Wartok: idle and walk sounds off' },
        ]);
        expect(m.shared).toBe(1);
        expect(m.swaps.map((s) => s.from)).toEqual([[0x201a1, 0x201a2], [0x201a9], [0x503ee]]);
        expect(m.swaps[0]!.to).toEqual([0x3025b, 0x30261]);
        const text = writeSoundSwaps(m.swaps);
        expect(text).toContain('# Rynn: HitRxn HSL\n0x201a1 0x201a2 = 0x3025b 0x30261\n');
        expect(text).toContain('0x503ee = none\n');
        expect(text).not.toMatch(/—/);
    });

    it('keeps loops and body sounds out of the voices', () => {
        expect(PC_VOICE_SKIPPED_FIELDS.test('Slide Sound (looped)')).toBe(true);
        expect(PC_VOICE_SKIPPED_FIELDS.test('Wing Flap Sounds')).toBe(true);
        expect(PC_VOICE_SKIPPED_FIELDS.test('Killed Enemy Sounds')).toBe(false);
    });
});
