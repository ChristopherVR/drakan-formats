// Push-over objects: trees and pillars Rynn fells to bridge a gap, bricks and pillars she knocks over to set off a chain.
//
// The PC Ground Object (engine 17) has "Push Over Mode", "Fall When Dead" and "Message To Send When Pushed". The campaign has
// six such objects: Ruined Village's "push tree" (mode 5; it falls over a chasm onto the orc taunting on the far side, whose
// Timer gibs him 1.65 s after the push, and is the bridge), Wartok Canyons' "Push Pillar" (7) with its "Push Brace" (1)
// (a bridge), Alwarren's two "Brick"s (5; one sends Off to two magic flames of the ring round a barrier crystal) and the
// Islands "Goblin Pillar" (4; starts the timer that drops a cage). The PS2 Ground Object has none of these fields (its 16
// end at "Smoke Generator"), so they were props with health 0 that nothing could move.
//
// A weapon blow reaches a PS2 Ground Object with health (message 0x1084 in 0x215030); at health 0 it is destroyed
// (0x214488) and sends its "Message To Send" along its links. The PS2 fells a tree with a Mover (35) that turns (the disc's
// "Tree Mechanism", Type 1; Type 4 slides as it turns). So a push-over object becomes:
//
//   * the standing object: the converted Ground Object with "Initial Health" 1 and "Message To Send" the PC "Message To
//     Send When Pushed", without explosion, smoke or rubble: one blow removes it and sends the PC message (the modes, which
//     were not decoded, all become a blow: the PS2 has no push for a static prop);
//   * when it bridges a gap (`bridgeAxis`): a hidden Mover with its model on the same spot, shown by a Visibility Toggler
//     of the level's own class at the same message, that turns a quarter turn toward the gap in 1.6 s (the PC Timer of the
//     tree gibs the orc 1.65 s after the push, so the fall takes about that) and sinks while it turns, so that the trunk's
//     top near its foot is a step (`TRUNK_STEP`) over the ledge: the PS2 Rynn does not climb onto a trunk lying with its
//     full thickness over the ground. Objects on the same spot (the brace) fall with it; the props at its foot (roots,
//     base) collide only with their low polygons (`treeFootProps`), so Rynn walks over them onto the trunk;
//   * otherwise only the blow and the message (`break`): the object vanishes instead of toppling.
//
// The fall direction is not stored on the PC: it is the one of the four model axes where the ground at the far end is at
// the foot's height again with a drop in between, the gap it bridges.

import { FLAG_SCALED, FLAG_VISIBLE, addObject, type LvlObject, type LvlObjectList, type Vec3 } from './lvl.ts';
import type { OdbClass } from './odb.ts';
import type { PcLevel } from './pc.ts';
import { layerHeightAt } from './terrain.ts';
import { pcFieldNumber, setNamedParam } from './ootfpuzzle.ts';
import type { ClassFieldDef } from './fields.ts';

export const GROUND_OBJECT_RFL = 17;
export const MOVER_RFL = 35;

/** One of the model's horizontal axes, as the direction the top of the tree falls toward. */
export type ModelAxis = '+x' | '-x' | '+z' | '-z';

export interface FallingTree {
    tree: LvlObject;
    cls: OdbClass;
    /**
     * `bridge`: it falls over a gap and is walked over (a Mover turns it down); `break`: no gap to bridge, so one blow only
     * removes it and sends its message (Alwarren's flame brick, the Islands goblin pillar).
     */
    kind: 'bridge' | 'break';
    /** Other push-over objects on the same spot that fall with it (Wartok Canyons' Push Brace on its Push Pillar). */
    followers: { o: LvlObject; cls: OdbClass }[];
    /** Model axis the top falls toward (a `break` keeps the value but does not fall). */
    toward: ModelAxis;
    /** World direction (x, z) of the fall. */
    dir: [number, number];
    /** Length of the tree (model height above its origin, world units). */
    length: number;
    /** PC "Message To Send When Pushed" (the message the fall sends along the tree's links). */
    message: number;
    /**
     * How far the fallen trunk sinks (world units, 0 = none) so that its top near the foot is a step over the ground there:
     * the PC level means it to be walked onto ("Fall When Dead" bridge), and the PS2 Rynn does not climb onto a trunk
     * lying with its full thickness above the ledge.
     */
    sink: number;
}

/** Height of the fallen trunk's top over the ground at its foot that Rynn walks onto (world units). */
export const TRUNK_STEP = 200;
/** Roots at the foot of a felled tree collide only up to this height over the ground there (world units). */
export const ROOT_STEP = 150;

/**
 * Static props at the foot of a felled tree (its roots and stump: Ruined Village's "pushtreebase" stands on the same spot),
 * with the highest model y (world units at scale 1) whose polygons should still collide: up to `ROOT_STEP` over the foot.
 */
export function treeFootProps(pc: PcLevel, t: FallingTree): { o: LvlObject; cls: OdbClass; maxY: number }[] {
    const foot = footHeight(pc, t.tree.pos);
    const out: { o: LvlObject; cls: OdbClass; maxY: number }[] = [];
    if (!Number.isFinite(foot)) return out;
    for (const o of pc.list.objects) {
        if (o === t.tree) continue;
        const cls = pc.classes.get(o.dbIndex)?.get(o.classId);
        if (cls?.rflClass !== GROUND_OBJECT_RFL || !cls.model) continue;
        if (Math.hypot(o.pos[0] - t.tree.pos[0], o.pos[2] - t.tree.pos[2]) > 300) continue;
        if (Math.abs(o.pos[1] - t.tree.pos[1]) > 400) continue;
        out.push({ o, cls, maxY: (foot + ROOT_STEP - o.pos[1]) / (o.scale?.[1] ?? 1) });
    }
    return out;
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
export function footHeight(pc: Pick<PcLevel, 'terrain'>, pos: readonly number[]): number {
    const [x, y, z] = pos as [number, number, number];
    return heights(pc, x, z)
        .filter((h) => h <= y + 200)
        .reduce((m, h) => Math.max(m, h), -Infinity);
}

/**
 * Top of the trunk's lower fifth once fallen toward `toward`, over the pivot (world units at scale 1): the model coordinate
 * that points up after the quarter turn (model +z for a fall toward -z, and so on), over the vertices of the first fifth of
 * the trunk's length. `positions` are model coordinates in lu (x, y, z triples).
 */
export function fallenButtTop(positions: ArrayLike<number>, toward: ModelAxis, length: number): number {
    const up = toward[1] === 'x' ? 0 : 2;
    const s = toward[0] === '+' ? -1 : 1;
    let top = -Infinity;
    for (let i = 0; i + 2 < positions.length; i += 3) {
        const y = positions[i + 1]! * 2048;
        if (y < 0 || y > length * 0.2) continue;
        top = Math.max(top, s * positions[i + up]! * 2048);
    }
    return top;
}

export function bridgeAxis(
    pc: Pick<PcLevel, 'terrain'>,
    pos: readonly number[],
    yawDeg: number,
    length: number,
    tol = 600,
): ModelAxis | undefined {
    const [x, , z] = pos as [number, number, number];
    const foot = footHeight(pc, pos);
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

/**
 * PC Ground Objects that can be pushed over (any "Push Over Mode" but 0): Ruined Village's tree (5), Wartok Canyons' Push
 * Pillar (7) with its Push Brace (1), Alwarren's two bricks (5), the Islands goblin pillar (4). What the modes mean was not
 * established; on the PS2 a blow does it (the engine has no push-over and no way for Rynn to push a static prop). Objects on
 * the same spot form one group, led by the longest: a `bridge` when the leader bridges a gap, else every member is a `break`.
 */
export function findFallingTrees(
    pc: PcLevel,
    lengthOf: (cls: OdbClass) => number | undefined,
    positionsOf?: (cls: OdbClass) => ArrayLike<number> | undefined,
): FallingTree[] {
    const cands: { o: LvlObject; cls: OdbClass; length: number; raw: number }[] = [];
    for (const o of pc.list.objects) {
        const cls = pc.classes.get(o.dbIndex)?.get(o.classId);
        if (cls?.rflClass !== GROUND_OBJECT_RFL || !cls.model) continue;
        if (!pcFieldNumber(pc, o, 'Push Over Mode')) continue;
        const raw = lengthOf(cls) ?? 0;
        cands.push({ o, cls, raw, length: raw * (o.scale?.[1] ?? 1) });
    }
    const out: FallingTree[] = [];
    const done = new Set<LvlObject>();
    for (const c of cands) {
        if (done.has(c.o)) continue;
        const group = cands.filter(
            (d) =>
                !done.has(d.o) &&
                Math.hypot(d.o.pos[0] - c.o.pos[0], d.o.pos[1] - c.o.pos[1], d.o.pos[2] - c.o.pos[2]) < 60,
        );
        for (const d of group) done.add(d.o);
        group.sort((a, b) => b.length - a.length);
        const lead = group[0]!;
        const toward = lead.length > 0 ? bridgeAxis(pc, lead.o.pos, lead.o.rot[1], lead.length) : undefined;
        const message = (o: LvlObject): number =>
            (pcFieldNumber(pc, o, 'Send Message When Pushed?') ?? 1) !== 0
                ? (pcFieldNumber(pc, o, 'Message To Send When Pushed') ?? 1)
                : NO_MESSAGE;
        if (toward) {
            const pos = positionsOf?.(lead.cls);
            const top = pos ? fallenButtTop(pos, toward, lead.raw) * (lead.o.scale?.[1] ?? 1) : -Infinity;
            const sink = Number.isFinite(top)
                ? Math.max(0, lead.o.pos[1] + top - (footHeight(pc, lead.o.pos) + TRUNK_STEP))
                : 0;
            out.push({
                tree: lead.o,
                cls: lead.cls,
                kind: 'bridge',
                followers: group.slice(1).map((d) => ({ o: d.o, cls: d.cls })),
                toward,
                dir: modelAxisWorld(toward, lead.o.rot[1]),
                length: lead.length,
                message: message(lead.o),
                sink: Math.round(sink),
            });
            continue;
        }
        for (const d of group)
            out.push({
                tree: d.o,
                cls: d.cls,
                kind: 'break',
                followers: [],
                toward: '+x',
                dir: modelAxisWorld('+x', d.o.rot[1]),
                length: d.length,
                message: message(d.o),
                sink: 0,
            });
    }
    return out;
}

/** The message enum's "<none>": a Ground Object destroyed with it sends nothing its links act on. */
export const NO_MESSAGE = 32;

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
    ['Slide acceleration time', 2],
    ['Slide deceleration time', 2],
    ['Total sliding time', 2],
    ['Slide Distance (lu)', 2],
    ['Slide Axis', 7],
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
export function fallingTreeMoverClass(
    t: FallingTree,
    id: number,
    sign = 1,
    member: { cls: OdbClass } = { cls: t.cls },
): OdbClass {
    const rot = fallRotation(t.toward, sign);
    // Type 4 slides and turns at once (the disc's elevator cog, Bonegrinder door): the trunk sinks while it falls.
    const values: Record<string, number> = {
        Type: t.sink > 0 ? 4 : 1,
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
        'Slide acceleration time': f32(1.4),
        'Slide deceleration time': f32(0.05),
        'Total sliding time': f32(1.6),
        'Slide Distance (lu)': f32(-t.sink / 2048),
        'Slide Axis': AXIS_INDEX.y,
    };
    const fields: ClassFieldDef[] = MOVER_FIELDS.map(([name, type]) => ({ name, type }));
    return {
        id,
        name: `${member.cls.name.trim()} (falling)`,
        group: member.cls.group,
        runtimeClass: 0x10000 | MOVER_RFL,
        model: member.cls.model ?? null,
        rflClass: MOVER_RFL,
        icon: member.cls.icon,
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
    mover?: { dbIndex: number; classId: number };
    /** PS2 sound reference of the PC "Hit Ground Sound", played when the Mover stops (undefined: silent). */
    stopSound?: number;
    /** The followers' Mover classes, in `t.followers` order. */
    followerMovers?: { dbIndex: number; classId: number }[];
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
    for (const { t, mover, stopSound, followerMovers } of trees) {
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
        if (t.kind === 'break' || !mover) {
            n++;
            continue;
        }
        const newObject = (cls: { dbIndex: number; classId: number }, at: LvlObject, visible: boolean): LvlObject => {
            const { object: v } = addObject(list, {
                classId: cls.classId,
                dbIndex: cls.dbIndex,
                pos: [...at.pos] as Vec3,
                rot: [...at.rot] as Vec3,
            });
            v.flags = (visible ? FLAG_VISIBLE : 0) | (at.scale ? FLAG_SCALED : 0);
            v.initialEvents = 1;
            v.radius = null;
            v.scale = at.scale ? ([...at.scale] as Vec3) : null;
            v.links = [];
            v.params = [];
            v.data = [];
            return v;
        };
        // Followers (a brace on a pillar): their own hidden Mover each, shown and turned with the leader's; their standing
        // objects are hidden by a toggler at the same message.
        const extra: LvlObject[] = [];
        const standing: number[] = [];
        t.followers.forEach((f, k) => {
            const fm = followerMovers?.[k];
            const fo = list.objects.find((x) => x.id === f.o.id);
            if (!fm || !fo) {
                warnings.push(`${title}: falling tree ${t.tree.id}: follower ${f.o.id} was not converted`);
                return;
            }
            const m2 = newObject(fm, fo, !!opt.visible);
            for (const name of MOVER_SOUNDS) set(m2, fieldsOf(m2), name, 0);
            extra.push(m2);
            standing.push(fo.id);
        });
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
        for (const name of MOVER_SOUNDS) set(m, mf, name, name === 'Stop Sound' && stopSound ? stopSound : 0);
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
            v.links = [m.id, ...extra.map((e) => e.id)];
            const vf = fieldsOf(v);
            set(v, vf, 'Trigger Mode', 1);
            set(v, vf, 'Show Message', t.message);
            set(v, vf, 'Hide Message', t.message === 0 ? 1 : 0);
            links.unshift(v.id);
            if (standing.length) {
                const { object: h } = addObject(list, {
                    classId: opt.toggler.classId,
                    dbIndex: opt.toggler.dbIndex,
                    pos: [...o.pos] as Vec3,
                    rot: [0, 0, 0],
                });
                h.flags = FLAG_VISIBLE;
                h.initialEvents = 1;
                h.radius = null;
                h.scale = null;
                h.params = [];
                h.data = [];
                h.links = standing;
                const hf = fieldsOf(h);
                set(h, hf, 'Trigger Mode', 1);
                set(h, hf, 'Show Message', NO_MESSAGE);
                set(h, hf, 'Hide Message', t.message);
                links.unshift(h.id);
            }
        } else if (!opt.visible)
            warnings.push(`${title}: falling tree ${t.tree.id}: no Visibility Toggler class to show its Mover`);
        links.push(...extra.map((e) => e.id));
        o.links = [...o.links.filter((l) => !links.includes(l)), ...links];
        n++;
    }
    return n;
}
