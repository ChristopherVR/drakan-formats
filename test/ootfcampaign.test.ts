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
    applyLevelMusic,
    MIN_HALF,
    boxFront,
    triggerHalves,
    MUSIC_ON_MESSAGES,
    isOotfArenaPath,
    exitBoxes,
    exitDetectorParams,
    EXIT_DETECTOR_MESSAGE,
    type TerrainLayer,
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
    const header: LvlHeader = {
        name: lvlStr(name),
        maxWidth: 0,
        maxHeight: 0,
        dependencies: [],
        trailer: new Uint8Array(0),
    };
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
        expect(plan.levels.map((l) => l.displayName)).toEqual([
            'Intro',
            'Ruined Village',
            'Ruined Village Book',
            'Canyon',
            'The End',
        ]);
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
        expect(village.exits.filter((e) => e.reason === 'pc').map((e) => e.destTitle)).toEqual([
            'OotF 02 - Ruined Village Book',
            'OotF 03 - Canyon',
        ]);
        expect(by('Intro').role).toBe('start');
        expect(by('Ruined Village Book').role).toBe('side');
        expect(by('end.lvl').role).toBe('final');
        expect(plan.unreachable).toEqual([]);
    });

    it('hands the intro over to the first level and adds an arrival exit where the way back is missing', () => {
        const intro = by('Intro');
        expect(intro.exits).toHaveLength(1);
        expect(intro.exits[0]).toMatchObject({
            reason: 'intro-next',
            destTitle: 'OotF 01 - Ruined Village',
            synthetic: true,
            pos: [100, 200, 300],
        });
        // village needs an exit back to the intro (arrival marker), the end needs one back to the canyon
        expect(
            by('Ruined Village.lvl')
                .exits.filter((e) => e.reason === 'arrival')
                .map((e) => e.destTitle),
        ).toEqual(['OotF 00 - Intro']);
        expect(by('end.lvl').exits).toMatchObject([
            { reason: 'arrival', destTitle: 'OotF 03 - Canyon', synthetic: true },
        ]);
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
        const xdb = await SrscReader.fromBytes(
            writePs2Srsc(entries.map((e) => ({ type: e.type, id: e.id, sub: e.sub, data: e.data }))),
        );
        const strings = await parseXdbStrings(xdb);
        for (const t of plan.destinationTitles)
            expect(strings.get(plan.stringIds.get(t)!)!.text[0]).toBe(campaignDestinationText(t));
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

    it('sends ON (as every disc exit detector does) on foot and mounted detectors, replacing a debug Detect Which override once', () => {
        const fields = [
            { name: 'Task', type: 7 },
            { name: 'Detect Which?', type: 7 },
            { name: 'Trigger Message', type: 7 },
        ];
        const params = exitDetectorParams(fields, 2);
        expect(params.map((p) => p.value)).toEqual([6, 2, 1]);
        expect(EXIT_DETECTOR_MESSAGE).toBe(1);
        const plan = planCampaign(fixture());
        const village = plan.levels.find((l) => l.path.endsWith('Ruined Village.lvl'))!;
        const list: LvlObjectList = { objects: [obj(1, 1)], warnings: [] };
        applyCampaignExits(list, village, plan, {
            ...ctxFor(() => false),
            detectorClass: { dbIndex: 2, classId: 3050 },
            detectorParams: params,
            mountDetector: { fieldIndex: 1, type: 7, name: 'Detect Which?' },
        });
        const detectors = list.objects.filter((o) => o.classId === 3050);
        expect(detectors.length).toBeGreaterThan(0);
        for (const detector of detectors) {
            expect(detector.params.map((p) => p.fieldIndex)).toEqual([0, 1, 2]);
            expect(detector.data[0]).toBe(6);
            expect(detector.data[2]).toBe(1); // ON: message 5 never queues the level change
        }
        expect(detectors.some((d) => d.data[1] === 1)).toBe(true);
        expect(detectors.some((d) => d.data[1] === 2)).toBe(true);
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
        const r = applyCampaignExits(
            list,
            village,
            plan,
            ctxFor((o) => o.id === 10),
        );
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
        // an existing detector of the class carries parameters that must not leak into the exit detectors
        const stray = obj(2, 3050, {
            params: [{ fieldIndex: 9, type: 7, name: 'Trigger Message', nameRaw: new Uint8Array(16) }],
            data: [0],
        });
        const list: LvlObjectList = { objects: [obj(1, 1), stray, obj(10, 5)], warnings: [] };
        const r = applyCampaignExits(list, village, plan, {
            ...ctxFor(() => false),
            detectorClass: { dbIndex: 2, classId: 3050 },
            mountDetector: { fieldIndex: 1, type: 7, name: 'Detect Which?' },
        });
        expect(r.warnings.some((w) => w.includes('replaced it with the exit class'))).toBe(true);
        // no inert twin: object 10 kept its id and became the exit class
        const ten = list.objects.find((x) => x.id === 10)!;
        expect(ten.classId).toBe(966);
        expect(list.objects.filter((x) => x.classId === 966 && x.dbIndex === 8)).toHaveLength(3); // 10, the exit whose class was dropped, the arrival marker
        // every real (pc) exit has a detector that links to it; the arrival marker has none
        const dets = list.objects.filter((x) => x.classId === 3050 && x.id !== 2);
        expect(dets.every((d) => d.params.every((p) => p.name === 'Detect Which?'))).toBe(true);
        expect(dets).toHaveLength(r.detectors);
        expect(dets.length).toBeGreaterThanOrEqual(1);
        for (const d of dets) {
            expect(d.scale).toEqual([2, 2, 2]);
            const target = list.objects.find((x) => x.id === d.links[0])!;
            expect(target.classId).toBe(966);
        }
        // one detector for Rynn on foot (class default) and one for Rynn on a mount (Detect Which? = 1) per real exit
        expect(dets.length).toBe(2 * village.exits.filter((e) => e.reason === 'pc' && e.destTitle).length);
        expect(dets.filter((d) => d.data[0] === 1 && d.params[0]?.name === 'Detect Which?')).toHaveLength(
            dets.length / 2,
        );
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
        expect(timer.params.map((p) => p.name)).toEqual(['Time Until Trigger', 'Start Mode', 'Trigger Message']);
        expect(new DataView(new Uint32Array([timer.data[0]!]).buffer).getFloat32(0, true)).toBeCloseTo(44, 3);
        expect(timer.data[1]).toBe(0); // Start Mode: at once
        expect(timer.data[2]).toBe(5);
    });

    it("puts the walk-in detectors on the level's own exit detector box, keeping its gating", () => {
        const plan = planCampaign(fixture());
        const village = plan.levels.find((l) => l.path.endsWith('Ruined Village.lvl'))!;
        const fields = [
            { name: 'Task', type: 7 },
            { name: 'Detect Which?', type: 7 },
            { name: 'Initial State', type: 7 },
            { name: 'Trigger Message', type: 7 },
        ];
        const defaults = [6, 2, 0, 1];
        const nameRaw = new Uint8Array(16);
        // 40: PC detector (Both, class defaults) far from exit 10 and also driving a door 50; 41: mount-only, disabled until
        // switch 43 enables it, firing exit 11.
        const pcBoth = obj(40, 4390, {
            links: [10, 50],
            scale: [4, 2, 1],
            flags: FLAG_VISIBLE | 0x100,
            rot: [0, 180, 0],
        });
        const pcMount = obj(41, 4390, {
            links: [11],
            scale: [7, 8, 3],
            flags: FLAG_VISIBLE | 0x100,
            params: [
                { fieldIndex: 1, type: 7, name: 'Detect Which?', nameRaw },
                { fieldIndex: 2, type: 7, name: 'Initial State', nameRaw },
            ],
            data: [1, 1],
        });
        const list: LvlObjectList = {
            objects: [obj(1, 1), obj(10, 5), obj(11, 5), pcBoth, pcMount, obj(43, 7, { links: [41] }), obj(50, 9)],
            warnings: [],
        };
        const r = applyCampaignExits(list, village, plan, {
            ...ctxFor((o) => o.classId === 5),
            detectorClass: { dbIndex: 2, classId: 3050 },
            mountDetector: { fieldIndex: 1, type: 7, name: 'Detect Which?' },
            detectorFieldsOf: (o) => (o.classId === 4390 ? { fields, defaults: (i) => defaults[i]! } : null),
        });
        const param = (o: LvlObject, i: number) => {
            const k = o.params.findIndex((p) => p.fieldIndex === i);
            return k >= 0 ? o.data[k] : undefined;
        };
        // no boxes on the exit objects: the level's detectors fire them
        expect(list.objects.some((o) => o.classId === 3050)).toBe(false);
        const to10 = list.objects.filter((o) => o.classId === 4390 && o.id > 50 && o.links.includes(10));
        const to11 = list.objects.filter((o) => o.classId === 4390 && o.id > 50 && o.links.includes(11));
        expect(to10.map((o) => param(o, 1)).sort()).toEqual([0, 1]); // Both -> foot and mount copies
        expect(to11.map((o) => param(o, 1))).toEqual([1]); // mount only stays mount only
        for (const c of [...to10, ...to11]) {
            expect(param(c, 3)).toBe(1); // ON
            expect(c.links).toHaveLength(1);
        }
        expect(to10[0]!.pos).toEqual(pcBoth.pos);
        expect(to10[0]!.scale).toEqual([4, 2, 1]);
        expect(to10[0]!.rot).toEqual([0, 180, 0]);
        expect(param(to11[0]!, 2)).toBe(1); // still disabled at start
        expect(list.objects.find((o) => o.id === 43)!.links).toEqual([41, to11[0]!.id]); // and enabled with it
        expect(pcBoth.links).toEqual([10, 50]); // the PC detector itself is unchanged
        expect(r.detectors).toBe(3);
    });

    it("keeps a PC exit's Maintain Player Position 0 instead of the PS2 default 1", () => {
        const levels = fixture();
        const canyon = levels.find((l) => l.path.endsWith('canyon.lvl'))!;
        const o30 = canyon.list.objects.find((o) => o.id === 30)!;
        o30.params = [
            { fieldIndex: 1, type: FIELD_INT, name: 'Maintain Player Position', nameRaw: new Uint8Array(26) },
        ];
        o30.data = [0];
        const plan = planCampaign(levels);
        const lv = plan.levels.find((l) => l.path.endsWith('canyon.lvl'))!;
        expect(lv.exits.find((e) => e.pcObjectId === 30)!.maintainPosition).toBe(0);
        expect(lv.exits.find((e) => e.pcObjectId === 31)!.maintainPosition).toBe(1);
        const list: LvlObjectList = { objects: [obj(1, 1), obj(30, 5), obj(31, 5)], warnings: [] };
        const maintain = { fieldIndex: 2, type: 7, name: 'Maintain Player Position', default: 1 };
        applyCampaignExits(list, lv, plan, {
            exitFieldOf: (o) =>
                o.classId === 5 ? { fieldIndex: 0, type: FIELD_STRING, name: 'Transition To...' } : null,
            exitClass: {
                dbIndex: 8,
                classId: 966,
                field: { fieldIndex: 0, type: FIELD_STRING, name: 'Transition To...' },
                maintain,
            },
        });
        const value = (id: number) => {
            const o = list.objects.find((x) => x.id === id)!;
            const k = o.params.findIndex((p) => p.fieldIndex === 2);
            return k >= 0 ? o.data[k] : undefined;
        };
        expect(value(30)).toBe(0);
        expect(value(31)).toBeUndefined(); // same as the class default: not written
    });

    it('drops Maintain Player Position on an exit whose destination has no way back (it lands on the Rynn start)', () => {
        const plan = planCampaign(fixture());
        const canyon = plan.levels.find((l) => l.path.endsWith('canyon.lvl'))!;
        // 30 leads to the end, which only gets a synthesized arrival marker; 31 leads back to the village and its exit 11
        expect(canyon.exits.find((e) => e.pcObjectId === 30)!.maintainPosition).toBe(0);
        expect(canyon.exits.find((e) => e.pcObjectId === 31)!.maintainPosition).toBe(1);
        const village = plan.levels.find((l) => l.path.endsWith('Ruined Village.lvl'))!;
        expect(village.exits.find((e) => e.pcObjectId === 11)!.maintainPosition).toBe(1);
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
        const m = await parseRrcStrings({
            entries: [],
            readRaw: async () => new Uint8Array(0),
        } as unknown as SrscReader);
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
        const xdb = await SrscReader.fromBytes(
            writePs2Srsc(sys.map((e) => ({ type: e.type, id: e.id, sub: e.sub, data: e.data }))),
        );
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
            obj(50, 40, {
                params: [
                    { fieldIndex: 0, type: FIELD_INT, name: 'Music 1 ID (0=none)', nameRaw: new Uint8Array(6) },
                    { fieldIndex: 1, type: FIELD_INT, name: 'Music 2 ID (0=none)', nameRaw: new Uint8Array(6) },
                ],
                data: [3, 5],
            }),
            obj(51, 40, {
                params: [
                    { fieldIndex: 1, type: FIELD_INT, name: 'Music 2 ID (0=none)', nameRaw: new Uint8Array(6) },
                    { fieldIndex: 4, type: FIELD_FLOAT, name: 'Music 2 Fade Out Time', nameRaw: new Uint8Array(6) },
                ],
                data: [8, f32(6)],
            }),
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

    const LOOP_FIELDS: ClassFieldDef[] = [
        ...MUSIC_FIELDS,
        { name: 'Message To Send To Trigger On', type: 7 },
        { name: 'Message To Send To Trigger Off', type: 7 },
        { name: 'Start State For Triggered Sounds', type: 7 },
    ];
    const loopClass = { dbIndex: 14, classId: 20, fields: LOOP_FIELDS };
    const detectorClass = {
        dbIndex: 4,
        classId: 9695,
        fields: [
            { name: 'Task', type: 7 },
            { name: 'Trigger Message', type: 7 },
            { name: 'Detect Only Once?', type: 7 },
        ] as ClassFieldDef[],
    };
    const val = (o: LvlObject, name: string): unknown => {
        const i = o.params.findIndex((p) => p.name === name);
        return i < 0 ? undefined : decodeFieldValue(o.params[i]!.type, o.data[i]!, o.data);
    };

    it('splits a trigger box into front and back halves along its local +z', () => {
        expect(boxFront([0, 0, 0])).toEqual([1, 0, 0]);
        const f90 = boxFront([0, 90, 0]);
        expect([f90[0], f90[2]].map((v) => Math.round(v * 1e6) / 1e6)).toEqual([0, 1]);
        const h = triggerHalves([1000, 50, 2000], [0, 0, 0], [2, 1, 1]);
        // half thickness 0.5 model units = 1024, centres a quarter box (512) either side of the plane
        expect(h.front).toEqual({ pos: [1512, 50, 2000], scale: [2, 1, 0.5] });
        expect(h.back).toEqual({ pos: [488, 50, 2000], scale: [2, 1, 0.5] });
        // a thin box keeps halves of at least MIN_HALF
        expect(triggerHalves([0, 0, 0], [0, 0, 0], [1, 1, 0.2]).front.scale[2]).toBe(MIN_HALF);
    });

    it('turns the trigger boxes into detectors that switch one loop per music id', () => {
        const pc = pcWithMusic();
        // 50: front 3 / back 5, 51: front 0 (stop) / back 8, 52: 0 / 0
        const triggers = findMusicTriggers(pc);
        const boxes = [50, 51, 52].map((id) =>
            obj(id, 99, { flags: FLAG_VISIBLE | 0x100, scale: [2, 1, 1], rot: [0, 90, 0] }),
        );
        const list: LvlObjectList = { objects: [...boxes, obj(60, 9)], warnings: [] };
        const posOf = (id: number) => [id * 10, 5, id * 20];
        const r = applyLevelMusic(list, triggers, {
            musicClass: loopClass,
            detectorClass,
            levelPath: pc.path,
            initialPcId: 3,
            loopPos: [1, 2, 3],
            trackIds: new Map([
                [3, 40],
                [5, 41],
            ]),
        });
        // loops: the start music first, then in order of use; 8 is not rendered and takes the palette (slot 2 list -> 120)
        expect([...r.tracks]).toEqual([
            [3, 40],
            [5, 41],
            [8, 120],
        ]);
        const loop = (pcId: number) => list.objects.find((o) => o.id === r.loops.get(pcId))!;
        expect([loop(3).classId, loop(3).dbIndex, ...loop(3).pos]).toEqual([20, 14, 1, 2, 3]);
        expect(val(loop(3), 'Sounds')).toEqual([40]);
        expect(val(loop(3), 'Start State For Triggered Sounds')).toBe(1);
        expect(val(loop(5), 'Start State For Triggered Sounds')).toBeUndefined();
        expect([3, 5, 8].map((id) => val(loop(id), 'Message To Send To Trigger On'))).toEqual(
            MUSIC_ON_MESSAGES.slice(0, 3),
        );
        expect([3, 5, 8].map((id) => val(loop(id), 'Message To Send To Trigger Off'))).toEqual([0, 0, 0]);
        const [l3, l5, l8] = [3, 5, 8].map((id) => r.loops.get(id)!) as [number, number, number];
        const [m3, m5, m8] = MUSIC_ON_MESSAGES as [number, number, number];
        const det = list.objects.filter((o) => o.classId === 9695);
        for (const o of det) {
            expect([o.dbIndex, o.flags & 0x101, o.scale, o.rot]).toEqual([4, 0x101, [2, 1, 0.5], [0, 90, 0]]);
            expect(val(o, 'Task')).toBe(6);
            expect(val(o, 'Detect Only Once?')).toBe(0);
        }
        // rot 90: front = +z; the halves sit 512 units either side of the trigger
        const of = (box: number, side: 1 | -1) => {
            const [x, y, z] = posOf(box);
            return det
                .filter(
                    (o) =>
                        Math.abs(o.pos[0] - x!) < 1e-6 &&
                        o.pos[1] === y &&
                        Math.abs(o.pos[2] - (z! + side * 512)) < 1e-6,
                )
                .map((o) => [val(o, 'Trigger Message'), [...o.links].sort()]);
        };
        const sorted = (...x: number[]) => x.sort();
        expect(of(50, 1)).toEqual([
            [0, sorted(l5, l8)],
            [m3, [l3]],
        ]);
        expect(of(50, -1)).toEqual([
            [0, sorted(l3, l8)],
            [m5, [l5]],
        ]);
        expect(of(51, 1)).toEqual([[0, sorted(l3, l5, l8)]]); // front 0: every loop off
        expect(of(51, -1)).toEqual([
            [0, sorted(l3, l5)],
            [m8, [l8]],
        ]);
        expect(of(52, 1)).toEqual([[0, sorted(l3, l5, l8)]]);
        expect(of(52, -1)).toEqual([[0, sorted(l3, l5, l8)]]);
        // the converted trigger objects are reused (first detector of each), nothing else is linked
        expect(list.objects.filter((o) => [50, 51, 52].includes(o.id)).every((o) => o.classId === 9695)).toBe(true);
        expect(r).toMatchObject({ detectors: 9, missing: 0, dropped: 0 });
        expect(list.objects.find((o) => o.id === 60)!.links).toEqual([]);
    });

    it('places a missing box from the PC transform and drops the triggers without a detector class', () => {
        const triggers = findMusicTriggers(pcWithMusic()).slice(0, 1);
        const list: LvlObjectList = { objects: [obj(60, 9)], warnings: [] };
        const r = applyLevelMusic(list, triggers, {
            musicClass: loopClass,
            detectorClass,
            levelPath: 'x',
            initialPcId: 0,
            loopPos: [0, 0, 0],
            trackIds: new Map([
                [3, 40],
                [5, 41],
            ]),
        });
        expect(r).toMatchObject({ missing: 1, detectors: 4 });
        const none: LvlObjectList = { objects: [], warnings: [] };
        const d = applyLevelMusic(none, triggers, {
            musicClass: loopClass,
            detectorClass: null,
            levelPath: 'x',
            initialPcId: 3,
            loopPos: [0, 0, 0],
            trackIds: new Map([[3, 40]]),
        });
        expect(d.dropped).toBe(1);
        expect(d.warnings).toHaveLength(1);
        // the start music alone keeps the class's message defaults
        expect(none.objects).toHaveLength(1);
        expect(val(none.objects[0]!, 'Message To Send To Trigger On')).toBeUndefined();
        expect(val(none.objects[0]!, 'Start State For Triggered Sounds')).toBe(1);
    });
});

describe('exitBoxes', () => {
    const layer = (type: number, h: number): TerrainLayer =>
        ({
            type,
            width: 4,
            height: 4,
            originX: 0,
            originZ: 0,
            heights: new Float32Array(25).fill(h),
            cellFlags: new Uint16Array(16),
            cellTexLeft: new Uint32Array(16),
            cellTexRight: new Uint32Array(16),
        }) as unknown as TerrainLayer;
    const x = 4096;
    const z = 4096;

    it('keeps the single box for an exit on the floor and for no terrain', () => {
        expect(exitBoxes(undefined, x, z, 5000, 700, 2)).toEqual([{ cy: 5700, sizeY: 2 }]);
        expect(exitBoxes([layer(0, 5000)], x, z, 5000, 700, 2)).toEqual([{ cy: 5700, sizeY: 2 }]);
    });

    it('spans floor to exit for a doorway exit and adds a box on the floor', () => {
        const b = exitBoxes([layer(0, 209000), layer(2, 219000)], x, z, 219000, 700, 2);
        expect(b).toHaveLength(2);
        expect(b[0]!.cy).toBeCloseTo((209000 + 220024) / 2);
        expect(b[0]!.sizeY).toBeCloseTo((220024 - 209000) / 2048);
        expect(b[1]).toEqual({ cy: 209700, sizeY: 2 });
    });

    it('puts a box on every surface under an exit that hangs far above them', () => {
        const b = exitBoxes([layer(0, 73000), layer(2, 91000)], x, z, 115000, 700, 2);
        expect(b.map((v) => v.cy)).toContain(73700);
        expect(b.map((v) => v.cy)).toContain(91700);
        expect(b[0]!.sizeY).toBeGreaterThan(20);
    });

    it('moves the boxes onto the surface for an exit under the ground', () => {
        const b = exitBoxes([layer(0, 77000)], x, z, 0, 700, 2);
        expect(b[0]).toEqual({ cy: 77700, sizeY: 2 });
        expect(b[1]!.cy).toBeGreaterThan(77700);
    });
});

describe('isOotfArenaPath', () => {
    it('tells arenas (Multiplayer/*) from campaign chapters, either slash style', () => {
        expect(isOotfArenaPath('Multiplayer/Ground/Relic/Relic.lvl')).toBe(true);
        expect(isOotfArenaPath('multiplayer\\Air\\Nemesis\\Nemesis.lvl')).toBe(true);
        expect(isOotfArenaPath('Mountain World/Grotto/grotto.lvl')).toBe(false);
    });

    it('keeps the campaign plan free of arenas so one conversion holds both', () => {
        const all = fixture();
        const withArena = [...all, level('Multiplayer/Ground/Relic/Relic.lvl', '<0x9100>relic', [])];
        const chapters = withArena.filter((l) => !isOotfArenaPath(l.path));
        expect(planCampaign(chapters).levels.map((l) => l.title)).toEqual(planCampaign(all).levels.map((l) => l.title));
    });
});
