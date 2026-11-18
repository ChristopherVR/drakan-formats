import type { LvlObject } from './lvl.ts';
import type { PcModel } from './ootfmodel.ts';
import { placementYaw } from './ootfpush.ts';
import { MODEL_UNIT } from './ootfshell.ts';

type Axis = 0 | 1 | 2;
type Point = readonly [number, number];
type Edge = readonly [number, number];
const AXES: readonly Axis[] = [0, 1, 2];
const PLANE_TOLERANCE = 0.0002;
const FACE_SEPARATION = 16 / MODEL_UNIT;
const VERTICAL_AXES = [0, 2] as const;
const PLACED_PATCH_AREA = 0.01;
const MIN_CONTACT_AREA = 0.000025;

export interface FaceOffset {
    axis: Axis;
    delta: number;
}

interface Face {
    index: number;
    vertices: readonly number[];
    edges: readonly Edge[];
    texture: number;
    axis: Axis;
    depth: readonly [number, number];
    points: Point[];
    signedArea: number;
}

const turn = (a: Point, b: Point, c: Point): number => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);

function signedArea(points: readonly Point[]): number {
    let area = 0;
    for (let i = 1; i + 1 < points.length; i++) area += turn(points[0]!, points[i]!, points[i + 1]!);
    return area / 2;
}

const edgeKey = (a: number, b: number): string => (a < b ? `${a}/${b}` : `${b}/${a}`);

function planarFace(
    model: Pick<PcModel, 'polygons'> & { positions: ArrayLike<number> },
    index: number,
    texture: number,
    axes: readonly Axis[] = AXES,
): Face | undefined {
    const polygon = model.polygons[index]!;
    const vertices = polygon.indices;
    if (
        (polygon.flags & 2) !== 0 ||
        (vertices.length !== 3 && vertices.length !== 4) ||
        vertices.some((v) => v * 3 + 2 >= model.positions.length)
    )
        return;

    for (const axis of axes) {
        const depths = vertices.map((v) => model.positions[v * 3 + axis]!);
        const near = Math.min(...depths);
        const far = Math.max(...depths);
        if (!(far - near <= PLANE_TOLERANCE)) continue;
        const points: Point[] = vertices.map((v) => [
            model.positions[v * 3 + ((axis + 1) % 3)]!,
            model.positions[v * 3 + ((axis + 2) % 3)]!,
        ]);
        const area = signedArea(points);
        if (!(Math.abs(area) > PLANE_TOLERANCE ** 2)) continue;
        if (
            vertices.length === 4 &&
            points.some((a, i) => Math.sign(turn(a, points[(i + 1) % 4]!, points[(i + 2) % 4]!)) !== Math.sign(area))
        )
            continue;
        const edges: Edge[] = vertices.map((a, i) => [a, vertices[(i + 1) % vertices.length]!]);
        return { index, vertices, edges, texture, axis, depth: [near, far], points, signedArea: area };
    }
}

function coveredArea(subject: Face, perimeter: Face): number {
    let points = subject.points;
    const side = Math.sign(perimeter.signedArea);
    for (let i = 0; i < perimeter.points.length && points.length >= 3; i++) {
        const a = perimeter.points[i]!;
        const b = perimeter.points[(i + 1) % perimeter.points.length]!;
        const clipped: Point[] = [];
        points.forEach((p, j) => {
            const q = points[(j + 1) % points.length]!;
            const pDistance = side * turn(a, b, p);
            const qDistance = side * turn(a, b, q);
            const inside = pDistance >= 0;
            if (inside) clipped.push(p);
            if (inside === qDistance >= 0) return;
            const t = pDistance / (pDistance - qDistance);
            clipped.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]);
        });
        points = clipped;
    }
    return Math.abs(signedArea(points));
}

function hasOppositePatch(quad: Face, triangles: ReadonlyMap<string, readonly Face[]>): boolean {
    const area = Math.abs(quad.signedArea);
    const opposite = (other: Face): boolean =>
        other.axis === quad.axis &&
        other.texture !== quad.texture &&
        other.signedArea * quad.signedArea < 0 &&
        onSamePlane(quad, other);

    for (const [a, b] of quad.edges) {
        for (const first of triangles.get(edgeKey(a, b)) ?? []) {
            if (!opposite(first)) continue;
            const shared = coveredArea(first, quad);
            if (shared < area * 0.05) continue;
            for (const [p, q] of first.edges) {
                for (const second of triangles.get(edgeKey(p, q)) ?? []) {
                    if (second.texture !== first.texture || !opposite(second)) continue;
                    // A reversed edge between equally wound triangles puts their interiors on opposite sides of it.
                    if (!second.edges.some(([u, v]) => p === v && q === u)) continue;
                    const remaining = coveredArea(second, quad);
                    if (remaining >= area * 0.05 && shared + remaining >= area * 0.9) return true;
                }
            }
        }
    }
    return false;
}

/** Give a backed quad enough depth for the two sides to draw separately in the PS2 double-sided renderer. */
export function separateBackToBackFaces(
    model: PcModel,
    opaqueTextures: ReadonlyMap<number, number>,
    droppedFaces?: ReadonlySet<number>,
): PcModel {
    if (model.character || opaqueTextures.size < 2) return model;
    const triangles = new Map<string, Face[]>();
    const quads: Face[] = [];
    model.polygons.forEach((polygon, index) => {
        const texture = opaqueTextures.get(polygon.texture);
        if (texture === undefined || droppedFaces?.has(index)) return;
        const face = planarFace(model, index, texture);
        if (!face) return;
        if (face.vertices.length === 4) quads.push(face);
        else {
            for (const [a, b] of face.edges) {
                const key = edgeKey(a, b);
                const faces = triangles.get(key);
                if (faces) faces.push(face);
                else triangles.set(key, [face]);
            }
        }
    });
    const repairs = new Map<number, FaceOffset>();
    for (const quad of quads)
        if (hasOppositePatch(quad, triangles))
            repairs.set(quad.index, { axis: quad.axis, delta: -Math.sign(quad.signedArea) * FACE_SEPARATION });
    return offsetModelFaces(model, repairs);
}

/** Duplicate only the corners of the moved faces, retaining the original positions for their other neighbors. */
export function offsetModelFaces(model: PcModel, offsets: ReadonlyMap<number, FaceOffset>): PcModel {
    const corners = [...offsets.keys()].reduce((total, index) => total + model.polygons[index]!.indices.length, 0);
    if (!corners || model.positions.length / 3 + corners > 0xffff) return model;
    const positions = new Float32Array(model.positions.length + corners * 3);
    positions.set(model.positions);
    const polygons = model.polygons.slice();
    const moved = new Map<string, number>();
    let end = model.positions.length;
    for (const [index, { axis, delta }] of offsets) {
        const polygon = polygons[index]!;
        const indices = polygon.indices.map((v) => {
            const key = `${v}/${axis}/${delta}`;
            const previous = moved.get(key);
            if (previous !== undefined) return previous;
            const offset = end;
            positions.set(model.positions.subarray(v * 3, v * 3 + 3), offset);
            positions[offset + axis] = positions[offset + axis]! + delta;
            end += 3;
            moved.set(key, offset / 3);
            return offset / 3;
        });
        polygons[index] = { ...polygon, indices };
    }
    return { ...model, positions: positions.subarray(0, end), polygons };
}

type Transform = Pick<LvlObject, 'pos' | 'rot' | 'scale'>;

export interface SeamPlacement {
    source: string;
    model: PcModel;
    at: Transform;
}

interface PlacedMesh {
    placement: SeamPlacement;
    positions: Float64Array;
    bounds: [number, number][];
    cos: number;
    sin: number;
    boundary: Map<number, Face[]>;
}

export function isSeamPlacement(at: Transform): boolean {
    return (
        at.rot[0] % 360 === 0 &&
        at.rot[1] % 90 === 0 &&
        at.rot[2] % 360 === 0 &&
        (!at.scale || at.scale.every((v) => v === 1))
    );
}

function place(placement: SeamPlacement): PlacedMesh {
    const { at, model } = placement;
    const angle = placementYaw(at);
    const cos = Math.round(Math.cos(angle));
    const sin = Math.round(Math.sin(angle));
    const positions = new Float64Array(model.positions.length);
    const bounds: [number, number][] = AXES.map(() => [Infinity, -Infinity]);
    for (let i = 0; i < positions.length; i += 3) {
        const x = model.positions[i]!;
        const z = model.positions[i + 2]!;
        const translated = [x * cos + z * sin, model.positions[i + 1]!, z * cos - x * sin];
        for (const axis of AXES) {
            const w = at.pos[axis] / MODEL_UNIT + translated[axis]!;
            positions[i + axis] = w;
            const extent = bounds[axis]!;
            extent[0] = Math.min(extent[0], w);
            extent[1] = Math.max(extent[1], w);
        }
    }
    return { placement, positions, bounds, cos, sin, boundary: new Map() };
}

function boundaryFaces(mesh: PlacedMesh, axis: Axis, side: 0 | 1): Face[] {
    const key = axis * 2 + side;
    const known = mesh.boundary.get(key);
    if (known) return known;
    const model = mesh.placement.model;
    const faces: Face[] = [];
    for (const [index, polygon] of model.polygons.entries()) {
        const texture = model.textures[polygon.texture];
        const plane = mesh.bounds[axis]![side];
        if (
            !texture ||
            !polygon.indices.every((v) => Math.abs(mesh.positions[v * 3 + axis]! - plane) <= PLANE_TOLERANCE)
        )
            continue;
        const face = planarFace(
            { polygons: model.polygons, positions: mesh.positions },
            index,
            texture.db * 0x10000 + texture.id,
            [axis],
        );
        // At the minimum boundary PC fronts point toward increasing depth, so their projected winding is negative.
        if (face && Math.sign(face.signedArea) === (side === 0 ? -1 : 1)) faces.push(face);
    }
    mesh.boundary.set(key, faces);
    return faces;
}

function seamOffset({ cos, sin }: PlacedMesh, worldAxis: 0 | 2, direction: -1 | 1): FaceOffset {
    if (worldAxis === 0) return { axis: cos ? 0 : 2, delta: (cos || sin) * direction * FACE_SEPARATION };
    return { axis: cos ? 2 : 0, delta: (cos || -sin) * direction * FACE_SEPARATION };
}

const volume = (mesh: PlacedMesh): number => mesh.bounds.reduce((v, [lo, hi]) => v * (hi - lo), 1);

const onSamePlane = (a: Face, b: Face): boolean =>
    Math.max(a.depth[1], b.depth[1]) - Math.min(a.depth[0], b.depth[0]) <= PLANE_TOLERANCE;

/**
 * Find touching interior boundaries between distinct static models from the same source container. Only call with
 * meshes having one placement so the local repair of a seam cannot change another copy in a different setting.
 */
export function touchingModelOffsets(
    placements: readonly SeamPlacement[],
): Map<SeamPlacement, Map<number, FaceOffset>> {
    const placed = placements.filter((p) => !p.model.character && isSeamPlacement(p.at)).map(place);
    const repairs = new Map<SeamPlacement, Map<number, FaceOffset>>();
    const conflicts = new Set<SeamPlacement>();
    for (const axis of VERTICAL_AXES) {
        const ending = new Map<string, PlacedMesh[]>();
        const binKey = (mesh: PlacedMesh, index: number): string => mesh.placement.source + '/' + index;
        for (const mesh of placed) {
            const key = binKey(mesh, Math.round(mesh.bounds[axis]![1] / PLANE_TOLERANCE));
            const matches = ending.get(key);
            if (matches) matches.push(mesh);
            else ending.set(key, [mesh]);
        }
        for (const right of placed) {
            const depth = right.bounds[axis]![0];
            const bin = Math.round(depth / PLANE_TOLERANCE);
            for (const left of [bin - 1, bin, bin + 1].flatMap((index) => ending.get(binKey(right, index)) ?? [])) {
                if (left === right || Math.abs(left.bounds[axis]![1] - depth) > PLANE_TOLERANCE) continue;
                if (
                    AXES.some((a) => {
                        if (a === axis) return false;
                        const [r0, r1] = right.bounds[a]!;
                        const [l0, l1] = left.bounds[a]!;
                        return Math.min(r1, l1) - Math.max(r0, l0) < 0.04;
                    })
                )
                    continue;
                const moveLeft = volume(left) < volume(right);
                const target = moveLeft ? left : right;
                const offset = seamOffset(target, axis, moveLeft ? -1 : 1);
                const contact = new Set<number>();
                let mixedArea = 0;
                for (const a of boundaryFaces(left, axis, 1))
                    for (const b of boundaryFaces(right, axis, 0)) {
                        if (!onSamePlane(a, b)) continue;
                        const overlap = coveredArea(a, b);
                        if (overlap < MIN_CONTACT_AREA) continue;
                        if (a.texture !== b.texture) mixedArea += overlap;
                        contact.add(moveLeft ? a.index : b.index);
                    }
                if (mixedArea < PLACED_PATCH_AREA) continue;
                const faces = repairs.get(target.placement) ?? new Map<number, FaceOffset>();
                for (const index of contact) {
                    const former = faces.get(index);
                    if (former && (former.axis !== offset.axis || former.delta !== offset.delta))
                        conflicts.add(target.placement);
                    faces.set(index, offset);
                }
                repairs.set(target.placement, faces);
            }
        }
    }
    for (const conflict of conflicts) repairs.delete(conflict);
    return repairs;
}
