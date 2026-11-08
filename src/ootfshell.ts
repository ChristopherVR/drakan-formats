// Inward-facing shells (a closed box whose faces look inward, such as the Intro's "Black Background" around the Psygnosis
// owl logo) seen from outside. The PC culls back faces, so a camera outside such a box sees only its far walls and
// whatever is inside. The PS2 draws model strips without back-face culling (their orientation is arbitrary on the disc,
// docs/reference/level-format.md 0x0211), so the near walls hide everything inside: the converted Intro stayed black for
// 12 s until its camera entered the box (journal 2026-11-08/ootf-intro-black-start.md).
//
// The converter drops the walls that the PC culls from a cut-scene camera position outside the shell. From inside, those
// walls lie on the side the camera came from; the PC would show them only to a camera turned back toward them.
// Sky boxes are inward shells too, but their classes are replaced by the PS2 sky and their models are not converted.

import { view } from './bytes.ts';
import { decodeFieldValue } from './fields.ts';
import type { LvlObject } from './lvl.ts';
import type { PcModel } from './ootfmodel.ts';
import { parsePcSequence } from './ootfseq.ts';
import type { OdbClass } from './odb.ts';
import type { PcFileSource, PcLevel } from './pc.ts';
import { SSD_SEQUENCE } from './resources.ts';
import { SrscReader } from './srsc.ts';

type Vec3 = readonly [number, number, number];

/** World units per model unit (model space is in terrain cells, level-format.md "Unit"). */
export const MODEL_UNIT = 2048;

/** PC draw distance when a level gives none: `Max Fog Depth (lu)` 30 of most PC levels, in world units. */
export const PC_DEFAULT_VIEW_DISTANCE = 30 * MODEL_UNIT;

/** PC engine id of the camera object (the actor cut scenes move). */
const CAMERA_RFL = 27;

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: Vec3, b: Vec3): Vec3 => [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/**
 * Front normal of a PC polygon: the PC's front side is the side opposite to `(b - a) x (c - a)` (every closed crate,
 * barrel and boulder of Ruined Village has all its faces pointing outward with this rule).
 */
function frontNormal(p: ArrayLike<number>, idx: readonly number[]): { n: Vec3; a: Vec3 } {
    const at = (i: number): Vec3 => [p[i * 3]!, p[i * 3 + 1]!, p[i * 3 + 2]!];
    const a = at(idx[0]!);
    const c = cross(sub(at(idx[1]!), a), sub(at(idx[2]!), a));
    return { n: [-c[0], -c[1], -c[2]], a };
}

/**
 * True for a closed mesh (every edge shared by exactly two polygons) of at least four single-sided polygons whose front
 * sides all face the mesh's vertex centroid: a room or backdrop box meant to be seen from inside.
 */
export function isInwardShell(m: Pick<PcModel, 'positions' | 'polygons'>): boolean {
    const p = m.positions;
    const nv = p.length / 3;
    if (m.polygons.length < 4 || nv < 4) return false;
    const c: [number, number, number] = [0, 0, 0];
    for (let i = 0; i < nv; i++) for (let k = 0; k < 3; k++) c[k] = c[k]! + p[i * 3 + k]! / nv;
    const edges = new Map<string, number>();
    for (const poly of m.polygons) {
        if (poly.indices.length < 3 || poly.indices.some((i) => i >= nv) || (poly.flags & 2) !== 0) return false;
        const { n, a } = frontNormal(p, poly.indices);
        if (dot(n, sub(c, a)) <= 0) return false;
        poly.indices.forEach((x, k) => {
            const y = poly.indices[(k + 1) % poly.indices.length]!;
            const e = x < y ? `${x},${y}` : `${y},${x}`;
            edges.set(e, (edges.get(e) ?? 0) + 1);
        });
    }
    return [...edges.values()].every((v) => v === 2);
}

/** Where an object puts a model: position, rotation (degrees as stored) and scale; only Y rotations are handled. */
export interface ShellPlacement {
    pos: Vec3;
    rot: Vec3;
    scale: Vec3 | null;
}

/**
 * Polygons of an inward shell placed at `at` that the PC culls from at least one of `cameras` lying outside the shell and
 * within `viewDistance` of it (the PC's `Max Fog Depth`: a camera farther away never draws the shell). Null when the
 * object is tilted (X or Z rotation; no shell found so far is).
 */
export function shellWallsHiddenFrom(
    m: Pick<PcModel, 'positions' | 'polygons'>,
    at: ShellPlacement,
    cameras: readonly Vec3[],
    viewDistance = PC_DEFAULT_VIEW_DISTANCE,
): Set<number> | null {
    if (at.rot[0] % 360 !== 0 || at.rot[2] % 360 !== 0) return null;
    // The engine turns an object by its stored Y degrees minus 90 (level-format.md section 3), as the editor draws it
    // (three.js Y rotation: x' = x cos + z sin, z' = z cos - x sin).
    const yaw = (((at.rot[1] - 90) % 360) * Math.PI) / 180;
    const cy = Math.cos(yaw);
    const sy = Math.sin(yaw);
    const s = at.scale ?? [1, 1, 1];
    const w = new Float32Array(m.positions.length);
    const lo = [Infinity, Infinity, Infinity];
    const hi = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < w.length; i += 3) {
        const x = m.positions[i]! * MODEL_UNIT * s[0]!;
        const y = m.positions[i + 1]! * MODEL_UNIT * s[1]!;
        const z = m.positions[i + 2]! * MODEL_UNIT * s[2]!;
        const v = [at.pos[0] + x * cy + z * sy, at.pos[1] + y, at.pos[2] + z * cy - x * sy];
        for (let k = 0; k < 3; k++) {
            w[i + k] = v[k]!;
            lo[k] = Math.min(lo[k]!, v[k]!);
            hi[k] = Math.max(hi[k]!, v[k]!);
        }
    }
    const planes = m.polygons.map((poly) => frontNormal(w, poly.indices));
    const behind = (pl: { n: Vec3; a: Vec3 }, c: Vec3): boolean => dot(pl.n, sub(c, pl.a)) < 0;
    // distance from a camera to the shell's box: cameras beyond the PC draw distance never see it
    const away = (c: Vec3): number => Math.hypot(...[0, 1, 2].map((k) => Math.max(lo[k]! - c[k]!, 0, c[k]! - hi[k]!)));
    const hidden = new Set<number>();
    for (const c of cameras) {
        if (away(c) > viewDistance) continue;
        // a convex shell: the camera is inside when it is in front of every wall
        if (!planes.some((pl) => behind(pl, c))) continue;
        planes.forEach((pl, i) => {
            if (behind(pl, c)) hidden.add(i);
        });
    }
    return hidden;
}

/**
 * Camera positions of every cut-scene key in `ssds` that moves a camera object of `pc` (actor bound to a placed object of
 * engine class 27, or named "camera"). Keys relative to another actor are left out.
 */
export async function cutSceneCameraPositions(pc: PcLevel, ssds: readonly SrscReader[]): Promise<Vec3[]> {
    const rflOf = (o: LvlObject): number | undefined => pc.classes.get(o.dbIndex)?.get(o.classId)?.rflClass;
    const cameraIds = new Set(pc.list.objects.filter((o) => rflOf(o) === CAMERA_RFL).map((o) => o.id));
    const out: Vec3[] = [];
    for (const r of ssds)
        for (const e of r.entries) {
            if (e.type !== SSD_SEQUENCE) continue;
            let seq;
            try {
                seq = parsePcSequence(e.id, e.sub, (await r.read(e)).data);
            } catch {
                continue;
            }
            for (const a of seq.actors) {
                if (!cameraIds.has(a.objectId) && !/^camera$/i.test(a.name.trim())) continue;
                for (const x of a.actions) {
                    if (x.type !== 0) continue;
                    const dv = view(x.payload);
                    if (dv.getUint32(28, true) !== 0) continue; // relative to another actor
                    out.push([dv.getFloat32(16, true), dv.getFloat32(20, true), dv.getFloat32(24, true)]);
                }
            }
        }
    return out;
}

/**
 * Walls to drop per model over all its placements: only walls hidden for every placement are dropped (a model
 * placed twice keeps a wall one of its copies needs). Models with any rotated placement are left alone.
 */
export function mergeShellDrops(perPlacement: readonly (Set<number> | null)[]): Set<number> | null {
    if (!perPlacement.length || perPlacement.some((s) => s === null)) return null;
    const [first, ...rest] = perPlacement as Set<number>[];
    const out = new Set([...first!].filter((i) => rest.every((s) => s.has(i))));
    return out.size ? out : null;
}

/** The PC draw distance of a level in world units: its Level Properties (engine 54) `Max Fog Depth (lu)`, else 30 lu. */
export function pcViewDistance(pc: Pick<PcLevel, 'classes'>): number {
    for (const table of [...pc.classes].sort((a, b) => a[0] - b[0]).map((x) => x[1]))
        for (const c of table.values()) {
            if (c.rflClass !== 54) continue;
            const i = c.fields?.findIndex((f) => /^max fog depth/i.test(f.name.trim())) ?? -1;
            const v = i >= 0 && c.data ? Number(decodeFieldValue(c.fields![i]!.type, c.data[i] ?? 0, c.data)) : NaN;
            return Number.isFinite(v) && v > 0 ? v * MODEL_UNIT : PC_DEFAULT_VIEW_DISTANCE;
        }
    return PC_DEFAULT_VIEW_DISTANCE;
}

/**
 * Walls to drop per class model for every inward shell placed in `levels` (`isInwardShell`), from the camera keys of the
 * cut scenes in the `.ssd` beside each of the level's `.odb` dependencies. `readModel` returns the class's PC model.
 */
export async function planShellTrims(
    levels: readonly PcLevel[],
    src: PcFileSource,
    readModel: (cls: OdbClass) => Promise<PcModel | null>,
): Promise<Map<OdbClass, { drop: Set<number>; walls: number; placements: number }>> {
    const per = new Map<OdbClass, (Set<number> | null)[]>();
    const models = new Map<OdbClass, PcModel | null>();
    for (const pc of levels) {
        let cameras: Vec3[] | null = null;
        for (const o of pc.list.objects) {
            const cls = pc.classes.get(o.dbIndex)?.get(o.classId);
            if (!cls?.model) continue;
            if (!models.has(cls)) {
                const m = await readModel(cls);
                models.set(cls, m && !m.character && isInwardShell(m) ? m : null);
            }
            const m = models.get(cls);
            if (!m) continue;
            if (!cameras) {
                const ssds: SrscReader[] = [];
                for (const p of new Set([...pc.odbPaths.values()].map((x) => x.replace(/\.odb$/i, '.ssd')))) {
                    const b = await src.read(p);
                    if (b) ssds.push(await SrscReader.fromBytes(b));
                }
                cameras = await cutSceneCameraPositions(pc, ssds);
            }
            const hidden = shellWallsHiddenFrom(m, o, cameras, pcViewDistance(pc));
            (per.get(cls) ?? per.set(cls, []).get(cls)!).push(hidden);
        }
    }
    const out = new Map<OdbClass, { drop: Set<number>; walls: number; placements: number }>();
    for (const [cls, list] of per) {
        const drop = mergeShellDrops(list);
        if (drop) out.set(cls, { drop, walls: models.get(cls)!.polygons.length, placements: list.length });
    }
    return out;
}
