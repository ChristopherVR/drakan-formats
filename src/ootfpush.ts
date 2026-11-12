// Push puzzles of converted Order of the Flame levels: a block Rynn pushes onto a pressure plate.
//
// The PC and the PS2 engine share the Rigid Body class (engine 16, "Push Mode" Slide) and the Pressure Plate class (engine 29,
// handler 0x45de10 in PAL SCES-500.06): a plate sinks under Rynn or under a Rigid Body when "Triggered by Rynn Only?" is off, a
// plate that is told to rise stays down while something touches it, and a counter fires only when it is still 0 two ticks
// after it reached 0. So both classes are converted as what they are, and the engine plays the puzzle. The campaign has one
// with a block: Ruined Village, the tomb of the Soul Crystal (block 1101, plates 988 / 991 / 992, counter 1009, the Rising
// Floor Ring). What the PS2 engine needs for it, each found in the game (journal 2026-11-12/ootf-lair-push-puzzle.md):
//
//   * Sphere bounds on the block. A body whose model has box bounds gets no contact sphere (0x458d88 stores -1); its contact
//     query (0x459a30) then never clears the "just woken" bit, and the tick (0x459000) never takes the velocity Rynn's push
//     stored. The PC bounds of the tomb's block are spheres and are kept (`pushableBounds`).
//   * Terrain under the block. The Rigid Body rests on terrain only (ground probe 0x230648). The tomb floor is a model 6,200
//     units over two invisible layers, so the block gets a layer of its own at floor height (`pushFloor`). Rynn is tested
//     against the objects filed on the layers under her (0x123bf0), and the layer lookup (0x14b6b8) walks the old layer's
//     list upward from that layer's own entry: the new layer must follow the room's layers in every list (`addPushFloor`),
//     or Rynn stays filed on the old layer and walks through the block.
//   * A plate box an actor's box overlaps. A flat tile has a box of no height (ootfassets.ts `plateBounds`).
//   * A block that still touches a plate at the bottom. The body does not follow the tile down, so its lowest sphere is
//     moved down by the sink distance (`PUSH_SPHERE_REACH`, ootfassets.ts `sinkLowestSphere`). With contact the engine
//     pulls a block onto the centre of the plate it is linked to and keeps it awake there (0x45aec0).
//
// An unrotated object shows its model's +x toward +z (`placementYaw`). The first pass on this puzzle placed the tiles a
// quarter turn off and concluded that native plates do not sense Rynn; they do.

import type { LvlObject } from './lvl.ts';
import type { OdbClass } from './odb.ts';
import type { PcLevel } from './pc.ts';
import { CELL_SIZE, TEX_HOLE, TEX_INVISIBLE, layerHeightAt, type TerrainLayer } from './terrain.ts';

/** PC / PS2 engine ids. */
export const RIGID_BODY_RFL = 16;
export const PRESSURE_PLATE_RFL = 29;

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

/** "Sink Distance (wu)" of a pressure plate object (its own value or its class's), 0 when it has none. */
export function plateSinkDistance(pc: PcLevel, plate: LvlObject): number {
    return Math.max(0, fieldNumber(pc, plate, 'Sink Distance (wu)') ?? 0);
}

/**
 * The PC sound references a pressure plate or a push block takes from its class ("Sink Sound", "Rise Sound"; "Looped Roll
 * Sound"): the puzzle pass sets them on the converted object, so they must be converted like a sound an object names itself.
 */
export function pushPuzzleSoundRefs(pc: PcLevel, o: LvlObject): number[] {
    const rfl = classOf(pc, o)?.rflClass;
    const names =
        rfl === PRESSURE_PLATE_RFL ? ['Sink Sound', 'Rise Sound'] : isPushBlock(pc, o) ? ['Looped Roll Sound'] : [];
    return names.map((n) => (fieldNumber(pc, o, n) ?? 0) >>> 0).filter((v) => v !== 0);
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

/**
 * Yaw of a placed object in radians: the engine turns a model by the stored Y degrees minus 90 (level-format.md section 3;
 * `x' = x cos + z sin`, `z' = z cos - x sin`), on the PC as on the PS2. An unrotated object shows its model's +x toward +z.
 */
export function placementYaw(o: Pick<LvlObject, 'rot'>): number {
    return (((o.rot[1] ?? 0) - 90) * Math.PI) / 180;
}

/** Axis-aligned world box of a model box placed as the object is (scale, then the rotation about y). */
export function worldBox(o: Pick<LvlObject, 'pos' | 'rot' | 'scale'>, box: ModelBox): ModelBox {
    const s = o.scale ?? [1, 1, 1];
    const a = placementYaw(o);
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

/** A triangle of a placed model in world units. */
export type FloorTriangle = [[number, number, number], [number, number, number], [number, number, number]];

/** The polygons of a PC model as world triangles of the object that shows it (scale, then the rotation about y, as `worldBox`). */
export function modelTriangles(
    o: Pick<LvlObject, 'pos' | 'rot' | 'scale'>,
    model: { positions: ArrayLike<number>; polygons: readonly { indices: readonly number[] }[] },
): FloorTriangle[] {
    const s = o.scale ?? [1, 1, 1];
    const a = placementYaw(o);
    const c = Math.cos(a);
    const sn = Math.sin(a);
    const at = (i: number): [number, number, number] => {
        const lx = model.positions[i * 3]! * CELL_SIZE * s[0]!;
        const lz = model.positions[i * 3 + 2]! * CELL_SIZE * s[2]!;
        return [
            o.pos[0]! + lx * c + lz * sn,
            o.pos[1]! + model.positions[i * 3 + 1]! * CELL_SIZE * s[1]!,
            o.pos[2]! - lx * sn + lz * c,
        ];
    };
    const out: FloorTriangle[] = [];
    for (const poly of model.polygons)
        for (let k = 1; k + 1 < poly.indices.length; k++)
            out.push([at(poly.indices[0]!), at(poly.indices[k]!), at(poly.indices[k + 1]!)]);
    return out;
}

/** Highest point of the triangles over (x, z) whose height lies in [lo, hi], or -Infinity. */
export function trianglesHeightAt(
    tris: readonly FloorTriangle[],
    x: number,
    z: number,
    lo: number,
    hi: number,
): number {
    let best = -Infinity;
    for (const [a, b, c] of tris) {
        const d = (b[2] - c[2]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[2] - c[2]);
        if (Math.abs(d) < 1e-6) continue;
        const u = ((b[2] - c[2]) * (x - c[0]) + (c[0] - b[0]) * (z - c[2])) / d;
        const v = ((c[2] - a[2]) * (x - c[0]) + (a[0] - c[0]) * (z - c[2])) / d;
        const w = 1 - u - v;
        if (u < -1e-6 || v < -1e-6 || w < -1e-6) continue;
        const y = u * a[1] + v * b[1] + w * c[1];
        if (y >= lo && y <= hi && y > best) best = y;
    }
    return best;
}

/**
 * How far the lowest bounding sphere of a push block is moved down beyond the sink distance of its plates (world units): the
 * drop of the floor patch and a margin, so the block's own contact query still finds a tile at the bottom.
 */
export const PUSH_SPHERE_REACH = 25;

/**
 * True when a PC model's bounds (its raw 0x0207 record) let a PS2 Rigid Body be pushed: a sphere hierarchy. For a body whose
 * model has box bounds the engine sets no contact sphere (0x458d88: index -1), its contact query then never clears the
 * "just woken" state, and the player's push velocity is never taken (tick 0x459000).
 */
export function pushableBounds(bounds: Uint8Array | null): boolean {
    if (!bounds || bounds.length < 68) return false;
    const dv = new DataView(bounds.buffer, bounds.byteOffset, bounds.byteLength);
    return dv.getUint16(64, true) > 0 && dv.getUint16(66, true) === 0;
}

/** The floor patch lies this far under the model floor, so Rynn walks on the model and not on the patch (world units). */
export const PUSH_FLOOR_DROP = 8;
/** A raised rim of the floor up to this high counts as floor when the patch's cells are cut (world units). */
export const PUSH_FLOOR_RIM = 1024;
/** Sample points per cell edge when a triangle of a patch cell is tested for floor under it. */
const PUSH_FLOOR_SAMPLES = 8;

export interface PushFloor {
    /** The new terrain layer (its `index` is the position it must get in the level's layer table). */
    layer: TerrainLayer;
    /** Height of the model floor under the block. */
    floor: number;
    /** Indices of the room's own layers (the invisible ones the patch lies over). */
    room: number[];
    /** The level's layers that must list the new one (it lists them): `addPushFloor`. */
    listedBy: number[];
    /** Triangles of the patch with floor over them, and without (holes). */
    solid: number;
    holes: number;
}

/**
 * The terrain layer a push block on a model floor needs. The PS2 Rigid Body rests on terrain only (its ground probe asks the
 * terrain layers, never an object), and an actor is filed on the layer with the highest ground under it: with a layer at the
 * height of the floor, the block and Rynn are both filed on it while they stand in the room, and she can push it. The patch
 * covers the invisible layers of the room (the flat, fully invisible floor layers that touch the one under the block), is
 * invisible, and has a hole wherever the floor model (`floors`: the triangle sets of the static models around the block; the
 * one under the block is the floor) has none: the pit of the tomb stays a pit. Null when the block does not stand on a model.
 */
export function pushFloor(
    terrain: readonly TerrainLayer[],
    block: Pick<LvlObject, 'pos'>,
    baseY: number,
    floors: readonly (readonly FloorTriangle[])[],
): PushFloor | null {
    const [bx, , bz] = block.pos as [number, number, number];
    let tris: readonly FloorTriangle[] | null = null;
    let floor = -Infinity;
    for (const t of floors) {
        const h = trianglesHeightAt(t, bx, bz, baseY - PUSH_FLOOR_RIM, baseY + PUSH_FLOOR_MIN_GAP);
        if (h > floor) {
            floor = h;
            tris = t;
        }
    }
    if (!tris) return null;
    const flat = (L: TerrainLayer): number | null => {
        if (L.type !== 0) return null;
        const h = L.heights[0]!;
        for (const v of L.heights) if (v !== h) return null;
        for (let i = 0; i < L.cellTexLeft.length; i++)
            if (L.cellTexLeft[i] !== TEX_INVISIBLE || L.cellTexRight[i] !== TEX_INVISIBLE) return null;
        return h;
    };
    let base: TerrainLayer | null = null;
    for (const L of terrain) {
        const h = layerHeightAt(L, bx, bz);
        if (flat(L) === null || !Number.isFinite(h) || floor - h <= PUSH_FLOOR_MIN_GAP) continue;
        if (!base || h > base.heights[0]!) base = L;
    }
    if (!base) return null;
    const touches = (p: TerrainLayer, q: TerrainLayer): boolean => {
        const ox = Math.min(p.originX + p.width, q.originX + q.width) - Math.max(p.originX, q.originX);
        const oz = Math.min(p.originZ + p.height, q.originZ + q.height) - Math.max(p.originZ, q.originZ);
        return (ox === 0 && oz > 0) || (oz === 0 && ox > 0);
    };
    const room = [base];
    for (let i = 0; i < room.length; i++)
        for (const L of terrain)
            if (!room.includes(L) && flat(L) === base.heights[0] && touches(room[i]!, L)) room.push(L);
    const x0 = Math.min(...room.map((L) => L.originX));
    const z0 = Math.min(...room.map((L) => L.originZ));
    const w = Math.max(...room.map((L) => L.originX + L.width)) - x0;
    const h = Math.max(...room.map((L) => L.originZ + L.height)) - z0;
    const index = terrain.length;
    const roomIds = room.map((L) => L.index);
    const listed = [...new Set(room.flatMap((L) => [L.index, ...L.visible]))].filter((i) => i >= 0 && i < index);
    const layer: TerrainLayer = {
        ...base,
        index,
        id: Math.max(...terrain.map((L) => L.id)) + 1,
        name: 'push floor',
        width: w,
        height: h,
        originX: x0,
        originZ: z0,
        worldHeight: Math.round(floor - PUSH_FLOOR_DROP),
        visible: afterRoom(base.visible, roomIds, index, true),
        heights: new Float32Array((w + 1) * (h + 1)).fill(floor - PUSH_FLOOR_DROP),
        vertexFlags: new Uint16Array((w + 1) * (h + 1)).fill(base.vertexFlags[0] ?? 0),
        vertexMask: new Uint8Array((w + 1) * (h + 1)),
        cellFlags: new Uint16Array(w * h).fill((base.cellFlags[0] ?? 0) & ~1),
        cellTexLeft: new Uint32Array(w * h),
        cellTexRight: new Uint32Array(w * h),
        cellUv: new Uint16Array(w * h * 8),
    };
    let solid = 0;
    let holes = 0;
    const n = PUSH_FLOOR_SAMPLES;
    for (let cz = 0; cz < h; cz++)
        for (let cx = 0; cx < w; cx++) {
            layer.cellUv.set(base.cellUv.subarray(0, 8), (cz * w + cx) * 8);
            // The left triangle of a cell without the diagonal bit holds its low x, low z corner (`layerHeightAt`).
            for (const left of [true, false]) {
                let hit = false;
                for (let i = 0; i <= n && !hit; i++)
                    for (let j = 0; j <= n - i && !hit; j++) {
                        const fx = left ? i / n : 1 - i / n;
                        const fz = left ? j / n : 1 - j / n;
                        const y = trianglesHeightAt(
                            tris,
                            (x0 + cx + fx) * CELL_SIZE,
                            (z0 + cz + fz) * CELL_SIZE,
                            floor - 64,
                            floor + PUSH_FLOOR_RIM,
                        );
                        hit = Number.isFinite(y);
                    }
                (left ? layer.cellTexLeft : layer.cellTexRight)[cz * w + cx] = hit ? TEX_INVISIBLE : TEX_HOLE;
                if (hit) solid++;
                else holes++;
            }
        }
    return { layer, floor, room: roomIds, listedBy: listed, solid, holes };
}

/**
 * `list` with `index` right after the last of the `room` layers it names; with `own` (the new layer's own list) the room
 * layers it does not name are added before `index`. The engine's layer lookup (0x14b6b8) walks the old layer's list upward
 * from that layer's own entry while the point is above each layer and stops at the first layer the point is under, so a
 * list must name the layers from low to high around the room: a patch appended behind the high layers over the room is
 * never reached, and a patch that names the room's layers after itself hands Rynn back to them.
 */
function afterRoom(list: readonly number[], room: readonly number[], index: number, own = false): number[] {
    const out = list.filter((v) => v !== index);
    let at = -1;
    out.forEach((v, i) => {
        if (room.includes(v)) at = i;
    });
    const add = own ? [...room.filter((r) => !out.includes(r)), index] : [index];
    if (at < 0) return [...out, ...add];
    out.splice(at + 1, 0, ...add);
    return out;
}

/** Append the patch to the level's layers and name it in the lists of the layers it names (`afterRoom`). */
export function addPushFloor(terrain: TerrainLayer[], pf: PushFloor): void {
    for (const i of pf.listedBy) {
        const L = terrain[i];
        if (L) L.visible = afterRoom(L.visible, pf.room, pf.layer.index);
    }
    terrain.push(pf.layer);
}
