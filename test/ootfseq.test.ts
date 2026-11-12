// Synthetic PC sequences only; no game bytes.
import { describe, expect, it } from 'vitest';
import type { SrscReader } from '../src/srsc.ts';
import { parseSequence } from '../src/story/ssd.ts';
import { parseActions } from '../src/story/ssdactions.ts';
import { floatBits } from '../src/fields.ts';
import type { OdbClass } from '../src/odb.ts';
import {
    convertPcSequences,
    parsePcSequence,
    pcLevelFov,
    PC_DEFAULT_FOV,
    remapSequenceRefs,
    settlePlayerLying,
    skeletonChannelMap,
    ssdEntryPath,
    sequenceSoundRefs,
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
        act(0, 1, [
            ...f32(0),
            ...f32(0),
            ...f32(0),
            ...f32(1),
            ...f32(10),
            ...f32(20),
            ...f32(30),
            ...u32(0),
            ...u32(0x10),
        ]),
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
    it('collects cinematic-only sound references from selected records', async () => {
        expect(await sequenceSoundRefs(stub(pcSeq()), new Set([410]))).toEqual([0x00040385, 0x99999]);
        expect(await sequenceSoundRefs(stub(pcSeq()), new Set([999]))).toEqual([]);
    });
    it('recognizes cinematic player and camera aliases by mapped object identity', async () => {
        const bytes = w(
            str('Release'),
            u32(126),
            u32(0),
            u32(2),
            u32(2),
            actor('Wrynn', 1, 1740, [act(5, 90, u32(1))]),
            actor('Final view', 2, 385, [act(5, 90, u32(1))]),
        );
        const result = await convertPcSequences(stub(bytes), {
            maps: {
                objectIdMap: new Map([
                    [1740, 42],
                    [385, 43],
                ]),
            },
            usedIds: new Set(),
            playerObjectId: 42,
            cameraObjectId: 43,
        });
        const entry = result.entries.find((e) => e.type === 0x311)!;
        const sequence = parseSequence(entry.id, entry.sub, entry.data)!;
        expect(sequence.actors[0]!.mode).toBe(1); // current controlled actor, including a carried/restored player
        expect(sequence.actors[0]!.ref).toBe(42);
        expect(parseActions(sequence.actors[0]!)![0]!.fields[0]!.value).toBe(1);
        expect(parseActions(sequence.actors[1]!)!.some((a) => a.type === 9)).toBe(true);
    });
    it('plays converted camera actors at the PC level field of view (80) unless told otherwise', async () => {
        const r = await convertPcSequences(stub(pcSeq()), {
            maps: { objectIdMap: new Map([[100, 11]]) },
            usedIds: new Set(),
        });
        const s = parseSequence(r.entries[1]!.id, r.entries[1]!.sub, r.entries[1]!.data)!;
        const setup = parseActions(s.actors[0]!)!.find((a) => a.type === 9)!;
        expect(setup.fields.find((f) => f.name === 'b')!.value).toBe(PC_DEFAULT_FOV);
        expect(PC_DEFAULT_FOV).toBe(80);
    });
    it('reads the field of view from the PC Level Properties class', () => {
        const props = (fov: number): OdbClass => ({
            id: 1,
            name: 'Level Properties',
            group: 0,
            runtimeClass: 0x36,
            rflClass: 54,
            fields: [
                { name: 'Fog Color', type: 15 },
                { name: 'Default Field of View (deg)', type: 2 },
            ],
            data: [0, floatBits(fov)],
        });
        const other: OdbClass = { id: 2, name: 'Camera', group: 0, runtimeClass: 0x1b, rflClass: 27 };
        expect(
            pcLevelFov({
                classes: new Map([
                    [3, new Map([[1, props(65)]])],
                    [0, new Map([[2, other]])],
                ]),
            }),
        ).toBe(65);
        expect(pcLevelFov({ classes: new Map([[0, new Map([[2, other]])]]) })).toBe(80);
        expect(pcLevelFov({ classes: new Map([[0, new Map([[1, props(0)]])]]) })).toBe(80);
    });
    it('holds a synthetic player in every scene of a level without a PC player', async () => {
        const r = await convertPcSequences(stub(pcSeq()), {
            maps: { objectIdMap: new Map([[100, 11]]) },
            usedIds: new Set(),
            holdPlayerObjectId: 77,
        });
        const s = parseSequence(r.entries[1]!.id, r.entries[1]!.sub, r.entries[1]!.data)!;
        const held = s.actors.find((a) => a.ref === 77)!;
        expect([held.name, held.mode, held.slot]).toEqual(['Rynn', 1, 2]);
        expect(s.slots).toBe(3);
        const actions = parseActions(held)!;
        expect(actions.map((a) => [a.type, a.time])).toEqual([[5, 0]]);
        expect(actions[0]!.fields[0]!.value).toBe(0);
        // a scene that already plays that player is left alone
        const again = await convertPcSequences(stub(pcSeq()), {
            maps: { objectIdMap: new Map([[100, 77]]) },
            usedIds: new Set(),
            holdPlayerObjectId: 77,
        });
        const t = parseSequence(again.entries[1]!.id, again.entries[1]!.sub, again.entries[1]!.data)!;
        expect(t.actors.filter((a) => a.ref === 77)).toHaveLength(1);
    });
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
        expect(ca[4]!.fields[0]!.value).toBe(1); // AI resume kept (the scene releases the actor at its end)
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
        expect(r.report.warnings).toContain('sound: 1 cinematic action(s) had no compatible resource mapping');
        expect(r.report.warnings).toContain('sound 0x99999: no compatible resource mapping');
        expect(r.report.unverifiedMessages.get(25)).toBe(1);
        expect(used.has(seqEntry.id)).toBe(true);
    });

    it('uses actor-specific rig maps without falling back to a global clip', async () => {
        const clip = act(1, 3.25, [...u32(2), ...u32(7), ...f32(0), ...f32(0.85), ...f32(1), ...u32(0x15)]);
        const bytes = w(
            str('Rigs'),
            u32(126),
            u32(0),
            u32(4),
            u32(3),
            actor('First', 1, 100, [clip]),
            actor('Second', 2, 200, [clip]),
            actor('Unverified', 3, 300, [clip]),
        );
        const result = await convertPcSequences(stub(bytes), {
            maps: {
                objectIdMap: new Map([
                    [100, 11],
                    [200, 22],
                    [300, 33],
                ]),
                animMap: new Map([[7, 999]]),
                animMapForActor: (_actor, target) =>
                    target === 11 ? new Map([[7, 41]]) : target === 22 ? new Map([[7, 82]]) : undefined,
            },
            usedIds: new Set(),
        });
        const entry = result.entries.find((e) => e.type === 0x311)!;
        const seq = parseSequence(entry.id, entry.sub, entry.data)!;
        expect(
            seq.actors.map((a) =>
                parseActions(a)!.map((action) => ({
                    time: action.time,
                    clip: action.fields.find((f) => f.name === 'animation')?.value,
                })),
            ),
        ).toEqual([[{ time: 3.25, clip: 41 }], [{ time: 3.25, clip: 82 }], []]);
        expect(result.report.droppedActions.get('animation')).toBe(1);
        expect(result.report.warnings).toContain('animation 0x7: no compatible resource mapping');
    });

    it('passes mapped source identities for aliased player and camera animation maps', async () => {
        const clip = act(1, 2, [...u32(2), ...u32(7), ...f32(0), ...f32(0.85), ...f32(1), ...u32(0x15)]);
        const bytes = w(
            str('Aliases'),
            u32(126),
            u32(0),
            u32(3),
            u32(2),
            actor('Wrynn', 1, 1740, [clip]),
            actor('UnlabelledView', 2, 385, [clip]),
        );
        const seen: number[][] = [];
        const result = await convertPcSequences(stub(bytes), {
            maps: {
                objectIdMap: new Map([
                    [1740, 501],
                    [385, 502],
                ]),
                animMapForActor: (source, target) => {
                    seen.push([source.objectId, target]);
                    return new Map([[7, target + 100]]);
                },
            },
            playerObjectId: 501,
            cameraObjectId: 502,
            usedIds: new Set(),
        });
        expect(seen).toEqual([
            [1740, 501],
            [385, 502],
        ]);
        const entry = result.entries.find((e) => e.type === 0x311)!;
        const sequence = parseSequence(entry.id, entry.sub, entry.data)!;
        expect(sequence.actors.map((a) => [a.ref, a.mode])).toEqual([
            [501, 1],
            [502, 0],
        ]);
        expect(
            sequence.actors.map(
                (a) =>
                    parseActions(a)!
                        .find((x) => x.type === 1)!
                        .fields.find((f) => f.name === 'animation')!.value,
            ),
        ).toEqual([601, 602]);
    });

    it('maps skeleton channels by joint name', () => {
        // PC Rynn order: wrynn, upperbody, neck, Lweapon, Rweapon; PS2 Rynn: wrynn, upperbody, torso, neck, head, ..., Rweapon.
        const pc = { channels: [0, 1, 4, 13, 18].map((joint) => ({ joint, caps: [] })) };
        const pcNames: string[] = [];
        Object.assign(pcNames, { 0: 'wrynn', 1: 'upperbody', 4: 'neck', 13: 'Lweapon', 18: 'Rweapon' });
        const ps2 = { channels: [0, 1, 2, 4, 5, 37].map((joint) => ({ joint, caps: [] })) };
        const ps2Names: string[] = [];
        Object.assign(ps2Names, { 0: 'wrynn', 1: 'upperbody', 2: 'torso', 4: 'neck', 5: 'head', 37: 'RWEAPON' });
        expect([...skeletonChannelMap(pc, pcNames, ps2, ps2Names)]).toEqual([
            [0, 0],
            [1, 1],
            [2, 3],
            [4, 5],
        ]);
    });

    it('remaps animation channels and attach points of an actor on another rig', async () => {
        const bytes = w(
            str('Draw'),
            u32(126),
            u32(0),
            u32(3),
            u32(2),
            actor('Rynn', 1, 1740, [
                act(1, 0, [...u32(2), ...u32(7), ...f32(0), ...f32(0.85), ...f32(1), ...u32(0)]),
                act(4, 1, [...u32(2), ...u32(4)]),
                act(4, 2, [...u32(0), ...u32(9)]),
            ]),
            actor('Delon', 2, 1841, [act(4, 1, [...u32(1), ...u32(4)])]),
        );
        const result = await convertPcSequences(stub(bytes), {
            maps: {
                objectIdMap: new Map([
                    [1740, 42],
                    [1841, 43],
                ]),
                animMapForActor: () => new Map([[7, 2400]]),
                channelMapForActor: (_a, target) =>
                    target === 42
                        ? new Map([
                              [2, 3],
                              [4, 21],
                          ])
                        : undefined,
            },
            playerObjectId: 42,
            usedIds: new Set(),
        });
        const entry = result.entries.find((e) => e.type === 0x311)!;
        const seq = parseSequence(entry.id, entry.sub, entry.data)!;
        const words = (a: (typeof seq.actors)[number]) =>
            parseActions(a)!.map((x) => x.fields.slice(0, 2).map((f) => f.value));
        // channel 2 -> 3 (neck), attach point 4 -> 21 (Rweapon); an unmapped channel is kept and reported
        expect(words(seq.actors[0]!)).toEqual([
            [3, 2400],
            [2, 21],
            [0, 9],
        ]);
        expect(result.report.warnings).toContain('channel 9: no channel on the same joint of the PS2 rig (kept)');
        // an actor without a channel map (own converted rig) keeps the PC attach point
        expect(words(seq.actors[1]!)).toEqual([[1, 4]]);
    });

    it('keeps holding a synthetic player that also plays a PC actor', async () => {
        const bytes = w(
            str('Intro 3'),
            u32(126),
            u32(0),
            u32(2),
            u32(1),
            actor('Rynn', 2, 2853, [act(1, 0, [...u32(0), ...u32(7), ...f32(0), ...f32(0.85), ...f32(1), ...u32(0)])]),
        );
        const result = await convertPcSequences(stub(bytes), {
            maps: { objectIdMap: new Map([[2853, 77]]), animMapForActor: () => new Map([[7, 2400]]) },
            playerObjectId: 77,
            holdPlayerObjectId: 77,
            usedIds: new Set(),
        });
        const entry = result.entries.find((e) => e.type === 0x311)!;
        const seq = parseSequence(entry.id, entry.sub, entry.data)!;
        expect(seq.actors.map((a) => [a.ref, a.mode])).toEqual([[77, 1]]);
        expect(parseActions(seq.actors[0]!)!.map((x) => [x.type, x.time])).toEqual([
            [5, 0],
            [1, 0],
        ]);
    });

    it('ends a held scene with the player detached from the actor that carries her', async () => {
        // Intro 3: the dragon puts Rynn (slot 2) on its point 19 at t = 0 and the level ends with her there; a gull is
        // attached and detached again on another point and must be left alone.
        const bytes = w(
            str('Intro 3'),
            u32(126),
            u32(0),
            u32(4),
            u32(2),
            actor('Rynn', 2, 2853, [act(1, 0, [...u32(0), ...u32(7), ...f32(0), ...f32(0.85), ...f32(1), ...u32(0)])]),
            actor('Aroch', 3, 2852, [
                act(4, 0, [...u32(2), ...u32(19)]),
                act(4, 1, [...u32(4), ...u32(5)]),
                act(4, 2, [...u32(0), ...u32(5)]),
                act(0, 13.34, [
                    ...f32(0),
                    ...f32(0),
                    ...f32(0),
                    ...f32(1),
                    ...f32(1),
                    ...f32(2),
                    ...f32(3),
                    ...u32(0),
                    ...u32(0x10),
                ]),
            ]),
        );
        const convert = (hold: number | undefined) =>
            convertPcSequences(stub(bytes), {
                maps: {
                    objectIdMap: new Map([
                        [2853, 77],
                        [2852, 88],
                    ]),
                    animMapForActor: () => new Map([[7, 2400]]),
                },
                playerObjectId: 77,
                holdPlayerObjectId: hold,
                usedIds: new Set(),
            });
        const attaches = async (hold: number | undefined) => {
            const result = await convert(hold);
            const entry = result.entries.find((e) => e.type === 0x311)!;
            const seq = parseSequence(entry.id, entry.sub, entry.data)!;
            const dragon = seq.actors.find((a) => a.ref === 88)!;
            return parseActions(dragon)!
                .filter((x) => x.type === 4)
                .map((x) => [x.time, ...x.fields.map((f) => f.value)].map((v) => Math.round(v * 100) / 100));
        };
        expect(await attaches(77)).toEqual([
            [0, 2, 19],
            [1, 4, 5],
            [2, 0, 5],
            [13.34, 0, 19], // the detach, at the scene's last action
        ]);
        // a scene that hands the player back (no held player) keeps her on the saddle
        expect((await attaches(undefined)).map((x) => x[1])).toEqual([2, 4, 0]);
    });

    it('releases the actors a level-ending scene still holds when asked to', async () => {
        // The Book's backstory: camera and Rynn held at t = 0, never released (the PC level ends there); a fader runs last.
        const bytes = w(
            str('backstory'),
            u32(124),
            u32(0),
            u32(4),
            u32(3),
            actor('camera', 1, 2416, [act(5, 0, [...u32(0)])]),
            actor('Rynn', 2, 2417, [act(5, 0, [...u32(0)])]),
            actor('Fader 2', 3, 2427, [act(7, 250.5, [...u32(4097), ...u32(0)])]),
        );
        const runs = async (release: boolean | undefined) => {
            const result = await convertPcSequences(stub(bytes), {
                maps: {
                    objectIdMap: new Map([
                        [2416, 10],
                        [2417, 11],
                        [2427, 12],
                    ]),
                },
                releaseHeldAtEnd: release,
                usedIds: new Set(),
            });
            const entry = result.entries.find((e) => e.type === 0x311)!;
            const seq = parseSequence(entry.id, entry.sub, entry.data)!;
            return seq.actors.map((a) =>
                parseActions(a)!
                    .filter((x) => x.type === 5)
                    .map((x) => [Math.round(x.time * 10) / 10, x.fields[0]!.value]),
            );
        };
        expect(await runs(true)).toEqual([
            [
                [0, 0],
                [250.5, 1],
            ],
            [
                [0, 0],
                [250.5, 1],
            ],
            [],
        ]);
        expect((await runs(undefined)).map((r) => r.length)).toEqual([1, 1, 0]);
    });

    it('sends the end messages at the last action, after the releases, so a skipped scene sends them too', async () => {
        // The engine's skip moves the scene clock to its last action and runs what it passed: a message there always goes out.
        const bytes = w(
            str('backstory'),
            u32(124),
            u32(0),
            u32(3),
            u32(2),
            actor('camera', 1, 2416, [act(5, 0, [...u32(0)]), act(0, 12, new Array(36).fill(0))]),
            actor('Fader 2', 2, 2427, [act(7, 250.5, [...u32(4097), ...u32(0)])]),
        );
        const result = await convertPcSequences(stub(bytes), {
            maps: {
                objectIdMap: new Map([
                    [2416, 10],
                    [2427, 12],
                ]),
            },
            releaseHeldAtEnd: true,
            endMessages: [{ ref: 2420, message: 0x1005, name: 'Level Exit' }],
            usedIds: new Set(),
        });
        const entry = result.entries.find((e) => e.type === 0x311)!;
        const seq = parseSequence(entry.id, entry.sub, entry.data)!;
        expect(seq.actors.map((a) => [a.name, a.slot, a.ref])).toEqual([
            ['camera', 1, 10],
            ['Fader 2', 2, 12],
            ['Level Exit', 3, 2420],
        ]);
        expect(seq.slots).toBe(4);
        const exit = parseActions(seq.actors[2]!)!;
        expect(exit.map((x) => [x.type, Math.round(x.time * 10) / 10, x.fields[0]!.value, x.fields[1]!.value])).toEqual(
            [[7, 250.5, 0x1005, 0]],
        );
        // no end messages: the scene is unchanged
        const plain = await convertPcSequences(stub(bytes), {
            maps: {
                objectIdMap: new Map([
                    [2416, 10],
                    [2427, 12],
                ]),
            },
            usedIds: new Set(),
        });
        expect(parseSequence(0, 0, plain.entries.find((e) => e.type === 0x311)!.data)!.actors).toHaveLength(2);
    });

    it('sets the lip-sync bit on the speech of lip-synced actors only', async () => {
        const speech = act(3, 1, [...u32(0x13f), ...f32(6.2), ...u16(10000), ...u16(0x10)]);
        const step = act(3, 2, [...u32(0x7d), ...f32(0.3), ...u16(6000), ...u16(0)]);
        const bytes = w(
            str('Talk'),
            u32(126),
            u32(0),
            u32(3),
            u32(2),
            actor('Rynn', 1, 1740, [speech, step]),
            actor('Delon', 2, 1841, [speech]),
        );
        const result = await convertPcSequences(stub(bytes), {
            maps: {
                objectIdMap: new Map([
                    [1740, 42],
                    [1841, 43],
                ]),
                soundMap: { get: (r) => r },
                lipSyncForActor: (_a, target) => target === 42,
            },
            usedIds: new Set(),
        });
        const entry = result.entries.find((e) => e.type === 0x311)!;
        const seq = parseSequence(entry.id, entry.sub, entry.data)!;
        const flags = (a: (typeof seq.actors)[number]) =>
            parseActions(a)!.map((x) => x.fields.find((f) => f.name === 'params')!.value >>> 16);
        expect(flags(seq.actors[0]!)).toEqual([0x30, 0]);
        expect(flags(seq.actors[1]!)).toEqual([0x10]);
    });

    it('plays the native idle just before an actor is released to the game', async () => {
        const clip = act(1, 2, [...u32(0), ...u32(7), ...u32(0), ...f32(0), ...f32(1), ...u32(0x15)]);
        const release = act(5, 10, u32(1));
        const bytes = w(str('End'), u32(126), u32(0), u32(2), u32(1), actor('Rynn', 1, 1740, [clip, release]));
        const run = async (idle?: number) => {
            const result = await convertPcSequences(stub(bytes), {
                maps: {
                    objectIdMap: new Map([[1740, 42]]),
                    animMapForActor: () => new Map([[7, 2400]]),
                    endIdleForActor: () => idle,
                },
                usedIds: new Set(),
            });
            const entry = result.entries.find((e) => e.type === 0x311)!;
            return parseActions(parseSequence(entry.id, entry.sub, entry.data)!.actors[0]!)!;
        };
        expect((await run()).map((x) => [x.type, x.time])).toEqual([
            [1, 2],
            [5, 10],
        ]);
        const withIdle = await run(1147);
        expect(withIdle.map((x) => [x.type, x.time])).toEqual([
            [1, 2],
            [1, 9.5],
            [5, 10],
        ]);
    });

    it('allocates holes below the maximum first and builds pack paths', () => {
        expect(ssdEntryPath('LEVEL1ON.SSD', { type: 0x311, id: 5, sub: 2 })).toBe('new/LEVEL1ON.SSD/0311_5_2.bin');
        expect(remapSequenceRefs([1, 2, 3], new Map([[2, 9]]))).toEqual([9]);
        expect(remapSequenceRefs(4, new Map())).toBe(0);
    });
});

describe('settlePlayerLying', () => {
    const move = (t: number, y: number): { x: import('../src/ootfseq.ts').PcAction; i: number } => {
        const payload = new Uint8Array(36);
        const dv = new DataView(payload.buffer);
        dv.setFloat32(12, 1, true);
        dv.setFloat32(16, 1000, true);
        dv.setFloat32(20, y, true);
        dv.setFloat32(24, 2000, true);
        return { x: { type: 0, time: t, payload }, i: 0 };
    };
    const clip = (t: number, ref: number): { x: import('../src/ootfseq.ts').PcAction; i: number } => {
        const payload = new Uint8Array(24);
        const dv = new DataView(payload.buffer);
        dv.setUint32(4, ref, true);
        dv.setFloat32(16, 1, true);
        return { x: { type: 1, time: t, payload }, i: 0 };
    };
    const ground = { groundAt: () => 0, lowestJoint: (ref: number) => (ref === 2 ? -25 : -480) };
    const ys = (a: { x: import('../src/ootfseq.ts').PcAction }[]): number[] =>
        a.filter((e) => e.x.type === 0).map((e) => new DataView(e.x.payload.buffer).getFloat32(20, true));

    it('rests a lying pose on the ground and adds a key where the clip starts', () => {
        const sorted = [move(0, 500), clip(1, 1), move(5, 540), clip(6, 2), move(9, 630)];
        settlePlayerLying(sorted, ground);
        expect(sorted.map((e) => e.x.time)).toEqual([0, 1, 5, 6, 6, 9]);
        // standing keys keep their height; the key added at the lying clip start and the one under it rest the body at 100
        expect(ys(sorted)).toEqual([500, 540, 100, 100]);
    });

    it('leaves standing and sitting keys alone', () => {
        const sorted = [move(0, 500), clip(0, 1), move(4, 520)];
        settlePlayerLying(sorted, ground);
        expect(ys(sorted)).toEqual([500, 520]);
        const sitting = [move(0, 260), clip(0, 2)];
        settlePlayerLying(sitting, { groundAt: () => 100, lowestJoint: () => -184 });
        expect(ys(sitting)).toEqual([260]);
    });
});
