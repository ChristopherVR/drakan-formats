// Synthetic fixtures only (no game bytes): a localized (German) Order of the Flame install, issue #3.
import { describe, expect, it } from 'vitest';
import {
    BOOK_SCENE_SECONDS,
    CAMPAIGN_TITLE_MAX,
    FIELD_INT,
    FIELD_STRING,
    FLAG_VISIBLE,
    LVL_SENTINEL,
    OotfSourceError,
    RRC_STRING_TYPE,
    TextPlan,
    asciiLevelTitle,
    assertOotfSource,
    campaignExitStrings,
    checkOotfSource,
    cleanGameText,
    decodeXdbSlots,
    detectOotfLanguage,
    encodeXdbString,
    isOotfAirArenaLevel,
    introTemplateWarning,
    isOotfArenaLevel,
    levelNameProblem,
    ootfLevelKey,
    paletteFor,
    parseRrcStrings,
    pickRrcPath,
    planCampaign,
    rawToCp1252,
    stringToWords,
    xorRrcString,
    transitionFieldIndex,
    type LvlObject,
    type OdbClass,
    type PcLevel,
    type SrscReader,
} from '../src/index.ts';

/** A string the PC readers would return for these Windows-1252 bytes (one code unit per byte). */
const raw = (bytes: number[]): string => String.fromCharCode(...bytes);
/** Windows-1252 bytes of Latin-1 text (ü = 0xfc). */
const cp = (s: string): number[] => [...s].map((c) => c.charCodeAt(0));

const obj = (id: number, classId: number, dbIndex = 2): LvlObject => ({
    id,
    classId,
    dbIndex,
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
});

const exitClass = (id: number, dest: string, field = 'Transition To...'): OdbClass => ({
    id,
    name: `Levelübergang ${id}`,
    group: 0,
    runtimeClass: 0x10037,
    rflClass: 55,
    fields: [
        { name: field, type: FIELD_STRING },
        { name: 'Maintain Player Position', type: FIELD_INT },
    ],
    data: [(stringToWords(dest).length << 16) | 2, 1, ...stringToWords(dest)],
});

/** A PC level as `loadPcLevel` returns it: Rynn (or a renamed player class) plus one exit per destination. */
function level(
    path: string,
    name: string,
    dests: string[],
    o: { player?: string; exitField?: string; missingDep?: boolean } = {},
): PcLevel {
    const classes = new Map<number, OdbClass>();
    const objects: LvlObject[] = [];
    classes.set(1, {
        id: 1,
        name: o.player ?? 'Rynn',
        group: 0,
        runtimeClass: 0x10009,
        rflClass: 9,
        fields: [],
        data: [],
    });
    objects.push(obj(1, 1));
    dests.forEach((d, i) => {
        classes.set(10 + i, exitClass(10 + i, d, o.exitField));
        objects.push(obj(10 + i, 10 + i));
    });
    if (o.missingDep) objects.push(obj(99, 1, 3));
    const bytes = [...name].map((c) => c.charCodeAt(0));
    return {
        path,
        header: {
            name: { raw: Uint8Array.from([...bytes, 0]), text: name },
            maxWidth: 0,
            maxHeight: 0,
            dependencies: [
                { dbIndex: 2, path: { raw: new Uint8Array(1), text: 'Eigene' } },
                ...(o.missingDep
                    ? [{ dbIndex: 3, path: { raw: new Uint8Array(1), text: '..\\..\\Common\\NPC\\NPCs' } }]
                    : []),
            ],
            trailer: new Uint8Array(0),
        } as unknown as PcLevel['header'],
        list: { objects, warnings: [] },
        terrain: [],
        classes: new Map([[2, classes]]),
        odbPaths: new Map([[2, `${path.slice(0, path.lastIndexOf('/'))}/Eigene.odb`]]),
        warnings: [],
    };
}

const GERMAN_RRC = [
    'Du hast die Fackel nicht.',
    'Der Schlüssel ist in der Höhle und nicht bei dem Turm.',
    'Sie kämpft mit einem Schwert und eine Axt für das Dorf.',
    raw([0x84, ...cp('Ruinendorf'), 0x93, ...cp(' ist ein Ort, den ich auf der Karte sehe.')]),
];
const ENGLISH_RRC = [
    'You have found the key to the gate.',
    'The dragon is not with you and your friends.',
    'This is the way to the mines, and this is the way from the village.',
];

describe('detectOotfLanguage', () => {
    it('tells a German install from an English one by its Dragon.rrc strings', () => {
        expect(detectOotfLanguage(GERMAN_RRC).language).toBe('german');
        expect(detectOotfLanguage(ENGLISH_RRC).language).toBe('english');
    });
    it('says unknown instead of guessing on too little text', () => {
        const g = detectOotfLanguage(['Rynn', 'Arokh']);
        expect(g.language).toBe('unknown');
        expect(g.evidence).toMatch(/no clear language/);
    });
});

describe('Windows-1252 text of a localized install', () => {
    it('keeps German quotes and umlauts read as raw bytes (they used to become ?)', () => {
        const s = raw([0x84, ...cp('Zurück'), 0x93, 0x20, 0x96, 0x20, ...cp('Grüße')]);
        expect(rawToCp1252(s)).toBe('„Zurück“ – Grüße');
        const c = cleanGameText(s);
        expect(c.replaced).toEqual([]);
        expect(c.text).toBe('„Zurück“ – Grüße');
        // The XDB entry holds the original bytes.
        const bytes = encodeXdbString({ id: 1, sub: 1, text: [c.text] });
        expect([...bytes.subarray(2, 2 + 5)]).toEqual([0x84, ...cp('Zurü')]);
        expect(decodeXdbSlots(bytes)[0]).toBe('„Zurück“ – Grüße');
    });
    it('leaves ASCII and already-decoded text alone', () => {
        expect(rawToCp1252('Ruined Village')).toBe('Ruined Village');
        expect(rawToCp1252('„schon“')).toBe('„schon“');
    });
    it('gives a German Dragon.rrc text with quotes one XDB id and no replacement warning', () => {
        const plan = new TextPlan({ rrc: new Map([[0x10, GERMAN_RRC[3]!]]) });
        expect(plan.idFor('LEVEL1ON.XDB', '<0x10>fallback')).toBe(0x6000);
        expect(plan.warnings).toEqual([]);
    });
});

describe('level titles the runtime accepts', () => {
    it('transliterates umlauts and accents and drops path characters', () => {
        expect(asciiLevelTitle('Grimstone-Höhlen')).toBe('Grimstone-Hoehlen');
        expect(asciiLevelTitle('Straße der Überlebenden')).toBe('Strasse der Ueberlebenden');
        expect(asciiLevelTitle('Château: Île')).toBe('Chateau Ile');
        expect(asciiLevelTitle(raw([0x84, ...cp('Buch'), 0x93]))).toBe('Buch');
        expect(asciiLevelTitle('Hill of Fire (ground)')).toBe('Hill of Fire (ground)');
    });
    it('names the reason the runtime would skip a level', () => {
        expect(levelNameProblem('OotF 01 - Ruined Village')).toBeNull();
        expect(levelNameProblem('OotF 01 - Höhle')).toMatch(/not plain ASCII/);
        expect(levelNameProblem('a:b')).toMatch(/disc path/);
        expect(levelNameProblem('x'.repeat(81))).toMatch(/1 to 80/);
        expect(levelNameProblem(asciiLevelTitle('OotF 01 - Höhle'))).toBeNull();
    });
});

describe('language-neutral level keys', () => {
    it('keys a level on its Dragon.rrc name id, whatever the folders are called', () => {
        const air = level('Mehrspieler/Luft/Arena des Todes/Arena des Todes.lvl', '<0x900d>Arena des Todes (Luft)', []);
        expect(ootfLevelKey(air)).toBe('multiplayer/air/arena of death/arena of death.lvl');
        expect(isOotfArenaLevel(air)).toBe(true);
        expect(isOotfAirArenaLevel(air)).toBe(true);
        const book = level('Bergwelt/Ruinendorf/Ruinendorf Buch.lvl', '<0x9001>Ruinendorf Buch', []);
        expect(isOotfArenaLevel(book)).toBe(false);
        expect(paletteFor(ootfLevelKey(book)).bed).toEqual(
            paletteFor('Mountain World/Ruined Village/Ruined Village Book.lvl').bed,
        );
    });
    it('finds the intro and arenas in an install chosen one folder too high', () => {
        expect(ootfLevelKey(level('Drakan/Mountain World/Intro Level/Intro.lvl', 'intro level', []))).toBe(
            'mountain world/intro level/intro.lvl',
        );
        expect(isOotfArenaLevel(level('Drakan/Multiplayer/Ground/Relic/Relic.lvl', '<0x9011>Relic (ground)', []))).toBe(
            true,
        );
        // Unknown ids keep the folder rule.
        expect(isOotfArenaLevel(level('Multiplayer/Ground/New/New.lvl', '<0x1234>New', []))).toBe(true);
        expect(isOotfArenaLevel(level('Custom/New/New.lvl', '<0x1234>New', []))).toBe(false);
    });
    it('prefers the Dragon.rrc nearest the install root', () => {
        expect(pickRrcPath(['Deutsch/dragon.rrc', 'Dragon.rrc', 'Music.rrc'])).toEqual({
            path: 'Dragon.rrc',
            others: ['Deutsch/dragon.rrc'],
        });
    });
});

/** A German install: German folders and names, English-schema field names (the engine's .rfl defines those). */
const germanCampaign = (): PcLevel[] => [
    level('Bergwelt/Intro/Intro.lvl', 'Intro', []),
    level('Bergwelt/Ruinendorf/Ruinendorf.lvl', '<0x9000>Ruinendorf', [
        'bergwelt\\ruinendorf\\Das Buch.lvl',
        'bergwelt\\schluchten\\schluchten.lvl',
    ]),
    level('Bergwelt/Ruinendorf/Das Buch.lvl', '<0x9001>Das Buch', ['bergwelt\\ruinendorf\\ruinendorf.lvl']),
    level(
        'Bergwelt/Schluchten/Schluchten.lvl',
        `<0x9002>Die überaus langen Wartok-Schluchten östlich des Grimstone-Gebirges`,
        [],
    ),
];

describe('planCampaign on a German install', () => {
    const plan = planCampaign(germanCampaign());
    it('writes ASCII titles no longer than the pipeline keeps, so exits and level names agree', () => {
        for (const l of plan.levels) {
            expect(levelNameProblem(l.title)).toBeNull();
            expect(l.title.length).toBeLessThanOrEqual(CAMPAIGN_TITLE_MAX);
        }
        expect(plan.levels.map((l) => l.title.slice(0, 26))).toEqual([
            'OotF 00 - Intro',
            'OotF 01 - Ruinendorf',
            'OotF 02 - Das Buch',
            'OotF 03 - Die ueberaus lan',
        ]);
        expect([...plan.destinationTitles].sort()).toEqual(plan.levels.map((l) => l.title).sort());
        expect(() => campaignExitStrings(plan, 'LEVEL1ON.XDB')).not.toThrow();
    });
    it('finds the Book cut-scene and the first level by name id, not by English names', () => {
        const book = plan.levels.find((l) => l.nameStringId === 0x9001)!;
        expect(book.exits.find((e) => e.reason === 'pc')!.autoSeconds).toBe(BOOK_SCENE_SECONDS);
        const intro = plan.levels[0]!;
        expect(intro.exits.find((e) => e.reason === 'intro-next')!.destTitle).toBe('OotF 01 - Ruinendorf');
    });
    it('takes a renamed player class by its engine class for the arrival markers', () => {
        const pcs = germanCampaign().map((p) => {
            p.classes.get(2)!.get(1)!.name = 'Spielerin';
            return p;
        });
        const p = planCampaign(pcs);
        expect(p.levels.every((l) => l.rynn !== null)).toBe(true);
    });
});

describe('checkOotfSource', () => {
    const rrc = { path: 'Dragon.rrc', others: [], strings: new Map(GERMAN_RRC.map((s, i) => [i, s])) };
    const hasField = (c: OdbClass) => transitionFieldIndex(c.fields) >= 0;
    it('reports a German install with no problems', () => {
        const p = checkOotfSource(germanCampaign(), rrc, hasField, true);
        expect(p.language.language).toBe('german');
        expect(p.errors).toEqual([]);
        expect(() => assertOotfSource(p)).not.toThrow();
    });
    it('refuses a localized exit schema instead of writing a campaign whose exits lead nowhere', () => {
        const pcs = [
            level('A/a.lvl', '<0x9000>A', ['a\\b.lvl'], { exitField: 'Übergang zu...' }),
            level('A/b.lvl', '<0x9002>B', []),
        ];
        const p = checkOotfSource(pcs, rrc, hasField, true);
        expect(p.errors.join('\n')).toMatch(/no "Transition To\.\.\." field.*issue #3/);
        expect(() => assertOotfSource(p)).toThrow(OotfSourceError);
        // Arena-only conversions do not need exits.
        expect(checkOotfSource(pcs, rrc, hasField, false).errors).toEqual([]);
    });
    it('refuses levels whose placed objects come from a database that is not in the install', () => {
        const p = checkOotfSource([level('A/a.lvl', '<0x9000>A', [], { missingDep: true })], rrc, hasField, false);
        expect(p.errors[0]).toMatch(/NPCs.*Copy the complete install/);
        expect(() => assertOotfSource(p)).toThrow(/cannot be converted as it is \(german source\)/);
    });
    it('refuses a campaign level without a player start', () => {
        const pc = level('A/a.lvl', '<0x9000>A', []);
        pc.list.objects = pc.list.objects.filter((o) => o.classId !== 1);
        expect(checkOotfSource([pc], rrc, hasField, true).errors[0]).toMatch(/no player start/);
    });
    it('warns when Dragon.rrc is missing or its language is unclear', () => {
        const none = checkOotfSource(germanCampaign(), { path: null, others: [], strings: new Map() }, hasField, true);
        expect(none.warnings.join('\n')).toMatch(/no Dragon\.rrc/);
        const unclear = checkOotfSource(
            germanCampaign(),
            { path: 'Dragon.rrc', others: [], strings: new Map([[1, 'Rynn']]) },
            hasField,
            true,
        );
        expect(unclear.warnings.join('\n')).toMatch(/could not tell/);
    });
});

/** A Dragon.rrc as the PC readers see it: XOR-coded Windows-1252 records, one entry per string id. */
function fakeRrc(texts: Record<number, number[]>): SrscReader {
    const bodies = new Map(
        Object.entries(texts).map(([id, b]) => [Number(id), xorRrcString(Uint8Array.from([...b, 0]))]),
    );
    return {
        entries: [...bodies.keys()].map((id) => ({ type: RRC_STRING_TYPE, id })),
        readRaw: async (e: { id: number }) => bodies.get(e.id)!,
    } as unknown as SrscReader;
}

describe('a German Dragon.rrc end to end', () => {
    const texts: Record<number, number[]> = {
        0x9000: cp('Ruinendorf'),
        0x9001: cp('Das Buch'),
        0x9003: cp('Grimstone-Höhlen'),
        0x1: [0x84, ...cp('Du hast den Schlüssel nicht'), 0x93],
        0x2: cp('Die Fackel ist in der Höhle und nicht bei dem Turm für sie.'),
        0x3: cp('Der Drache und die Fähigkeit des Magiers ist ein Geschenk mit einer Axt.'),
        0x4: [0x80, 0x20, ...cp('5'), 0x85, 0x20, 0x97, 0x20, 0x92], // € … — ’ (Windows-1252 only)
    };
    it('decodes the XOR-coded bytes, detects German and keeps the 0x80..0x9f characters', async () => {
        const strings = await parseRrcStrings(fakeRrc(texts));
        expect(strings.size).toBe(Object.keys(texts).length);
        expect(strings.get(0x9003)).toBe('Grimstone-Höhlen');
        expect(detectOotfLanguage(strings.values()).language).toBe('german');
        expect(rawToCp1252(strings.get(4)!)).toBe('€ 5… — ’');
        expect(cleanGameText(strings.get(1)!).replaced).toEqual([]);
    });
    it('turns every localized level title into a name the runtime accepts', async () => {
        const strings = await parseRrcStrings(fakeRrc(texts));
        for (const id of [0x9000, 0x9001, 0x9003]) {
            const title = asciiLevelTitle(`OotF - ${strings.get(id)}`);
            expect(levelNameProblem(title)).toBeNull();
        }
        expect(asciiLevelTitle('OotF - Grimstone-Höhlen')).toBe('OotF - Grimstone-Hoehlen');
    });
    it('does not guess from an empty, missing or unreadable file', async () => {
        expect(detectOotfLanguage([]).language).toBe('unknown');
        const strings = await parseRrcStrings(fakeRrc({}));
        expect(strings.size).toBe(0);
    });
});

describe('language detection of the other releases', () => {
    it('recognises French, Italian and Spanish text, and a German title with only an umlaut', () => {
        expect(
            detectOotfLanguage([
                'Vous avez trouvé la clé pour la porte et le dragon est dans une grotte avec votre ami du village.',
                'Ce n’est pas le chemin pour les mines, pas dans le noir.',
            ]).language,
        ).toBe('french');
        expect(
            detectOotfLanguage([
                'Non hai la chiave per il cancello che è nel villaggio di Rynn.',
                'Questo è il tuo drago, non sono nel castello con gli altri per una ragione.',
            ]).language,
        ).toBe('italian');
        expect(
            detectOotfLanguage([
                'No tienes la llave para el portón que es de los magos, pero esta es tu espada.',
                'Las puertas del castillo son para los que tienen su permiso, con una llave del reino.',
            ]).language,
        ).toBe('spanish');
    });
    it('keeps English when German proper nouns appear inside English text', () => {
        expect(detectOotfLanguage([...ENGLISH_RRC, 'Wartok Höhlen', 'Grimstone']).language).toBe('english');
    });
});

describe('level title edge cases of localized installs', () => {
    it('never produces a name the runtime would refuse, for every Latin-1 and Windows-1252 character', () => {
        for (let c = 0x20; c <= 0xff; c++) {
            const title = asciiLevelTitle(`OotF 01 - ${String.fromCharCode(c)}x${String.fromCharCode(c)}`);
            expect(levelNameProblem(title), `char 0x${c.toString(16)} -> '${title}'`).toBeNull();
            expect(asciiLevelTitle(title)).toBe(title);
        }
    });
    it('keeps a plain ASCII title untouched, including punctuation the runtime allows', () => {
        for (const t of ["Dragon's Rest", 'Hill of Fire (ground)', 'OotF 12 - Rift World', 'A+B, C&D #1']) {
            expect(asciiLevelTitle(t)).toBe(t);
            expect(levelNameProblem(t)).toBeNull();
        }
    });
});

describe('the Intro as a conversion template', () => {
    it('warns when the template names its own database without a folder, in any language tree', () => {
        const w = introTemplateWarning(['Level 0 - Intro', '..\\Common\\System', 'Levels\\Über\\Gemeinsam']);
        expect(w).toContain('Level 0 - Intro');
        expect(w).toContain('Surdana');
    });
    it('stays silent for a template whose databases all carry a folder', () => {
        expect(introTemplateWarning(['..\\Level 1 - Common\\Level 1 - Common', '../Common/System/System', ''])).toBeNull();
    });
});
