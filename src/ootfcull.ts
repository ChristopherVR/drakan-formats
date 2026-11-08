// Back-face culling of the cinematic Intro, done in the data. The PC culls back faces; the PS2 draws converted models from
// both sides (the polygon double-sided flag does not change it: a pack without it drew the same picture). The Intro's
// title cards are single-sided planes and thin boxes that rely on culling: the Surreal Software planes waiting outside the
// first shot showed mirrored below the Psygnosis owl, and the "a" / "Production" boxes printed their back faces, mirrored,
// over their front text (journal 2026-11-08/ootf-intro-graphics.md).
//
// For a level with no player (`isCinematicLevel`), every cut scene is sampled: the camera position and each placed
// model's pose (its placement, or its sequence keys) give, per polygon, whether the PC would draw its front.
//   * A polygon whose front the camera never sees while its object is shown is left out of the converted model.
//   * An object whose polygons all face away from the camera is drawn by the PC as nothing: the converted scene hides it
//     for that stretch (show / hide actions, type 6) and shows it again when it turns to the camera.
// Shells (`ootfshell.ts`) keep their own trimming; this handles open and moving models.

import { view } from './bytes.ts';
import { objectParamSpecs, type LvlObject } from './lvl.ts';
import { classFieldDefault, type OdbClass } from './odb.ts';
import type { PcModel } from './ootfmodel.ts';
import { isCinematicLevel, MODEL_UNIT } from './ootfshell.ts';
import { parsePcSequence, type PcAction, type PcSeqActor, type PcSequence } from './ootfseq.ts';
import type { PcFileSource, PcLevel } from './pc.ts';
import { SSD_SEQUENCE } from './resources.ts';
import { SrscReader } from './srsc.ts';

type Vec3 = [number, number, number];
type Quat = [number, number, number, number];

/**
 * Engine ids whose model the game draws as placed scenery: Ground Object (17), Rock (35), Morph Plug (99) and the model
 * faders (136, converted to Ground Objects). Others are left alone: a sound (6) or light carries an editor box model the game
 * never draws, so a scene's show action would put it on screen.
 */
const DRAWN_RFL: ReadonlySet<number> = new Set([17, 35, 99, 136]);
/** Morph Plug: its models morph into each other, so their polygon lists must stay the same; only hidden or shown. */
const MORPH_RFL = 99;
/** Stomp Player: plays the sequences of its list when it receives the play message. */
const STOMP_PLAYER_RFL = 51;
/** Message that makes a Stomp Player play (`SEQUENCE_MESSAGES.playSequence`). */
const PLAY_SEQUENCE = 4257;
/** Sample rate of the cut scenes, per second. */
export const CULL_SAMPLES_PER_SECOND = 30;

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** A pose: rotation matrix rows (applied to model space) and position. */
export interface Pose {
    m: [Vec3, Vec3, Vec3];
    pos: Vec3;
}

/**
 * Rotation of a placed object: stored Y degrees minus 90 (level-format.md section 3), as `ootfshell.ts` places shells.
 * Null for a tilted placement (no Euler order is known for X / Z).
 */
export function placementPose(o: Pick<LvlObject, 'pos' | 'rot'>): Pose | null {
    if (o.rot[0] % 360 !== 0 || o.rot[2] % 360 !== 0) return null;
    const yaw = (((o.rot[1] - 90) % 360) * Math.PI) / 180;
    const c = Math.cos(yaw);
    const s = Math.sin(yaw);
    return {
        m: [
            [c, 0, s],
            [0, 1, 0],
            [-s, 0, c],
        ],
        pos: [o.pos[0], o.pos[1], o.pos[2]],
    };
}

/**
 * Rotation of a sequence transform key: the conjugate of its quaternion (x, y, z, w). Checked on the Intro, where a key
 * at an object's placed position repeats its placement: the D letter (stored Y 261) is keyed with (0, 0.997, 0, -0.078),
 * the owl face (stored Y 0) with (0, 0.707, 0, 0.707). Keys are normalised (the Black Grid's is not).
 */
export function keyPose(q: Quat, pos: Vec3): Pose {
    const n = Math.hypot(...q) || 1;
    // conjugate: negate the vector part
    const x = -q[0] / n;
    const y = -q[1] / n;
    const z = -q[2] / n;
    const w = q[3] / n;
    return {
        m: [
            [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
            [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
            [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
        ],
        pos,
    };
}

interface Key {
    t: number;
    q: Quat;
    pos: Vec3;
}

function slerp(a: Quat, b: Quat, f: number): Quat {
    let d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
    const bb: Quat = d < 0 ? [-b[0], -b[1], -b[2], -b[3]] : b;
    d = Math.abs(d);
    const lerp = (): Quat => [0, 1, 2, 3].map((k) => a[k]! + (bb[k]! - a[k]!) * f) as Quat;
    if (d > 0.9995) return lerp();
    const th = Math.acos(Math.min(1, d));
    const s = Math.sin(th);
    const wa = Math.sin((1 - f) * th) / s;
    const wb = Math.sin(f * th) / s;
    return [0, 1, 2, 3].map((k) => a[k]! * wa + bb[k]! * wb) as Quat;
}

/** Key pose at time t (held before the first and after the last key), or null before the first key. */
function keyAt(keys: readonly Key[], t: number): { q: Quat; pos: Vec3 } | null {
    if (!keys.length || t < keys[0]!.t) return null;
    let i = 0;
    while (i + 1 < keys.length && keys[i + 1]!.t <= t) i++;
    const a = keys[i]!;
    const b = keys[i + 1];
    if (!b || b.t <= a.t) return { q: a.q, pos: a.pos };
    const f = (t - a.t) / (b.t - a.t);
    return {
        q: slerp(a.q, b.q, f),
        pos: [0, 1, 2].map((k) => a.pos[k]! + (b.pos[k]! - a.pos[k]!) * f) as Vec3,
    };
}

/** Absolute transform keys of an actor (keys relative to another actor make the pose unknown: null). */
function keysOf(a: PcSeqActor): Key[] | null {
    const out: Key[] = [];
    for (const x of a.actions) {
        if (x.type !== 0) continue;
        const d = view(x.payload);
        if (d.getUint32(28, true) !== 0) return null;
        out.push({
            t: x.time,
            q: [0, 4, 8, 12].map((o) => d.getFloat32(o, true)) as Quat,
            pos: [16, 20, 24].map((o) => d.getFloat32(o, true)) as Vec3,
        });
    }
    return out.sort((p, q) => p.t - q.t);
}

/** A polygon in model space: front normal (the PC front is opposite to `(b - a) x (c - a)`), a corner, view test points. */
interface Plane {
    n: Vec3;
    a: Vec3;
    pts: Vec3[];
}

/** Corners, edge midpoints and centre of a polygon: the points tested against the camera's view. */
function viewPoints(c: Vec3[]): Vec3[] {
    const mid = (a: Vec3, b: Vec3): Vec3 => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
    const centre = c.reduce<Vec3>(
        (m, p) => [m[0] + p[0] / c.length, m[1] + p[1] / c.length, m[2] + p[2] / c.length],
        [0, 0, 0],
    );
    return [...c, ...c.map((p, i) => mid(p, c[(i + 1) % c.length]!)), centre];
}

/** Model-space front planes of a PC model (scaled to world units). */
function modelPlanes(m: Pick<PcModel, 'positions' | 'polygons'>, scale: Vec3): Plane[] {
    const p = m.positions;
    const at = (i: number): Vec3 => [
        p[i * 3]! * MODEL_UNIT * scale[0],
        p[i * 3 + 1]! * MODEL_UNIT * scale[1],
        p[i * 3 + 2]! * MODEL_UNIT * scale[2],
    ];
    return m.polygons.map((poly) => {
        const a = at(poly.indices[0]!);
        const u = sub(at(poly.indices[1]!), a);
        const v = sub(at(poly.indices[2]!), a);
        return {
            n: [-(u[1] * v[2] - u[2] * v[1]), -(u[2] * v[0] - u[0] * v[2]), -(u[0] * v[1] - u[1] * v[0])],
            a,
            pts: viewPoints(poly.indices.map(at)),
        };
    });
}

/** A camera sample: position and, when known, its view direction. */
interface CameraAt {
    pos: Vec3;
    fwd: Vec3 | null;
}

/**
 * View direction of a camera key: its local -Z, turned like an object (conjugate quaternion). Checked on the Intro: the
 * cameras at (0, -0.71, 0, 0.70) look down -X at the owl and the title cards, and the Intro 3 key (0, 0.996, 0, -0.086)
 * looks straight at the DRAKAN title letters.
 */
export function cameraForward(q: Quat): Vec3 {
    const m = keyPose(q, [0, 0, 0]).m;
    return [-m[0][2], -m[1][2], -m[2][2]];
}

/** A direction from the camera within 84 degrees of its view (any field of view up to 168 degrees; not edge-on). */
const inView = (fwd: Vec3, d: Vec3): boolean => dot(fwd, d) > 0.1 * Math.hypot(...d);

/**
 * Which planes the PC draws from a camera: their front faces the camera and a corner, edge midpoint or its centre lies in view (`inView`: a polygon
 * wholly behind or beside the camera is off screen whichever side it shows).
 */
function frontsFrom(planes: readonly Plane[], pose: Pose, camera: CameraAt): boolean[] {
    // inverse rotation = transpose
    const toLocal = (d: Vec3): Vec3 => [
        pose.m[0][0] * d[0] + pose.m[1][0] * d[1] + pose.m[2][0] * d[2],
        pose.m[0][1] * d[0] + pose.m[1][1] * d[1] + pose.m[2][1] * d[2],
        pose.m[0][2] * d[0] + pose.m[1][2] * d[1] + pose.m[2][2] * d[2],
    ];
    const local = toLocal(sub(camera.pos, pose.pos));
    const fwd = camera.fwd ? toLocal(camera.fwd) : null;
    return planes.map(
        (pl) => dot(pl.n, sub(local, pl.a)) > 0 && (!fwd || pl.pts.some((p) => inView(fwd, sub(p, local)))),
    );
}

/** Show (true) / hide action of a PC sequence. */
function showAction(time: number, show: boolean): PcAction {
    const payload = new Uint8Array(4);
    view(payload).setUint32(0, show ? 1 : 0, true);
    return { type: 6, time, payload };
}

export interface CullTarget {
    /** PC level object id. */
    id: number;
    cls: OdbClass;
    model: Pick<PcModel, 'positions' | 'polygons'>;
    /** Polygons may be left out of the model (false for morph models). */
    trimmable: boolean;
}

export interface CullPlan {
    /** PC polygon indices to leave out, per class model (only polygons unseen at every placement). */
    drops: Map<OdbClass, Set<number>>;
    /** PC sequence id -> show / hide timeline per PC object id (replaces the object's own show / hide actions). */
    visibility: Map<number, Map<number, PcAction[]>>;
    /** Sequences in the order they were simulated. */
    order: number[];
}

/**
 * Order in which the scenes play: a scene that sends the play message to a Stomp Player is followed by that player's list.
 * Scenes no other scene starts come first (by id); unreached ones follow by id.
 */
export function sequencePlayOrder(
    pc: Pick<PcLevel, 'list' | 'classes'>,
    seqs: readonly PcSequence[],
): { order: number[]; started: Set<number> } {
    const byObj = new Map(pc.list.objects.map((o) => [o.id, o]));
    const ids = new Set(seqs.map((s) => s.id));
    const next = new Map<number, number[]>();
    const started = new Set<number>();
    for (const s of seqs)
        for (const a of s.actors) {
            const o = a.actorType === 1 ? byObj.get(a.objectId) : undefined;
            if (!o || pc.classes.get(o.dbIndex)?.get(o.classId)?.rflClass !== STOMP_PLAYER_RFL) continue;
            if (!a.actions.some((x) => x.type === 7 && view(x.payload).getUint32(0, true) === PLAY_SEQUENCE)) continue;
            const list = stompSequences(pc, o).filter((x) => ids.has(x));
            next.set(s.id, [...(next.get(s.id) ?? []), ...list]);
            for (const x of list) started.add(x);
        }
    const out: number[] = [];
    const visit = (id: number): void => {
        if (out.includes(id)) return;
        out.push(id);
        for (const n of next.get(id) ?? []) visit(n);
    };
    const sorted = [...ids].sort((a, b) => a - b);
    for (const id of sorted) if (!started.has(id)) visit(id);
    for (const id of sorted) visit(id);
    return { order: out, started };
}

/** Sequence ids a Stomp Player's `Sequence List` names (object override, else the class default). */
export function stompSequences(pc: Pick<PcLevel, 'classes'>, o: LvlObject): number[] {
    const cls = pc.classes.get(o.dbIndex)?.get(o.classId);
    const fi = cls?.fields?.findIndex((f) => /^sequence list$/i.test(f.name.trim())) ?? -1;
    if (!cls || fi < 0) return [];
    const spec = objectParamSpecs(o).find((sp) => sp.fieldIndex === fi);
    const v = spec ? spec.value : classFieldDefault(cls, fi);
    return (Array.isArray(v) ? v : [v])
        .filter((x): x is number => typeof x === 'number' && x !== 0)
        .map((x) => x & 0xffff);
}

/** The scenes a placed Stomp Player of the level plays (all of `seqs` when the level has none). */
export function playedSequences(pc: Pick<PcLevel, 'list' | 'classes'>, seqs: readonly PcSequence[]): PcSequence[] {
    const named = new Set<number>();
    for (const o of pc.list.objects)
        if (pc.classes.get(o.dbIndex)?.get(o.classId)?.rflClass === STOMP_PLAYER_RFL)
            for (const id of stompSequences(pc, o)) named.add(id);
    return named.size ? seqs.filter((s) => named.has(s.id)) : [...seqs];
}

/**
 * Plan the culling of a cinematic level's placed models over its scenes. `targets` are the placed objects with a static
 * (not skinned) model; `seqs` the scenes that are converted.
 */
export function planCinematicCulling(
    pc: Pick<PcLevel, 'list' | 'classes'>,
    seqs: readonly PcSequence[],
    targets: readonly CullTarget[],
    rate = CULL_SAMPLES_PER_SECOND,
): CullPlan {
    const byObj = new Map(pc.list.objects.map((o) => [o.id, o]));
    const cameraIds = new Set(
        pc.list.objects.filter((o) => pc.classes.get(o.dbIndex)?.get(o.classId)?.rflClass === 27).map((o) => o.id),
    );
    const { order, started } = sequencePlayOrder(pc, seqs);
    const seqById = new Map(seqs.map((s) => [s.id, s]));
    const planes = new Map<number, Plane[]>();
    for (const t of targets) {
        const o = byObj.get(t.id);
        if (!o) continue;
        const sc = o.scale ?? [1, 1, 1];
        planes.set(t.id, modelPlanes(t.model, [sc[0], sc[1], sc[2]]));
    }
    // carried state per object across the scenes of a chain: shown (as authored and as converted) and pose
    interface State {
        shown: boolean;
        converted: boolean;
        pose: Pose | null;
    }
    const initial = (o: LvlObject): State => ({
        shown: (o.flags & 1) !== 0,
        converted: (o.flags & 1) !== 0,
        pose: placementPose(o),
    });
    const state = new Map<number, State>();
    for (const t of targets) {
        const o = byObj.get(t.id);
        if (o) state.set(t.id, initial(o));
    }
    let camera: CameraAt | null = null;
    // per target: polygons seen from the front at least once while shown (null = pose unknown while shown: keep all)
    const seen = new Map<number, boolean[] | null>();
    const visibility = new Map<number, Map<number, PcAction[]>>();
    for (const sid of order) {
        const seq = seqById.get(sid)!;
        if (!started.has(sid)) {
            // a scene no other scene starts begins from the placed state
            for (const t of targets) {
                const o = byObj.get(t.id);
                if (o) state.set(t.id, initial(o));
            }
            camera = null;
        }
        const actorOf = new Map<number, PcSeqActor>();
        for (const a of seq.actors) if (a.actorType === 1) actorOf.set(a.objectId, a);
        const end = seq.actors.reduce((m, a) => a.actions.reduce((mm, x) => Math.max(mm, x.time), m), 0);
        const camActor = seq.actors.find(
            (a) => (a.actorType === 1 && cameraIds.has(a.objectId)) || /^camera$/i.test(a.name.trim()),
        );
        const camKeys = camActor ? keysOf(camActor) : [];
        const steps = Math.max(1, Math.ceil(end * rate));
        // the grid plus every authored show / hide time, so a timeline keeps the authored instants
        const times = [
            ...new Set([
                ...Array.from({ length: steps + 1 }, (_, i) => Math.min(end, i / rate)),
                ...seq.actors.flatMap((a) => a.actions.filter((x) => x.type === 6).map((x) => Math.max(0, x.time))),
            ]),
        ].sort((p, q) => p - q);
        const camAt = times.map((t): CameraAt | null => {
            const k = keyAt(camKeys ?? [], t);
            return k ? { pos: k.pos, fwd: cameraForward(k.q) } : camera;
        });
        const perSeq = new Map<number, PcAction[]>();
        for (const t of targets) {
            const st = state.get(t.id);
            const pl = planes.get(t.id);
            if (!st || !pl) continue;
            const a = actorOf.get(t.id);
            const keys = a ? keysOf(a) : [];
            const shows = (a?.actions ?? [])
                .filter((x) => x.type === 6)
                .map((x) => ({ t: x.time, on: view(x.payload).getUint32(0, true) !== 0 }))
                .sort((p, q) => p.t - q.t);
            const want: boolean[] = [];
            const authored: boolean[] = [];
            let shown = st.shown;
            let k = 0;
            let pose = st.pose;
            const unknown = keys === null;
            for (let i = 0; i < times.length; i++) {
                const tt = times[i]!;
                while (k < shows.length && shows[k]!.t <= tt) shown = shows[k++]!.on;
                const kp = keys ? keyAt(keys, tt) : null;
                if (kp) pose = keyPose(kp.q, kp.pos);
                const cam = camAt[i];
                authored.push(shown);
                if (!shown) {
                    want.push(false);
                    continue;
                }
                if (unknown || !pose || !cam) {
                    want.push(true);
                    seen.set(t.id, null);
                    continue;
                }
                const fronts = frontsFrom(pl, pose, cam);
                const prev = seen.get(t.id);
                if (prev !== null) {
                    const acc = prev ?? new Array<boolean>(pl.length).fill(false);
                    fronts.forEach((f, j) => {
                        if (f) acc[j] = true;
                    });
                    seen.set(t.id, acc);
                }
                want.push(fronts.some(Boolean));
            }
            while (k < shows.length) shown = shows[k++]!.on;
            const changed = want.some((w, i) => w !== authored[i]) || st.converted !== st.shown;
            if (changed) {
                const actions: PcAction[] = [showAction(0, want[0]!)];
                for (let i = 1; i < want.length; i++)
                    if (want[i] !== want[i - 1]) actions.push(showAction(times[i]!, want[i]!));
                perSeq.set(t.id, actions);
                st.converted = want[want.length - 1]!;
            } else st.converted = shown;
            st.shown = shown;
            if (keys) {
                const last = keys[keys.length - 1];
                if (last) st.pose = keyPose(last.q, last.pos);
            } else st.pose = null;
        }
        const lastCam = camKeys?.length ? camKeys[camKeys.length - 1]! : null;
        if (lastCam) camera = { pos: lastCam.pos, fwd: cameraForward(lastCam.q) };
        if (perSeq.size) visibility.set(sid, perSeq);
    }
    const perClass = new Map<OdbClass, (boolean[] | null)[]>();
    for (const t of targets) {
        if (!t.trimmable) continue;
        const s = seen.get(t.id);
        (perClass.get(t.cls) ?? perClass.set(t.cls, []).get(t.cls)!).push(s === undefined ? null : s);
    }
    const drops = new Map<OdbClass, Set<number>>();
    for (const [cls, list] of perClass) {
        if (list.some((x) => x === null)) continue;
        const n = list[0]!.length;
        const drop = new Set<number>();
        for (let j = 0; j < n; j++) if (list.every((x) => !x![j])) drop.add(j);
        // a model never seen from the front at all is hidden by the scenes instead; keep it whole
        if (drop.size && drop.size < n) drops.set(cls, drop);
    }
    return { drops, visibility, order };
}

/** The scene with the planned show / hide timelines in place of the objects' own show / hide actions. */
export function applyCulling(
    seq: PcSequence,
    plan: Pick<CullPlan, 'visibility'>,
    names?: (objectId: number) => string,
): PcSequence {
    const vis = plan.visibility.get(seq.id);
    if (!vis?.size) return seq;
    const actors = seq.actors.map((a) => {
        const v = a.actorType === 1 ? vis.get(a.objectId) : undefined;
        return v ? { ...a, actions: [...a.actions.filter((x) => x.type !== 6), ...v] } : a;
    });
    let nextId = actors.reduce((m, a) => Math.max(m, a.id), 0) + 1;
    for (const [objectId, v] of vis) {
        if (actors.some((a) => a.actorType === 1 && a.objectId === objectId)) continue;
        actors.push({
            name: names?.(objectId) ?? `cull ${objectId}`,
            id: nextId++,
            actorType: 1,
            assignedAs: 0,
            objectId,
            actions: v,
        });
    }
    return { ...seq, actors };
}

/** The scenes of `ssds` that `only` names (all when omitted), parsed; unreadable ones are skipped. */
export async function readPcSequences(ssds: readonly SrscReader[], only?: ReadonlySet<number>): Promise<PcSequence[]> {
    const out: PcSequence[] = [];
    for (const r of ssds)
        for (const e of r.entries) {
            if (e.type !== SSD_SEQUENCE || (only && !only.has(e.id))) continue;
            try {
                out.push(parsePcSequence(e.id, e.sub, (await r.read(e)).data));
            } catch {
                /* skipped as in convertPcSequences */
            }
        }
    return out;
}

/** True when dependency `dbIndex` of a level is its own database (the `.odb` in the level's folder). */
function ownDatabase(pc: Pick<PcLevel, 'path' | 'odbPaths'>, dbIndex: number): boolean {
    const dir = (p: string): string => p.split('/').slice(0, -1).join('/').toLowerCase();
    const odb = pc.odbPaths.get(dbIndex);
    return odb !== undefined && dir(odb) === dir(pc.path);
}

/** Key of a scene file: its path without the extension, lower case (`Mountain World/Intro Level/Intro Level`). */
export const sceneFileKey = (path: string): string => path.replace(/\.ssd$/i, '').toLowerCase();

export interface LevelCulling {
    /** Scene file key (`sceneFileKey`) -> plan of its scenes. */
    plans: Map<string, CullPlan>;
    /** Polygons to leave out per class model, over every placement in every planned level. */
    drops: Map<OdbClass, Set<number>>;
}

/**
 * Culling plans of the cinematic levels among `levels`, from the `.ssd` beside each of a level's `.odb` dependencies.
 * `readModel` returns a class's PC model. A class model placed in several levels loses only polygons no level shows.
 */
export async function planLevelCulling(
    levels: readonly PcLevel[],
    src: PcFileSource,
    readModel: (cls: OdbClass) => Promise<PcModel | null>,
): Promise<LevelCulling> {
    const plans = new Map<string, CullPlan>();
    const perClass = new Map<OdbClass, Set<number>[]>();
    const models = new Map<OdbClass, PcModel | null>();
    // classes placed in a playable level of the batch keep every polygon
    const sharedClasses = new Set<OdbClass>();
    for (const pc of levels)
        if (!isCinematicLevel(pc))
            for (const o of pc.list.objects) {
                const cls = pc.classes.get(o.dbIndex)?.get(o.classId);
                if (cls) sharedClasses.add(cls);
            }
    for (const pc of levels) {
        if (!isCinematicLevel(pc)) continue;
        const targets: CullTarget[] = [];
        for (const o of pc.list.objects) {
            const cls = pc.classes.get(o.dbIndex)?.get(o.classId);
            if (!cls?.model || !DRAWN_RFL.has(cls.rflClass ?? -1)) continue;
            if (!models.has(cls)) {
                const m = await readModel(cls).catch(() => null);
                models.set(cls, m && !m.character && m.polygons.length ? m : null);
            }
            const m = models.get(cls);
            // Only models of the level's own database are trimmed: a shared class may be placed in a playable level,
            // whose player can walk behind it.
            const own = ownDatabase(pc, o.dbIndex) && !sharedClasses.has(cls);
            if (m) targets.push({ id: o.id, cls, model: m, trimmable: own && cls.rflClass !== MORPH_RFL });
        }
        if (!targets.length) continue;
        for (const path of new Set([...pc.odbPaths.values()].map((x) => x.replace(/\.odb$/i, '.ssd')))) {
            const b = await src.read(path);
            if (!b) continue;
            const seqs = playedSequences(pc, await readPcSequences([await SrscReader.fromBytes(b)]));
            if (!seqs.length) continue;
            const plan = planCinematicCulling(pc, seqs, targets);
            plans.set(sceneFileKey(path), plan);
            for (const [cls, d] of plan.drops) (perClass.get(cls) ?? perClass.set(cls, []).get(cls)!).push(d);
        }
    }
    const drops = new Map<OdbClass, Set<number>>();
    for (const [cls, list] of perClass) {
        const [first, ...rest] = list;
        const d = new Set([...first!].filter((i) => rest.every((x) => x.has(i))));
        if (d.size) drops.set(cls, d);
    }
    return { plans, drops };
}
