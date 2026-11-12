// Scene creature classes found from any level's own class objects (sceneTockLookup). Synthetic classes; no game bytes.
import { describe, expect, it } from 'vitest';
import { sceneTockLookup } from '../src/ootfpipeline.ts';
import type { OdbClass } from '../src/odb.ts';

const cls = (name: string, data: number[] = [0, 5]): OdbClass => ({
    id: 3345,
    name,
    group: 1,
    runtimeClass: 0x10011,
    rflClass: 17,
    model: { id: 3713, db: 4 },
    data,
});
const sig = (c: OdbClass): string => `${c.name}|${c.rflClass}|${(c.data ?? []).join(',')}`;

describe('sceneTockLookup', () => {
    it("finds the entry from another level's equal class object (the plan keeps only the first level's)", () => {
        const village = cls('Heuge Purple');
        const volcanic = cls('Heuge Purple'); // parsed again from the Volcanic level: equal, not the same object
        const find = sceneTockLookup(new Map([[village, 'disc purple orc']]), sig);
        expect(find(village)).toBe('disc purple orc');
        expect(find(volcanic)).toBe('disc purple orc');
    });

    it('does not match a class with another name or other defaults', () => {
        const find = sceneTockLookup(new Map([[cls('Heuge Purple'), 'disc purple orc']]), sig);
        expect(find(cls('Heuge Yellow'))).toBeUndefined();
        expect(find(cls('Heuge Purple', [1, 5]))).toBeUndefined();
    });

    it('returns nothing when no class plays on a disc model', () => {
        expect(sceneTockLookup(new Map<OdbClass, string>(), sig)(cls('Heuge Purple'))).toBeUndefined();
    });
});
