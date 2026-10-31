import { describe, expect, it } from 'vitest';
import {
    FIELDS,
    ITEM_PTR_GAP,
    STATS_KEY,
    STAT_OFFSETS,
    SaveFieldError,
    SaveFormatError,
    applyFieldEdits,
    listQuests,
    assembleSave,
    decodeScreenshot,
    describeRecords,
    dec,
    diffSaves,
    enc,
    getField,
    listInventory,
    levelNameOf,
    listSkills,
    nextBackupName,
    parseFieldValue,
    parseSave,
    probeField,
    sameBytes,
    slotNumber,
    statsBase,
    summarizeSave,
} from '../src/index.ts';
import { buildSave, saveEntries, skillTable } from './savefixture.ts';

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

describe('Live-memory fields (stats block, inventory cells, quest rows)', () => {
    const CELL_BASE = 0x302; // 2-byte phase like the real layouts
    const HANDLES = [0xa59e30, 0x9edd30];

    function liveText(maxhp = 100): Uint8Array {
        const d = skillTable([
            [1, 8],
            [1, 8],
            [1, 8],
        ]).slice();
        const dv = new DataView(d.buffer);
        dv.setUint32(0x80, 2, true);
        [110, 100, 0, 0, 1, 0, 0x10c7, 4].forEach((v, i) => dv.setUint32(0x84 + 4 * i, v, true));
        [0, 0, 0, 0, 1, 0, 0x1047, 2].forEach((v, i) => dv.setUint32(0xa4 + 4 * i, v, true));
        dv.setUint32(0x100, 0xbb6050, true);
        dv.setUint32(0x104, 6, true);
        dv.setUint32(0x108, 3, true);
        const vals: Record<string, number> = {
            hp: 84,
            maxhp: maxhp,
            gold: 646,
            mana: 100,
            maxmana: 100,
            xp: 250,
            level: 1,
            skillpoints: 0,
        };
        for (const [name, off] of Object.entries(STAT_OFFSETS)) dv.setUint32(0x100 + off, enc(vals[name]!), true);
        return d;
    }

    function rynnWithCells(equipped: number): Uint8Array {
        const b = new Uint8Array(0x800);
        const dv = new DataView(b.buffer);
        dv.setUint32(0, 0xa50, true);
        dv.setUint32(8, 0x17081069, true);
        dv.setInt32(CELL_BASE - 4, -1, true);
        dv.setInt32(CELL_BASE - 0x14, -1, true);
        dv.setUint32(CELL_BASE - 0x10, 1, true);
        [equipped, 0, HANDLES[0]!, 0].forEach((v, i) => dv.setUint32(CELL_BASE + 4 * i, v, true));
        [0, 0, HANDLES[1]!, 0].forEach((v, i) => dv.setUint32(CELL_BASE + 16 + 4 * i, v, true));
        [0, 0, 1, 0].forEach((v, i) => dv.setUint32(CELL_BASE + 16 * 8 + 4 * i, v, true));
        return b;
    }

    function itemEntry(handle: number, resource: number, cur: number, max: number, extra = 0): Uint8Array {
        const b = new Uint8Array(0x300);
        const dv = new DataView(b.buffer);
        dv.setUint32(0, resource - 0x20000, true);
        dv.setUint32(8, 0x19001041, true);
        const at = 0x40 + extra;
        dv.setUint32(at, handle, true);
        dv.setUint32(at + 8, enc(cur), true);
        dv.setUint32(at + 12, enc(max), true);
        dv.setUint32(at + ITEM_PTR_GAP, handle, true);
        return b;
    }

    const live = () =>
        parseSave(
            buildSave([
                { type: 0x401, id: 893, data: liveText() },
                { type: 0x102, id: 56, data: rynnWithCells(1) },
                { type: 0x102, id: 301, data: itemEntry(HANDLES[0]!, 0x31bc9, 181, 200) },
                { type: 0x102, id: 361, data: itemEntry(HANDLES[1]!, 0x3217b, 144, 150, 0x46) },
            ]),
        );

    it('obfuscation matches the game (enc(0) is the key, round trip)', () => {
        expect(enc(0)).toBe(STATS_KEY);
        expect(dec(enc(0xdeadbeef))).toBe(0xdeadbeef);
        expect(dec(0x739a9945)).toBe(84); // HP word seen in RAM and in a real save
    });

    it('reads and edits the stats block', () => {
        const save = live();
        expect(getField(save, 'stat.maxhp')).toBe(100);
        expect(getField(save, 'stat.gold')).toBe(646);
        const edited = applyFieldEdits(save, [
            { name: 'stat.maxhp', value: 333 },
            { name: 'stat.level', value: 5 },
        ]);
        expect(getField(edited, 'stat.maxhp')).toBe(333);
        expect(getField(edited, 'stat.level')).toBe(5);
        expect(getField(edited, 'stat.hp')).toBe(84);
        const { entry, base } = statsBase(edited);
        expect(new DataView(entry.data.buffer, entry.data.byteOffset).getUint32(base + 0x10, true)).toBe(enc(333));
    });

    it('lists the inventory and edits cells and items', () => {
        const save = live();
        const rows = listInventory(save);
        expect(rows.map((r) => r.cell)).toEqual([0, 1, 8]);
        expect([rows[0]!.resource, rows[0]!.durability, rows[0]!.max, rows[0]!.equipped]).toEqual([
            0x31bc9, 181, 200, 1,
        ]);
        expect(rows[1]!.durability).toBe(144); // pointer at another offset
        expect(rows[2]).toEqual({ cell: 8, marker: 1 });
        const edited = applyFieldEdits(save, [
            { name: 'inv.0.durability', value: 77 },
            { name: 'inv.1.hot', value: 1 },
            { name: 'inv.0.equipped', value: 0 },
        ]);
        expect(getField(edited, 'inv.0.durability')).toBe(77);
        expect(getField(edited, 'inv.0.max')).toBe(200);
        expect(getField(edited, 'inv.1.hot')).toBe(1);
        expect(getField(edited, 'inv.0.equipped')).toBe(0);
        expect(() => applyFieldEdits(save, [{ name: 'inv.0.hot', value: 2 }])).toThrow(SaveFieldError);
        expect(() => getField(save, 'inv.5.durability')).toThrow(/no item/);
    });

    it('reads quest rows', () => {
        const save = live();
        expect(getField(save, 'quest.0')).toBe(4);
        expect(getField(save, 'quest.1')).toBe(2);
        expect(() => getField(save, 'quest.2')).toThrow(SaveFieldError);
    });

    it('edits the quest done flag without touching the seen word', () => {
        const save = live();
        expect(getField(save, 'quest.1.done')).toBe(0);
        const edited = applyFieldEdits(save, [{ name: 'quest.1.done', value: 1 }]);
        expect(getField(edited, 'quest.1.done')).toBe(1);
        expect(getField(edited, 'quest.1')).toBe(2);
        expect(listQuests(edited)[1]!.icon).toBe(1);
        expect(listQuests(edited)[0]!.icon).toBe(0);
        expect(() => getField(save, 'quest.2.done')).toThrow(SaveFieldError);
    });
});
