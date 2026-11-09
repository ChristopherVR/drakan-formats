// The player's ponytail at rest. The engine drives Rynn's hair joints itself in converted scenes (the clips' hair tracks are not
// applied there, see docs/journal/2026-11-09/ootf-rynn-rig-audit.md) and holds them at the bind pose of the disc's Rynn, which
// points the ponytail straight back: a scene crouch showed a horizontal bar. Re-posing the hair joints' bind did not help (the
// engine's own rotations of hair1 and hair2 still moved the strips), so this rewrites every Rynn record of SYSTEM.MOD so the hair
// vertices take the hanging shape of the native idle and are weighted to the head joint alone. The ponytail then hangs from the
// head in scenes; the price is that it no longer swings on its own joints (it moves with the head).
import { MOD_VERTICES, MOD_CHARACTER } from './model.ts';
import { animName, parsePs2Anim, parseSkeleton, type Skeleton } from './ootfanim.ts';
import { sampleClip } from './anim.ts';
import type { SrscReader } from './srsc.ts';
import { buildRig, localToWorld, mulMat12 } from './skeleton.ts';

const HAIR = ['hair1', 'hair2', 'hair3'];

export interface HangingHairResult {
    /** `overrides/<stem>.MOD/<type>_<id>_<sub>.bin` -> record bytes. */
    files: Record<string, Uint8Array>;
    /** Models rewritten (ids) and notes. */
    models: number[];
    warnings: string[];
}

export interface HangingHairOptions {
    /**
     * Hair joints (0 = hair1, 1 = hair2, 2 = hair3) whose strips move to the head joint. Default all three; a joint left out keeps
     * its vertices on itself (they still take the hanging shape, about that joint's old bind frame).
     */
    toHead?: readonly number[];
    /**
     * Shift the weight of the moved strips from the head to the chest (the model root when there is none) towards the tip of
     * the ponytail (default true). With false the strips ride the head alone.
     */
    rootBlend?: boolean;
}

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

interface JointSpan {
    /** Byte offset of the 48 byte inverse bind matrix. */
    xform: number;
    /** Byte span of each LOD's weight list (`u16 count`, then `u32 vertex, f32 weight` pairs). */
    lists: { at: number; end: number }[];
}

/** Byte offsets inside a PS2 0x0208 record (the layout of `parseSkeleton`), so records can be patched in place. */
export function locateJoints(raw: Uint8Array): JointSpan[] {
    const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    let o = 64;
    const nl = dv.getUint16(o, true);
    o += 2;
    for (let i = 0; i < nl - 1; i++) o += 2 + dv.getUint16(o, true);
    const nn = dv.getUint16(o, true);
    o += 2 + nn * 36 + 4; // nodes (32 name bytes, i32 joint), then the u32 total vertex count
    const jc = dv.getUint16(o, true);
    o += 2;
    const out: JointSpan[] = [];
    for (let j = 0; j < jc; j++) {
        const xform = o;
        o += 48 + 12;
        const lists: JointSpan['lists'] = [];
        for (let l = 0; l < nl; l++) {
            const at = o;
            o += 2 + dv.getUint16(o, true) * 8;
            lists.push({ at, end: o });
        }
        out.push({ xform, lists });
    }
    return out;
}

/**
 * Hair rewrite for every character record of `mod` that has hair1 to hair3 joints, using the hair pose of the first key of the
 * native idle clip (`NCIdle`) of `adb` as the hanging pose.
 */
export async function hangingHairOverrides(
    mod: SrscReader,
    adb: SrscReader,
    stem: string,
    opt: HangingHairOptions = {},
): Promise<HangingHairResult> {
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
        const head = hj[0]! < 0 ? -1 : rig.parents[hj[0]!]!;
        if (hj.some((j) => j < 0) || head < 0) continue;
        const idle = await ncIdle(adb, sk.joints.length);
        if (!idle) {
            result.warnings.push(`model ${e.id}: no NCIdle clip for the hair pose`);
            continue;
        }
        const spans = locateJoints(raw);
        if (spans.length !== sk.joints.length) {
            result.warnings.push(`model ${e.id}: joint spans do not match the skeleton`);
            continue;
        }
        const pose = sampleClip(rig, idle, 0);
        const rot = (m: ArrayLike<number>) => Float32Array.from([...Array.from(m).slice(0, 9), 0, 0, 0]);
        const bindWorld = localToWorld(rig, rig.bindLocal);
        const headWorld = Float32Array.from(bindWorld.subarray(head * 12, head * 12 + 12));

        // Hanging shape: the idle's local rotations of the three joints on the bind head, the bind translations kept. It places
        // the vertices.
        const shape: Float32Array[] = [];
        let parent: Float32Array = headWorld;
        for (const j of hj) {
            const local = Float32Array.from(rig.bindLocal.subarray(j * 12, j * 12 + 12));
            local.set(rot(pose.subarray(j * 12, j * 12 + 12)).subarray(0, 9), 0);
            parent = mulMat12(local, parent);
            shape.push(parent);
        }
        const replace: { at: number; end: number; bytes: Uint8Array }[] = [];

        // vertices: hair-weighted ones take the hanging shape (about the old joint frame, into the shape's frame)
        const dv = new DataView(vraw.buffer, vraw.byteOffset);
        const toShape = (p: number[], k: number): number[] => {
            const j = hj[k]!;
            const u = [0, 1, 2].map(
                (c) =>
                    p[0]! * rig.invBind[j * 12 + c]! +
                    p[1]! * rig.invBind[j * 12 + 3 + c]! +
                    p[2]! * rig.invBind[j * 12 + 6 + c]! +
                    rig.invBind[j * 12 + 9 + c]!,
            );
            const w = shape[k]!;
            return [0, 1, 2].map((c) => u[0]! * w[c]! + u[1]! * w[3 + c]! + u[2]! * w[6 + c]! + w[9 + c]!);
        };
        const toShapeNormal = (n: number[], k: number): number[] => {
            const j = hj[k]!;
            const inv = rot(rig.invBind.subarray(j * 12, j * 12 + 12));
            const u = [0, 1, 2].map((c) => n[0]! * inv[c]! + n[1]! * inv[3 + c]! + n[2]! * inv[6 + c]!);
            const w = rot(shape[k]!);
            return [0, 1, 2].map((c) => u[0]! * w[c]! + u[1]! * w[3 + c]! + u[2]! * w[6 + c]!);
        };
        // how far down the ponytail a vertex sits (0 at the hair tie, 1 at the tip), along the shape's direction
        const pivot = [shape[0]![9]!, shape[0]![10]!, shape[0]![11]!];
        const axis = [shape[2]![9]! - pivot[0]!, shape[2]![10]! - pivot[1]!, shape[2]![11]! - pivot[2]!];
        const axisLen = Math.hypot(axis[0]!, axis[1]!, axis[2]!) || 1;
        const along = new Map<number, number>();
        let moved = 0;
        for (let v = 0; v < nv; v++) {
            let wh = 0;
            const wk = [0, 0, 0];
            for (let s = 0; s < 4; s++) {
                const w = rig.jointWeight[v * 4 + s]!;
                const k = w ? hj.indexOf(rig.jointIndex[v * 4 + s]!) : -1;
                if (k >= 0) {
                    wk[k]! += w;
                    wh += w;
                }
            }
            if (wh <= 0) continue;
            const p = [
                dv.getFloat32(2 + v * 12, true),
                dv.getFloat32(6 + v * 12, true),
                dv.getFloat32(10 + v * 12, true),
            ];
            const t = 2 + nv * 12 + v * 4;
            const n = [dv.getInt8(t) / 127, dv.getInt8(t + 1) / 127, dv.getInt8(t + 2) / 127];
            const np = p.map((x) => x * (1 - wh));
            const nn = n.map((x) => x * (1 - wh));
            for (let k = 0; k < 3; k++) {
                if (!wk[k]) continue;
                const mp = toShape(p, k);
                const mn = toShapeNormal(n, k);
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
            along.set(
                v,
                ((np[0]! - pivot[0]!) * axis[0]! + (np[1]! - pivot[1]!) * axis[1]! + (np[2]! - pivot[2]!) * axis[2]!) /
                    axisLen,
            );
            moved++;
        }
        const reach = Math.max(1e-6, ...along.values());

        // weights: whatever the hair joints carried goes to the head joint, shifting to the chest towards the tip (a strip
        // that rides a bowed head alone points back as a horizontal bar; the chest drapes it along the back). Their own lists are emptied.
        const wdv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
        const lodCount = spans[head]!.lists.length;
        const readList = (span: { at: number }): Map<number, number> => {
            const m = new Map<number, number>();
            for (let i = 0, n = wdv.getUint16(span.at, true); i < n; i++)
                m.set(wdv.getUint32(span.at + 2 + i * 8, true), wdv.getFloat32(span.at + 6 + i * 8, true));
            return m;
        };
        // the joint the tip follows: the chest (the ponytail then drapes along the back of a bowed body), else the model root
        const chestJoint = rig.names.findIndex((n) => n.toLowerCase() === 'chest');
        const rootJoint = chestJoint >= 0 ? chestJoint : rig.order[0]!;
        const rootBlend = opt.rootBlend ?? true;
        for (let l = 0; l < lodCount; l++) {
            const headList = spans[head]!.lists[l]!;
            const rootList = spans[rootJoint]!.lists[l]!;
            const first = sk.lods[l]?.firstVertex ?? 0;
            const mergedHead = readList(headList);
            const mergedRoot = readList(rootList);
            let any = false;
            for (const k of opt.toHead ?? [0, 1, 2]) {
                const span = spans[hj[k]!]!.lists[l]!;
                const moves = readList(span);
                if (!moves.size) continue;
                any = true;
                for (const [v, w] of moves) {
                    const t = rootBlend ? Math.min(1, Math.max(0, (along.get(first + v) ?? 0) / reach)) : 0;
                    mergedHead.set(v, (mergedHead.get(v) ?? 0) + w * (1 - t));
                    if (t > 0) mergedRoot.set(v, (mergedRoot.get(v) ?? 0) + w * t);
                }
                replace.push({ at: span.at, end: span.end, bytes: new Uint8Array(2) });
            }
            if (!any) continue;
            const encode = (m: Map<number, number>): Uint8Array => {
                const entries = [...m].sort((x, y) => x[0] - y[0]);
                const bytes = new Uint8Array(2 + entries.length * 8);
                const bd = new DataView(bytes.buffer);
                bd.setUint16(0, entries.length, true);
                entries.forEach(([v, w], i) => {
                    bd.setUint32(2 + i * 8, v, true);
                    bd.setFloat32(6 + i * 8, w, true);
                });
                return bytes;
            };
            replace.push({ at: headList.at, end: headList.end, bytes: encode(mergedHead) });
            if (rootJoint !== head) replace.push({ at: rootList.at, end: rootList.end, bytes: encode(mergedRoot) });
        }

        replace.sort((a, b) => a.at - b.at);
        const parts: Uint8Array[] = [];
        let o = 0;
        for (const r of replace) {
            parts.push(raw.subarray(o, r.at), r.bytes);
            o = r.end;
        }
        parts.push(raw.subarray(o));
        const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
        let at = 0;
        for (const p of parts) {
            out.set(p, at);
            at += p.length;
        }
        const hex4 = (n: number): string => n.toString(16).padStart(4, '0');
        result.files[`overrides/${stem}.MOD/${hex4(MOD_CHARACTER)}_${e.id}_${e.sub}.bin`] = out;
        result.files[`overrides/${stem}.MOD/${hex4(MOD_VERTICES)}_${e.id}_${vr.sub}.bin`] = vraw;
        result.models.push(e.id);
        if (!moved) result.warnings.push(`model ${e.id}: no hair vertices found`);
    }
    return result;
}
