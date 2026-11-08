// The player's ponytail at rest. The engine leaves Rynn's hair joints at their bind pose in converted scenes (the clips' hair
// tracks are not applied there, see docs/journal/2026-11-09/ootf-rynn-rig-audit.md), and the bind pose of the disc's Rynn
// holds the ponytail straight back, so a scene crouch showed a horizontal bar. This rewrites the bind pose of the hair joints
// (and the hair vertices with it) to the hanging pose of the native idle. Clip poses stay as they are: a clip key is an
// absolute parent-relative rotation, and a vertex that moves with its joint's bind gives the same skinned result.
import { MOD_VERTICES, MOD_CHARACTER } from './model.ts';
import { animName, parsePs2Anim, parseSkeleton, type Skeleton } from './ootfanim.ts';
import { sampleClip } from './anim.ts';
import type { SrscReader } from './srsc.ts';
import { buildRig, invertMat12, localToWorld, mulMat12 } from './skeleton.ts';

const HAIR = ['hair1', 'hair2', 'hair3'];

/** The native idle clip `NCIdle` made for a rig of `joints` joints (the clip is shared by name across the Rynn models). */
async function ncIdle(adb: SrscReader, joints: number): Promise<ReturnType<typeof parsePs2Anim> | undefined> {
    for (const e of adb.entries) {
        if (e.type !== 0x0501) continue;
        const info = await adb.readRaw(e);
        if (animName(info).toLowerCase() !== 'ncidle') continue;
        const data = adb.find(0x0502, e.id);
        if (!data) continue;
        try {
            const a = parsePs2Anim(info, await adb.readRaw(data));
            if (a.tracks.length === joints) return a;
        } catch {
            // not a clip of this rig
        }
    }
    return undefined;
}

export interface HangingHairResult {
    /** `overrides/<stem>.MOD/<type>_<id>_<sub>.bin` -> record bytes. */
    files: Record<string, Uint8Array>;
    /** Models rewritten (ids) and notes. */
    models: number[];
    warnings: string[];
}

function indexOfBytes(hay: Uint8Array, needle: Uint8Array): number {
    outer: for (let i = 0; i + needle.length <= hay.length; i++) {
        for (let k = 0; k < needle.length; k++) if (hay[i + k] !== needle[k]) continue outer;
        return i;
    }
    return -1;
}

const f32bytes = (values: ArrayLike<number>): Uint8Array => {
    const out = new Uint8Array(values.length * 4);
    const dv = new DataView(out.buffer);
    for (let i = 0; i < values.length; i++) dv.setFloat32(i * 4, values[i]!, true);
    return out;
};

/** Record order of a joint matrix: translation, then the 3x3 rotation (the `xform` field holds rotation then translation). */
const recordOrder = (x: ArrayLike<number>): number[] => [
    x[9]!,
    x[10]!,
    x[11]!,
    ...Array.from({ length: 9 }, (_, i) => x[i]!),
];

/**
 * Hair bind rewrite for every character record of `mod` that has hair1 to hair3 joints, using the hair pose of the first key of
 * the native idle clip (`NCIdle`) of `adb` as the hanging pose.
 */
export async function hangingHairOverrides(mod: SrscReader, adb: SrscReader, stem: string): Promise<HangingHairResult> {
    const result: HangingHairResult = { files: {}, models: [], warnings: [] };
    for (const e of mod.entries) {
        if (e.type !== MOD_CHARACTER) continue;
        let sk: Skeleton;
        let raw: Uint8Array;
        try {
            raw = await mod.readRaw(e);
            sk = parseSkeleton(raw, 'ps2');
        } catch {
            continue;
        }
        const vr = mod.find(MOD_VERTICES, e.id);
        if (!vr) continue;
        const vraw = (await mod.readRaw(vr)).slice();
        const nv = new DataView(vraw.buffer, vraw.byteOffset).getUint16(0, true);
        const rig = buildRig(sk, nv);
        const hj = HAIR.map((n) => rig.names.findIndex((x) => x.toLowerCase() === n));
        if (hj.some((j) => j < 0) || rig.parents[hj[0]!]! < 0) continue;
        // the hanging pose: the idle's local rotations of the three joints, the bind translations kept
        const idle = await ncIdle(adb, sk.joints.length);
        if (!idle) {
            result.warnings.push(`model ${e.id}: no NCIdle clip for the hair pose`);
            continue;
        }
        const pose = sampleClip(rig, idle, 0);
        const rot = (m: ArrayLike<number>) => Float32Array.from([...Array.from(m).slice(0, 9), 0, 0, 0]);
        const bindWorld = localToWorld(rig, rig.bindLocal);
        const oldWorld = hj.map((j) => Float32Array.from(bindWorld.subarray(j * 12, j * 12 + 12)));
        // hair1 stays where it is (the engine drives it itself, see above); hair2 and hair3 take the idle's world orientation
        const idleWorld = localToWorld(rig, pose);
        const newWorld: Float32Array[] = [oldWorld[0]!];
        for (let k = 1; k < 3; k++) {
            const j = hj[k]!;
            const parentWorld = newWorld[k - 1]!;
            const local = Float32Array.from(rig.bindLocal.subarray(j * 12, j * 12 + 12));
            const turn = mulMat12(rot(idleWorld.subarray(j * 12, j * 12 + 12)), invertMat12(rot(parentWorld)));
            local.set(turn.subarray(0, 9), 0); // hanging orientation, bind translation
            newWorld.push(mulMat12(local, parentWorld));
        }
        const newInv = newWorld.map((w) => invertMat12(w));

        // joints: replace the inverse bind matrices in the raw record
        const out = raw.slice();
        hj.forEach((j, k) => {
            if (k === 0) return;
            const old = f32bytes(recordOrder(sk.joints[j]!.xform));
            const at = indexOfBytes(out, old);
            if (at < 0 || indexOfBytes(out.subarray(at + 1), old) >= 0) {
                result.warnings.push(`model ${e.id}: joint ${rig.names[j]} matrix not found once in the record`);
                return;
            }
            out.set(f32bytes(recordOrder(newInv[k]!)), at);
        });

        // vertices (positions and the signed byte normals) that hair joints carry move with them
        const dv = new DataView(vraw.buffer, vraw.byteOffset);
        const mapPoint = (p: number[], k: number): number[] => {
            const j = hj[k]!;
            const u = [0, 1, 2].map(
                (c) =>
                    p[0]! * rig.invBind[j * 12 + c]! +
                    p[1]! * rig.invBind[j * 12 + 3 + c]! +
                    p[2]! * rig.invBind[j * 12 + 6 + c]! +
                    rig.invBind[j * 12 + 9 + c]!,
            );
            const w = newWorld[k]!;
            return [0, 1, 2].map((c) => u[0]! * w[c]! + u[1]! * w[3 + c]! + u[2]! * w[6 + c]! + w[9 + c]!);
        };
        const mapNormal = (n: number[], k: number): number[] => {
            const j = hj[k]!;
            const inv = rot(rig.invBind.subarray(j * 12, j * 12 + 12));
            const u = [0, 1, 2].map((c) => n[0]! * inv[c]! + n[1]! * inv[3 + c]! + n[2]! * inv[6 + c]!);
            const w = rot(newWorld[k]!);
            return [0, 1, 2].map((c) => u[0]! * w[c]! + u[1]! * w[3 + c]! + u[2]! * w[6 + c]!);
        };
        let moved = 0;
        let blended = 0;
        for (let v = 0; v < nv; v++) {
            let wh = 0;
            const wk = [0, 0, 0];
            for (let s = 0; s < 4; s++) {
                const w = rig.jointWeight[v * 4 + s]!;
                if (!w) continue;
                const k = hj.indexOf(rig.jointIndex[v * 4 + s]!);
                if (k >= 1) {
                    wk[k]! += w;
                    wh += w;
                }
            }
            if (wh <= 0) continue;
            if (wh < 0.999) blended++;
            const p = [
                dv.getFloat32(2 + v * 12, true),
                dv.getFloat32(6 + v * 12, true),
                dv.getFloat32(10 + v * 12, true),
            ];
            const t = 2 + nv * 12 + v * 4;
            const n = [dv.getInt8(t) / 127, dv.getInt8(t + 1) / 127, dv.getInt8(t + 2) / 127];
            const np = [p[0]! * (1 - wh), p[1]! * (1 - wh), p[2]! * (1 - wh)];
            const nn = [n[0]! * (1 - wh), n[1]! * (1 - wh), n[2]! * (1 - wh)];
            for (let k = 0; k < 3; k++) {
                if (!wk[k]) continue;
                const mp = mapPoint(p, k);
                const mn = mapNormal(n, k);
                for (let c = 0; c < 3; c++) {
                    np[c]! += wk[k]! * mp[c]!;
                    nn[c]! += wk[k]! * mn[c]!;
                }
            }
            const nl = Math.hypot(nn[0]!, nn[1]!, nn[2]!) || 1;
            for (let c = 0; c < 3; c++) {
                dv.setFloat32(2 + v * 12 + c * 4, np[c]!, true);
                dv.setInt8(t + c, Math.max(-127, Math.min(127, Math.round((nn[c]! / nl) * 127))));
            }
            moved++;
        }
        result.files[`overrides/${stem}.MOD/${MOD_CHARACTER.toString(16).padStart(4, '0')}_${e.id}_${e.sub}.bin`] = out;
        result.files[`overrides/${stem}.MOD/${MOD_VERTICES.toString(16).padStart(4, '0')}_${e.id}_${vr.sub}.bin`] =
            vraw;
        result.models.push(e.id);
        if (blended)
            result.warnings.push(`model ${e.id}: ${blended} of ${moved} hair vertices are shared with other joints`);
    }
    return result;
}
