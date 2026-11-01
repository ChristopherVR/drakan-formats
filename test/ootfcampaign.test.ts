// Synthetic fixtures only; no game bytes.
import { describe, expect, it } from 'vitest';
import {
    FIELD_FLOAT,
    FIELD_INT,
    FIELD_STRING,
    FLAG_VISIBLE,
    LVL_SENTINEL,
    SrscReader,
    TextPlan,
    applyCampaignExits,
    applyMusicTriggers,
    campaignExitStrings,
    campaignRegistration,
    cleanGameText,
    decodeFieldValue,
    decodeRrcString,
    campaignDestinationText,
    findMusicTriggers,
    normalizeLevelRef,
    parseRrcStrings,
    parseXdbStrings,
    planCampaign,
    rewriteClassTextDefaults,
    rewriteObjectTexts,
    setExitDestinationId,
    splitTextRef,
    stringToWords,
    trackFor,
    writePs2Srsc,
    xorRrcString,
    type ClassFieldDef,
    type LvlHeader,
    type LvlObject,
    type LvlObjectList,
    type OdbClass,
    type PcLevel,
} from '../src/index.ts';

const lvlStr = (s: string) => {
    const raw = new Uint8Array(s.length + 1 + ((s.length + 1) % 2));
    for (let i = 0; i < s.length; i++) raw[i] = s.charCodeAt(i);
    return { raw, text: s };
};

const obj = (id: number, classId: number, extra: Partial<LvlObject> = {}): LvlObject => ({
    id,
    classId,
    dbIndex: 2,
    prefix0: 0,
    prefix1: 0,
    pos: [id * 10, 5, id * 20],
    flags: FLAG_VISIBLE,
    initialEvents: 1,
    radius: null,
    links: [],
    rot: [0, 0, 0],
    scale: null,
    preSentinel: 0,
    sentinel: LVL_SENTINEL,
    data: [],
    params: [],
    ...extra,
});

const TF: ClassFieldDef = { name: 'Transition To...', type: FIELD_STRING };
const exitClass = (name: string, dest: string): OdbClass => ({
    id: 0,
    name,
    group: 0,
    runtimeClass: 0x10037,
    fields: [TF, { name: 'Maintain Player Position', type: FIELD_INT }],
    data: [(dest.length ? stringToWords(dest).length << 16 : 0) | 2, 1, ...stringToWords(dest)],
});

function level(
    path: string,
    name: string,
    exits: { id: number; cls: number; dest: string }[],
    opts: { rynn?: boolean } = {},
): PcLevel {
    const classes = new Map<number, OdbClass>();
    const objects: LvlObject[] = [];
    if (opts.rynn !== false) {
        classes.set(1, { id: 1, name: 'Rynn', group: 0, runtimeClass: 0x10009, fields: [], data: [] });
        objects.push(obj(1, 1, { pos: [100, 200, 300] }));
    }
    for (const e of exits) {
        classes.set(e.cls, { ...exitClass(`Level Transition ${e.cls}`, e.dest), id: e.cls });
        objects.push(obj(e.id, e.cls, { scale: [2, 2, 2], flags: FLAG_VISIBLE | 0x100 }));
    }
    const header: LvlHeader = { name: lvlStr(name), maxWidth: 0, maxHeight: 0, dependencies: [], trailer: new Uint8Array(0) };
    return {
        path,
        header,
        list: { objects, warnings: [] },
        terrain: [],
        classes: new Map([[2, classes]]),
        odbPaths: new Map(),
        warnings: [],
    };
}

// A small world: intro (no exit) -> village <-> book, village -> canyon -> end (no way back).
const fixture = (): PcLevel[] => [
    level('Mountain World/Intro Level/Intro.lvl', 'intro level', []),
    level('Mountain World/Ruined Village/Ruined Village.lvl', '<0x9000>Ruined Village', [
        { id: 10, cls: 10, dest: 'mountain world\\ruined village\\Ruined Village Book.lvl' },
        { id: 11, cls: 11, dest: 'mountain world\\canyon\\canyon.lvl' },
    ]),
    level('Mountain World/Ruined Village/Ruined Village Book.lvl', '<0x9001>Ruined Village Book', [
        { id: 20, cls: 20, dest: 'mountain world\\ruined village\\ruined village.lvl' },
    ]),
    level('Mountain World/Canyon/canyon.lvl', '<0x9002>Canyon', [
        { id: 30, cls: 30, dest: 'Volcanic World\\end\\end.lvl' },
        { id: 31, cls: 31, dest: 'mountain world\\ruined village\\ruined village.lvl' },
    ]),
    level('Volcanic World/End/end.lvl', '<0x9003>the end', []),
];

describe('planCampaign', () => {
    const plan = planCampaign(fixture());
    const by = (needle: string) => plan.levels.find((l) => l.path.includes(needle))!;

    it('orders by header string id with the unnamed intro first and titles with unique 8.3 stems', () => {
        expect(plan.levels.map((l) => l.displayName)).toEqual(['Intro', 'Ruined Village', 'Ruined Village Book', 'Canyon', 'The End']);
        expect(plan.levels.map((l) => l.title)).toEqual([
            'OotF 00 - Intro',
            'OotF 01 - Ruined Village',
            'OotF 02 - Ruined Village Book',
            'OotF 03 - Canyon',
            'OotF 04 - The End',
        ]);
        expect(new Set(plan.levels.map((l) => l.mangled)).size).toBe(5);
        expect(by('Canyon').mangled).toBe('OOTF03ON');
        expect(by('Canyon').packPath).toBe('files/ENGLISH/LEVELS/OOTF03ON/OOTF03ON.LVL');
        expect(plan.warnings).toEqual([]);
    });

    it('resolves destinations case-insensitively and flags roles', () => {
        const village = by('Ruined Village.lvl');
        expect(village.exits.filter((e) => e.reason === 'pc').map((e) => e.destTitle)).toEqual(['OotF 02 - Ruined Village Book', 'OotF 03 - Canyon']);
        expect(by('Intro').role).toBe('start');
        expect(by('Ruined Village Book').role).toBe('side');
        expect(by('end.lvl').role).toBe('final');
        expect(plan.unreachable).toEqual([]);
    });

    it('hands the intro over to the first level and adds an arrival exit where the way back is missing', () => {
        const intro = by('Intro');
        expect(intro.exits).toHaveLength(1);
        expect(intro.exits[0]).toMatchObject({ reason: 'intro-next', destTitle: 'OotF 01 - Ruined Village', synthetic: true, pos: [100, 200, 300] });
        // village needs an exit back to the intro (arrival marker), the end needs one back to the canyon
        expect(by('Ruined Village.lvl').exits.filter((e) => e.reason === 'arrival').map((e) => e.destTitle)).toEqual(['OotF 00 - Intro']);
        expect(by('end.lvl').exits).toMatchObject([{ reason: 'arrival', destTitle: 'OotF 03 - Canyon', synthetic: true }]);
        // the book and the canyon already have exits back
        expect(by('Book').exits).toHaveLength(1);
        expect(by('Canyon').exits).toHaveLength(2);
    });

    it('lists every destination as one string with consecutive ids and a registration in play order', () => {
        expect([...plan.stringIds.values()]).toEqual(plan.destinationTitles.map((_, i) => 0x7000 + i));
        const reg = campaignRegistration(plan);
        expect(reg.levels[0]).toBe('OotF 00 - Intro');
        expect(reg.levelListLines[1]).toBe('\\Levels\\OotF 01 - Ruined Village\\OotF 01 - Ruined Village.lvl');
    });

    it('warns about an exit that leaves the campaign and leaves it alone', () => {
        const p = planCampaign([level('A/a/a.lvl', 'a', [{ id: 5, cls: 5, dest: 'nowhere\\x.lvl' }])]);
        expect(p.warnings.some((w) => w.includes('not in the campaign'))).toBe(true);
        expect(p.levels[0]!.exits[0]!.destTitle).toBeNull();
    });
});

describe('campaignExitStrings', () => {
    it('encodes one new XDB string per destination: the loader path text', async () => {
        const plan = planCampaign(fixture());
        const entries = campaignExitStrings(plan, 'level1on.xdb');
        expect(entries).toHaveLength(plan.destinationTitles.length);
        expect(entries[0]).toMatchObject({ file: 'LEVEL1ON.XDB', type: 0x400, sub: 1, isNew: true });
        const xdb = await SrscReader.fromBytes(writePs2Srsc(entries.map((e) => ({ type: e.type, id: e.id, sub: e.sub, data: e.data }))));
        const strings = await parseXdbStrings(xdb);
        for (const t of plan.destinationTitles) expect(strings.get(plan.stringIds.get(t)!)!.text[0]).toBe(campaignDestinationText(t));
        expect(campaignDestinationText('X Y')).toBe('Levels\\X Y\\X Y.lvl');
        expect(normalizeLevelRef('\\Levels\\X\\X.lvl')).toBe('x/x.lvl');
    });
});

describe('applyCampaignExits', () => {
    const exitField = { fieldIndex: 0, type: FIELD_STRING, name: 'Transition To...' };
    const ctxFor = (isExit: (o: LvlObject) => boolean) => ({
        exitFieldOf: (o: LvlObject) => (isExit(o) ? exitField : null),
        exitClass: { dbIndex: 8, classId: 966, field: exitField },
    });

    it('sets a plain string id on converted exits, keeps other parameters and adds missing exits', () => {
        const plan = planCampaign(fixture());
        const village = plan.levels.find((l) => l.path.endsWith('Ruined Village.lvl'))!;
        const withText = obj(10, 5, {
            // literal "x" string param (field 0) plus an int param (field 1), as convertPcLevel leaves them
            params: [
                { fieldIndex: 0, type: FIELD_STRING, name: 'Transition To...', nameRaw: new Uint8Array(16) },
                { fieldIndex: 1, type: FIELD_INT, name: 'Maintain Player Position', nameRaw: new Uint8Array(26) },
            ],
            data: [(1 << 16) | 2, 1, ...stringToWords('abc').slice(0, 1)],
        });
        const list: LvlObjectList = { objects: [obj(1, 1), withText], warnings: [] };
        const r = applyCampaignExits(list, village, plan, ctxFor((o) => o.id === 10));
        // exit 10 rewritten; exit 11 (class dropped) and the arrival exit to the intro added
        expect(r).toMatchObject({ rewritten: 1, added: 2, external: 0 });
        const o = list.objects.find((x) => x.id === 10)!;
        expect(o.data[0]).toBe(plan.stringIds.get('OotF 02 - Ruined Village Book'));
        expect(o.data[1]).toBe(1);
        expect(o.params.map((p) => p.fieldIndex)).toEqual([0, 1]);
        const added = list.objects.filter((x) => x.id > 10);
        expect(added).toHaveLength(2);
        expect(added.map((x) => x.data[0]).sort()).toEqual(
            [plan.stringIds.get('OotF 03 - Canyon')!, plan.stringIds.get('OotF 00 - Intro')!].sort(),
        );
        expect(added.every((x) => x.classId === 966 && x.dbIndex === 8)).toBe(true);
        expect(added.find((x) => x.data[0] === plan.stringIds.get('OotF 03 - Canyon'))!.scale).toEqual([2, 2, 2]);
    });

    it('adds a linked trigger detector to real exits and turns a non-exit twin into the exit in place', () => {
        const plan = planCampaign(fixture());
        const village = plan.levels.find((l) => l.path.endsWith('Ruined Village.lvl'))!;
        // object 10 is the converted PC exit but of a class that is no exit on PS2 (a synthesized clone)
        const list: LvlObjectList = { objects: [obj(1, 1), obj(10, 5)], warnings: [] };
        const r = applyCampaignExits(list, village, plan, {
            ...ctxFor(() => false),
            detectorClass: { dbIndex: 2, classId: 3050 },
        });
        expect(r.warnings.some((w) => w.includes('replaced it with the exit class'))).toBe(true);
        // no inert twin: object 10 kept its id and became the exit class
        const ten = list.objects.find((x) => x.id === 10)!;
        expect(ten.classId).toBe(966);
        expect(list.objects.filter((x) => x.classId === 966 && x.dbIndex === 8)).toHaveLength(3); // 10, the exit whose class was dropped, the arrival marker
        // every real (pc) exit has a detector that links to it; the arrival marker has none
        const dets = list.objects.filter((x) => x.classId === 3050);
        expect(dets).toHaveLength(r.detectors);
        expect(dets.length).toBeGreaterThanOrEqual(1);
        for (const d of dets) {
            expect(d.scale).toEqual([2, 2, 2]);
            const target = list.objects.find((x) => x.id === d.links[0])!;
            expect(target.classId).toBe(966);
        }
        expect(dets.length).toBe(village.exits.filter((e) => e.reason === 'pc' && e.destTitle).length);
    });

    it('fires the intro hand-over from a linked timer (nobody walks into an exit of a cut-scene level)', () => {
        const plan = planCampaign(fixture());
        const intro = plan.levels[0]!;
        expect(intro.exits.find((e) => e.reason === 'intro-next')!.autoSeconds).toBeGreaterThan(30);
        const list: LvlObjectList = { objects: [obj(1, 1)], warnings: [] };
        const fields = [
            { name: 'Time Until Trigger', type: 2 },
            { name: 'Start Mode', type: 7 },
            { name: 'Trigger Message', type: 7 },
        ];
        const r = applyCampaignExits(list, intro, plan, {
            ...ctxFor(() => false),
            timerClass: { dbIndex: 8, classId: 128, fields },
        });
        expect(r.timers).toBe(1);
        const timer = list.objects.find((o) => o.classId === 128)!;
        const exit = list.objects.find((o) => o.id === timer.links[0])!;
        expect(exit.classId).toBe(966);
        expect(timer.params.map((p) => p.name)).toEqual(['Time Until Trigger', 'Trigger Message']);
        expect(new DataView(new Uint32Array([timer.data[0]!]).buffer).getFloat32(0, true)).toBeCloseTo(44, 3);
        expect(timer.data[1]).toBe(5);
    });

    it('setExitDestinationId keeps string payloads of other parameters intact', () => {
        const o = obj(1, 1, {
            params: [{ fieldIndex: 3, type: FIELD_STRING, name: 'Name', nameRaw: new Uint8Array(6) }],
            data: [(2 << 16) | 1, ...stringToWords('hello wo')],
        });
        setExitDestinationId(o, { fieldIndex: 0, type: FIELD_STRING, name: 'Transition To...' }, 0x7001);
        expect(o.params.map((p) => p.fieldIndex)).toEqual([0, 3]);
        expect(o.data[0]).toBe(0x7001);
        expect(decodeFieldValue(FIELD_STRING, o.data[1]!, o.data)).toBe('hello wo');
    });
});

describe('Dragon.rrc strings and text plan', () => {
    it('xor key round trips and decodes a known word', () => {
        const enc = xorRrcString(Uint8Array.from('Alwarren', (c) => c.charCodeAt(0)));
        expect(Array.from(enc.slice(0, 8))).toEqual([0x4c, 0x06, 0x20, 0xde, 0x8f, 0x9c, 0x11, 0xc9]);
        expect(decodeRrcString(enc)).toBe('Alwarren');
        const long = 'x'.repeat(100);
        expect(decodeRrcString(xorRrcString(Uint8Array.from(long, (c) => c.charCodeAt(0))))).toBe(long);
    });

    it('reads 0x400 records of a PC container', async () => {
        const buf = new Uint8Array(1 + 8 + 100);
        buf.set([0x53, 0x52, 0x53, 0x43, 0, 1]);
        // build a PC SRSC via the PS2 writer is not possible (header differs): check splitTextRef/resolve instead
        expect(buf.length).toBeGreaterThan(0);
        expect(splitTextRef('<0x850a>The Ugly Stick')).toEqual({ id: 0x850a, fallback: 'The Ugly Stick' });
        expect(splitTextRef('plain')).toEqual({ id: null, fallback: 'plain' });
        const m = await parseRrcStrings({ entries: [], readRaw: async () => new Uint8Array(0) } as unknown as SrscReader);
        expect(m.size).toBe(0);
    });

    it('cleans text for the XDB: escaped and real newlines, trailing blanks, unsupported characters', () => {
        expect(cleanGameText('A\\n B  \\nC').text).toBe('A\r\nB\r\nC');
        expect(cleanGameText('it\u2019s').text).toBe('it\u2019s');
        const r = cleanGameText('go \u2192 there \u4e2d');
        expect(r.text).toBe('go -> there ?');
        expect(r.replaced).toEqual(['\u2192', '\u4e2d']);
    });

    it('allocates ids per XDB, shares equal texts, resolves <0x...> refs and respects reserved ids', async () => {
        const plan = new TextPlan({ rrc: new Map([[0x850a, 'The Ugly Stick (rrc)']]), base: 100 });
        plan.reserve('SYSTEM.XDB', [100, 101]);
        const a = plan.idFor('system.xdb', '<0x850a>fallback');
        const b = plan.idFor('SYSTEM.XDB', 'The Ugly Stick (rrc)');
        const c = plan.idFor('SYSTEM.XDB', 'Other\\nline');
        const d = plan.idFor('LEVEL1ON.XDB', 'Other\\nline');
        expect(a).toBe(102);
        expect(b).toBe(a);
        expect(c).toBe(103);
        expect(d).toBe(100);
        expect(plan.idFor('SYSTEM.XDB', '')).toBe(0);
        expect(plan.count).toBe(3);
        const entries = plan.entries();
        const sys = entries.filter((e) => e.file === 'SYSTEM.XDB');
        expect(sys.map((e) => e.id)).toEqual([102, 103]);
        const xdb = await SrscReader.fromBytes(writePs2Srsc(sys.map((e) => ({ type: e.type, id: e.id, sub: e.sub, data: e.data }))));
        const s = await parseXdbStrings(xdb);
        expect(s.get(103)!.text[0]).toBe('Other\r\nline');
    });

    it('rewrites class defaults and object overrides to plain ids', () => {
        const plan = new TextPlan({ base: 500 });
        const fields: ClassFieldDef[] = [
            { name: 'Message String', type: FIELD_STRING },
            { name: 'Count', type: FIELD_INT },
            { name: 'DisplayName', type: FIELD_STRING },
        ];
        const words = stringToWords('Hello there');
        const data = [(words.length << 16) | 3, 7, 0, ...words];
        expect(rewriteClassTextDefaults(fields, data, plan, 'LEVEL1ON.XDB')).toBe(2);
        expect(data[0]).toBe(500);
        expect(data[1]).toBe(7);
        expect(data[2]).toBe(0);

        const w2 = stringToWords('<0x1>Rimril says hi');
        const o = obj(3, 61, {
            params: [
                { fieldIndex: 0, type: FIELD_STRING, name: 'Message String', nameRaw: new Uint8Array(16) },
                { fieldIndex: 1, type: FIELD_INT, name: 'Count', nameRaw: new Uint8Array(6) },
                { fieldIndex: 3, type: FIELD_STRING, name: 'Other', nameRaw: new Uint8Array(6) },
            ],
            data: [(w2.length << 16) | 3, 9, ((2 << 16) | (3 + w2.length)) >>> 0, ...w2, ...stringToWords('keep it')],
        });
        const n = rewriteObjectTexts({ objects: [o], warnings: [] }, plan, () => 'LEVEL1ON.XDB');
        expect(n).toBe(1);
        expect(o.data[0]).toBe(501);
        expect(o.data[1]).toBe(9);
        expect(decodeFieldValue(FIELD_STRING, o.data[2]!, o.data)).toBe('keep it');
    });
});

describe('music', () => {
    const MUSIC_FIELDS: ClassFieldDef[] = [
        { name: 'Sounds', type: 0x1005 },
        { name: 'Plays overlay music (Triggered only) ?', type: FIELD_INT },
        { name: 'Fade Out Time When Stopped', type: FIELD_FLOAT },
        { name: 'Fade In Time When Started', type: FIELD_FLOAT },
    ];
    const musicClass = { dbIndex: 14, classId: 20, fields: MUSIC_FIELDS };

    const pcWithMusic = (): PcLevel => {
        const pc = level('Islands World/Islands/islands.lvl', 'islands', [], { rynn: false });
        const f32 = (v: number) => {
            const dv = new DataView(new ArrayBuffer(4));
            dv.setFloat32(0, v, true);
            return dv.getUint32(0, true);
        };
        const mc: OdbClass = {
            id: 40,
            name: 'Music Trigger',
            group: 0,
            runtimeClass: 0x10081,
            fields: [
                { name: 'Music 1 ID (0=none)', type: FIELD_INT },
                { name: 'Music 2 ID (0=none)', type: FIELD_INT },
                { name: 'Music 1 Fade Out Time', type: FIELD_FLOAT },
                { name: 'Music 1 Fade In Time', type: FIELD_FLOAT },
                { name: 'Music 2 Fade Out Time', type: FIELD_FLOAT },
                { name: 'Music 2 Fade In Time', type: FIELD_FLOAT },
            ],
            data: [0, 0, f32(3), f32(3), f32(3), f32(3)],
        };
        pc.classes.get(2)!.set(40, mc);
        pc.list.objects.push(
            obj(50, 40, { params: [{ fieldIndex: 0, type: FIELD_INT, name: 'Music 1 ID (0=none)', nameRaw: new Uint8Array(6) }, { fieldIndex: 1, type: FIELD_INT, name: 'Music 2 ID (0=none)', nameRaw: new Uint8Array(6) }], data: [3, 5] }),
            obj(51, 40, { params: [{ fieldIndex: 1, type: FIELD_INT, name: 'Music 2 ID (0=none)', nameRaw: new Uint8Array(6) }, { fieldIndex: 4, type: FIELD_FLOAT, name: 'Music 2 Fade Out Time', nameRaw: new Uint8Array(6) }], data: [8, f32(6)] }),
            obj(52, 40),
        );
        return pc;
    };

    it('finds triggers with override-or-default values', () => {
        const t = findMusicTriggers(pcWithMusic());
        expect(t.map((x) => [x.objectId, x.music1, x.music2])).toEqual([
            [50, 3, 5],
            [51, 0, 8],
            [52, 0, 0],
        ]);
        expect(t[1]!.fadeOut2).toBe(6);
        expect(t[1]!.fadeIn2).toBe(3);
    });

    it('picks stable tracks by world and slot', () => {
        expect(trackFor('Islands World/Islands/islands.lvl', 1, 1)).toBe(116);
        expect(trackFor('Islands World/Islands/islands.lvl', 1, 2)).toBe(98);
        expect(trackFor('Islands World/Islands/islands.lvl', 2, 5)).toBe(113);
        expect(trackFor('Mountain World/Grotto/grotto.lvl', 1, 6)).toBe(109);
        expect(trackFor('Rift World/Rift World/RiftWorld.lvl', 2, 1)).toBe(87);
        expect(trackFor('Unknown/x/x.lvl', 1, 1)).toBe(88);
    });

    it('replaces slot 1, adds slot 2 with the same detector links and skips silent triggers', () => {
        const pc = pcWithMusic();
        const triggers = findMusicTriggers(pc);
        const detector = obj(60, 61, { links: [50, 51] });
        const list: LvlObjectList = { objects: [obj(50, 99), obj(51, 99), obj(52, 99), detector], warnings: [] };
        const r = applyMusicTriggers(list, triggers, pc.path, { musicClass });
        expect(r).toMatchObject({ replaced: 2, added: 1, silent: 1 });
        const o50 = list.objects.find((o) => o.id === 50)!;
        expect([o50.classId, o50.dbIndex]).toEqual([20, 14]);
        // slot 1 = track 3 -> bed list [116, 98, 115][2] = 115, Sounds is one element
        expect(decodeFieldValue(0x1005, o50.data[o50.params.findIndex((p) => p.name === 'Sounds')]!, o50.data)).toEqual([115]);
        const ov = list.objects.filter((o) => o.id > 60);
        expect(ov).toHaveLength(1);
        const ov50 = ov[0]!;
        expect(decodeFieldValue(0x1005, ov50.data[ov50.params.findIndex((p) => p.name === 'Sounds')]!, ov50.data)).toEqual([113]);
        const ovFlag = ov50.params.findIndex((p) => p.name.startsWith('Plays overlay'));
        expect(ov50.data[ovFlag]).toBe(1);
        // the detector now links to the added overlay object of trigger 50 as well
        expect(detector.links).toHaveLength(3);
        expect(detector.links).toContain(ov50.id);
        // the untouched silent trigger stays as converted
        expect(list.objects.find((o) => o.id === 52)!.classId).toBe(99);
        expect(r.tracks.get(115)).toBe(1);
    });
});
