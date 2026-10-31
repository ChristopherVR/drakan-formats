// Synthetic story fixtures only (sequences, sound descriptors, dialog classes); no game bytes.
import { describe, expect, it } from 'vitest';
import {
    ACTION_TYPES,
    actorPath,
    cameraPath,
    describeMessage,
    dialogLineSoundEdit,
    insertAction,
    joinSubtitlePages,
    messageCues,
    newActionBytes,
    parseActions,
    parseConversationHandler,
    parseDialogLine,
    parseSdbText,
    parseSequence,
    removeAction,
    samplePath,
    sequenceDuration,
    setActionField,
    setActionTime,
    soundCues,
    splitSubtitlePages,
    splitLineName,
    stompPlayerFromFields,
    writeSdbText,
    writeSequence,
    type OdbClass,
} from '../src/index.ts';

const BS = String.fromCharCode(92);
const u16 = (n: number): number[] => [n & 255, (n >> 8) & 255];
const u32 = (n: number): number[] => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];
const name = (s: string, len = ((s.length + 1 + 2 + 3) & ~3) - 2): number[] => {
    const raw = [...s].map((c) => c.charCodeAt(0));
    while (raw.length < len) raw.push(0);
    return [...u16(len), ...raw];
};

function actor(nm: string, slot: number, ref: number, mode: number, actions: Uint8Array[]): number[] {
    return [
        ...name(nm),
        ...u32(slot),
        ...u32(ref),
        ...u32(mode),
        ...u32(actions.length),
        ...actions.flatMap((a) => [...a]),
    ];
}

function sequence(): Uint8Array {
    const cam = actor('Camera', 1, 910, 0, [
        newActionBytes(5, 0),
        newActionBytes(9, 0, { a: 1, b: 50 }),
        newActionBytes(0, 0, { x: 1000, y: 2000, z: 3000, qw: 1 }),
        newActionBytes(10, 2),
        newActionBytes(0, 2, { x: 5000, y: 2000, z: 3000, qw: 1 }),
    ]);
    const jade = actor('Jade', 2, 7726, 1, [
        newActionBytes(1, 0, { animation: 3009, mode: 7 }),
        newActionBytes(3, 1.5, { sound: 472, params: 0x382710 }),
        newActionBytes(7, 3, { message: 4097, param: 0 }),
    ]);
    return Uint8Array.from([...name('Test Scene'), ...u32(60), ...u32(0), ...u32(3), ...u32(2), ...cam, ...jade]);
}

describe('ssd sequences', () => {
    it('parses actors and keeps the bytes on rewrite', () => {
        const raw = sequence();
        const seq = parseSequence(7, 3, raw)!;
        expect(seq.name).toBe('Test Scene');
        expect(seq.slots).toBe(3);
        expect(seq.actors.map((a) => [a.name, a.slot, a.ref, a.mode, a.actionCount])).toEqual([
            ['Camera', 1, 910, 0, 5],
            ['Jade', 2, 7726, 1, 3],
        ]);
        expect(writeSequence(seq)).toEqual(raw);
        expect(sequenceDuration(seq)).toBe(3);
    });

    it('rejects text that is not a sequence', () => {
        expect(parseSequence(1, 0, Uint8Array.from([1, 2, 3]))).toBeNull();
        expect(
            parseSequence(1, 0, Uint8Array.from([...name('x'), ...u32(1), ...u32(0), ...u32(2), ...u32(1)])),
        ).toBeNull();
    });

    it('decodes every action type with exact sizes', () => {
        const seq = parseSequence(7, 3, sequence())!;
        const cam = parseActions(seq.actors[0]!)!;
        expect(cam.map((a) => a.kind)).toEqual(['marker', 'camera', 'transform', 'hold', 'transform']);
        expect(cam.map((a) => a.size).reduce((s, n) => s + n, 0)).toBe(seq.actors[0]!.actions.length);
        const jade = parseActions(seq.actors[1]!)!;
        expect(jade[0]!.fields.find((f) => f.name === 'animation')!.value).toBe(3009);
        expect(soundCues(seq).map((c) => [c.time, c.ref, c.actor])).toEqual([[1.5, 472, 'Jade']]);
        expect(messageCues(seq).map((c) => c.message)).toEqual([4097]);
        expect(Object.keys(ACTION_TYPES).map(Number)).toEqual([0, 1, 3, 4, 5, 6, 7, 8, 9, 10]);
    });

    it('edits fields, inserts in time order and removes actions', () => {
        const seq = parseSequence(7, 3, sequence())!;
        const jade = seq.actors[1]!;
        const sound = parseActions(jade)![1]!;
        jade.actions = setActionField(jade, sound, 'sound', 99);
        jade.actions = setActionTime(jade, parseActions(jade)![1]!, 2.5);
        expect(soundCues(seq)[0]).toMatchObject({ time: 2.5, ref: 99 });
        const ins = insertAction(jade, newActionBytes(7, 2, { message: 4098 }));
        Object.assign(jade, ins);
        expect(parseActions(jade)!.map((a) => a.kind)).toEqual(['animation', 'message', 'sound', 'message']);
        Object.assign(jade, removeAction(jade, 1));
        expect(parseActions(jade)!.map((a) => a.kind)).toEqual(['animation', 'sound', 'message']);
        expect(parseSequence(7, 3, writeSequence(seq))!.actors[1]!.actionCount).toBe(3);
        expect(() => newActionBytes(2, 0)).toThrow();
    });

    it('renames with the stored padding kept when it fits', () => {
        const seq = parseSequence(7, 3, sequence())!;
        seq.name = 'Test';
        seq.actors[0]!.name = 'Cam';
        const back = parseSequence(7, 3, writeSequence(seq))!;
        expect(back.name).toBe('Test');
        expect(back.actors[0]!.name).toBe('Cam');
        expect(back.actors[0]!.actions).toEqual(seq.actors[0]!.actions);
    });

    it('builds a camera path and samples it', () => {
        const seq = parseSequence(7, 3, sequence())!;
        const { actor: cam, keys } = cameraPath(seq);
        expect(cam!.name).toBe('Camera');
        expect(keys.map((k) => k.time)).toEqual([0, 2]);
        expect(actorPath(seq.actors[1]!)).toEqual([]);
        expect(samplePath(keys, 1)!.pos[0]).toBeCloseTo(3000, 3);
        expect(samplePath(keys, -1)!.pos[0]).toBe(1000);
        expect(samplePath(keys, 9)!.pos[0]).toBe(5000);
        expect(samplePath([], 1)).toBeNull();
    });
});

describe('sound descriptor subtitles', () => {
    function descriptor(text: string | null): Uint8Array {
        const n = name('C103FA01');
        const base = n.length;
        const head = [
            ...u32(text === null ? 2 : 0x2002),
            ...u32(0x100001),
            ...u32(22050),
            ...u32(0),
            ...u32(0),
            ...u32(0),
            ...u32(0x41700000),
            ...u32(0x55),
        ];
        let mid: number[];
        if (text === null) mid = u32(2);
        else {
            const start = base + 34;
            const len = ((start + text.length + 1 + 3) & ~3) - start;
            mid = [...u16(len), ...[...text].map((c) => c.charCodeAt(0))];
            while (mid.length < 2 + len) mid.push(0);
        }
        return Uint8Array.from([...n, ...head, ...mid, ...u32(111), ...u32(222), ...u32(0)]);
    }

    it('reads and rewrites a subtitle', () => {
        const d = descriptor('Have you come to see the dragon?');
        expect(parseSdbText(d)).toEqual({ name: 'C103FA01', hasText: true, text: 'Have you come to see the dragon?' });
        expect(writeSdbText(d, 'Have you come to see the dragon?')).toEqual(d);
        const w = writeSdbText(d, 'Hi ’there’')!;
        expect(parseSdbText(w)!.text).toBe('Hi ’there’');
        expect(w.length % 4).toBe(0);
        expect(w.subarray(w.length - 12)).toEqual(d.subarray(d.length - 12));
    });

    it('adds text to a silent descriptor and clears it again', () => {
        const d = descriptor(null);
        expect(parseSdbText(d)).toMatchObject({ hasText: false, text: '' });
        expect(writeSdbText(d, '')).toEqual(d);
        const w = writeSdbText(d, 'Now it speaks.')!;
        expect(parseSdbText(w)).toMatchObject({ hasText: true, text: 'Now it speaks.' });
        expect(parseSdbText(writeSdbText(w, '')!)!.text).toBe('');
        expect(writeSdbText(Uint8Array.from([1, 2]), 'x')).toBeNull();
    });

    it('splits and joins timed pages', () => {
        const pages = splitSubtitlePages('Have you heard? \\.9 They say something. \\2 Bye');
        expect(pages).toEqual([
            { text: 'Have you heard?', delay: 0.9 },
            { text: 'They say something.', delay: 2 },
            { text: 'Bye', delay: 0 },
        ]);
        expect(joinSubtitlePages(pages)).toBe('Have you heard? \\.9 They say something. \\2 Bye');
        expect(splitSubtitlePages('One page')).toEqual([{ text: 'One page', delay: 0 }]);
    });
});

describe('conversations', () => {
    const F = (type: number, n: string) => ({ type, name: n });
    function lineClass(): OdbClass {
        // data: 0 animation(arr), 1 delay, 2 head, 3 sound(arr), 4 mode, ... array payloads at 8 and 9
        const fields = [
            F(0x1009, 'Animation'),
            F(2, 'Delay'),
            F(7, 'Maintain special head animation during anim?'),
            F(0x1005, 'Sound'),
            F(7, 'Sound Play Mode'),
            F(0x0a, 'Debug Text'),
            F(7, 'Camera Position'),
            F(7, 'Camera Transition'),
            F(2, 'Time to Transition Camera (sec) (0 = default)'),
        ];
        const data = [(1 << 16) | 9, 0, 1, (2 << 16) | 10, 1, 0, 5, 1, 0, 3009, 0x10, 0x20];
        return { id: 449, name: 'Farmer - C103FA01', group: 443, runtimeClass: 0x100ba, fields, data };
    }

    it('decodes a dialog line and edits its sound in place', () => {
        const line = parseDialogLine(lineClass())!;
        expect(line).toMatchObject({ speaker: 'Farmer', animations: [3009], playMode: 1, headAnimation: true });
        expect(line.sounds).toEqual([0x10, 0x20]);
        expect([...dialogLineSoundEdit(line, 1, 77)]).toEqual([[11, 77]]);
        expect(() => dialogLineSoundEdit(line, 2, 1)).toThrow();
        expect(parseDialogLine({ ...lineClass(), runtimeClass: 5 })).toBeNull();
        expect(splitLineName('Monk - C111MO02 - A')).toEqual({ speaker: 'Monk', sound: 'C111MO02' });
        expect(splitLineName('Greeting')).toEqual({ speaker: 'Greeting', sound: '' });
    });

    it('decodes a handler with instance overrides', () => {
        const fields = [
            F(0x3003, 'Beginning Dialog Exchange'),
            F(7, 'Message to send after Beginning dialog'),
            F(1, 'Gold to give when complete'),
            F(7, 'Initially active?'),
            F(2, 'Distance From Rynn'),
        ];
        const cls: OdbClass = {
            id: 445,
            name: 'Conversation Handler',
            group: 1,
            runtimeClass: 0x100b4,
            fields,
            data: [0, 0, 5, 1, 0x3f800000],
        };
        const h = parseConversationHandler(
            cls,
            new Map<string, number | number[]>([
                ['Beginning Dialog Exchange', [449, 446]],
                ['Message to send after Beginning dialog', 1],
            ]),
        )!;
        expect(h.phases[0]).toMatchObject({ key: 'beginning', lines: [449, 446], message: 1 });
        expect(h.phases[4]!.lines).toEqual([]);
        expect(h).toMatchObject({ goldOnComplete: 5, initiallyActive: true, distance: 1 });
        expect(parseConversationHandler({ ...cls, runtimeClass: 1 })).toBeNull();
    });
});

describe('cut scene players and messages', () => {
    it('reads a player and names messages', () => {
        const p = stompPlayerFromFields(new Map([['Sequence List', [421, 1022 | 0x50000]]]), { initialState: 1 });
        expect(p).toEqual({ sequences: [421, 1022], playOrder: 0, initialState: 1, messageToPlayNext: 4 });
        expect(describeMessage(4097)).toBe('On (4097)');
        expect(describeMessage(4257)).toBe('Play sequence (4257)');
        expect(describeMessage(9)).toBe('Message 9');
    });
});

describe('level story loading', () => {
    it('reads sequences, folders, sounds and dependencies through a file map', async () => {
        const { buildSrsc } = await import('./fixtures.ts');
        const { loadLevelStory } = await import('../src/index.ts');
        const seq = sequence();
        const ssd = buildSrsc([
            { type: 0x312, id: 5, sub: 0, data: Uint8Array.from(name('Folder')) },
            { type: 0x311, id: 7, sub: 5, data: seq },
            { type: 0x311, id: 8, sub: 5, data: Uint8Array.from([9, 9, 9]) },
        ]);
        const n = name('C103FA01');
        const desc = Uint8Array.from([
            ...n,
            ...u32(2),
            ...u32(0x100001),
            ...u32(22050),
            ...new Array<number>(20).fill(0),
            ...u32(2),
            ...u32(1),
            ...u32(2),
            ...u32(0),
        ]);
        const sdb = buildSrsc([
            { type: 0x302, id: 3, sub: 1, data: desc },
            { type: 0x304, id: 3, sub: 1, data: new Uint8Array(1600) },
        ]);
        const files = new Map<string, Uint8Array>([
            [`LEVELS${BS}LEVELX${BS}LEVELX.SSD`, ssd],
            [`LEVELS${BS}LEVELX${BS}LEVELX.SDB`, sdb],
            [
                `LEVELS${BS}LEVELX${BS}LEVELX.DB`,
                new TextEncoder().encode(
                    `version 1\r\ndependencies 1\r\n3 ..${BS}..${BS}Common${BS}System${BS}System\r\n`,
                ),
            ],
        ]);
        const s = await loadLevelStory({ read: async (p) => files.get(p) ?? null }, 'ENGLISH', 'LEVELX');
        expect(s.deps).toEqual({ 3: 'SYSTEM' });
        expect(s.folders).toEqual([{ id: 5, parent: 0, name: 'Folder' }]);
        expect(s.sequences.map((q) => [q.id, q.folder, q.seq?.name ?? null])).toEqual([
            [7, 5, 'Test Scene'],
            [8, 5, null],
        ]);
        expect(s.sounds.get(3)).toMatchObject({ name: 'C103FA01', rate: 22050 });
        expect(s.sounds.get(3)!.seconds).toBeCloseTo(((1600 / 16) * 28) / 22050, 5);
        expect(s.lines).toEqual([]);
        const none = await loadLevelStory({ read: async () => null }, 'ENGLISH', 'NOPE');
        expect(none.sequences).toEqual([]);
    });
});

describe('creating story content (synthetic)', () => {
    it('newSequence + addActor round trips through writeSequence / parseSequence', async () => {
        const {
            newSequence,
            addActor,
            writeSequence,
            parseSequence,
            newActionBytes,
            insertAction,
            parseActions,
            freeSequenceId,
        } = await import('../src/index.ts');
        expect(freeSequenceId(new Set([3, 9]))).toBe(10);
        const seq = newSequence(10, 2, 'My new scene');
        const cam = addActor(seq, 'Camera', 910);
        const r = addActor(seq, 'Rynn', 908);
        const ins = insertAction(r, newActionBytes(3, 1.5, { sound: 33, params: 3680016 }));
        r.actions = ins.actions;
        r.actionCount = ins.actionCount;
        expect(cam.slot).toBe(1);
        expect(r.slot).toBe(2);
        expect(seq.slots).toBe(3);
        const bytes = writeSequence(seq);
        const back = parseSequence(10, 2, bytes)!;
        expect(back.name).toBe('My new scene');
        expect(back.actors.map((a) => a.name)).toEqual(['Camera', 'Rynn']);
        const acts = parseActions(back.actors[1]!)!;
        expect(acts.map((a) => a.type)).toEqual([3]);
        expect(writeSequence(back)).toEqual(bytes);
    });
});
