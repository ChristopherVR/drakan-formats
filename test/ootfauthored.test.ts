// Authored replacement meshes (ootfauthored.ts). Synthetic fixtures only: no game data.
import { describe, expect, it } from 'vitest';
import type { Skeleton } from '../src/ootfanim.ts';
import {
    AUTHORED_FORMAT,
    type AuthoredModel,
    authoredProblem,
    closestBary,
    fitAuthored,
    jointOrigin,
    piecewise,
    placeAuthored,
} from '../src/ootfauthored.ts';
import type { SkinPoly, VertexWeights } from '../src/ootfskinupgrade.ts';
import { decodePng } from '../src/png.ts';
import { zlibSync } from 'fflate';

/** A joint whose inverse bind is uniform scale `s` and origin `o` (row vectors: p' = p R + t, R = s I, t = -o s). */
function joint(o: [number, number, number], s = 1) {
    return {
        xform: [s, 0, 0, 0, s, 0, 0, 0, s, -o[0] * s, -o[1] * s, -o[2] * s],
        mesh: 0,
        firstChild: 0,
        nextSibling: 0,
        weights: [[]],
    };
}

/** A closed tetrahedron in PC space (Y up), two textures, wound like PC models: clockwise seen from outside (they
 * measure a negative signed volume). */
function pcTetra() {
    const positions = [0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 2, 0];
    const faces = [
        [0, 2, 1],
        [0, 1, 3],
        [0, 3, 2],
        [1, 2, 3],
    ];
    const polygons: SkinPoly[] = faces.map((f, i) => ({
        flags: 0,
        texture: i === 3 ? 1 : 0,
        indices: f,
        uvs: [0, 0, 1, 0, 0, 1],
    }));
    const weights: VertexWeights[] = [[{ j: 0, w: 1 }], [{ j: 0, w: 1 }], [{ j: 0, w: 1 }], [{ j: 1, w: 1 }]];
    return { positions, polygons, weights };
}

const skeleton = {
    joints: [joint([0, 0, 0]), joint([0, 2, 0])],
    nodes: [
        { name: 'root', joint: 0 },
        { name: 'head', joint: 1 },
    ],
} as unknown as Skeleton;

const signedVolume = (pos: ArrayLike<number>, tris: number[][]) =>
    tris.reduce((s, [a, b, c]) => {
        const p = (i: number) => [pos[i * 3]!, pos[i * 3 + 1]!, pos[i * 3 + 2]!];
        const [A, B, C] = [p(a!), p(b!), p(c!)];
        return (
            s +
            (A[0]! * (B[1]! * C[2]! - B[2]! * C[1]!) -
                A[1]! * (B[0]! * C[2]! - B[2]! * C[0]!) +
                A[2]! * (B[0]! * C[1]! - B[1]! * C[0]!)) /
                6
        );
    }, 0);

/** The same tetrahedron authored in Blender space ((x, y, z) PC -> (x, z, y)): the swap mirrors, so the PC order is
 * counter-clockwise from outside there, as a Blender mesh is. */
function authoredTetra(): AuthoredModel {
    const pc = pcTetra();
    const positions: number[] = [];
    for (let i = 0; i < 4; i++)
        positions.push(pc.positions[i * 3]!, pc.positions[i * 3 + 2]!, pc.positions[i * 3 + 1]!);
    const triangles = pc.polygons.flatMap((p) => [p.indices[0]!, p.indices[1]!, p.indices[2]!, 0]);
    return {
        format: AUTHORED_FORMAT,
        model: 'tetra',
        label: 'Tetra',
        fit: 'height',
        positions,
        triangles,
        slots: [{ name: 'skin', texture: 'pc' }],
    };
}

describe('authored model files', () => {
    it('accepts a well formed file and names what is wrong with a bad one', () => {
        expect(authoredProblem(authoredTetra())).toBeNull();
        expect(authoredProblem({ ...authoredTetra(), format: 'x' })).toMatch(/format/);
        expect(authoredProblem({ ...authoredTetra(), triangles: [0, 1, 9, 0] })).toMatch(/vertex 9/);
        expect(authoredProblem({ ...authoredTetra(), triangles: [0, 1, 2, 3] })).toMatch(/slot 3/);
        expect(authoredProblem({ ...authoredTetra(), fit: 'joints' })).toMatch(/landmarks/);
    });
});

describe('fitting an authored mesh on a PC model', () => {
    it('keeps the PC winding (the y/z swap already mirrors) so the faces light from outside', () => {
        const pc = pcTetra();
        const fit = fitAuthored(authoredTetra(), pc, skeleton);
        const pcVol = signedVolume(
            pc.positions,
            pc.polygons.map((p) => p.indices),
        );
        const fitVol = signedVolume(
            fit.positions,
            fit.polygons.map((p) => p.indices),
        );
        expect(pcVol).toBeLessThan(0);
        const blenderVol = signedVolume(
            authoredTetra().positions,
            pcTetra().polygons.map((p) => p.indices),
        );
        expect(blenderVol).toBeGreaterThan(0); // outward in Blender
        expect(Math.sign(fitVol)).toBe(Math.sign(pcVol));
        expect(fit.dropped).toBe(0);
    });

    it('takes the texture and weights of the nearest PC surface', () => {
        const fit = fitAuthored(authoredTetra(), pcTetra(), skeleton);
        expect(fit.polygons.map((p) => p.texture).sort()).toEqual([0, 0, 0, 1]);
        const top = fit.weights[(fit.positions.findIndex((v, i) => i % 3 === 1 && v > 1.9) / 3) | 0]!;
        expect(top[0]!.j).toBe(1);
    });

    it('places the mesh on the PC box by height', () => {
        const a = authoredTetra();
        const doubled = { ...a, positions: a.positions.map((v) => v * 2) };
        const p = placeAuthored(doubled, pcTetra().positions);
        expect(Math.max(...p.filter((_, i) => i % 3 === 1))).toBeCloseTo(2);
        expect(Math.min(...p.filter((_, i) => i % 3 === 1))).toBeCloseTo(0);
    });

    it('drops authored triangles of a kept joint and appends the PC part instead', () => {
        const fit = fitAuthored({ ...authoredTetra(), keepPcJoints: ['head'] }, pcTetra(), skeleton);
        expect(fit.polygons.length).toBeGreaterThan(0);
        for (const p of fit.polygons) for (const v of p.indices) expect(v).toBeLessThan(fit.positions.length / 3);
    });
});

describe('fit helpers', () => {
    it('finds a joint origin through a scaled inverse bind (the Boss Blade Dragon joints are scaled)', () => {
        const sk = { joints: [joint([1, 2, 3], 0.786)] };
        const o = jointOrigin(sk, 0);
        expect(o[0]).toBeCloseTo(1);
        expect(o[1]).toBeCloseTo(2);
        expect(o[2]).toBeCloseTo(3);
    });

    it('maps piecewise between landmarks and with the overall slope outside them', () => {
        const f = piecewise(
            [
                [0, 0],
                [1, 2],
                [2, 3],
            ],
            1.5,
        );
        expect(f(0.5)).toBeCloseTo(1);
        expect(f(1.5)).toBeCloseTo(2.5);
        expect(f(3)).toBeCloseTo(4.5);
        expect(f(-1)).toBeCloseTo(-1.5);
    });

    it('closest point barycentrics stay on the triangle', () => {
        const b = closestBary([5, 5, 0], [0, 0, 0], [1, 0, 0], [0, 1, 0]);
        expect(b[0]).toBeCloseTo(0);
        expect(b[1] + b[2]).toBeCloseTo(1);
        const inside = closestBary([0.25, 0.25, 1], [0, 0, 0], [1, 0, 0], [0, 1, 0]);
        expect(inside[0]).toBeCloseTo(0.5);
    });
});

/** A PNG of RGBA rows (filter 0 on even rows, Sub on odd rows) built by hand. */
function png(width: number, height: number, rgba: number[]): Uint8Array {
    const crcTable = Array.from({ length: 256 }, (_, n) => {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        return c >>> 0;
    });
    const crc = (b: Uint8Array) => {
        let c = 0xffffffff;
        for (const x of b) c = crcTable[(c ^ x) & 255]! ^ (c >>> 8);
        return (c ^ 0xffffffff) >>> 0;
    };
    const chunk = (type: string, data: Uint8Array) => {
        const out = new Uint8Array(12 + data.length);
        const dv = new DataView(out.buffer);
        dv.setUint32(0, data.length);
        for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
        out.set(data, 8);
        dv.setUint32(8 + data.length, crc(out.subarray(4, 8 + data.length)));
        return out;
    };
    const ihdr = new Uint8Array(13);
    new DataView(ihdr.buffer).setUint32(0, width);
    new DataView(ihdr.buffer).setUint32(4, height);
    ihdr.set([8, 6, 0, 0, 0], 8);
    const raw: number[] = [];
    for (let y = 0; y < height; y++) {
        const row = rgba.slice(y * width * 4, (y + 1) * width * 4);
        if (y % 2 === 0) raw.push(0, ...row);
        else raw.push(1, ...row.map((v, x) => (x >= 4 ? (v - row[x - 4]! + 256) & 255 : v)));
    }
    const parts = [
        new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
        chunk('IHDR', ihdr),
        chunk('IDAT', zlibSync(new Uint8Array(raw))),
        chunk('IEND', new Uint8Array()),
    ];
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of parts) {
        out.set(p, o);
        o += p.length;
    }
    return out;
}

describe('own textures', () => {
    it('decodes an 8-bit RGBA PNG with filtered rows', () => {
        const px = [10, 20, 30, 255, 40, 50, 60, 128, 70, 80, 90, 0, 100, 110, 120, 255];
        const img = decodePng(png(2, 2, px));
        expect([img.width, img.height]).toEqual([2, 2]);
        expect([...img.rgba]).toEqual(px);
        expect(() => decodePng(new Uint8Array([1, 2, 3]))).toThrow(/not a PNG/);
    });

    it('image slots keep their own UVs (v flipped to the PC convention) and texture after the PC entries', () => {
        const a = authoredTetra();
        const m: AuthoredModel = {
            ...a,
            slots: [
                { name: 'skin', texture: 'pc' },
                { name: 'armour', texture: 'image', image: 'armour.png' },
            ],
            triangles: a.triangles.map((v, i) => (i % 4 === 3 ? (i < 8 ? 1 : 0) : v)),
            uvs: Array.from({ length: (a.triangles.length / 4) * 6 }, (_, i) => (i % 2 ? 0.25 : 0.5)),
        };
        expect(authoredProblem(m)).toBeNull();
        expect(authoredProblem({ ...m, uvs: [0, 0] })).toMatch(/uvs/);
        const fit = fitAuthored(m, pcTetra(), skeleton, new Set(), 2);
        expect(fit.images).toEqual(['armour.png']);
        const own = fit.polygons.filter((p) => p.texture === 2);
        expect(own).toHaveLength(2);
        expect(own[0]!.uvs).toEqual([0.5, 0.75, 0.5, 0.75, 0.5, 0.75]);
        expect(fit.polygons.filter((p) => p.texture < 2)).toHaveLength(2);
    });
});
