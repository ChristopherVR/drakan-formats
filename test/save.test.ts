import { describe, expect, it } from 'vitest';
import {
    FIELDS,
    SaveFieldError,
    SaveFormatError,
    applyFieldEdits,
    assembleSave,
    decodeScreenshot,
    describeRecords,
    diffSaves,
    getField,
    levelNameOf,
    listSkills,
    nextBackupName,
    parseFieldValue,
    parseSave,
    probeField,
    sameBytes,
    slotNumber,
    summarizeSave,
} from '../src/index.ts';
import { buildSave, saveEntries } from './savefixture.ts';

describe('Save container', () => {
    it('round-trips byte for byte, keeping gaps, pad and compressed bytes', () => {
        const blob = buildSave();
        expect(sameBytes(assembleSave(parseSave(blob)).bytes, blob)).toBe(true);
        const s = parseSave(blob);
        expect(s.entries.some((e) => e.gap.length > 0)).toBe(true);
        expect(s.pad).toBe(0x1234);
    });

    it('keeps trailing bytes between the last payload and the index', () => {
        const s = parseSave(buildSave());
        s.tail = Uint8Array.from([1, 2, 3]);
        const bytes = assembleSave(s).bytes;
        expect(Array.from(parseSave(bytes).tail)).toEqual([1, 2, 3]);
        expect(sameBytes(assembleSave(parseSave(bytes)).bytes, bytes)).toBe(true);
    });

    it('rejects bad magic, a short file, a bad index and corrupt zlib', () => {
        expect(() => parseSave(new Uint8Array(4))).toThrow(SaveFormatError);
        const bad = buildSave().slice();
        bad[0] = 0x58;
        expect(() => parseSave(bad)).toThrow(/magic/);
        const whole = buildSave();
        expect(() => parseSave(whole.subarray(0, whole.length - 3))).toThrow(/index/);
        const z = buildSave().slice();
        for (let i = 24; i < 40; i++) z[i] = z[i]! ^ 0xff;
        expect(() => parseSave(z)).toThrow(SaveFormatError);
    });
});

describe('Save fields', () => {
    const save = parseSave(buildSave());

    it('reads hp, gold, position and skills', () => {
        expect(getField(save, 'hp')).toBe(84);
        expect(getField(save, 'gold')).toBe(376);
        expect(getField(save, 'pos')).toEqual([1000, 2000, 3000]);
        expect(getField(save, 'skill.1')).toBe(1);
        expect(getField(save, 'skill.2.max')).toBe(5);
        expect(listSkills(save)).toEqual([
            { id: 1, name: 'Melee', level: 1, max: 8 },
            { id: 2, name: 'Archery', level: 2, max: 5 },
            { id: 3, name: 'Magic', level: 2, max: 6 },
        ]);
    });

    it('edits only the touched entries and leaves the rest with their original compressed bytes', () => {
        const edited = applyFieldEdits(save, [
            { name: 'gold', value: 9999 },
            { name: 'pos', value: [1, 2.5, -3] },
        ]);
        expect(getField(edited, 'gold')).toBe(9999);
        expect(getField(edited, 'pos')).toEqual([1, 2.5, -3]);
        const changed = edited.entries.filter((e, i) => e !== save.entries[i]).map((e) => e.index);
        expect(changed).toHaveLength(2);
        for (const e of edited.entries) {
            const orig = save.entries[e.index]!;
            if (changed.includes(e.index)) expect(sameBytes(e.raw, orig.raw)).toBe(false);
            else expect(e.raw).toBe(orig.raw);
        }
        const again = parseSave(assembleSave(edited).bytes);
        expect(getField(again, 'gold')).toBe(9999);
        const g = (s: typeof save) => s.entries.find((e) => e.id === 63)!.data;
        let diff = 0;
        g(save).forEach((v, i) => {
            if (v !== g(again)[i]) diff++;
        });
        expect(diff).toBeGreaterThan(0);
        expect(diff).toBeLessThanOrEqual(2);
        expect(getField(save, 'gold')).toBe(376); // the input is never modified
    });

    it('keeps the original bytes when an edit does not change anything', () => {
        const same = applyFieldEdits(save, [{ name: 'gold', value: 376 }]);
        expect(sameBytes(assembleSave(same).bytes, buildSave())).toBe(true);
    });

    it('checks ranges and skill bounds on the final state', () => {
        expect(() => applyFieldEdits(save, [{ name: 'gold', value: -1 }])).toThrow(SaveFieldError);
        expect(() => applyFieldEdits(save, [{ name: 'hp', value: 2 ** 32 }])).toThrow(/u32/);
        expect(() => applyFieldEdits(save, [{ name: 'pos', value: [NaN, 0, 0] }])).toThrow(/finite/);
        expect(() => applyFieldEdits(save, [{ name: 'skill.1', value: 9 }])).toThrow(/exceed max/);
        const both = applyFieldEdits(save, [
            { name: 'skill.1', value: 12 },
            { name: 'skill.1.max', value: 15 },
        ]);
        expect(getField(both, 'skill.1')).toBe(12);
        expect(() => applyFieldEdits(save, [{ name: 'skill.1.max', value: 0 }])).toThrow(/exceed max/);
        expect(() => applyFieldEdits(save, [{ name: 'nope', value: 1 }])).toThrow(/unknown field/);
        expect(() => applyFieldEdits(save, [{ name: 'skill.9', value: 1 }])).toThrow(/no unique skill row/);
    });

    it('treats an entry-id mismatch as unconfirmed and needs force', () => {
        const other = parseSave(buildSave(saveEntries({ rynnId: 53 })));
        expect(() => getField(other, 'hp')).toThrow(/verified only for id 56/);
        expect(probeField(other, 'hp').status).toBe('unconfirmed');
        expect(probeField(other, 'pos').status).toBe('ok'); // pos is matched by class alone
        expect(() => applyFieldEdits(other, [{ name: 'hp', value: 5 }])).toThrow(/verified only/);
        const forced = applyFieldEdits(other, [{ name: 'hp', value: 5, force: true }]);
        expect(getField(forced, 'hp', true)).toBe(5);
    });

    it('reports missing records', () => {
        const none = parseSave(buildSave(saveEntries({ withGold: false })));
        expect(probeField(none, 'gold').status).toBe('missing');
        expect(probeField(save, 'hp').status).toBe('ok');
    });

    it('parses user text', () => {
        expect(parseFieldValue(FIELDS.gold!, ' 42 ')).toBe(42);
        expect(parseFieldValue(FIELDS.gold!, '0x10')).toBe(16);
        expect(() => parseFieldValue(FIELDS.gold!, '1.5')).toThrow();
        expect(parseFieldValue(FIELDS.pos!, '1, 2,3.5')).toEqual([1, 2, 3.5]);
        expect(() => parseFieldValue(FIELDS.pos!, '1,2')).toThrow();
        expect(() => parseFieldValue(FIELDS.pos!, '1,,3')).toThrow();
    });
});

describe('Save summaries', () => {
    it('decodes the CT16 screenshot and the level strings', () => {
        const blob = buildSave();
        const sum = summarizeSave(blob);
        expect(sum.levelName).toBe('Testland');
        expect(sum.levelPath).toContain('Level 1A - Test.lvl');
        expect(sum.entryCount).toBe(parseSave(blob).entries.length);
        const shot = sum.screenshot!;
        expect([shot.width, shot.height]).toEqual([8, 4]);
        // 0x801f: R=31 -> red; 0xfc00: B=31 -> blue; both opaque.
        expect(Array.from(shot.rgba.subarray(0, 4))).toEqual([255, 0, 0, 255]);
        expect(Array.from(shot.rgba.subarray(4, 8))).toEqual([0, 0, 255, 255]);
        expect(levelNameOf(parseSave(blob))).toBe('Testland');
        expect(decodeScreenshot(new Uint8Array(8))).toBeNull();
    });

    it('lists records with class and plausible positions', () => {
        const recs = describeRecords(parseSave(buildSave()));
        const rynn = recs.find((r) => r.classId === 0x17081069)!;
        expect(rynn.pos).toEqual([1000, 2000, 3000]);
        expect(recs.filter((r) => r.type === 0x102)).toHaveLength(5);
        expect(recs.find((r) => r.type === 0x104)!.pos).toBeUndefined();
    });
});

describe('Save compare and files', () => {
    it('diffs fields and entries', () => {
        const a = parseSave(buildSave());
        const b = applyFieldEdits(a, [
            { name: 'gold', value: 10 },
            { name: 'skill.3', value: 4 },
        ]);
        const d = diffSaves(a, parseSave(assembleSave(b).bytes));
        expect(d.fields.filter((f) => f.changed).map((f) => f.name)).toEqual(['gold', 'skill.3']);
        expect(d.counts.changed).toBe(2);
        expect(d.counts.unchanged).toBe(a.entries.length - 2);
        const gold = d.entries.find((e) => e.status === 'changed' && e.id === 63)!;
        expect(gold.bytesChanged).toBeGreaterThan(0);
        const self = diffSaves(a, a);
        expect(self.counts.changed + self.counts.onlyA + self.counts.onlyB).toBe(0);
    });

    it('reports entries present in one save only, and recompression', () => {
        const a = parseSave(buildSave());
        const b = parseSave(buildSave(saveEntries({ extraRecords: 1 })));
        const d = diffSaves(a, b);
        expect(d.counts.onlyA).toBe(2);
        expect(d.counts.onlyB).toBe(0);
        const re = {
            ...a,
            entries: a.entries.map((e, i) => (i === 0 ? { ...e, raw: Uint8Array.from(e.raw).fill(0) } : e)),
        };
        expect(diffSaves(a, re).entries[0]!.recompressed).toBe(true);
        expect(diffSaves(a, a).entries[0]!.recompressed).toBe(false);
    });

    it('names backups without replacing an existing one', () => {
        expect(nextBackupName(['a.rsg'], 'a.rsg')).toBe('a.rsg.bak');
        expect(nextBackupName(['a.rsg', 'a.rsg.bak', 'a.rsg.bak.1'], 'a.rsg')).toBe('a.rsg.bak.2');
        expect(slotNumber('BESCES-50006Slot12')).toBe(12);
        expect(slotNumber('mc0')).toBeNull();
    });
});
