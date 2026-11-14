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
    readVertexRecord,
    writeVertexRecord,
} from '../src/ootfdiscmodel.ts';
import { decodeDisplayList, expandTriangles, withDisplayList } from '../src/ootfdisplaylist.ts';
import { writePs2ModelRecords } from '../src/ootfmodel.ts';

describe('Drakan 2 model table', () => {
    it('names each pair once, with a category and a reason, and every enemy pair is the planner alias', () => {
        const seen = new Set<string>();
        for (const r of DEFAULT_PS2_MODEL_SUBSTITUTIONS) {
            expect(seen.has(modelKey(r.ootf))).toBe(false);
            seen.add(modelKey(r.ootf));
            expect(['enemies', 'weapons', 'props']).toContain(r.category);
            if (r.category === 'props') expect(r.odb && r.pcModel).toBeTruthy();
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
            effectiveModelSubstitutions({ categoriesOff: ['weapons', 'props'] }).every((r) => r.category === 'enemies'),
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
