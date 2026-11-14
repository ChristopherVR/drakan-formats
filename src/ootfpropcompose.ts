/**
 * Order of the Flame props drawn in Drakan 2 style from parts (ootfps2model.ts props rows with `compose`): some OotF parts are
 * kept (a gallows beam and its rope, a cage, a spike, a chain) and the rest (the body) is replaced by a Drakan 2 disc model
 * (a dead man, a skeleton) placed where the replaced part was: turned by `yaw`, scaled uniformly to the replaced part's
 * height and moved onto it. The engine still collides with the converted OotF model (`OotfAssetBuilder.composeDrawing`).
 * No game data here: the meshes come from the player's install and disc at convert time.
 */

import type { NeutralModel } from './ootfmodel.ts';
import { boxOf, topPoint } from './ootfdiscmodel.ts';

export interface ComposeOptions {
    /** OotF texture-list entries whose polygons are replaced by the disc model (the body); the others stay. */
    replace: readonly number[];
    /** Turn the disc model about the vertical axis first, degrees (to face the way the OotF body faces). */
    yaw?: number;
    /**
     * `box` (default): the disc model's box centre on the replaced part's; `top`: the centre of its topmost vertices on the
     * replaced part's topmost point (a body hanging from a rope or chain).
     */
    align?: 'box' | 'top';
    /** Scale on top of the height fit (1 = exactly as tall as the replaced part). */
    scale?: number;
    /**
     * Fold the disc model forward (towards its +z) before it is placed: everything above `at` (a fraction of its height) turns
     * by `angle` degrees about a level axis there, blended over `band` (a fraction of its height, default 0.06) so the
     * bend has no crease: a hanging dead man folded over a spike.
     */
    bend?: { at: number; angle: number; band?: number };
}

/** `bend` applied to positions and normals in place. */
function bendMesh(pos: Float32Array, nrm: Int8Array, used: number[], bend: NonNullable<ComposeOptions['bend']>): void {
    const b = boxOf(pos, used);
    const h = b.max[1]! - b.min[1]!;
    const y0 = b.min[1]! + h * bend.at;
    const half = (h * (bend.band ?? 0.06)) / 2;
    const zs = used
        .filter((i) => Math.abs(pos[i * 3 + 1]! - y0) <= Math.max(half, h * 0.03))
        .map((i) => pos[i * 3 + 2]!);
    const z0 = zs.length ? zs.reduce((a, z) => a + z, 0) / zs.length : (b.min[2]! + b.max[2]!) / 2;
    const full = (bend.angle * Math.PI) / 180;
    for (let i = 0; i < pos.length / 3; i++) {
        const dy = pos[i * 3 + 1]! - y0;
        const f = half > 0 ? Math.min(1, Math.max(0, (dy + half) / (2 * half))) : dy > 0 ? 1 : 0;
        if (f <= 0) continue;
        const t = full * f;
        const c = Math.cos(t);
        const s = Math.sin(t);
        const dz = pos[i * 3 + 2]! - z0;
        pos[i * 3 + 1] = y0 + dy * c - dz * s;
        pos[i * 3 + 2] = z0 + dy * s + dz * c;
        const ny = nrm[i * 3 + 1]!;
        const nz = nrm[i * 3 + 2]!;
        nrm[i * 3 + 1] = Math.round(ny * c - nz * s);
        nrm[i * 3 + 2] = Math.round(ny * s + nz * c);
    }
}

type Mesh = Pick<NeutralModel, 'positions' | 'normals' | 'polygons'>;

/** The OotF model with the `replace` parts swapped for `disc` (whose texture indices move behind `ootfTextures`). */
export function composeBody(ootf: Mesh, disc: Mesh, ootfTextures: number, opt: ComposeOptions): Mesh {
    const replace = new Set(opt.replace);
    const kept = ootf.polygons.filter((p) => !replace.has(p.texture));
    const gone = ootf.polygons.filter((p) => replace.has(p.texture));
    if (!gone.length) throw new Error('no OotF polygon uses the replaced textures');
    const partUsed = new Set(gone.flatMap((p) => p.indices));
    const part = boxOf(ootf.positions, partUsed);
    const dUsed = [...new Set(disc.polygons.flatMap((p) => p.indices))];
    const nd = disc.positions.length / 3;
    const a = ((opt.yaw ?? 0) * Math.PI) / 180;
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    const pos = Float32Array.from(disc.positions);
    const nrm = Int8Array.from(disc.normals);
    if (opt.bend) bendMesh(pos, nrm, dUsed, opt.bend);
    for (let i = 0; i < nd; i++) {
        const x = pos[i * 3]!;
        const z = pos[i * 3 + 2]!;
        pos[i * 3] = x * ca + z * sa;
        pos[i * 3 + 2] = -x * sa + z * ca;
        const nx = nrm[i * 3]!;
        const nz = nrm[i * 3 + 2]!;
        nrm[i * 3] = Math.round(nx * ca + nz * sa);
        nrm[i * 3 + 2] = Math.round(-nx * sa + nz * ca);
    }
    const db = boxOf(pos, dUsed);
    const h = db.max[1]! - db.min[1]!;
    const s = (h > 1e-6 ? (part.max[1]! - part.min[1]!) / h : 1) * (opt.scale ?? 1);
    let from: number[];
    let to: number[];
    if (opt.align === 'top') {
        from = topPoint(pos, dUsed);
        to = topPoint(ootf.positions, partUsed);
    } else {
        from = [0, 1, 2].map((k) => (db.min[k]! + db.max[k]!) / 2);
        to = [0, 1, 2].map((k) => (part.min[k]! + part.max[k]!) / 2);
    }
    for (let i = 0; i < nd; i++) for (let k = 0; k < 3; k++) pos[i * 3 + k] = to[k]! + (pos[i * 3 + k]! - from[k]!) * s;
    const no = ootf.positions.length / 3;
    const positions = new Float32Array((no + nd) * 3);
    positions.set(ootf.positions, 0);
    positions.set(pos, no * 3);
    const normals = new Int8Array((no + nd) * 3);
    normals.set(ootf.normals, 0);
    normals.set(nrm, no * 3);
    return {
        positions,
        normals,
        polygons: [
            ...kept.map((p) => ({ ...p, indices: [...p.indices], uvs: [...p.uvs] })),
            ...disc.polygons.map((p) => ({
                ...p,
                texture: p.texture + ootfTextures,
                indices: p.indices.map((v) => v + no),
                uvs: [...p.uvs],
            })),
        ],
    };
}
