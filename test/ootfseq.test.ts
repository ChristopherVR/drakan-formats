// Synthetic PC sequences only; no game bytes.
import { describe, expect, it } from 'vitest';
import type { SrscReader } from '../src/srsc.ts';
import { parseSequence } from '../src/story/ssd.ts';
import { parseActions } from '../src/story/ssdactions.ts';
import {
    convertPcSequences,
    parsePcSequence,
    remapSequenceRefs,
    ssdEntryPath,
    type PcSeqActor,
} from '../src/ootfseq.ts';

function w(...parts: (number[] | Uint8Array)[]): Uint8Array {
    return Uint8Array.from(parts.flatMap((p) => [...p]));
}
const u16 = (v: number): number[] => [v & 255, v >> 8];
const u32 = (v: number): number[] => [v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255];
const f32 = (v: number): number[] => [...new Uint8Array(new Float32Array([v]).buffer)];
const str = (s: string): number[] => {
    const n = s.length + (s.length % 2);
    return [...u16(n), ...[...s].map((c) => c.charCodeAt(0)), ...(s.length % 2 ? [0] : [])];
};
const act = (type: number, t: number, payload: number[]): number[] => [...u16(type), ...f32(t), ...payload];

function actor(name: string, id: number, obj: number, actions: number[][]): number[] {
    return [...str(name), ...u32(id), ...u32(1), ...u32(0), ...u32(obj), ...u32(actions.length), ...actions.flat()];
}

function pcSeq(): Uint8Array {
    const cam = actor('Camera', 1, 100, [
        act(5, 0, u32(0)),
        act(0, 1, [...f32(0), ...f32(0), ...f32(0), ...f32(1), ...f32(10), ...f32(20), ...f32(30), ...u32(0), ...u32(0x10)]),
        act(8, 2, [...u32(4), ...u32(0x103), ...f32(0.5), ...f32(3)]),
        act(5, 9, u32(1)),
    ]);
    const prop = actor('Door', 5, 200, [
        act(1, 0, [...u32(2), ...u32(0x00010007), ...f32(0), ...f32(0.85), ...f32(1), ...u32(0x15)]),
        act(3, 1, [...u32(0x00040385), ...f32(2.5), ...u16(10000), ...u16(0x18)]),
        act(7, 2, [...u32(4097), ...u32(0)]),
        act(7, 3, [...u32(25), ...u32(0)]),
        act(3, 4, [...u32(0x99999), ...f32(1), ...u16(10000), ...u16(0)]),
    ]);
    const gone = actor('Lost', 7, 999, [act(6, 0, u32(1))]);
    return w(str('Test'), u32(126), u32(0), u32(70), u32(3), cam, prop, gone);
}

const stub = (data: Uint8Array): SrscReader =>
    ({
        entries: [{ index: 0, type: 0x311, id: 410, sub: 1, offset: 0, size: data.length }],
        read: async () => ({ data, compressed: false }),
    }) as unknown as SrscReader;

describe('ootfseq', () => {
    it('parses the PC layout', () => {
        const s = parsePcSequence(410, 1, pcSeq());
        expect(s.flags).toBe(126);
        expect(s.actors.map((a: PcSeqActor) => a.name)).toEqual(['Camera', 'Door', 'Lost']);
        expect(s.actors[0]!.actions).toHaveLength(4);
    });

    it('converts to a PS2 record the story parsers accept', async () => {
        const used = new Set([1, 2, 3]);
        const r = await convertPcSequences(stub(pcSeq()), {
            maps: {
                objectIdMap: new Map([
                    [100, 11],
                    [200, 22],
                ]),
                animMap: new Map([[0x00010007, 0x00030042]]),
                soundMap: new Map([[0x00040385, 0x00050101]]),
                musicMap: new Map([[4, 0x00070059]]),
            },
            usedIds: used,
            cameraFov: 55,
        });
        expect(r.entries.map((e) => e.type)).toEqual([0x312, 0x311]);
        const seqEntry = r.entries[1]!;
        expect(seqEntry.sub).toBe(r.entries[0]!.id);
        expect(r.idMap.get(410)).toBe(seqEntry.id);
        const s = parseSequence(seqEntry.id, seqEntry.sub, seqEntry.data)!;
        expect(s).not.toBeNull();
        expect([s.length, s.slots, s.actors.length]).toEqual([126, 6, 2]);
        const [cam, door] = s.actors;
        expect([cam!.slot, cam!.ref]).toEqual([1, 11]);
        const ca = parseActions(cam!)!;
        expect(ca.map((a) => a.type)).toEqual([5, 9, 0, 8, 5]);
        expect(ca[1]!.fields.find((f) => f.name === 'b')!.value).toBe(55);
        expect(ca[4]!.fields[0]!.value).toBe(0); // AI resume zeroed
        const tr = ca[2]!;
        expect(tr.size).toBe(54);
        expect(tr.fields.find((f) => f.name === 'z')!.value).toBe(30);
        expect(tr.fields.find((f) => f.name === 'sx')!.value).toBe(1);
        expect(ca[3]!.fields[0]!.value).toBe(0x00070059);
        const da = parseActions(door!)!;
        expect(da.map((a) => a.type)).toEqual([1, 3, 7, 7]); // unmapped sound dropped
        expect(da[0]!.fields.find((f) => f.name === 'animation')!.value).toBe(0x00030042);
        expect(da[1]!.fields.find((f) => f.name === 'params')!.value).toBe(10000 | (0x18 << 16));
        expect(r.report.droppedActors.get('Lost')).toBe(1);
        expect(r.report.droppedActions.get('sound')).toBe(1);
        expect(r.report.unverifiedMessages.get(25)).toBe(1);
        expect(used.has(seqEntry.id)).toBe(true);
    });

    it('allocates holes below the maximum first and builds pack paths', () => {
        expect(ssdEntryPath('LEVEL1ON.SSD', { type: 0x311, id: 5, sub: 2 })).toBe('new/LEVEL1ON.SSD/0311_5_2.bin');
        expect(remapSequenceRefs([1, 2, 3], new Map([[2, 9]]))).toEqual([9]);
        expect(remapSequenceRefs(4, new Map())).toBe(0);
    });
});
