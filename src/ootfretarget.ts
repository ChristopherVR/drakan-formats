/**
 * Order of the Flame creatures -> a DIFFERENT PS2 creature rig (animation retarget by joint correspondence).
 * Evidence: docs/journal/2026-11-01/ootf-creature-retarget.md.
 *
 * `ootfcreature.ts` converts PC animations onto a rig with the SAME joint tree (spider). Most OotF creatures have a PS2
 * relative with a different tree (goblin 3680 vs PS2 goblin 4550 differs only in bind pose; PC troll has 30 joints, the PS2
 * troll 50; hueges 34 vs 55; deathmage 44 vs 46). A PC key is a rotation in MODEL axes applied after the joint's bind
 * world orientation (ootfcreature.ts), so it is rig independent: map each target joint to the PC joint with the same
 * role, feed that joint's keys through the target's own bind basis, and leave unmatched target joints at their bind
 * pose. The root translation is scaled by the size ratio of the two rigs.
 */
import { type PcAnim, type Ps2Anim, type Skeleton, writePs2Anim } from './ootfanim.ts';
import { type ConvertAnimOptions, bindBasis, convertPcAnimToPs2 } from './ootfcreature.ts';
import { buildRig, invertMat12, mulMat12, quatToMat12, mat12ToQuat, type Rig } from './skeleton.ts';

// ------------------------------------------------------------------------------------------------ name matching

/** Canonical body-part words (both games name the same bones differently). */
const PART_SYNONYMS: Record<string, string> = {
    shoulder: 'shoulder',
    collar: 'shoulder',
    clavicle: 'shoulder',
    bicep: 'upperarm',
    uparm: 'upperarm',
    upperarm: 'upperarm',
    armup: 'upperarm',
    arm: 'upperarm',
    forearm: 'forearm',
    lowarm: 'forearm',
    lowerarm: 'forearm',
    armlow: 'forearm',
    radius: 'forearm',
    hand: 'hand',
    thigh: 'thigh',
    upleg: 'thigh',
    femur: 'thigh',
    calf: 'calf',
    shin: 'calf',
    lowleg: 'calf',
    tibia: 'calf',
    foot: 'foot',
    toe: 'toe',
    heel: 'heel',
    head: 'head',
    neck: 'neck',
    jaw: 'jaw',
    lowjaw: 'jaw',
    lowerjaw: 'jaw',
    tail: 'tail',
};

/** Keys a joint name can be matched under, strongest first: the plain normalised name, then `side:part`. */
export function nameKeys(raw: string): string[] {
    const plain = raw.toLowerCase().replace(/[^a-z0-9]/g, '');
    const keys = [plain];
    let side = '';
    let rest = '';
    let m = /^(left|right)[_ ]?(.+)$/i.exec(raw);
    if (m) {
        side = m[1]![0]!.toLowerCase();
        rest = m[2]!;
    } else if ((m = /^(.+?)[_ ]?([LR])$/.exec(raw))) {
        side = m[2]!.toLowerCase();
        rest = m[1]!;
    } else if ((m = /^([LRlr])(.+)$/.exec(raw))) {
        side = m[1]!.toLowerCase();
        rest = m[2]!;
    }
    if (side) {
        const part = rest.toLowerCase().replace(/[^a-z]/g, '');
        const canon = PART_SYNONYMS[part];
        if (canon) keys.push(`${side}:${canon}`);
    } else {
        const canon = PART_SYNONYMS[plain];
        if (canon && canon !== plain) keys.push(`c:${canon}`);
    }
    return keys;
}

export interface JointMatch {
    /** For every TARGET joint the matched SOURCE (PC) joint, or -1. One-to-one. */
    map: number[];
    matched: number;
    /** How each match was found, per target joint ('name', 'canon', 'root', 'tree' or ''). */
    how: string[];
    unmatchedTarget: string[];
    unmatchedSource: string[];
}

/**
 * Pair the joints of `dst` (PS2 target) with those of `src` (PC source). Stages: identical normalised name, side+part
 * synonyms, the single root of each, then the tree walk (an unmatched target child of a matched parent takes the only
 * unmatched source child of that parent's partner).
 */
export function matchJoints(src: Rig, dst: Rig): JointMatch {
    const map = new Array<number>(dst.jointCount).fill(-1);
    const how = new Array<string>(dst.jointCount).fill('');
    const used = new Uint8Array(src.jointCount);
    const srcKeys = src.names.map(nameKeys);
    const dstKeys = dst.names.map(nameKeys);
    const take = (d: number, s: number, h: string): void => {
        map[d] = s;
        how[d] = h;
        used[s] = 1;
    };
    for (const [stage, ki, label] of [
        ['plain', 0, 'name'],
        ['canon', 1, 'canon'],
    ] as const) {
        void stage;
        const index = new Map<string, number[]>();
        srcKeys.forEach((ks, s) => {
            if (used[s] || ks[ki] === undefined) return;
            const l = index.get(ks[ki]!) ?? [];
            l.push(s);
            index.set(ks[ki]!, l);
        });
        for (let d = 0; d < dst.jointCount; d++) {
            if (map[d]! >= 0 || dstKeys[d]![ki] === undefined) continue;
            const cand = (index.get(dstKeys[d]![ki]!) ?? []).filter((s) => !used[s]);
            // only an unambiguous key matches (two "tail" joints stay for the tree walk)
            if (cand.length === 1) take(d, cand[0]!, label);
        }
    }
    const dstRoots = dst.parents.map((p, j) => (p < 0 ? j : -1)).filter((j) => j >= 0);
    const srcRoots = src.parents.map((p, j) => (p < 0 ? j : -1)).filter((j) => j >= 0);
    if (dstRoots.length === 1 && srcRoots.length === 1 && map[dstRoots[0]!]! < 0 && !used[srcRoots[0]!])
        take(dstRoots[0]!, srcRoots[0]!, 'root');
    // tree walk, repeated until nothing changes (a new match can unlock its children)
    for (let changed = true; changed;) {
        changed = false;
        for (const d of dst.order) {
            const pd = dst.parents[d]!;
            if (map[d]! >= 0 || pd < 0 || map[pd]! < 0) continue;
            const ps = map[pd]!;
            const dKids = dst.parents.flatMap((p, j) => (p === pd && map[j]! < 0 ? [j] : []));
            const sKids = src.parents.flatMap((p, j) => (p === ps && !used[j] ? [j] : []));
            if (dKids.length === 1 && sKids.length === 1) {
                take(d, sKids[0]!, 'tree');
                changed = true;
            }
        }
    }
    return {
        map,
        matched: map.filter((s) => s >= 0).length,
        how,
        unmatchedTarget: dst.names.filter((_, d) => map[d]! < 0),
        unmatchedSource: src.names.filter((_, s) => !used[s]),
    };
}

// ------------------------------------------------------------------------------------------------ rig scale and choice

/** Model-space bind position of every joint (3 floats each). */
export function bindPositions(rig: Rig): Float32Array {
    const out = new Float32Array(rig.jointCount * 3);
    for (let j = 0; j < rig.jointCount; j++) {
        const w = invertMat12(rig.invBind.subarray(j * 12, j * 12 + 12));
        out.set(w.subarray(9, 12), j * 3);
    }
    return out;
}

/** Overall size of a rig: the largest edge of the bounding box of its joint positions (0 for a single joint). */
export function rigSize(rig: Rig): number {
    const p = bindPositions(rig);
    let best = 0;
    for (let c = 0; c < 3; c++) {
        let lo = Infinity;
        let hi = -Infinity;
        for (let j = 0; j < rig.jointCount; j++) {
            lo = Math.min(lo, p[j * 3 + c]!);
            hi = Math.max(hi, p[j * 3 + c]!);
        }
        best = Math.max(best, hi - lo);
    }
    return best;
}

export interface RetargetCandidate {
    id: number;
    skeleton: Skeleton;
}
export interface RetargetChoice {
    id: number;
    match: JointMatch;
    /** matched / PC joints that carry weight or are animated: how much of the PC motion survives. */
    sourceCoverage: number;
    /** matched / target joints: how much of the target is driven. */
    targetCoverage: number;
}

/**
 * Best PS2 rig for a PC creature by joint correspondence. Score = sourceCoverage * (0.5 + 0.5 * targetCoverage), so a
 * target that keeps all the PC motion beats one that is merely similar in size. `minSource` (default 0.5) is the least
 * fraction of PC joints that must find a partner.
 */
export function chooseRetargetTarget(
    pc: Skeleton,
    candidates: RetargetCandidate[],
    minSource = 0.5,
): RetargetChoice | null {
    const src = buildRig(pc, 0);
    let best: (RetargetChoice & { score: number }) | null = null;
    for (const c of candidates) {
        const dst = buildRig(c.skeleton, 0);
        if (dst.jointCount < 3) continue;
        const match = matchJoints(src, dst);
        const sourceCoverage = match.matched / src.jointCount;
        const targetCoverage = match.matched / dst.jointCount;
        const score = sourceCoverage * (0.5 + 0.5 * targetCoverage);
        if (sourceCoverage >= minSource && (!best || score > best.score))
            best = { id: c.id, match, sourceCoverage, targetCoverage, score };
    }
    return best;
}

// ------------------------------------------------------------------------------------------------ animation retarget

export interface RetargetAnimOptions extends ConvertAnimOptions {
    /** Root translation scale. Default: target rig size / source rig size. */
    scale?: number;
    /** Render-only actor: its controller already supplies world motion, so retain root bind translation. */
    inPlace?: boolean;
    /**
     * Target joints that must take the source joint's model-space orientation instead of a bind-relative delta:
     * attachment frames (e.g. `Rweapon`) whose items were authored on the source rig. Their bind frames can differ
     * by 100 degrees between rigs, which would otherwise turn every held item by that constant. Leaf joints only:
     * the change is not propagated to children.
     */
    worldJoints?: readonly number[];
    /**
     * Rotation (parent-relative quaternion) for target joints with no source partner, instead of the bind pose. The PS2
     * Rynn's finger joints have no PC partner and her bind hand is open, so a retargeted scene clip left her sword hand
     * open; the native armed clips curl the fingers.
     */
    holdPose?: ReadonlyMap<number, readonly [number, number, number, number]>;
}

/** PS2 absolute parent-relative tracks -> another PS2 bind skeleton, preserving each source key and timing. */
export function retargetPs2Anim(
    source: Ps2Anim,
    src: Rig,
    dst: Rig,
    match: JointMatch,
    opt: RetargetAnimOptions = {},
): Ps2Anim {
    if (source.tracks.length !== src.jointCount) throw new Error('source animation does not fit its skeleton');
    const sb = bindBasis(src);
    const tb = bindBasis(dst);
    const scale = opt.scale ?? (rigSize(src) > 1e-9 ? rigSize(dst) / rigSize(src) : 1);
    const rotation = (r: ArrayLike<number>) => Float32Array.from([...Array.from(r).slice(0, 9), 0, 0, 0]);
    const tracks = dst.names.map((_, d) => {
        const s = match.map[d]!;
        const base = tb.translation[d]!;
        if (s < 0)
            return { base, hasPos: false, keys: [{ time: 0, q: mat12ToQuat([...tb.local[d]!, 0, 0, 0]), pos: null }] };
        const original = source.tracks[s]!;
        const root = dst.parents[d]! < 0;
        // Qsource = Bsource * WparentSource * delta * inverse(WparentSource).
        // Recover that model-axis delta and apply it in the target bind basis. Cache both sides per joint.
        const left = mulMat12(
            mulMat12(
                mulMat12(rotation(tb.local[d]!), rotation(tb.parentWorld[d]!)),
                invertMat12(rotation(sb.parentWorld[s]!)),
            ),
            invertMat12(rotation(sb.local[s]!)),
        );
        const right = mulMat12(rotation(sb.parentWorld[s]!), invertMat12(rotation(tb.parentWorld[d]!)));
        // Every matched ancestor follows world = bindWorld * delta on both rigs, so pre-multiplying the local key by
        // sourceBindWorld * inverse(targetBindWorld) yields exactly the source joint's animated world orientation.
        const world = opt.worldJoints?.includes(d)
            ? mulMat12(
                  mulMat12(rotation(sb.local[s]!), rotation(sb.parentWorld[s]!)),
                  invertMat12(mulMat12(rotation(tb.local[d]!), rotation(tb.parentWorld[d]!))),
              )
            : null;
        const keys = original.keys.map((k) => {
            const delta = mulMat12(mulMat12(left, quatToMat12(k.q, [0, 0, 0])), right);
            const q = mat12ToQuat(world ? mulMat12(world, delta) : delta);
            const length = Math.hypot(...q);
            const pos =
                root && !opt.inPlace && k.pos
                    ? (k.pos.map((v, i) => base[i]! + (v - original.base[i]!) * scale) as [number, number, number])
                    : null;
            return { time: k.time, q: q.map((v) => v / length) as [number, number, number, number], pos };
        });
        return { base, hasPos: root && original.hasPos && !opt.inPlace, keys };
    });
    return {
        ...source,
        name: opt.name ?? source.name,
        frames: dst.jointCount,
        channels: opt.channels ?? source.channels,
        tracks,
    };
}

type PcKey = PcAnim['keys'][number];

function slerpQuat(a: Quat4, b: Quat4, f: number): Quat4 {
    let d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
    const sign = d < 0 ? -1 : 1;
    d *= sign;
    let s0 = 1 - f;
    let s1 = f * sign;
    if (d < 0.9995) {
        const th = Math.acos(Math.min(1, d));
        const sn = Math.sin(th);
        s0 = Math.sin((1 - f) * th) / sn;
        s1 = (Math.sin(f * th) / sn) * sign;
    }
    const q: Quat4 = [s0 * a[0] + s1 * b[0], s0 * a[1] + s1 * b[1], s0 * a[2] + s1 * b[2], s0 * a[3] + s1 * b[3]];
    const l = Math.hypot(...q) || 1;
    return [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
}
type Quat4 = [number, number, number, number];

/** A PC track's transform at time `t` (rotation slerped, translation lerped between the neighbouring keys). */
function sampleKey(keys: readonly PcKey[], t: number): number[] {
    let i = 0;
    while (i + 1 < keys.length && keys[i + 1]!.time <= t) i++;
    const a = keys[i]!;
    const b = keys[i + 1];
    if (!b || b.time <= a.time || t <= a.time) return [...a.xform];
    const f = Math.min(1, (t - a.time) / (b.time - a.time));
    const q = slerpQuat(mat12ToQuat(a.xform), mat12ToQuat(b.xform), f);
    const pos = [9, 10, 11].map((k) => a.xform[k]! + (b.xform[k]! - a.xform[k]!) * f);
    return [...quatToMat12(q, pos)];
}

/**
 * Fold the keys of an unmatched source joint into its matched parent when it is that parent's only child and sits on the
 * parent's bind pivot: a pass-through node such as the PC orc's `root` under `hueges` (the PS2 rig has no such joint and
 * hangs the legs and spine straight on `hueges`). Dropping it lost its motion for the whole body: the sitting clips lower
 * the body there (0.135 of a 0.46 rig), so retargeted sitting orcs hovered. A PC key is a model-space delta transform (its
 * rotation is the model-axes delta of `ootfcreature.ts`, its translation the pivot term plus any real travel), and the
 * deltas of a chain compose child first, so the parent's new key is `M_child * M_parent`, translation included.
 */
function foldPassThroughJoints(pc: PcAnim, src: Rig, match: JointMatch): PcAnim {
    const matched = new Set(match.map.filter((s) => s >= 0));
    const bind = bindPositions(src);
    const size = rigSize(src);
    const folds: { parent: number; child: number }[] = [];
    for (let s = 0; s < src.jointCount; s++) {
        const p = src.parents[s]!;
        if (matched.has(s) || p < 0 || !matched.has(p)) continue;
        if (src.parents.filter((x) => x === p).length !== 1) continue;
        if (Math.hypot(...[0, 1, 2].map((c) => bind[s * 3 + c]! - bind[p * 3 + c]!)) > 1e-3 * size) continue;
        const l = pc.lookup[s];
        if (!l || l.count === 0) continue;
        folds.push({ parent: p, child: s });
    }
    if (!folds.length) return pc;
    const replaced = new Map<number, PcKey[]>();
    for (const { parent, child } of folds) {
        const pl = pc.lookup[parent]!;
        const cl = pc.lookup[child]!;
        const pk = replaced.get(parent) ?? pc.keys.slice(pl.first, pl.first + pl.count);
        const ck = pc.keys.slice(cl.first, cl.first + cl.count);
        if (!pk.length) continue;
        const times = [...new Set([...pk, ...ck].map((k) => k.time))].sort((a, b) => a - b);
        replaced.set(
            parent,
            times.map((time) => {
                return { time, xform: [...mulMat12(sampleKey(ck, time), sampleKey(pk, time))] };
            }),
        );
    }
    const keys: PcKey[] = [];
    const lookup: PcAnim['lookup'] = [];
    pc.lookup.forEach((l, j) => {
        const first = keys.length;
        keys.push(...(replaced.get(j) ?? pc.keys.slice(l.first, l.first + l.count)));
        lookup.push({ first, count: keys.length - first });
    });
    return { ...pc, keys, lookup };
}

/**
 * PC animation of the `src` rig -> PS2 animation of the `dst` rig. Unmatched target joints stay at their bind pose,
 * source joints without a partner are dropped (a pass-through joint is first folded into its parent).
 */
export function retargetPcAnim(
    pc: PcAnim,
    srcRig: Rig,
    dstRig: Rig,
    match: JointMatch,
    opt: RetargetAnimOptions = {},
): Ps2Anim {
    if (pc.lookup.length !== srcRig.jointCount)
        throw new Error(`animation has ${pc.lookup.length} tracks, source rig ${srcRig.jointCount} joints`);
    pc = foldPassThroughJoints(pc, srcRig, match);
    const srcSize = rigSize(srcRig);
    const scale = opt.scale ?? (srcSize > 1e-9 ? rigSize(dstRig) / srcSize : 1);
    const keys: PcAnim['keys'] = [];
    const lookup: PcAnim['lookup'] = [];
    const identity = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];
    for (let d = 0; d < dstRig.jointCount; d++) {
        const s = match.map[d]!;
        const first = keys.length;
        const l = s >= 0 ? pc.lookup[s]! : { first: 0, count: 0 };
        if (l.count === 0) keys.push({ time: 0, xform: identity });
        else {
            const root = dstRig.parents[d]! < 0;
            for (const k of pc.keys.slice(l.first, l.first + l.count))
                keys.push({
                    time: k.time,
                    xform: root
                        ? [...k.xform.slice(0, 9), k.xform[9]! * scale, k.xform[10]! * scale, k.xform[11]! * scale]
                        : k.xform,
                });
        }
        lookup.push({ first, count: keys.length - first });
    }
    const out = convertPcAnimToPs2({ ...pc, nodes: dstRig.jointCount, keys, lookup }, bindBasis(dstRig), opt);
    for (const [d, q] of opt.holdPose ?? []) {
        const track = out.tracks[d];
        if (track && (match.map[d] ?? -1) < 0) track.keys = [{ time: 0, q: [q[0], q[1], q[2], q[3]], pos: null }];
    }
    if (!opt.worldJoints?.length) return out;
    // Attachment frames take the source joint's orientation (as retargetPs2Anim does): every matched ancestor follows
    // world = bindWorld * delta on both rigs, so pre-multiplying the local key by sourceBindWorld * inverse(targetBindWorld)
    // gives the source joint's animated world orientation. The PC Rynn's `Rweapon` sits about 104 degrees from the PS2
    // Rynn's, and the PC items held there (the opening's sword) were authored on the PC frame.
    const sb = bindBasis(srcRig);
    const tb = bindBasis(dstRig);
    const rotation = (r: ArrayLike<number>) => Float32Array.from([...Array.from(r).slice(0, 9), 0, 0, 0]);
    for (const d of opt.worldJoints) {
        const s = match.map[d] ?? -1;
        const track = out.tracks[d];
        if (s < 0 || !track) continue;
        const world = mulMat12(
            mulMat12(rotation(sb.local[s]!), rotation(sb.parentWorld[s]!)),
            invertMat12(mulMat12(rotation(tb.local[d]!), rotation(tb.parentWorld[d]!))),
        );
        track.keys = track.keys.map((k) => {
            const q = mat12ToQuat(mulMat12(world, quatToMat12(k.q, [0, 0, 0])));
            const length = Math.hypot(...q);
            return { ...k, q: q.map((v) => v / length) as [number, number, number, number] };
        });
    }
    return out;
}

export interface RetargetResult {
    match: JointMatch;
    scale: number;
    anims: { id: number; anim: Ps2Anim }[];
    skipped: { id: number; name: string; why: string }[];
}

/** Retarget every animation of a PC creature onto one PS2 skeleton. */
export function retargetCreature(
    pcSkeleton: Skeleton,
    ps2Skeleton: Skeleton,
    pcAnims: Map<number, PcAnim>,
    opt: RetargetAnimOptions = {},
): RetargetResult {
    const src = buildRig(pcSkeleton, 0);
    const dst = buildRig(ps2Skeleton, 0);
    const match = matchJoints(src, dst);
    const srcSize = rigSize(src);
    const scale = opt.scale ?? (srcSize > 1e-9 ? rigSize(dst) / srcSize : 1);
    const channels = opt.channels ?? ps2Skeleton.channels.length;
    const anims: RetargetResult['anims'] = [];
    const skipped: RetargetResult['skipped'] = [];
    for (const [id, a] of pcAnims) {
        try {
            anims.push({ id, anim: retargetPcAnim(a, src, dst, match, { ...opt, scale, channels }) });
        } catch (e) {
            skipped.push({ id, name: a.name, why: e instanceof Error ? e.message : String(e) });
        }
    }
    return { match, scale, anims, skipped };
}

// ------------------------------------------------------------------------------------------------ asset level

export interface RetargetAssetsInput {
    pcSkeleton: Skeleton;
    pcAnims: Map<number, PcAnim>;
    /** PS2 rigs the creature may take (any disc model id). */
    candidates: RetargetCandidate[];
    /** Animations of each candidate by model id and animation id (to keep the disc's own same-named clips). */
    ps2Anims?: Map<number, Map<number, Ps2Anim>>;
    /** Every animation id already used in the ADB the clips will be added to (new ids avoid them). */
    takenIds?: Set<number>;
    minSource?: number;
}

export interface RetargetAssets {
    /** PS2 model id whose model and skeleton the creature uses; null when no rig fits. */
    target: number | null;
    reason: string;
    choice: RetargetChoice | null;
    /** New ADB entries (0x0501 `info`, 0x0502 `data`) under a free id. */
    anims: { pcId: number; id: number; name: string; info: Uint8Array; data: Uint8Array }[];
    /** pc animation id -> id on the PS2 side (the disc's own clip when the target already has one of that name). */
    animIdMap: Map<number, number>;
    skipped: { id: number; name: string; why: string }[];
}

/**
 * Retarget one PC creature onto the closest PS2 rig: choose the target (`chooseRetargetTarget`), keep the target's own
 * clips where the name already exists, convert the rest under ids that are free in the ADB (the PC id when free).
 * The caller adds the new ids to the model's 0x0208 animation list or to the class's animation fields.
 */
export function retargetCreatureAssets(input: RetargetAssetsInput, opt: RetargetAnimOptions = {}): RetargetAssets {
    const out: RetargetAssets = {
        target: null,
        reason: '',
        choice: null,
        anims: [],
        animIdMap: new Map(),
        skipped: [],
    };
    const choice = chooseRetargetTarget(input.pcSkeleton, input.candidates, input.minSource);
    if (!choice) {
        out.reason = 'no PS2 rig shares enough joints';
        return out;
    }
    out.choice = choice;
    out.target = choice.id;
    const targetSk = input.candidates.find((c) => c.id === choice.id)!.skeleton;
    const own = input.ps2Anims?.get(choice.id) ?? new Map<number, Ps2Anim>();
    const ownByName = new Map<string, number>();
    for (const [id, a] of [...own].sort((x, y) => x[0] - y[0])) {
        const k = a.name.toLowerCase();
        if (!ownByName.has(k)) ownByName.set(k, id);
    }
    const taken = new Set<number>(input.takenIds ?? []);
    for (const id of targetSk.animIds) taken.add(id);
    let next = Math.max(0, ...taken) + 1;
    const src = buildRig(input.pcSkeleton, 0);
    const dst = buildRig(targetSk, 0);
    const scale = opt.scale ?? (rigSize(src) > 1e-9 ? rigSize(dst) / rigSize(src) : 1);
    for (const [pcId, a] of input.pcAnims) {
        const hit = ownByName.get(a.name.toLowerCase());
        if (hit !== undefined) {
            out.animIdMap.set(pcId, hit);
            continue;
        }
        try {
            const c = retargetPcAnim(a, src, dst, choice.match, {
                ...opt,
                scale,
                channels: opt.channels ?? targetSk.channels.length,
            });
            const w = writePs2Anim(c);
            const id = taken.has(pcId) ? next++ : pcId;
            taken.add(id);
            out.anims.push({ pcId, id, name: a.name, info: w.info, data: w.data });
            out.animIdMap.set(pcId, id);
        } catch (e) {
            out.skipped.push({ id: pcId, name: a.name, why: e instanceof Error ? e.message : String(e) });
        }
    }
    out.reason = `PS2 model ${choice.id}: ${choice.match.matched} joints matched (${(choice.sourceCoverage * 100).toFixed(0)}% of the PC rig)`;
    return out;
}
