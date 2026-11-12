// Push puzzles of converted Order of the Flame levels: a block Rynn pushes onto a pressure plate.
//
// The PC and the PS2 engine share the Rigid Body class (engine 16, "Push Mode" Slide) and the Pressure Plate class (engine 29,
// handler 0x45de10 in PAL SCES-500.06): a plate sinks under Rynn or under a Rigid Body when "Triggered by Rynn Only?" is off, a
// plate that is told to rise stays down while something stands on it, and a counter fires only when it is still 0 two ticks
// after it reached 0. The campaign has one such puzzle: Ruined Village, the tomb of the Soul Crystal (block 1101, plates
// 988 / 991 / 992, counter 1009, the Rising Floor Ring). Three things kept it from working:
//
//   * The PS2 Rigid Body rests on terrain only (its ground probe 0x230648 asks the terrain layers, never an object). The tomb
//     floor is a model 6,300 units over the terrain, so the block dropped into the pit under the floor at the level start.
//     A terrain layer of its own under the block does not help: an object filed on another layer than Rynn's is not solid for
//     her. A push block that stands on a model therefore becomes a Mover (engine 35) with the block's model, which slides
//     onto the nearest plate when Rynn walks into it (`PlanOptions.pushBlockMover`, `ootfpuzzle.ts` `pushPuzzles`).
//   * The block's PC bounds are spheres, which do not stop Rynn on the PS2: it gets one solid box (ootfassets.ts).
//   * Plates are static props with a Trigger Detector box at the object origin (ootfpuzzle.ts). The tomb's plate tiles lie
//     up to 7,000 units from their origin, so nothing could press them. The puzzle pass puts the detector on the tile.
//     (A native Pressure Plate record written from the PC class loads and its plates raise each other, but Rynn walked
//     over its tile without pressing it, whatever its collision box; so the plates stay stand-ins.)
//
// Journal: docs/journal/2026-11-12/ootf-lair-push-puzzle.md.

import type { LvlObject } from './lvl.ts';
import type { OdbClass } from './odb.ts';
import type { PcLevel } from './pc.ts';
import { CELL_SIZE, layerHeightAt } from './terrain.ts';

/** PC / PS2 engine ids. */
export const RIGID_BODY_RFL = 16;
export const PRESSURE_PLATE_RFL = 29;
export const MOVER_RFL = 35;

/** A slide-mode block whose base lies more than this far above the terrain under it stands on a model (world units). */
export const PUSH_FLOOR_MIN_GAP = 256;

export interface ModelBox {
    min: [number, number, number];
    max: [number, number, number];
}

export interface PushPuzzle {
    /** The pushed Rigid Body. */
    block: LvlObject;
    /** The plates the block is linked to and every plate linked with them (they raise and enable each other). */
    plates: LvlObject[];
}

const norm = (s: string): string => s.trim().toLowerCase();

function classOf(pc: PcLevel, o: LvlObject): OdbClass | undefined {
    return pc.classes.get(o.dbIndex)?.get(o.classId);
}

/** PC value of a scalar field of the object (override or class default), as a float for float fields. */
function fieldNumber(pc: PcLevel, o: LvlObject, name: string): number | undefined {
    const cls = classOf(pc, o);
    const i = (cls?.fields ?? []).findIndex((f) => norm(f.name) === norm(name));
    if (i < 0) return undefined;
    const pi = o.params.findIndex((p) => p.fieldIndex === i);
    const dword = pi >= 0 ? o.data[pi] : cls?.data?.[i];
    if (dword === undefined) return undefined;
    if ((cls!.fields![i]!.type & 0xff) === 2) {
        const dv = new DataView(new ArrayBuffer(4));
        dv.setUint32(0, dword >>> 0);
        return dv.getFloat32(0);
    }
    return dword | 0;
}

/** A Rigid Body Rynn can push at once: "Push Mode" Slide and not waiting for a trigger (boulders roll, traps wait). */
export function isPushBlock(pc: PcLevel, o: LvlObject): boolean {
    return (
        classOf(pc, o)?.rflClass === RIGID_BODY_RFL &&
        (fieldNumber(pc, o, 'Push Mode') ?? 1) === 0 &&
        (fieldNumber(pc, o, 'Wait For Trigger?') ?? 0) === 0
    );
}

/** The push blocks of a level with the plate group each is linked to (empty for a block that only stands around). */
export function findPushPuzzles(pc: PcLevel): PushPuzzle[] {
    const byId = new Map(pc.list.objects.map((o) => [o.id, o]));
    const isPlate = (o: LvlObject | undefined): o is LvlObject =>
        !!o && classOf(pc, o)?.rflClass === PRESSURE_PLATE_RFL;
    const plates = pc.list.objects.filter(isPlate);
    const out: PushPuzzle[] = [];
    for (const block of pc.list.objects) {
        if (!isPushBlock(pc, block)) continue;
        const group = new Map<number, LvlObject>();
        const queue = block.links.map((l) => byId.get(l)).filter(isPlate);
        while (queue.length) {
            const p = queue.pop()!;
            if (group.has(p.id)) continue;
            group.set(p.id, p);
            for (const l of p.links) if (isPlate(byId.get(l))) queue.push(byId.get(l)!);
            for (const q of plates) if (q.links.includes(p.id)) queue.push(q);
        }
        out.push({ block, plates: [...group.values()].sort((a, b) => a.id - b.id) });
    }
    return out;
}

/** Axis-aligned world box of a model box placed as the object is (scale, then the rotation about y). */
export function worldBox(o: Pick<LvlObject, 'pos' | 'rot' | 'scale'>, box: ModelBox): ModelBox {
    const s = o.scale ?? [1, 1, 1];
    const a = ((o.rot[1] ?? 0) * Math.PI) / 180;
    const c = Math.cos(a);
    const sn = Math.sin(a);
    const min: [number, number, number] = [Infinity, Infinity, Infinity];
    const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
    for (const x of [box.min[0], box.max[0]])
        for (const y of [box.min[1], box.max[1]])
            for (const z of [box.min[2], box.max[2]]) {
                const lx = x * s[0]!;
                const lz = z * s[2]!;
                const p = [o.pos[0]! + lx * c + lz * sn, o.pos[1]! + y * s[1]!, o.pos[2]! - lx * sn + lz * c];
                for (let k = 0; k < 3; k++) {
                    min[k] = Math.min(min[k]!, p[k]!);
                    max[k] = Math.max(max[k]!, p[k]!);
                }
            }
    return { min, max };
}

/**
 * True when the push block stands on a model and not on terrain: its base (`box` is its model box in world units before the
 * placement, null when the model is unknown) lies more than `PUSH_FLOOR_MIN_GAP` over the highest floor layer under it.
 */
export function standsOnModel(pc: PcLevel, block: LvlObject, box: ModelBox | null): boolean {
    if (!box) return false;
    const baseY = worldBox(block, box).min[1];
    let ground = -Infinity;
    for (const L of pc.terrain) {
        if (L.type !== 0) continue;
        const h = layerHeightAt(L, block.pos[0]!, block.pos[2]!);
        if (Number.isFinite(h) && h <= baseY + PUSH_FLOOR_MIN_GAP && h > ground) ground = h;
    }
    return Number.isFinite(ground) && baseY - ground > PUSH_FLOOR_MIN_GAP;
}

export interface PushSlide {
    /** The plate the block slides onto: the plate of the puzzle whose tile is nearest to the block. */
    target: LvlObject;
    /** World axis of the slide (0 x, 2 z) and the signed distance (world units) that puts the block's centre over the tile's. */
    axis: 0 | 2;
    distance: number;
    /** Height of the raised tile's top: where the block's base rests. */
    floor: number;
    /** The block's box in the world before the slide. */
    box: ModelBox;
}

/** Where the block of a push puzzle goes, or null when no plate tile of the puzzle is known. */
export function pushSlide(puzzle: PushPuzzle, box: (o: LvlObject) => ModelBox | null): PushSlide | null {
    const bb = box(puzzle.block);
    if (!bb) return null;
    const b = worldBox(puzzle.block, bb);
    const bc = [(b.min[0] + b.max[0]) / 2, (b.min[2] + b.max[2]) / 2];
    let best: PushSlide | null = null;
    let bestD = Infinity;
    for (const p of puzzle.plates) {
        const pb = box(p);
        if (!pb) continue;
        const w = worldBox(p, pb);
        const d = [(w.min[0] + w.max[0]) / 2 - bc[0]!, (w.min[2] + w.max[2]) / 2 - bc[1]!];
        const len = Math.hypot(d[0]!, d[1]!);
        if (len >= bestD) continue;
        bestD = len;
        const axis = Math.abs(d[0]!) > Math.abs(d[1]!) ? 0 : 2;
        best = { target: p, axis, distance: axis === 0 ? d[0]! : d[1]!, floor: w.max[1], box: b };
    }
    return best;
}

/** Model box (world units before placement) of PC model vertex positions in model units (1 = 2048 world units). */
export function modelBoxOf(positions: ArrayLike<number>): ModelBox | null {
    if (positions.length < 3) return null;
    const min: [number, number, number] = [Infinity, Infinity, Infinity];
    const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i + 2 < positions.length; i += 3)
        for (let k = 0; k < 3; k++) {
            const v = positions[i + k]! * CELL_SIZE;
            min[k] = Math.min(min[k]!, v);
            max[k] = Math.max(max[k]!, v);
        }
    return { min, max };
}
