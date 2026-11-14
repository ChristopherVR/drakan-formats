/**
 * Fuller crowns for the OotF palms whose fronds are already curved strips (the tall and short palms of Islands and Alwarren):
 * the trunk and the other opaque parts are rounded (ootfdiscmodel.ts `refineMesh` `round`), every frond is kept, and a second
 * ring of the same fronds is added, turned half a frond step about the crown, a little shorter and drooping more, so the
 * crown is twice as full as the OotF one. No game data here: the mesh is the player's own OotF palm, read at convert time.
 */

import { refineMesh } from './ootfdiscmodel.ts';

interface Poly {
    flags: number;
    texture: number;
    indices: number[];
    uvs: number[];
}

/** The palm with a rounded trunk and a doubled crown; `alpha(texture)` says whether a texture has holes (fronds). */
export function palmCrownMesh<M extends { positions: Float32Array; normals: Int8Array; polygons: Poly[] }>(
    m: M,
    alpha: (texture: number) => boolean,
): M {
    const P = (i: number) => [m.positions[i * 3]!, m.positions[i * 3 + 1]!, m.positions[i * 3 + 2]!];
    const fronds = m.polygons.filter((p) => alpha(p.texture));
    const solidPolys = m.polygons.filter((p) => !alpha(p.texture));
    if (!fronds.length || !solidPolys.length) throw new Error('not a palm (no frond or no trunk texture)');
    // crown centre: the opaque part that sits highest (the crown cap), its centre
    const byTex = new Map<number, number[]>();
    for (const p of solidPolys)
        for (const v of p.indices) (byTex.get(p.texture) ?? byTex.set(p.texture, []).get(p.texture)!).push(v);
    let crown = [0, 0, 0];
    let bestY = -Infinity;
    for (const vs of byTex.values()) {
        const c = [0, 1, 2].map((k) => vs.reduce((a, v) => a + P(v)[k]!, 0) / vs.length);
        if (c[1]! > bestY) {
            bestY = c[1]!;
            crown = c;
        }
    }
    // frond step: azimuths of the frond triangles about the crown, split where a gap opens
    const az = fronds
        .map((p) => {
            const c = [0, 2].map((k) => p.indices.reduce((a, v) => a + P(v)[k]!, 0) / p.indices.length - crown[k]!);
            return Math.atan2(c[1]!, c[0]!);
        })
        .sort((a, b) => a - b);
    let groups = 0;
    for (let i = 0; i < az.length; i++) {
        const next = i + 1 < az.length ? az[i + 1]! : az[0]! + 2 * Math.PI;
        if (next - az[i]! > (10 * Math.PI) / 180) groups++;
    }
    const turn = Math.PI / Math.max(groups, 6);
    let reach = 0;
    for (const p of fronds)
        for (const v of p.indices) reach = Math.max(reach, Math.hypot(P(v)[0]! - crown[0]!, P(v)[2]! - crown[2]!));
    const solid = refineMesh({ positions: m.positions, normals: m.normals, polygons: solidPolys }, 'round');
    const pos = Array.from(solid.positions);
    const nrm = Array.from(solid.normals);
    const polys: Poly[] = solid.polygons.map((q) => ({ ...q }));
    const ca = Math.cos(turn);
    const sa = Math.sin(turn);
    for (const ring of [0, 1]) {
        const map = new Map<number, number>();
        const vert = (v: number): number => {
            const known = map.get(v);
            if (known !== undefined) return known;
            let [x, y, z] = P(v) as [number, number, number];
            let [nx, ny, nz] = [m.normals[v * 3]!, m.normals[v * 3 + 1]!, m.normals[v * 3 + 2]!];
            if (ring) {
                const dx = (x - crown[0]!) * 0.88;
                const dz = (z - crown[2]!) * 0.88;
                const r = Math.hypot(dx, dz);
                x = crown[0]! + dx * ca - dz * sa;
                z = crown[2]! + dx * sa + dz * ca;
                y = crown[1]! + (y - crown[1]!) * 0.88 - (reach > 0 ? (0.22 * r * r) / reach : 0);
                [nx, nz] = [Math.round(nx * ca - nz * sa), Math.round(nx * sa + nz * ca)];
                void ny;
            }
            const id = pos.length / 3;
            pos.push(x, y, z);
            nrm.push(nx, ny, nz);
            map.set(v, id);
            return id;
        };
        for (const f of fronds) polys.push({ ...f, indices: f.indices.map(vert), uvs: [...f.uvs] });
    }
    return {
        ...m,
        positions: Float32Array.from(pos),
        normals: Int8Array.from(nrm),
        normalW: undefined,
        polygons: polys,
        bounds: null,
    };
}
