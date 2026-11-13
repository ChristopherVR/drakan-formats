// Synthetic fixtures only; no game bytes.
import { describe, expect, it } from 'vitest';
import { pcTransitionSequences, relayExitSequences } from '../src/ootfexitseq.ts';
import { FIELD_INT, type ClassFieldDef } from '../src/fields.ts';
import { objectParamSpecs, setObjectParams, type LvlObject, type LvlObjectList } from '../src/lvl.ts';
import type { OdbClass } from '../src/odb.ts';
import type { PcLevel } from '../src/pc.ts';
import { mergeSubtitleFiles, parseSubtitleFile, SUBTITLE_FORMAT, SubtitleTable } from '../src/ootfsubtitles.ts';

const SEQ = 0x0b; // sequence ref field type (the disc's ExitSequence / Entrance Sequence)
const field = (name: string, type: number): ClassFieldDef => ({ type, nameRaw: new Uint8Array(0), name }) as ClassFieldDef;
const exitFields = [field('Transition To...', 0x0a), field('Maintain Player Position', FIELD_INT), field('ExitSequence', SEQ), field('Entrance Sequence', SEQ)];

function obj(id: number, classId: number): LvlObject {
    return {
        id,
        classId,
        dbIndex: 1,
        prefix0: 0,
        prefix1: 0,
        pos: [0, 0, 0],
        flags: 1,
        initialEvents: 0,
        radius: null,
        links: [],
        rot: [0, 0, 0],
        scale: null,
        preSentinel: 0,
        sentinel: 0xffffffff,
        data: [],
        params: [],
    } as LvlObject;
}
const listOf = (...objects: LvlObject[]): LvlObjectList => ({ objects, warnings: [] }) as unknown as LvlObjectList;

function pcLevel(): PcLevel {
    const transition = { id: 7, name: 'Level Transition', rflClass: 55, fields: exitFields, data: [0, 1, 0, 0] } as unknown as OdbClass;
    const other = { id: 8, name: 'Timer', rflClass: 62, fields: [], data: [] } as unknown as OdbClass;
    const a = obj(100, 7); // names both scenes
    const b = obj(101, 7); // names none
    const c = obj(102, 8);
    const list = listOf(a, b, c);
    setObjectParams(list, 100, [
        { fieldIndex: 2, type: SEQ, name: 'ExitSequence', value: 0x41e },
        { fieldIndex: 3, type: SEQ, name: 'Entrance Sequence', value: 0x45c },
    ]);
    return { path: 'World/Level/Level.lvl', list, classes: new Map([[1, new Map([[7, transition], [8, other]])]]) } as unknown as PcLevel;
}

describe('exit and entrance sequences', () => {
    it('finds what the PC transitions name', () => {
        expect(pcTransitionSequences(pcLevel())).toEqual([
            { objectId: 100, field: 'ExitSequence', ref: 0x41e },
            { objectId: 100, field: 'Entrance Sequence', ref: 0x45c },
        ]);
    });

    const T_ENUM = 7;
    const player = {
        dbIndex: 2,
        classId: 129,
        fields: [field('Sequence List', 0x100b), field('List Play Order', T_ENUM), field('Initial State', T_ENUM), field('Message To Play Next', T_ENUM)],
    };
    const timer = { dbIndex: 2, classId: 128, fields: [field('Time Until Trigger', 2), field('Start Mode', T_ENUM), field('Trigger Message', T_ENUM)] };
    const value = (o: LvlObject, name: string) => objectParamSpecs(o).find((p) => p.name === name)?.value;

    it('puts a player with both scenes and a timer of their length in front of the exit', () => {
        const pc = pcLevel();
        const exit = obj(100, 498); // the rewritten PS2 exit keeps the PC id
        const sender = obj(50, 128);
        sender.links = [9, 100];
        const list = listOf(sender, exit, obj(101, 498));
        const warnings: string[] = [];
        const relays = relayExitSequences({
            pc,
            list,
            title: 'Level',
            player,
            timer,
            mapSequence: (_o: LvlObject, ref: number) => (ref === 0x41e ? 71 : 72),
            seconds: (_o: LvlObject, ref: number) => (ref === 0x41e ? 19.7 : 0),
            warnings,
        });
        expect(warnings).toEqual([]);
        expect(relays).toHaveLength(1);
        const r = relays[0]!;
        const byId = (id: number) => list.objects.find((o) => o.id === id)!;
        expect(r.sequences).toEqual([71, 72]); // the exit scene, then the entrance scene
        expect(value(byId(r.playerId), 'Sequence List')).toEqual([71, 72]);
        expect(value(byId(r.playerId), 'List Play Order')).toBe(0);
        expect(value(byId(r.playerId), 'Initial State')).toBe(0);
        expect(value(byId(r.playerId), 'Message To Play Next')).toBe(4);
        // what fired the exit now starts the scene and the timer; the timer fires the exit when the scenes are over
        expect(sender.links).toEqual([9, r.startTimerId, r.exitTimerId]);
        expect(byId(r.startTimerId).links).toEqual([r.playerId]);
        expect(value(byId(r.startTimerId), 'Trigger Message')).toBe(4);
        expect(byId(r.exitTimerId!).links).toEqual([100]);
        expect(value(byId(r.exitTimerId!), 'Trigger Message')).toBe(1);
        expect(value(byId(r.exitTimerId!), 'Time Until Trigger')).toBeCloseTo(19.95, 3);
        expect(r.reofferId).toBeNull(); // no detector class given: the relay's Timer fires the exit
        expect(exit.links).toEqual([]);
        // the exit can no longer be walked into: only the timer fires it
        expect(exit.scale).toEqual([0.01, 0.01, 0.01]);
        expect(exit.flags & 0x100).toBe(0x100);
    });

    it('lets the last scene fire the exit and offers the exit again from a box at the foot', () => {
        const pc = pcLevel();
        const exit = obj(100, 498);
        const sender = obj(50, 128);
        sender.links = [100];
        const list = listOf(sender, exit);
        const fullTimer = {
            ...timer,
            fields: [...timer.fields, field('Repeat', T_ENUM), field('Destroy After Timeout?', T_ENUM)],
        };
        const detector = {
            dbIndex: 2,
            classId: 129,
            fields: ['Task', 'Detect Which?', 'Initial State', 'Can be Triggered by Message ?', 'Trigger Message', 'Detect Only Once?'].map(
                (n) => field(n, T_ENUM),
            ),
        };
        const ends: { id: number; messages: unknown[] }[] = [];
        const warnings: string[] = [];
        const relays = relayExitSequences({
            pc,
            list,
            title: 'Level',
            player,
            timer: fullTimer,
            detector,
            endMessages: (id, messages) => (ends.push({ id, messages: [...messages] }), true),
            reofferAt: (_o, ref) => (ref === 0x41e ? [1000, 2000, 3000] : null),
            mapSequence: (_o: LvlObject, ref: number) => (ref === 0x41e ? 71 : 72),
            seconds: () => 1,
            warnings,
        });
        expect(warnings).toEqual([]);
        const r = relays[0]!;
        const byId = (id: number) => list.objects.find((o) => o.id === id)!;
        // no countdown fires the exit: the entrance scene (the last one) sends it ON and starts the arm Timer at its end
        expect(r.exitTimerId).toBeNull();
        expect(sender.links).toEqual([r.startTimerId]);
        expect(ends).toEqual([
            {
                id: 72,
                messages: [
                    { ref: 100, message: 4097, name: 'Level Exit' },
                    { ref: r.armTimerId, message: 4097, name: 'Exit Re-offer' },
                ],
            },
        ]);
        const arm = byId(r.armTimerId!);
        const box = byId(r.reofferId!);
        expect(arm.links).toEqual([box.id]);
        expect(value(arm, 'Start Mode')).toBe(1);
        expect(value(arm, 'Destroy After Timeout?')).toBe(0);
        expect(value(arm, 'Time Until Trigger')).toBeCloseTo(0.5, 5);
        // the box starts disabled, is enabled by a message, fires once: ON to the exit and the arm Timer again
        expect(box.links).toEqual([100, arm.id]);
        expect(box.pos).toEqual([1000, 2600, 3000]);
        expect(box.scale).toEqual([0.4, 0.6, 0.4]);
        expect(value(box, 'Initial State')).toBe(1);
        expect(value(box, 'Can be Triggered by Message ?')).toBe(1);
        expect(value(box, 'Detect Only Once?')).toBe(1);
        expect(value(box, 'Trigger Message')).toBe(1);
        expect(value(box, 'Detect Which?')).toBe(0);
        // without a place for the box (or when the scene cannot be rewritten) the relay keeps its Timer
        const exit2 = obj(100, 498);
        const sender2 = obj(50, 128);
        sender2.links = [100];
        const list2 = listOf(sender2, exit2);
        const w2: string[] = [];
        const r2 = relayExitSequences({
            pc,
            list: list2,
            title: 'Level',
            player,
            timer: fullTimer,
            detector,
            endMessages: () => false,
            reofferAt: () => [0, 0, 0],
            mapSequence: (_o: LvlObject, ref: number) => (ref === 0x41e ? 71 : 72),
            seconds: () => 1,
            warnings: w2,
        })[0]!;
        expect(r2.exitTimerId).not.toBeNull();
        expect(r2.reofferId).toBeNull();
        expect(list2.objects).toHaveLength(5); // sender, exit, player, start and exit Timers
        expect(w2.join()).toMatch(/could not be given its end messages/);
    });

    it('says why a scene cannot play', () => {
        const base = { pc: pcLevel(), title: 'Level', player, timer, seconds: () => 1 };
        let warnings: string[] = [];
        // nothing links to the exit: it is only walked into
        expect(relayExitSequences({ ...base, list: listOf(obj(100, 498)), mapSequence: () => 5, warnings })).toEqual([]);
        expect(warnings.join()).toMatch(/nothing fires this exit by link/);
        warnings = [];
        expect(relayExitSequences({ ...base, list: listOf(), mapSequence: () => 5, warnings })).toEqual([]);
        expect(warnings.join()).toMatch(/exit was not converted/);
        warnings = [];
        const sender = obj(50, 128);
        sender.links = [100];
        const relays = relayExitSequences({
            ...base,
            list: listOf(sender, obj(100, 498)),
            mapSequence: (_o: LvlObject, ref: number) => (ref === 0x41e ? 71 : null),
            warnings,
        });
        expect(relays[0]!.sequences).toEqual([71]);
        expect(warnings.join()).toMatch(/Entrance Sequence 0x45c was not converted/);
    });
});

describe('subtitle file precedence', () => {
    const file = (lines: unknown[]) => parseSubtitleFile({ format: SUBTITLE_FORMAT, version: 1, language: 'english', lines });
    it('lets a later (corrected) file replace lines of an earlier one', () => {
        const fresh = file([
            { bank: 'a/b', id: 1, cues: [{ start: 0, end: 2, text: 'A misheard line.' }] },
            { bank: 'a/b', id: 2, cues: [{ start: 0, end: 2, text: 'A noise taken for words.' }] },
            { bank: 'a/b', id: 3, cues: [{ start: 0, end: 2, text: 'A good line.' }] },
        ]);
        const corrected = file([
            { bank: 'A\\B', id: 1, cues: [{ start: 0, end: 2, text: 'The line as spoken.' }] },
            { bank: 'a/b', id: 2, cues: [] }, // emptied on purpose: no subtitle
        ]);
        const merged = mergeSubtitleFiles([fresh, corrected]);
        const t = new SubtitleTable(merged);
        expect(t.clipText('a/b', 1)).toBe('[[0]]The line as spoken.[[2]]');
        expect(t.clipText('a/b', 2)).toBeNull();
        expect(t.clipText('a/b', 3)).toBe('[[0]]A good line.[[2]]');
        expect(merged.lines).toHaveLength(3);
    });
});
