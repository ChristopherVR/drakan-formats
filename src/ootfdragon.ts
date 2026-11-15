/**
 * Arokh's scene clips on the Drakan 2 dragon. The converted Order of the Flame levels show Arokh with the disc's own Dragon
 * class and model (SYSTEM.MOD 3889, 71 joints, clips in SYSTEM.ADB), but their scenes name clips of the PC dragon (50
 * joints). The PS2 engine resolves a scene clip in the actor's own ADB, so PC clips converted for the PC rig into other
 * ADBs were never found there and Arokh only floated along his scene keys (Ruined Village "arokh awakening").
 *
 * Two kinds of clips:
 * - Clips the PC Dragon class names in an animation field (Ready, Fly, Hover, Landing, Mount ...) play the disc clip of the
 *   same field of the disc Dragon class (`nativeDragonClips`).
 * - Every other scene clip (the acting clips "1_6m", "5_2a" ...) is retargeted onto the disc rig (`retargetDragonClip`).
 *   The two rigs share almost no joint names and their trees differ (the PC wings, neck and arms hang under an UpperBody
 *   joint, the disc's under the root), so each disc joint copies the model-space rotation change of one PC joint from a
 *   fixed table (`DRAGON_JOINTS`), and a disc joint without a partner keeps its bind pose under its parent.
 */

import type { Ps2Anim, Ps2Key, Ps2Track, Skeleton } from './ootfanim.ts';
import { reduceQuatKeys } from './ootfcreature.ts';
import { invertMat12, localToWorld, mat12ToQuat, mulMat12, type Rig } from './skeleton.ts';
import { sampleClip } from './anim.ts';
import { classFieldDefault, type OdbClass } from './odb.ts';

/**
 * Disc Arokh joint -> PC dragon joint whose rotation change it copies (lower-case names). Chains with more disc joints than
 * PC joints (neck 8 against 6, tail 8 against 5) give several disc joints the same partner. Toes, ears, eyes, the breath
 * point and the group nodes of the tail and spine have none.
 */
export const DRAGON_JOINTS: ReadonlyMap<string, string> = new Map([
    ['arokh', 'dragon'],
    ['nn_legs', 'pelvis'],
    ['l_upleg', 'lleg'],
    ['l_lowleg_a', 'ltibia'],
    ['l_lowleg_b', 'lulna'],
    ['lfoot_a', 'lfoot'],
    ['r_upleg', 'rleg'],
    ['r_lowleg_a', 'rtibia'],
    ['r_lowleg_b', 'rulna'],
    ['rfoot_a', 'rfoot'],
    ['tail_b', 'tail'],
    ['tail_d', 'tail2'],
    ['tail_e', 'tail3'],
    ['tail_f', 'tail4'],
    ['tail_g', 'tail5'],
    ['tail_h', 'tail5'],
    ['spine_a', 'pelvis'],
    ['spine_b', 'lowerbody'],
    ['spine_c', 'upperbody'],
    ['saddle', 'saddle'],
    ['luparm', 'larm'],
    ['llowarm', 'lradius'],
    ['lhand_a', 'lhand'],
    ['ruparm', 'rarm'],
    ['rlowarm', 'rradius'],
    ['rhand_a', 'rhand'],
    ['nn_neck', 'neck'],
    ['neck_a', 'neck0'],
    ['neck_b', 'neck1'],
    ['neck_c', 'neck1'],
    ['neck_d', 'neck2'],
    ['neck_e', 'neck2'],
    ['neck_f', 'neck3'],
    ['neck_g', 'neck4'],
    ['neck_head', 'head'],
    ['jaw', 'jaw'],
    ['nn_wings', 'wings'],
    ['rwing_a', 'rwing'],
    ['rwing_b', 'rwing2'],
    ['nn_rwingwrist', 'rwing3'],
    ['rwing_c1_ref', 'rwing3'],
    ['rwing_d', 'rwing4'],
    ['rwing_c3_track', 'rout_strut'],
    ['rwing_c2_track', 'rin_strut'],
    ['lwing_a', 'lwing'],
    ['lwing_b', 'lwing2'],
    ['nn_lwingwrist', 'lwing3'],
    ['lwing_c1_ref', 'lwing3'],
    ['lwing_d', 'lwing4'],
    ['lwing_c3_track', 'lout_strut'],
    ['lwing_c2_track', 'lin_strut'],
]);

/** Disc joint -> PC joint index (-1 without a partner) through `DRAGON_JOINTS`. */
export function dragonPartners(pcNames: readonly string[], discNames: readonly string[]): number[] {
    const pc = new Map(pcNames.map((n, i) => [n.toLowerCase(), i]));
    return discNames.map((n) => {
        const p = DRAGON_JOINTS.get(n.toLowerCase());
        return p === undefined ? -1 : (pc.get(p) ?? -1);
    });
}

/** True when the two rigs are the PC dragon and the disc Arokh: at least 40 of the table's disc joints find their PC joint. */
export function isDragonPair(pcNames: readonly string[], discNames: readonly string[]): boolean {
    return dragonPartners(pcNames, discNames).filter((s) => s >= 0).length >= 40;
}

/**
 * PC channel -> disc channel. A channel names a joint (the scene plays a clip on that joint's branch or attaches to it); the
 * PC channel's joint is followed to the disc joints that copy it, and the disc channel on the first of those (in tree order),
 * else on its nearest ancestor with a channel. The saddle (PC 19) becomes 14, the wings (1) 27, the neck (4) 15.
 */
export function dragonChannelMap(
    pc: Pick<Skeleton, 'channels'>,
    pcNames: readonly string[],
    disc: Pick<Skeleton, 'channels'>,
    discRig: Pick<Rig, 'names' | 'parents' | 'order'>,
): Map<number, number> {
    const partner = dragonPartners(pcNames, discRig.names);
    const channelOf = new Map<number, number>();
    disc.channels.forEach((c, i) => {
        if (!channelOf.has(c.joint)) channelOf.set(c.joint, i);
    });
    const out = new Map<number, number>();
    pc.channels.forEach((c, i) => {
        const d = discRig.order.find((j) => partner[j] === c.joint);
        for (let j = d ?? -1; j >= 0; j = discRig.parents[j]!) {
            const ch = channelOf.get(j);
            if (ch !== undefined) {
                out.set(i, ch);
                return;
            }
        }
    });
    return out;
}

/** Animation fields the PC and the disc Dragon class share (field name, lower case): the disc clip stands in for the PC one. */
const NATIVE_FIELDS = [
    'ready',
    'walk',
    'run',
    'ground strafe l',
    'ground strafe r',
    'walk backward',
    'mount',
    'dismount',
    'fly',
    'fly-->hover',
    'hover',
    'hover backwards',
    'soar',
    'strafe left air',
    'strafe right air',
    'turn left (gnd)',
    'turn right (gnd)',
    'landing',
    'bite',
];

/** PC clip id -> disc clip id for the clips both Dragon classes name in the same animation field (`NATIVE_FIELDS`). */
export function nativeDragonClips(
    pc: Pick<OdbClass, 'fields' | 'data'>,
    disc: Pick<OdbClass, 'fields' | 'data'>,
): Map<number, number> {
    const value = (c: Pick<OdbClass, 'fields' | 'data'>, name: string): number | undefined => {
        const i = c.fields?.findIndex((f) => f.name.trim().toLowerCase() === name) ?? -1;
        const v = i >= 0 ? classFieldDefault(c, i) : undefined;
        return typeof v === 'number' && v > 0 ? v & 0xffff : undefined;
    };
    const out = new Map<number, number>();
    for (const f of NATIVE_FIELDS) {
        const a = value(pc, f);
        const b = value(disc, f);
        if (a !== undefined && b !== undefined && !out.has(a)) out.set(a, b);
    }
    return out;
}

const rotationOnly = (m: ArrayLike<number>): Float32Array => Float32Array.from([...Array.from(m).slice(0, 9), 0, 0, 0]);

export interface DragonRetargetOptions {
    /** Root translation scale (disc rig size / PC rig size). Default 1. */
    scale?: number;
    /** Channel count written to the clip header (the disc skeleton's). */
    channels?: number;
    /** Key reduction tolerance, degrees. Default 0.35. */
    toleranceDeg?: number;
}

/**
 * A clip of the PC rig (already in PS2 form on that rig, `convertPcAnimToPs2`) on the disc rig: at every key time of the
 * source, each disc joint with a partner takes the partner's model-space rotation change from its bind pose
 * (W = Wbind_disc * inverse(Wbind_pc) * W_pc, row vectors), a joint without one keeps its bind rotation under its parent,
 * and the root's translation follows the PC root's change from its bind position. Keys are then reduced per track.
 */
export function retargetDragonClip(
    source: Ps2Anim,
    src: Rig,
    dst: Rig,
    partner: readonly number[],
    opt: DragonRetargetOptions = {},
): Ps2Anim {
    if (source.tracks.length !== src.jointCount) throw new Error('source animation does not fit its skeleton');
    const scale = opt.scale ?? 1;
    const tol = ((opt.toleranceDeg ?? 0.35) * Math.PI) / 180;
    const times = [...new Set(source.tracks.flatMap((t) => t.keys.map((k) => k.time)))].sort((a, b) => a - b);
    if (!times.length) times.push(0);
    const srcBind = localToWorld(src, Float32Array.from(src.bindLocal));
    const dstBind = localToWorld(dst, Float32Array.from(dst.bindLocal));
    // per disc joint with a partner: Wbind_disc * inverse(Wbind_pc), rotation only
    const lead = dst.names.map((_, d) => {
        const s = partner[d]!;
        if (s < 0) return null;
        return mulMat12(
            rotationOnly(dstBind.subarray(d * 12, d * 12 + 12)),
            invertMat12(rotationOnly(srcBind.subarray(s * 12, s * 12 + 12))),
        );
    });
    const srcRoot = src.parents.indexOf(-1);
    const dstRoot = dst.parents.indexOf(-1);
    const rootBind = [9, 10, 11].map((k) => src.bindLocal[srcRoot * 12 + k]!);
    const keys: { time: number; q: [number, number, number, number] }[][] = dst.names.map(() => []);
    const rootPos: [number, number, number][] = [];
    const world = new Float32Array(dst.jointCount * 12);
    // sampled as a clip that holds its last frame: a looping clip would wrap its last key time back to the first key
    const held: Ps2Anim = { ...source, flags: source.flags | 1 };
    for (const t of times) {
        const ws = localToWorld(src, sampleClip(src, held, t));
        for (const d of dst.order) {
            const p = dst.parents[d]!;
            const s = partner[d]!;
            const w = world.subarray(d * 12, d * 12 + 12);
            if (s >= 0) w.set(mulMat12(lead[d]!, rotationOnly(ws.subarray(s * 12, s * 12 + 12))));
            else if (p >= 0)
                w.set(
                    mulMat12(
                        rotationOnly(dst.bindLocal.subarray(d * 12, d * 12 + 12)),
                        world.subarray(p * 12, p * 12 + 12),
                    ),
                );
            else w.set(rotationOnly(dst.bindLocal.subarray(d * 12, d * 12 + 12)));
            const local = p < 0 ? w : mulMat12(w, invertMat12(world.subarray(p * 12, p * 12 + 12)));
            const q = mat12ToQuat(local);
            const prev = keys[d]!.at(-1)?.q;
            const l = Math.hypot(...q) || 1;
            const sign = prev && prev[0] * q[0] + prev[1] * q[1] + prev[2] * q[2] + prev[3] * q[3] < 0 ? -1 : 1;
            keys[d]!.push({ time: t, q: q.map((v) => (v * sign) / l) as [number, number, number, number] });
        }
        const r = ws.subarray(srcRoot * 12 + 9, srcRoot * 12 + 12);
        rootPos.push(
            [0, 1, 2].map((k) => dst.bindLocal[dstRoot * 12 + 9 + k]! + (r[k]! - rootBind[k]!) * scale) as [
                number,
                number,
                number,
            ],
        );
    }
    const srcRootMoves = !!source.tracks[srcRoot]?.hasPos;
    const tracks: Ps2Track[] = dst.names.map((_, d) => {
        const base: [number, number, number] = [
            dst.bindLocal[d * 12 + 9]!,
            dst.bindLocal[d * 12 + 10]!,
            dst.bindLocal[d * 12 + 11]!,
        ];
        if (d === dstRoot && srcRootMoves) {
            const ks: Ps2Key[] = keys[d]!.map((k, i) => ({ time: k.time, q: k.q, pos: rootPos[i]! }));
            return { base: ks[0]!.pos!, hasPos: true, keys: ks };
        }
        const reduced = reduceQuatKeys(keys[d]!, tol);
        const still = reduced.length === 2 && quatClose(reduced[0]!.q, reduced[1]!.q);
        return {
            base,
            hasPos: false,
            keys: (still ? reduced.slice(0, 1) : reduced).map((k) => ({ time: k.time, q: k.q, pos: null })),
        };
    });
    return { ...source, frames: dst.jointCount, channels: opt.channels ?? source.channels, tracks };
}

const quatClose = (a: readonly number[], b: readonly number[]): boolean =>
    Math.abs(a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]! + a[3]! * b[3]!) > 1 - 1e-7;
