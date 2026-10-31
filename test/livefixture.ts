// Synthetic save with a stats block, an inventory controller image, item records and quest rows (no real bytes).
import { ITEM_PTR_GAP, STAT_OFFSETS, enc } from '../src/index.ts';
import { buildSave, saveEntries, skillTable, type SaveSpecEntry } from './savefixture.ts';

const CELL_BASE = 0x302; // 2-byte phase like the real layouts
const HANDLES = [0xa59e30, 0x9edd30, 0x7a0010];

export function liveText(stats: Partial<Record<string, number>> = {}): Uint8Array {
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
        maxhp: 100,
        gold: 646,
        mana: 100,
        maxmana: 100,
        xp: 250,
        level: 1,
        skillpoints: 0,
        ...stats,
    };
    for (const [name, off] of Object.entries(STAT_OFFSETS)) dv.setUint32(0x100 + off, enc(vals[name]!), true);
    return d;
}

function rynnWithCells(): Uint8Array {
    const b = new Uint8Array(0x800);
    const dv = new DataView(b.buffer);
    dv.setUint32(0, 0xa50, true);
    dv.setUint32(8, 0x17081069, true);
    dv.setInt32(CELL_BASE - 4, -1, true);
    dv.setInt32(CELL_BASE - 0x14, -1, true);
    dv.setUint32(CELL_BASE - 0x10, 1, true);
    // cell 0: bow (equipped), cell 1: club, cell 2: dagger (quick slot), cell 8: the bow's second row
    [1, 0, HANDLES[0]!, 0].forEach((v, i) => dv.setUint32(CELL_BASE + 4 * i, v, true));
    [0, 0, HANDLES[1]!, 0].forEach((v, i) => dv.setUint32(CELL_BASE + 16 + 4 * i, v, true));
    [0, 1, HANDLES[2]!, 0].forEach((v, i) => dv.setUint32(CELL_BASE + 32 + 4 * i, v, true));
    [0, 0, 1, 0].forEach((v, i) => dv.setUint32(CELL_BASE + 16 * 8 + 4 * i, v, true));
    return b;
}

function itemEntry(handle: number, resource: number, cur: number, max: number): Uint8Array {
    const b = new Uint8Array(0x300);
    const dv = new DataView(b.buffer);
    dv.setUint32(0, resource - 0x20000, true);
    dv.setUint32(8, 0x19001041, true);
    dv.setUint32(0x40, handle, true);
    dv.setUint32(0x48, enc(cur), true);
    dv.setUint32(0x4c, enc(max), true);
    dv.setUint32(0x40 + ITEM_PTR_GAP, handle, true);
    return b;
}

export function liveEntries(stats: Partial<Record<string, number>> = {}): SaveSpecEntry[] {
    const base = saveEntries({ rynnId: 56 }).filter((e) => !(e.type === 0x401 && e.id === 893) && e.type !== 0x102);
    return [
        ...base,
        { type: 0x401, id: 893, data: liveText(stats) },
        { type: 0x102, id: 56, data: rynnWithCells() },
        { type: 0x102, id: 301, data: itemEntry(HANDLES[0]!, 0x31bc9, 181, 200) },
        { type: 0x102, id: 361, data: itemEntry(HANDLES[1]!, 0x3217b, 144, 150) },
        { type: 0x102, id: 419, data: itemEntry(HANDLES[2]!, 0x33cbc, 0xffffffff, 0xffffffff) },
    ];
}

export const liveSave = (stats: Partial<Record<string, number>> = {}): Uint8Array => buildSave(liveEntries(stats));
