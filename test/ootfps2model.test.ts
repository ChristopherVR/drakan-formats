// Drakan 2 models in place of OotF ones (ootfps2model.ts). Synthetic fixtures only: no game data.
import { describe, expect, it } from 'vitest';
import { OotfAssetBuilder } from '../src/ootfassets.ts';
import { PC_CLASS_ALIASES } from '../src/ootfclass.ts';
import {
    DEFAULT_PS2_MODEL_SUBSTITUTIONS,
    Ps2ModelMapError,
    discModelMismatch,
    effectiveModelSubstitutions,
    healthUntilFlee,
    modelKey,
    planPs2Models,
    ps2ModelSwapFromEdits,
} from '../src/ootfps2model.ts';
import type { PcFileSource } from '../src/pc.ts';
import {
    appendTextures,
    boxOf,
    combineDrawing,
    fitVertices,
    palmMesh,
    refineMesh,
    readVertexRecord,
    tintImage,
    writeVertexRecord,
} from '../src/ootfdiscmodel.ts';
import { decodeDisplayList, expandTriangles, withDisplayList } from '../src/ootfdisplaylist.ts';
import { writePs2ModelRecords } from '../src/ootfmodel.ts';

describe('Drakan 2 model table', () => {
    it('names each pair once, with a category and a reason, and every enemy pair is the planner alias', () => {
        const seen = new Set<string>();
        for (const r of DEFAULT_PS2_MODEL_SUBSTITUTIONS) {
            const k = modelKey(r.ootf) + (r.category === 'props' ? `|${modelKey(r.pcModel ?? '')}` : '');
            expect(seen.has(k)).toBe(false);
            seen.add(k);
            expect(['enemies', 'weapons', 'props', 'flames', 'effects']).toContain(r.category);
            if (r.category === 'effects') expect(r.odb && r.fields?.length).toBeTruthy();
            if (r.category === 'props') expect(r.pcModel && (r.odb || r.refine)).toBeTruthy();
            if (r.category === 'flames') expect(r.odb).toBeTruthy();
            expect(r.why.length).toBeGreaterThan(10);
            expect(`${r.label} ${r.why}`).not.toMatch(/—/);
            if (r.scene) {
                // a scene prop names a disc creature that a gameplay row already plays
                expect(DEFAULT_PS2_MODEL_SUBSTITUTIONS.some((g) => !g.scene && g.ps2 === r.ps2)).toBe(true);
                expect(planPs2Models().enemyTarget(r.ootf)).toBe(r.ps2);
            } else if (r.category === 'enemies' && modelKey(r.ootf) !== modelKey(r.ps2))
                expect(PC_CLASS_ALIASES.get(modelKey(r.ootf))).toBe(modelKey(r.ps2));
        }
    });

    it('turns categories, rows and default-off rows on and off', () => {
        const all = effectiveModelSubstitutions();
        expect(all.some((r) => r.ootf === 'Troll Leather')).toBe(true);
        expect(all.some((r) => r.ootf === 'Scavenger')).toBe(true);
        expect(effectiveModelSubstitutions({ off: ['scavenger'] }).some((r) => r.ootf === 'Scavenger')).toBe(false);
        const table = [
            {
                category: 'enemies' as const,
                ootf: 'Demo',
                ps2: 'Demo',
                label: 'Demo',
                why: 'a default-off row',
                defaultOff: true,
            },
        ];
        expect(effectiveModelSubstitutions({ table }).length).toBe(0); // default-off rows stay off
        expect(effectiveModelSubstitutions({ table, on: ['demo'] }).length).toBe(1);
        expect(effectiveModelSubstitutions({ enabled: false })).toEqual([]);
        expect(
            effectiveModelSubstitutions({ categoriesOff: ['weapons', 'props', 'flames', 'effects'] }).every(
                (r) => r.category === 'enemies',
            ),
        ).toBe(true);
        expect(effectiveModelSubstitutions({ off: ['LONG SWORD'] }).some((r) => r.ootf === 'Long Sword')).toBe(false);
    });

    it('answers per class: enemy animations, enemies turned off, weapon targets', () => {
        const p = planPs2Models();
        expect(p.enemy('Troll Chain')).toBe('drakan2');
        expect(p.enemyOff('Troll Chain')).toBe(false);
        expect(p.weapon('Long Sword')?.ps2).toBe('Steel Longsword');
        expect(p.weapon('Troll Chain')).toBeNull();
        expect(planPs2Models({ enemyAnimations: 'ootf' }).enemy('Troll Chain')).toBe('ootf');
        const off = planPs2Models({ off: ['Troll Chain'] });
        expect(off.enemy('Troll Chain')).toBeNull();
        expect(off.enemyOff('Troll Chain')).toBe(true);
        expect(off.enemyOff('Some Other Creature')).toBe(false); // not in the table: the converter decides as before
        const none = planPs2Models({ enabled: false });
        expect(none.enemyOff('Troll Chain')).toBe(true);
        expect(none.weapon('Long Sword')).toBeNull();
    });

    it('reads user edits', () => {
        const demo = [
            {
                category: 'enemies' as const,
                ootf: 'Scavenger',
                ps2: 'Scavenger',
                label: 'S',
                why: 'default-off demo row',
                defaultOff: true,
            },
        ];
        const o = ps2ModelSwapFromEdits(
            [
                { ootf: 'Mace', ps2: null },
                { ootf: 'Scavenger', ps2: 'Scavenger' },
                { ootf: 'Flame Sword', ps2: 'Fire Blade', label: 'Flame sword' },
            ],
            { table: demo },
        );
        expect(o.off).toEqual(['Mace']);
        expect(o.on).toEqual(['Scavenger']);
        expect(o.extra).toEqual([
            { category: 'weapons', ootf: 'Flame Sword', ps2: 'Fire Blade', label: 'Flame sword', why: 'user mapping' },
        ]);
        expect(planPs2Models(o).weapon('flame sword')?.ps2).toBe('Fire Blade');
        expect(() => ps2ModelSwapFromEdits({})).toThrow(Ps2ModelMapError);
        expect(() => ps2ModelSwapFromEdits([{ ootf: 'X', ps2: 3 }])).toThrow(/Drakan 2 class name/);
        expect(() => ps2ModelSwapFromEdits([{ ootf: 'X', ps2: 'Y', category: 'pets' }])).toThrow(/category/);
    });
});

describe('OotfAssetBuilder.useNativeModel', () => {
    const src: PcFileSource = { read: async () => null, list: async () => [] };
    it('names the native model for the PC model and converts nothing', async () => {
        const b = new OotfAssetBuilder(src, { firstModelId: 7000 });
        expect(await b.useNativeModel('Lvl/Lvl', 0, 5, 5965)).toBe(true);
        expect(b.mapModelRef(0, 5, 'Lvl/Lvl')).toBe(5965);
        expect(await b.useNativeModel('Lvl/Lvl', 0, 5, 5965)).toBe(true); // idempotent
        expect(await b.useNativeModel('Lvl/Lvl', 0, 5, 5966)).toBe(false); // already taken
        expect(await b.useNativeModel('Lvl/Lvl', 3, 5, 5965)).toBe(false); // db not in the .db
        expect(b.requireDisplayList(5965)).toBe(false); // native models are never rewritten
        expect(b.report.models.converted).toBe(0);
    });
});

describe('health of a swapped enemy whose Drakan 2 class never flees', () => {
    it('only the Scavenger row asks for it, and only while the row is on with the disc clips', () => {
        const plan = planPs2Models();
        expect(plan.enemyHealthUntilFlee('Scavenger')).toBe(true);
        expect(plan.enemyHealthUntilFlee(' scavenger')).toBe(true);
        expect(plan.enemyHealthUntilFlee('Spider')).toBe(false);
        expect(plan.enemyHealthUntilFlee('Troll Leather')).toBe(false);
        expect(planPs2Models({ off: ['Scavenger'] }).enemyHealthUntilFlee('Scavenger')).toBe(false);
        expect(planPs2Models({ enemyAnimations: 'ootf' }).enemyHealthUntilFlee('Scavenger')).toBe(false);
        expect(planPs2Models({ enabled: false }).enemyHealthUntilFlee('Scavenger')).toBe(false);
        for (const r of DEFAULT_PS2_MODEL_SUBSTITUTIONS)
            if (r.healthUntilFlee) expect(r.category === 'enemies' && !r.scene).toBe(true);
    });

    it('is the damage the PC creature takes before it runs', () => {
        expect(healthUntilFlee(35, 20)).toBe(15);
        expect(healthUntilFlee(45, 20)).toBe(25);
        expect(healthUntilFlee(35.4, 20)).toBe(15);
    });

    it('leaves the disc health alone when the PC creature does not flee or the values make no sense', () => {
        expect(healthUntilFlee(35, 0)).toBeNull();
        expect(healthUntilFlee(35, -5)).toBeNull();
        expect(healthUntilFlee(20, 20)).toBeNull();
        expect(healthUntilFlee(10, 20)).toBeNull();
        expect(healthUntilFlee(undefined, 20)).toBeNull();
        expect(healthUntilFlee(35, [20])).toBeNull();
        expect(healthUntilFlee(Number.NaN, 20)).toBeNull();
    });
});

describe('Drakan 2 prop models', () => {
    const src: PcFileSource = { read: async () => null, list: async () => [] };
    it('answers only for the PC model a row names, and leaves default-off rows off', () => {
        const plan = planPs2Models();
        expect(plan.prop('Skeleton Spike', 'Skeleton05')?.odb).toBe('MOUNTAON');
        expect(plan.prop('Skeleton', 'Skeleton01')).toBeNull(); // the same class name with another model
        expect(plan.prop('Skeleton Hanging', 'Skeleton04')).toBeNull(); // off by default
        expect(planPs2Models({ on: ['Skeleton Hanging'] }).prop('Skeleton Hanging', 'Skeleton04')).not.toBeNull();
        expect(planPs2Models({ categoriesOff: ['props'] }).prop('Skeleton Spike', 'Skeleton05')).toBeNull();
        expect(() => ps2ModelSwapFromEdits([{ ootf: 'Barrel', ps2: 'Barrel', category: 'props' }])).toThrow(
            Ps2ModelMapError,
        );
    });
    it('refuses a disc model of another size or with its origin elsewhere', () => {
        const spike = { min: [-0.048, 0, -0.099], max: [0.047, 0.581, 0.058] };
        expect(discModelMismatch(spike, { min: [-0.043, 0, -0.099], max: [0.049, 0.581, 0.094] })).toBeNull();
        // the hanging skeleton: same size, origin at the chest instead of the chain
        expect(
            discModelMismatch(
                { min: [-0.045, -0.842, -0.039], max: [0.045, -0.002, 0.042] },
                { min: [-0.035, -0.267, -0.023], max: [0.035, 0.592, 0.046] },
            ),
        ).toMatch(/origin along y/);
        expect(discModelMismatch(spike, { min: [-0.1, 0, -0.1], max: [0.1, 0.3, 0.1] })).toMatch(/size along y/);
    });
    it('draws the disc model behind the OotF vertices and textures, keeping the OotF ones for collision', () => {
        const tri = (t: number, a: number, b: number, c: number) => ({
            flags: 0,
            texture: t,
            indices: [a, b, c],
            uvs: [0, 0, 1, 0, 0, 1],
        });
        const disc = withDisplayList({
            name: 'D',
            shading: 2,
            distance: null,
            textures: [
                { id: 1, db: 0 },
                { id: 2, db: 0 },
            ],
            positions: new Float32Array([0, 0, 0, 2, 0, 0, 0, 2, 0, 0, 0, 2]),
            normals: new Int8Array([0, 127, 0, 0, 127, 0, 0, 127, 0, 0, 127, 0]),
            polygons: [tri(0, 0, 1, 2), tri(1, 0, 2, 3)],
            bounds: null,
        });
        const discVerts = readVertexRecord(writePs2ModelRecords(disc.model).find((r) => r.type === 0x0203)!.data);
        const ootf = writeVertexRecord({
            positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 1, 1, 1]),
            normals: new Int8Array(15),
            w: new Uint8Array(5).fill(0x7f),
        });
        const out = combineDrawing(ootf, discVerts, disc.record, 3);
        const v = readVertexRecord(out.vertices);
        expect(v.positions.length / 3).toBe(8 + discVerts.positions.length / 3); // 5 OotF vertices padded to 8
        expect(Array.from(v.positions.slice(0, 15))).toEqual([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 1, 1, 1]);
        const before = decodeDisplayList(disc.record);
        const after = decodeDisplayList(out.displayList);
        expect(after.groups.length).toBe(before.groups.length + 1);
        expect(after.batches.map((b) => b.texture)).toEqual(before.batches.map((b) => b.texture + 3));
        expect(after.batches.flatMap((b) => b.loads.map((l) => l.group))).toEqual(
            before.batches.flatMap((b) => b.loads.map((l) => l.group + 1)),
        );
        // the triangles drawn are the disc's, read from the appended vertices
        const pos = (vs: Float32Array, t: { vertices: number[] }) =>
            t.vertices.map((i) => Array.from(vs.slice(i * 3, i * 3 + 3)));
        expect(expandTriangles(after).map((t) => pos(v.positions, t))).toEqual(
            expandTriangles(before).map((t) => pos(discVerts.positions, t)),
        );
    });
    it('appends texture refs to the name record and stretches a model onto a box', () => {
        const name = new Uint8Array([2, 0, 0x41, 0, 2, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 5, 0, 3, 0]);
        const r = appendTextures(name, [900, 901]);
        expect(r.before).toBe(1);
        const dv = new DataView(r.record.buffer);
        expect([
            dv.getUint32(12, true),
            dv.getUint16(20, true),
            dv.getUint16(24, true),
            dv.getUint16(26, true),
        ]).toEqual([3, 900, 901, 0]);
        const v = { positions: new Float32Array([0, 0, 0, 1, 1, 1]), normals: new Int8Array([0, 0, 127, 127, 0, 0]) };
        fitVertices(v, { min: [0, 0, 0], max: [1, 1, 1] }, { min: [-1, 0, 0], max: [1, 0.5, 2] });
        expect(Array.from(v.positions)).toEqual([-1, 0, 0, 1, 0.5, 2]);
        expect(boxOf(v.positions).max).toEqual([1, 0.5, 2]);
    });
});

describe('Drakan 2 flames', () => {
    it('answers for the OotF flame classes, compares names without spaces, and switches off per row or category', () => {
        const plan = planPs2Models();
        for (const n of ['Sconce Flame', 'SconceFlame', 'Torch Flame', 'Standing Torch Flame', 'Hanging Flame'])
            expect(plan.flame(n)).toMatchObject({
                category: 'flames',
                odb: 'WORLDCON',
                ps2: 'Wartok Torch',
                fireScale: 1.4,
            });
        expect(plan.flame('Torch Base')).toBeNull();
        expect(plan.prop('Torch Flame', 'TFlame01')).toBeNull();
        expect(planPs2Models({ categoriesOff: ['flames'] }).flame('Torch Flame')).toBeNull();
        expect(planPs2Models({ off: ['Torch Flame'] }).flame('Torch Flame')).toBeNull();
        expect(planPs2Models({ off: ['Torch Flame'] }).flame('Sconce Flame')).not.toBeNull();
        expect(
            planPs2Models(ps2ModelSwapFromEdits([{ ootf: 'Hanging Flame', ps2: null }])).flame('Hanging Flame'),
        ).toBeNull();
        expect(() =>
            ps2ModelSwapFromEdits([{ ootf: 'Brazier Flame', ps2: 'Wartok Firepot', category: 'flames' }]),
        ).toThrow(Ps2ModelMapError);
        const user = planPs2Models(
            ps2ModelSwapFromEdits([
                { ootf: 'Brazier Flame', ps2: 'Wartok Firepot', category: 'flames', odb: 'WORLDCON' },
            ]),
        );
        expect(user.flame('Brazier Flame')?.ps2).toBe('Wartok Firepot');
    });
});

describe('Drakan 2 effects', () => {
    it('names the Drakan 2 barrel explosion for both OotF exploding barrels, and switches off', () => {
        const plan = planPs2Models();
        for (const n of ['Barrel (explode)', 'Barrel (Exploding)'])
            expect(plan.effect(n)).toMatchObject({
                odb: 'MOUNTAON',
                ps2: 'TNT Barrel',
                fields: ['Explosion Generator>Smoke Generator'],
            });
        expect(plan.effect('Barrel')).toBeNull();
        expect(plan.flame('Barrel (explode)')).toBeNull();
        expect(planPs2Models({ categoriesOff: ['effects'] }).effect('Barrel (explode)')).toBeNull();
        expect(
            planPs2Models(ps2ModelSwapFromEdits([{ ootf: 'Barrel (explode)', ps2: null }])).effect('Barrel (explode)'),
        ).toBeNull();
        expect(() =>
            ps2ModelSwapFromEdits([{ ootf: 'Crate', ps2: 'TNT Barrel', category: 'effects', odb: 'MOUNTAON' }]),
        ).toThrow(Ps2ModelMapError);
        const user = planPs2Models(
            ps2ModelSwapFromEdits([
                {
                    ootf: 'Crate',
                    ps2: 'TNT Barrel',
                    category: 'effects',
                    odb: 'MOUNTAON',
                    fields: ['Explosion Generator'],
                },
            ]),
        );
        expect(user.effect('Crate')?.fields).toEqual(['Explosion Generator']);
    });
});

describe('refined OotF prop meshes', () => {
    // a low "tent" of two triangles meeting at a soft edge, with open borders
    const tent = {
        positions: new Float32Array([0, 0, 0, 2, 0, 0, 1, 0.2, 1, 1, 0.2, -1]),
        normals: new Int8Array([0, 127, 0, 0, 127, 0, 0, 127, 0, 0, 127, 0]),
        polygons: [
            { flags: 0, texture: 0, indices: [0, 2, 1], uvs: [0, 0, 0.5, 1, 1, 0] },
            { flags: 0, texture: 1, indices: [0, 1, 3], uvs: [0, 0, 1, 0, 0.5, 1] },
        ],
    };
    it('keeps the triangles and corner UVs with smooth normals only', () => {
        const r = refineMesh(tent, 'normals');
        expect(r.polygons.length).toBe(2);
        expect(r.polygons.map((p) => p.uvs)).toEqual(tent.polygons.map((p) => p.uvs));
        expect(r.polygons.map((p) => p.texture)).toEqual([0, 1]);
    });
    it('splits every triangle in four, keeps the original corners and bends soft edges only', () => {
        const r = refineMesh(tent, 'pn');
        expect(r.polygons.length).toBe(8);
        const pts = Array.from({ length: r.positions.length / 3 }, (_, i) =>
            Array.from(r.positions.slice(i * 3, i * 3 + 3)),
        );
        for (const c of [
            [0, 0, 0],
            [2, 0, 0],
            [1, 0.2, 1],
            [1, 0.2, -1],
        ].map((v) => v.map((x) => Math.fround(x))))
            expect(pts.some((p) => p.every((v, k) => Math.abs(v - c[k]!) < 1e-6))).toBe(true);
        // a soft edge whose end normals are square to it stays straight
        expect(pts.some((p) => Math.abs(p[0]! - 1) < 1e-6 && Math.abs(p[1]!) < 1e-6 && Math.abs(p[2]!) < 1e-6)).toBe(
            true,
        );
        // a shallow cone: the soft edges from the apex bend towards the curved surface
        const cone = {
            positions: new Float32Array([0, 0.3, 0, 1, 0, 1, 1, 0, -1, -1, 0, -1, -1, 0, 1]),
            normals: new Int8Array(15).fill(0).map((_, i) => (i % 3 === 1 ? 127 : 0)),
            polygons: [
                [0, 1, 2],
                [0, 2, 3],
                [0, 3, 4],
                [0, 4, 1],
            ].map((v) => ({ flags: 0, texture: 0, indices: v, uvs: [0, 0, 1, 0, 0, 1] })),
        };
        const c = refineMesh(cone, 'pn');
        const cp = Array.from({ length: c.positions.length / 3 }, (_, i) =>
            Array.from(c.positions.slice(i * 3, i * 3 + 3)),
        );
        const m = cp.find((p) => p[0]! > 0.3 && p[0]! < 0.7 && Math.abs(p[0]! - p[2]!) < 1e-6)!;
        expect(Math.abs(m[1]! - 0.15)).toBeGreaterThan(1e-3);
        // a border edge stays straight
        expect(
            pts.some(
                (p) => Math.abs(p[0]! - 1.5) < 1e-6 && Math.abs(p[1]! - 0.1) < 1e-6 && Math.abs(p[2]! - 0.5) < 1e-6,
            ),
        ).toBe(true);
        expect(refineMesh(tent, 'pn2').polygons.length).toBe(32);
    });
});

describe('new palms and recoloured disc textures', () => {
    it('answers the palm row and the pine row of one class name by PC model', () => {
        const plan = planPs2Models({ on: ['Large Tree'] });
        expect(plan.prop('Large Tree', 'Large Pine(H)')?.ps2).toBe('Pine Tree 01');
        expect(plan.prop('Large Tree', 'PalmTree_Tall01(H)')?.refine).toBe('palm');
        expect(planPs2Models().prop('Large Tree', 'PalmTree_Tall01(H)')).toBeNull(); // off by default
        expect(planPs2Models().prop('Fan Palm 01', 'tropical tree01')?.refine).toBe('palm');
    });
    it('builds a palm: a rounded trunk, curved two-sided fronds with the OotF frond UVs, the same textures', () => {
        // trunk: a square post from y 0 to 2 (texture 0); one frond card at the top (texture 1, with holes)
        const positions = new Float32Array([
            -0.1, 0, -0.1, 0.1, 0, -0.1, 0.1, 2, -0.1, -0.1, 2, -0.1, 0.1, 0, 0.1, 0.1, 2, 0.1, -0.1, 0, 0.1, -0.1, 2,
            0.1, 0, 2, -0.05, 0, 2, 0.05, 1, 2, 0.05, 1, 2, -0.05,
        ]);
        const quad = (t: number, i: number[]) => ({ flags: 0, texture: t, indices: i, uvs: [0, 0, 1, 0, 1, 1, 0, 1] });
        const m = {
            positions,
            normals: new Int8Array(positions.length),
            polygons: [
                quad(0, [0, 1, 2, 3]),
                quad(0, [1, 4, 5, 2]),
                quad(0, [4, 6, 7, 5]),
                quad(0, [6, 0, 3, 7]),
                quad(1, [8, 9, 10, 11]),
            ],
        };
        const r = palmMesh(m, (t) => t === 1);
        const trunk = r.polygons.filter((p) => p.texture === 0);
        const frond = r.polygons.filter((p) => p.texture === 1);
        expect(trunk.length).toBe(4 * 2 * 4); // four quads, two triangles each, split in four
        expect(frond.length).toBe(6 * 2 * 2);
        // the frond tip droops below the crown
        const tipY = Math.min(...frond.flatMap((p) => p.indices.map((i) => r.positions[i * 3 + 1]!)));
        expect(tipY).toBeLessThan(2);
        // its UVs stay inside the card's UV rectangle
        expect(frond.every((p) => p.uvs.every((v) => v >= 0 && v <= 1))).toBe(true);
    });
    it('recolours a picture green, keeping brightness order and alpha', () => {
        const img = { width: 2, height: 1, rgba: new Uint8Array([200, 200, 255, 255, 40, 40, 60, 0]) };
        const t = tintImage(img, 'green');
        expect(t.rgba[1]!).toBeGreaterThan(t.rgba[0]!);
        expect(t.rgba[1]!).toBeGreaterThan(t.rgba[5]!);
        expect([t.rgba[3], t.rgba[7]]).toEqual([255, 0]);
    });
});
