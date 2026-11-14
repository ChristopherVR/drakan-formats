// Trees Rynn fells to bridge a gap (Ruined Village, past the cave from the tomb of Heron's Soul Crystal).
//
// The PC Ground Object (engine 17) has "Push Over Mode" and "Fall When Dead": the PC "push tree" (mode 5, falls when dead) is
// struck, falls over a chasm and lies there as the bridge; "Message To Send When Pushed" goes along its links (a Timer that
// gibs the orc it lands on, a falling sound). The PS2 Ground Object has neither field (its 16 fields end at "Smoke
// Generator"), so the converted tree was a static prop with health 0 that no blow could touch.
//
// The PS2 engine fells a tree with a Mover (35) that rotates (the disc's "Tree Mechanism", Type 1, Rotation Axis, Rotate
// Distance in turns, started by On). A weapon blow reaches a Ground Object with health (message 0x1084 in 0x215030); at
// health 0 it is destroyed (0x214488) and sends its "Message To Send" along its links. So a falling tree becomes:
//
//   * the standing tree: the converted Ground Object with "Initial Health" 1, its "Message To Send" the PC "Message To Send
//     When Pushed", and no explosion, smoke or rubble; one blow removes it;
//   * the falling tree: a Mover with the same model, placed hidden on the same spot (a visible one takes the blow meant for
//     the standing tree), and a Visibility Toggler of the level's own class that shows it on the same message, as the tomb's
//     toggler shows its hidden stair Movers. Both are linked from the standing tree after the PC links; On turns the Mover
//     a quarter turn about the model axis that tips its top toward the gap.
//
// The fall direction is not stored on the PC (what mode 5 means was not established): it is the one of the four model axes
// where the ground at the tree's length is at the tree's foot again with a drop in between, the gap the tree bridges.

import { FLAG_SCALED, FLAG_VISIBLE, addObject, type LvlObject, type LvlObjectList, type Vec3 } from './lvl.ts';
import type { OdbClass } from './odb.ts';
import type { PcLevel } from './pc.ts';
import { layerHeightAt } from './terrain.ts';
import { pcFieldNumber, setNamedParam } from './ootfpuzzle.ts';
import type { ClassFieldDef } from './fields.ts';

export const GROUND_OBJECT_RFL = 17;
export const MOVER_RFL = 35;
/** PC "Push Over Mode" of a tree that is struck down (Ruined Village "push tree"). */
export const STRUCK_PUSH_OVER_MODE = 5;

/** One of the model's horizontal axes, as the direction the top of the tree falls toward. */
export type ModelAxis = '+x' | '-x' | '+z' | '-z';

export interface FallingTree {
    tree: LvlObject;
    cls: OdbClass;
    /** Model axis the top falls toward. */
    toward: ModelAxis;
    /** World direction (x, z) of the fall. */
    dir: [number, number];
    /** Length of the tree (model height above its origin, world units). */
    length: number;
    /** PC "Message To Send When Pushed" (the message the fall sends along the tree's links). */
    message: number;
}

/**
 * World direction (x, z) of a model axis of an object turned by `yawDeg` (the stored Y degrees): the loader applies Y minus
 * 90 degrees, so an unturned object shows its model +x toward world +z (docs/reference/level-format.md section 3).
 */
export function modelAxisWorld(axis: ModelAxis, yawDeg: number): [number, number] {
    const t = ((yawDeg - 90) * Math.PI) / 180;
    const x: [number, number] = [Math.cos(t), -Math.sin(t)];
    const z: [number, number] = [Math.sin(t), Math.cos(t)];
    const v = axis[1] === 'x' ? x : z;
    const s = axis[0] === '+' ? 1 : -1;
    return [Math.round(v[0] * s * 1e6) / 1e6, Math.round(v[1] * s * 1e6) / 1e6];
}

/** Heights of every terrain layer at (x, z). */
function heights(pc: Pick<PcLevel, 'terrain'>, x: number, z: number): number[] {
    return pc.terrain.map((L) => layerHeightAt(L, x, z)).filter((h) => Number.isFinite(h));
}

/**
 * The model axis toward which a tree of `length` standing at `pos` (stored yaw `yawDeg`) bridges a gap: ground within `tol`
 * of its foot lies under the last 30 % of its length, and at half its length none does (a drop). Undefined when no axis does.
 */
export function bridgeAxis(
    pc: Pick<PcLevel, 'terrain'>,
    pos: readonly number[],
    yawDeg: number,
    length: number,
    tol = 600,
): ModelAxis | undefined {
    const [x, y, z] = pos as [number, number, number];
    const foot = heights(pc, x, z)
        .filter((h) => h <= y + 200)
        .reduce((m, h) => Math.max(m, h), -Infinity);
    if (!Number.isFinite(foot)) return undefined;
    let best: { axis: ModelAxis; err: number } | undefined;
    for (const axis of ['+x', '-x', '+z', '-z'] as const) {
        const [dx, dz] = modelAxisWorld(axis, yawDeg);
        const near = (d: number): number[] =>
            heights(pc, x + dx * d, z + dz * d).filter((h) => Math.abs(h - foot) < tol);
        if (near(length * 0.5).length) continue;
        // The far side: ground at the foot's height somewhere under the last 30 % of the trunk.
        const land: number[] = [];
        for (let f = 0.7; f <= 1.0001 && !land.length; f += 0.02) land.push(...near(length * f));
        if (!land.length) continue;
        const err = Math.min(...land.map((h) => Math.abs(h - foot)));
        if (!best || err < best.err) best = { axis, err };
    }
    return best?.axis;
}

/** Ground Objects that are struck down and fall over (PC Push Over Mode 5 with Fall When Dead), with their fall. */
export function findFallingTrees(pc: PcLevel, lengthOf: (cls: OdbClass) => number | undefined): FallingTree[] {
    const out: FallingTree[] = [];
    for (const o of pc.list.objects) {
        const cls = pc.classes.get(o.dbIndex)?.get(o.classId);
        if (cls?.rflClass !== GROUND_OBJECT_RFL || !cls.model) continue;
        if (pcFieldNumber(pc, o, 'Push Over Mode') !== STRUCK_PUSH_OVER_MODE) continue;
        if (!pcFieldNumber(pc, o, 'Fall When Dead')) continue;
        const raw = lengthOf(cls);
        if (!raw || raw <= 0) continue;
        const length = raw * (o.scale?.[1] ?? 1);
        const toward = bridgeAxis(pc, o.pos, o.rot[1], length);
        if (!toward) continue;
        out.push({
            tree: o,
            cls,
            toward,
            dir: modelAxisWorld(toward, o.rot[1]),
            length,
            message: pcFieldNumber(pc, o, 'Message To Send When Pushed') ?? 1,
        });
    }
    return out;
}

/** PS2 Mover fields the falling tree sets (names and types of the disc's Mover schema, LEVEL1ON "Tree Mechanism"). */
const MOVER_FIELDS: readonly [string, number][] = [
    ['Type', 7],
    ['Activate Instantly?', 7],
    ['Damage', 1],
    ['Looping?', 7],
    ['Collide with player', 7],
    ['Is elevator?', 7],
    ['Run Only When Visible?', 7],
    ['Rotate Mesh Instead of Frame?', 7],
    ['Rotate acceleration time', 2],
    ['Rotate deceleration time', 2],
    ['Total rotation time', 2],
    ['Rotate Distance (r)', 2],
    ['Rotation Axis', 7],
];

/** Mover "Rotation Axis" values (model axes). */
const AXIS_INDEX = { x: 0, y: 1, z: 2 } as const;

/**
 * The rotation that tips the model's +y toward `toward`: about model x for a fall along z, about model z for a fall along x,
 * a quarter turn. `sign` is the engine's turn sense (1: a positive distance turns right-handed about the axis).
 */
export function fallRotation(toward: ModelAxis, sign = 1): { axis: number; turns: number } {
    // Right-handed: about +x by +90 degrees takes +y to +z; about +z by +90 degrees takes +y to -x.
    const t = {
        '+z': [AXIS_INDEX.x, 0.25],
        '-z': [AXIS_INDEX.x, -0.25],
        '-x': [AXIS_INDEX.z, 0.25],
        '+x': [AXIS_INDEX.z, -0.25],
    }[toward] as [number, number];
    return { axis: t[0], turns: t[1] * sign };
}

function f32(v: number): number {
    const dv = new DataView(new ArrayBuffer(4));
    dv.setFloat32(0, v);
    return dv.getUint32(0);
}

/**
 * A PC-side class for the falling tree's Mover: engine 35, the tree's model, and the Mover fields of the fall, so the class
 * planner clones a PS2 Mover with the converted tree model and these defaults. `id` must be free in the tree's class table.
 */
export function fallingTreeMoverClass(t: FallingTree, id: number, sign = 1): OdbClass {
    const rot = fallRotation(t.toward, sign);
    const values: Record<string, number> = {
        Type: 1,
        'Activate Instantly?': 0,
        Damage: 0,
        'Looping?': 0,
        'Collide with player': 1,
        'Is elevator?': 0,
        'Run Only When Visible?': 0,
        'Rotate Mesh Instead of Frame?': 0,
        // A felled tree speeds up as it goes over and stops dead on the far side.
        'Rotate acceleration time': f32(1.4),
        'Rotate deceleration time': f32(0.05),
        'Total rotation time': f32(1.6),
        'Rotate Distance (r)': f32(rot.turns),
        'Rotation Axis': rot.axis,
    };
    const fields: ClassFieldDef[] = MOVER_FIELDS.map(([name, type]) => ({ name, type }));
    return {
        id,
        name: `${t.cls.name.trim()} (falling)`,
        group: t.cls.group,
        runtimeClass: 0x10000 | MOVER_RFL,
        model: t.cls.model ?? null,
        rflClass: MOVER_RFL,
        icon: t.cls.icon,
        fields,
        data: MOVER_FIELDS.map(([name]) => values[name]! >>> 0),
    };
}

/** Free class id in a PC class table, above every id in it. */
export function freeClassId(table: ReadonlyMap<number, OdbClass>): number {
    let m = 0;
    for (const id of table.keys()) m = Math.max(m, id);
    return m + 1;
}

/** Mover sound fields: the fall is heard through the PC links (a Triggered Sound), the template's disc sounds stay silent. */
const MOVER_SOUNDS = [
    'Stop Sound',
    'Reverse motion Stop Sound',
    'Forward Looped Sound',
    'Reverse Looped Sound',
    'Forward Slide Sound',
    'Reverse Slide Sound',
    'Forward Rotate Sound',
    'Reverse Rotate Sound',
];

export interface PlacedTree {
    t: FallingTree;
    /** The planned PS2 class of the tree's Mover. */
    mover: { dbIndex: number; classId: number };
}

/**
 * In a converted object list (object ids = PC ids): make each standing tree a Ground Object one blow destroys, sending the PC
 * fall message along its links, and add its Mover on the same spot, hidden, with a Visibility Toggler (of the class
 * `toggler`) that shows it on the same message; both are linked from the tree after its PC links. With `visible` (test
 * aid) the Mover is placed visible instead: it then takes the blow meant for the tree (round 7, run n3). Returns the number
 * of trees done.
 */
export function placeFallingTrees(
    list: LvlObjectList,
    trees: readonly PlacedTree[],
    fieldsOf: (o: LvlObject) => readonly ClassFieldDef[] | undefined,
    warnings: string[],
    title: string,
    opt: { visible?: boolean; toggler?: { dbIndex: number; classId: number } } = {},
): number {
    let n = 0;
    for (const { t, mover } of trees) {
        const o = list.objects.find((x) => x.id === t.tree.id);
        const tf = o ? fieldsOf(o) : undefined;
        if (!o || !tf) {
            warnings.push(`${title}: falling tree ${t.tree.id} was not converted`);
            continue;
        }
        const set = (obj: LvlObject, fields: readonly ClassFieldDef[] | undefined, name: string, v: number): void => {
            if (!setNamedParam(list, obj, fields, name, v))
                warnings.push(`${title}: falling tree ${t.tree.id}: no field "${name}"`);
        };
        set(o, tf, 'Initial Health', 1);
        set(o, tf, 'Message To Send', t.message);
        for (const name of ['2D Explosion Object', 'Explosion Generator', 'Smoke Generator']) set(o, tf, name, 0);
        const { object: m } = addObject(list, {
            classId: mover.classId,
            dbIndex: mover.dbIndex,
            pos: [...o.pos] as Vec3,
            rot: [...o.rot] as Vec3,
        });
        m.flags = (opt.visible ? FLAG_VISIBLE : 0) | (o.scale ? FLAG_SCALED : 0);
        m.initialEvents = 1;
        m.radius = null;
        m.scale = o.scale ? ([...o.scale] as Vec3) : null;
        m.links = [];
        m.params = [];
        m.data = [];
        const mf = fieldsOf(m);
        for (const name of MOVER_SOUNDS) set(m, mf, name, 0);
        const links = [m.id];
        // A hidden object turns on On but stays unseen and passes through Rynn; the level's own Visibility Toggler class
        // shows it first (as the tomb's toggler shows its hidden stair Movers before they move).
        if (!opt.visible && opt.toggler) {
            const { object: v } = addObject(list, {
                classId: opt.toggler.classId,
                dbIndex: opt.toggler.dbIndex,
                pos: [...o.pos] as Vec3,
                rot: [0, 0, 0],
            });
            v.flags = FLAG_VISIBLE;
            v.initialEvents = 1;
            v.radius = null;
            v.scale = null;
            v.params = [];
            v.data = [];
            v.links = [m.id];
            const vf = fieldsOf(v);
            set(v, vf, 'Trigger Mode', 1);
            set(v, vf, 'Show Message', t.message);
            set(v, vf, 'Hide Message', t.message === 0 ? 1 : 0);
            links.unshift(v.id);
        } else if (!opt.visible)
            warnings.push(`${title}: falling tree ${t.tree.id}: no Visibility Toggler class to show its Mover`);
        o.links = [...o.links.filter((l) => !links.includes(l)), ...links];
        n++;
    }
    return n;
}
