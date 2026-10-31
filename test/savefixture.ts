// Synthetic .rsg builder for tests. Layout follows docs/journal/2026-10-31/save-editor.md; no real save bytes.
import { zlibSync } from 'fflate';

export interface SaveFixtureOptions {
    /** Entry id of the player record (the field table pins hp to 56). */
    rynnId?: number;
    hp?: number;
    gold?: number;
    pos?: [number, number, number];
    /** Skill rows as [level, max] for ids 1..3. */
    skills?: [number, number][];
    levelName?: string;
    withGold?: boolean;
    extraRecords?: number;
    /** State table rows [kind, key, value] appended to the skill/text payload. */
    progress?: [number, number, number][];
    /** Add an Arokh record (resource id 0xa60). */
    arokh?: [number, number, number];
    /** Write the item text of the Equipment page into Rynn's record (with the usual damaged line starts). */
    itemText?: boolean;
}

const LEVEL_PATH = 'Levels/Level 1A - Test/Level 1A - Test.lvl';

function lenString(s: string, pad = 2): Uint8Array {
    const b = new Uint8Array(2 + s.length + pad);
    new DataView(b.buffer).setUint16(0, s.length + pad, true);
    for (let i = 0; i < s.length; i++) b[2 + i] = s.charCodeAt(i);
    return b;
}

function record(classId: number, pos: [number, number, number], size: number): Uint8Array {
    const b = new Uint8Array(size);
    const dv = new DataView(b.buffer);
    dv.setUint32(0, 0xa50, true);
    dv.setUint32(8, classId, true);
    pos.forEach((x, i) => dv.setFloat32(12 + 4 * i, x, true));
    return b;
}

export function skillTable(skills: [number, number][], progress: [number, number, number][] = []): Uint8Array {
    const b = new Uint8Array(0x3d4 + 0x4c * skills.length + 8 + progress.length * 12);
    const dv = new DataView(b.buffer);
    dv.setUint32(0x3d0, skills.length, true);
    const names = ['Melee', 'Archery', 'Magic', 'Extra'];
    skills.forEach(([level, max], k) => {
        const o = 0x3d4 + k * 0x4c;
        dv.setUint32(o, k + 1, true);
        dv.setUint32(o + 4, level, true);
        dv.setUint32(o + 8, max, true);
        for (let i = 0; i < names[k]!.length; i++) b[o + 12 + i] = names[k]!.charCodeAt(i);
    });
    const base = 0x3d4 + 0x4c * skills.length + 8;
    progress.forEach(([kind, key, value], k) => {
        dv.setUint32(base + k * 12, kind, true);
        dv.setUint32(base + k * 12 + 4, key, true);
        dv.setUint32(base + k * 12 + 8, value, true);
    });
    return b;
}

export function screenshot(w = 8, h = 4): Uint8Array {
    const b = new Uint8Array(16 + w * h * 2);
    const dv = new DataView(b.buffer);
    dv.setUint32(0, w, true);
    dv.setUint32(4, h, true);
    dv.setUint32(8, 16, true);
    dv.setUint32(12, w * h * 2, true);
    for (let i = 0; i < w * h; i++) dv.setUint16(16 + i * 2, i === 0 ? 0x801f : 0xfc00, true); // red, blue
    return b;
}

export interface SaveSpecEntry {
    type: number;
    id: number;
    sub?: number;
    data: Uint8Array;
}

/** Entries of a typical save, in file order. */
export function saveEntries(o: SaveFixtureOptions = {}): SaveSpecEntry[] {
    const rynn = record(0x17081069, o.pos ?? [1000, 2000, 3000], 0x720);
    new DataView(rynn.buffer).setUint32(0x708, o.hp ?? 84, true);
    if (o.itemText) {
        const put = (at: number, text: string): void => {
            for (let i = 0; i < text.length; i++) rynn[at + i] = text.charCodeAt(i);
        };
        put(0x100, 'Wood Club');
        put(0x140, 'Skill Needed: 1');
        put(0x181, '?Damage: 8');
        put(0x1c0, 'L=Speed: Medium');
        put(0x202, 'ange: Short');
        put(0x240, 'u?Durability: 144/150');
        put(0x280, 'W=In left hand');
    }
    const entries: SaveSpecEntry[] = [
        { type: 0x23, id: 0, data: screenshot() },
        { type: 0x400, id: 0, data: lenString(LEVEL_PATH) },
        { type: 0x401, id: 891, data: lenString(o.levelName ?? 'Testland', 3) },
        {
            type: 0x401,
            id: 893,
            data: skillTable(
                o.skills ?? [
                    [1, 8],
                    [2, 5],
                    [2, 6],
                ],
                o.progress,
            ),
        },
        { type: 0x402, id: 0, data: Uint8Array.from([7, 0, 0, 0, 1, 0, 0, 0]) },
        { type: 0x102, id: o.rynnId ?? 56, data: rynn },
    ];
    if (o.withGold !== false) {
        const gold = record(0x19001255, [5, 6, 7], 0x460);
        new DataView(gold.buffer).setUint32(0x448, o.gold ?? 376, true);
        entries.push({ type: 0x102, id: 63, data: gold });
    }
    if (o.arokh) {
        const arokh = record(0x1b001041, o.arokh, 0x200);
        new DataView(arokh.buffer).setUint32(0, 0xa60, true);
        entries.push({ type: 0x102, id: 71, data: arokh });
    }
    for (let i = 0; i < (o.extraRecords ?? 3); i++) {
        entries.push({ type: 0x102, id: 100 + i, data: record(0x100d3 + (i % 2), [i * 100, 50, -i * 20], 64 + i) });
    }
    entries.push({ type: 0x104, id: 7, data: Uint8Array.from([0, 0, 0, 0x3f]) });
    return entries;
}

/** Build the file: payloads zlib level 1 (so a default-level recompression differs), odd-sized gaps, trailing index. */
export function buildSave(entries: SaveSpecEntry[] = saveEntries(), pad = 0x1234): Uint8Array {
    const body: number[] = [];
    const rows: { e: SaveSpecEntry; off: number; size: number }[] = [];
    let pos = 16;
    entries.forEach((e, i) => {
        for (let g = 0; g < i % 3; g++) {
            body.push(0x77);
            pos++;
        }
        const z = zlibSync(e.data, { level: 1 });
        rows.push({ e, off: pos, size: z.length });
        body.push(...z);
        pos += z.length;
    });
    const out = new Uint8Array(pos + rows.length * 14);
    const dv = new DataView(out.buffer);
    out.set([0x53, 0x52, 0x53, 0x43], 0);
    dv.setUint16(4, 0x0101, true);
    dv.setUint32(6, pos, true);
    dv.setUint32(10, rows.length, true);
    dv.setUint16(14, pad, true);
    out.set(body, 16);
    rows.forEach((r, i) => {
        const o = pos + i * 14;
        dv.setUint16(o, r.e.type, true);
        dv.setUint16(o + 2, r.e.id, true);
        dv.setUint16(o + 4, r.e.sub ?? 0, true);
        dv.setUint32(o + 6, r.off, true);
        dv.setUint32(o + 10, r.size, true);
    });
    return out;
}
