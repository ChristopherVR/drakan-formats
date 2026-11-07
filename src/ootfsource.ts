// Order of the Flame source install: which language it is, and the language-neutral facts the converter keys on.
// Evidence and audit: docs/journal/2026-11-06/issue-3-localized-ootf.md. Facts from the owned English install (names only):
//
//   * Dragon.rrc holds the 426 UI / item / level-name strings of the install's language; levels refer to them as `<0xNNNN>`.
//     The level header names are `<0x9000>Ruined Village` ... `<0x9015>Volcano of Death (mod)`; only the intro has no id.
//   * Every other converter heuristic that looked at the folder layout (multiplayer arenas, air arenas, music palettes, the
//     intro and the Book cut-scene) can be keyed on those ids instead, so a localized install with other folder names, or
//     an install picked one folder too high, still converts.
//   * The PC text bytes are Windows-1252 (German `„ “` are 0x84 / 0x93), read as raw bytes (code unit = byte) by the readers.

import type { OdbClass } from './odb.ts';
import type { PcLevel } from './pc.ts';

export type OotfLanguage = 'english' | 'german' | 'french' | 'italian' | 'spanish';

export interface OotfLanguageGuess {
    language: OotfLanguage | 'unknown';
    /** Stop-word hits of the winner and the runner-up. */
    hits: number;
    runnerUp: number;
    /** One-line human explanation (shown in the converter log). */
    evidence: string;
}

/** Short, frequent function words; every list avoids words that are also common in another of the languages. */
const STOP_WORDS: Readonly<Record<OotfLanguage, readonly string[]>> = {
    english: ['the', 'and', 'you', 'of', 'to', 'is', 'your', 'with', 'this', 'are', 'for', 'have', 'not', 'from'],
    german: [
        'der',
        'die',
        'das',
        'und',
        'nicht',
        'ist',
        'sie',
        'mit',
        'ein',
        'eine',
        'zu',
        'den',
        'dem',
        'auf',
        'ich',
        'für',
    ],
    french: ['le', 'les', 'et', 'vous', 'une', 'est', 'des', 'du', 'pour', 'pas', 'dans', 'avec', 'votre', 'sur'],
    italian: ['il', 'di', 'che', 'non', 'per', 'una', 'gli', 'della', 'sono', 'nel', 'questo', 'hai', 'tuo', 'con'],
    spanish: ['el', 'los', 'las', 'que', 'por', 'una', 'del', 'para', 'tu', 'con', 'es', 'su', 'pero', 'esta'],
};

const LANGUAGES = Object.keys(STOP_WORDS) as OotfLanguage[];

/**
 * Guess the language of an install from its strings (Dragon.rrc). Counts stop words per language; German umlauts / sharp s
 * count for German. `unknown` when there is too little text or no clear winner, so the caller can say so instead of guessing.
 */
export function detectOotfLanguage(strings: Iterable<string>): OotfLanguageGuess {
    const sets = new Map(LANGUAGES.map((l) => [l, new Set(STOP_WORDS[l])]));
    const score = new Map<OotfLanguage, number>(LANGUAGES.map((l) => [l, 0]));
    for (const raw of strings) {
        const s = rawToCp1252(raw).toLowerCase();
        for (const w of s.split(/[^a-zà-öø-ÿß]+/)) {
            if (!w) continue;
            for (const l of LANGUAGES) if (sets.get(l)!.has(w)) score.set(l, score.get(l)! + 1);
        }
        for (const ch of s) if ('äöüß'.includes(ch)) score.set('german', score.get('german')! + 1);
    }
    const ranked = [...score].sort((a, b) => b[1] - a[1]);
    const [best, second] = [ranked[0]!, ranked[1]!];
    const table = ranked.map(([l, n]) => `${l} ${n}`).join(', ');
    if (best[1] < 8 || best[1] < second[1] * 1.5)
        return { language: 'unknown', hits: best[1], runnerUp: second[1], evidence: `no clear language (${table})` };
    return { language: best[0], hits: best[1], runnerUp: second[1], evidence: `stop words: ${table}` };
}

// ---------------------------------------------------------------- text bytes

const cp1252 = new TextDecoder('windows-1252');

/**
 * The PC readers return text as raw bytes (one UTF-16 code unit per byte). Bytes 0xa0..0xff already are the Windows-1252
 * characters (ä = 0xe4 = U+00E4), but 0x80..0x9f are not: German `„` is byte 0x84, which reads as U+0084. Turn those into the
 * real characters so they survive into the PS2 string tables instead of becoming `?`. Text that is already Unicode is unchanged.
 */
export function rawToCp1252(s: string): string {
    if (!/[\u0080-\u009f]/.test(s)) return s;
    let out = '';
    for (const ch of s) {
        const c = ch.charCodeAt(0);
        out += c >= 0x80 && c <= 0x9f ? cp1252.decode(Uint8Array.of(c)) : ch;
    }
    return out;
}

// ---------------------------------------------------------------- level titles

const TRANSLIT: Readonly<Record<string, string>> = {
    ä: 'ae',
    ö: 'oe',
    ü: 'ue',
    Ä: 'Ae',
    Ö: 'Oe',
    Ü: 'Ue',
    ß: 'ss',
    æ: 'ae',
    Æ: 'Ae',
    œ: 'oe',
    Œ: 'Oe',
    ø: 'o',
    Ø: 'O',
    đ: 'd',
    Đ: 'D',
    ð: 'd',
    Ð: 'D',
    þ: 'th',
    Þ: 'Th',
    '„': '',
    '“': '',
    '”': '',
    '‘': "'",
    '’': "'",
    '«': '',
    '»': '',
    '\u2013': '-',
    '\u2014': '-',
};

/** Characters the runtime refuses in a level name (runtime/hle/src/ModPack.cpp `validLevelName`). */
const PATH_UNSAFE = /[\\/:*?"<>|;]/;
export const LEVEL_NAME_MAX = 80;

/** Why the runtime would refuse `name` as a pack level (it then silently ignores the level), or null when it is fine. */
export function levelNameProblem(name: string): string | null {
    if (!name || name.length > LEVEL_NAME_MAX) return `must be 1 to ${LEVEL_NAME_MAX} characters`;
    for (const ch of name) {
        const c = ch.charCodeAt(0);
        if (c < 0x20 || c >= 0x7f) return `'${ch}' is not plain ASCII; level names become disc paths`;
        if (PATH_UNSAFE.test(ch)) return `'${ch}' cannot be part of a disc path`;
    }
    return null;
}

/**
 * A level title the runtime accepts, from a localized name: umlauts become `ae oe ue ss`, other accents are dropped
 * (`é` -> `e`), quotes and path characters go, whitespace collapses. ASCII names come back unchanged (trimmed).
 */
export function asciiLevelTitle(name: string): string {
    const t = rawToCp1252(name);
    let out = '';
    for (const ch of t) {
        if (ch in TRANSLIT) out += TRANSLIT[ch];
        else if (ch.charCodeAt(0) < 0x80) out += ch;
        else out += ch.normalize('NFD').replace(/[^\x20-\x7e]/g, '');
    }
    return out
        .replace(/[\x00-\x1f\x7f]/g, ' ')
        .replace(new RegExp(PATH_UNSAFE.source, 'g'), ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

// ---------------------------------------------------------------- language-neutral level keys

export type OotfLevelKind = 'campaign' | 'air' | 'ground' | 'qod';

/** The retail levels by their Dragon.rrc name id, with the English install path (lower case) and kind. */
export const OOTF_LEVEL_IDS: ReadonlyMap<number, { path: string; kind: OotfLevelKind }> = new Map([
    [0x9000, { path: 'mountain world/ruined village/ruined village.lvl', kind: 'campaign' }],
    [0x9001, { path: 'mountain world/ruined village/ruined village book.lvl', kind: 'campaign' }],
    [0x9002, { path: 'mountain world/wartok canyons/wartok canyons.lvl', kind: 'campaign' }],
    [0x9003, { path: 'mountain world/grimstone mines/mines.lvl', kind: 'campaign' }],
    [0x9004, { path: 'mountain world/grotto/grotto.lvl', kind: 'campaign' }],
    [0x9005, { path: 'islands world/islands/islands.lvl', kind: 'campaign' }],
    [0x9006, { path: 'islands world/alwarren/alwarren.lvl', kind: 'campaign' }],
    [0x9007, { path: 'islands world/rift crystal/rift crystal.lvl', kind: 'campaign' }],
    [0x9008, { path: 'islands world/islands night/islands night.lvl', kind: 'campaign' }],
    [0x9009, { path: 'islands world/succubus lair/succubus lair.lvl', kind: 'campaign' }],
    [0x900a, { path: 'volcanic world/volcano/volcano.lvl', kind: 'campaign' }],
    [0x900b, { path: 'rift world/rift world/riftworld.lvl', kind: 'campaign' }],
    [0x900c, { path: 'multiplayer/air/alwarren of death/alwarren of death.lvl', kind: 'air' }],
    [0x900d, { path: 'multiplayer/air/arena of death/arena of death.lvl', kind: 'air' }],
    [0x900e, { path: 'multiplayer/air/grotto of death/grotto of death.lvl', kind: 'air' }],
    [0x900f, { path: 'multiplayer/air/nemesis/nemesis.lvl', kind: 'air' }],
    [0x9010, { path: 'multiplayer/ground/hill of fire/hill of fire.lvl', kind: 'ground' }],
    [0x9011, { path: 'multiplayer/ground/relic/relic.lvl', kind: 'ground' }],
    [0x9012, { path: 'multiplayer/ground/sanctuary/sanctuary.lvl', kind: 'ground' }],
    [0x9013, { path: 'multiplayer/qod/island of death/island of death.lvl', kind: 'qod' }],
    [0x9014, { path: 'multiplayer/qod/rise to power/rise to power.lvl', kind: 'qod' }],
    [0x9015, { path: 'multiplayer/qod/volcano of death/volcano of death.lvl', kind: 'qod' }],
]);

/** The English install path of the intro, the one retail level without a name id. */
export const OOTF_INTRO_PATH = 'mountain world/intro level/intro.lvl';
/** Name ids of the two levels the campaign plan treats specially: the first level after the intro, and the Book cut-scene. */
export const OOTF_FIRST_LEVEL_ID = 0x9000;
export const OOTF_BOOK_LEVEL_ID = 0x9001;

/** Dragon.rrc id of a level's header name (`<0x9000>Ruined Village` -> 0x9000), or null. */
export function ootfLevelNameId(pc: Pick<PcLevel, 'header'>): number | null {
    const m = /^<0x([0-9a-fA-F]+)>/.exec(pc.header.name.text);
    return m ? parseInt(m[1]!, 16) : null;
}

/**
 * Language-neutral key of a PC level for the converter's role heuristics: the English install path (lower case, `/`) of the
 * retail level with the same name id, else the level's own path (lower case). Never use it to read files.
 */
export function ootfLevelKey(pc: Pick<PcLevel, 'header' | 'path'>): string {
    const id = ootfLevelNameId(pc);
    const known = id === null ? undefined : OOTF_LEVEL_IDS.get(id);
    if (known) return known.path;
    const own = pc.path.replace(/\\/g, '/').toLowerCase();
    // An install chosen one folder too high (`Drakan/Mountain World/...`): the retail tail still names the level.
    if (id === null && own.endsWith(`/${OOTF_INTRO_PATH}`)) return OOTF_INTRO_PATH;
    return own;
}

/** A multiplayer arena (by name id, else by a `Multiplayer/` folder), not a campaign chapter. */
export function isOotfArenaLevel(pc: Pick<PcLevel, 'header' | 'path'>): boolean {
    return /^multiplayer\//.test(ootfLevelKey(pc));
}

/** A dragon-only (air) multiplayer arena. */
export function isOotfAirArenaLevel(pc: Pick<PcLevel, 'header' | 'path'>): boolean {
    return /^multiplayer\/air\//.test(ootfLevelKey(pc));
}

// ---------------------------------------------------------------- source checks

export class OotfSourceError extends Error {}

export interface OotfSourceProfile {
    language: OotfLanguageGuess;
    /** Path of the Dragon.rrc that was used, or null. */
    rrcPath: string | null;
    rrcStrings: number;
    /** Problems that make a broken pack; `assertOotfSource` throws them. */
    errors: string[];
    /** Things that degrade the result but do not break it. */
    warnings: string[];
}

/** The Dragon.rrc of an install: the one nearest the root when several exist (warned). */
export function pickRrcPath(paths: readonly string[]): { path: string | null; others: string[] } {
    const all = paths.filter((p) => /(^|\/)dragon\.rrc$/i.test(p));
    const sorted = [...all].sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));
    return { path: sorted[0] ?? null, others: sorted.slice(1) };
}

/** Engine class of the player (Rynn) and of a level transition (the PC `.rfl` ids, ootfclass.ts ENGINE_LIST). */
const RFL_PLAYER = 9;
const RFL_TRANSITION = 55;

/**
 * Check the loaded levels for the facts the converter relies on and that a localized install could break: every
 * dependency database is there (no silent class loss), campaign levels have a player start, and level transitions carry the
 * `Transition To...` field the campaign exits are read from. `hasTransitionField` is the campaign reader's own test.
 */
export function checkOotfSource(
    pcs: readonly PcLevel[],
    rrc: { path: string | null; others: string[]; strings: ReadonlyMap<number, string> },
    hasTransitionField: (cls: OdbClass) => boolean,
    campaign: boolean,
): OotfSourceProfile {
    const errors: string[] = [];
    const warnings: string[] = [];
    const language = detectOotfLanguage(rrc.strings.values());
    if (!rrc.path)
        warnings.push('no Dragon.rrc in the install: `<0xNNNN>` texts fall back to the text stored in the level');
    if (rrc.others.length) warnings.push(`several Dragon.rrc files; using ${rrc.path} (not ${rrc.others.join(', ')})`);
    if (rrc.path && language.language === 'unknown')
        warnings.push(
            `could not tell the install's language from Dragon.rrc (${language.evidence}); texts are copied as they are`,
        );
    for (const pc of pcs) {
        const missing = pc.header.dependencies.filter((d) => !pc.classes.has(d.dbIndex));
        const placed = new Set(pc.list.objects.map((o) => o.dbIndex));
        const lost = missing.filter((d) => placed.has(d.dbIndex)).map((d) => d.path.text);
        if (lost.length)
            errors.push(
                `${pc.path}: dependency database(s) not found: ${lost.join(', ')}. Copy the complete install (every .odb in its folder; some releases leave data on the CD); the objects of these databases would be dropped`,
            );
        else if (missing.length)
            warnings.push(
                `${pc.path}: dependency database(s) not found: ${missing.map((d) => d.path.text).join(', ')}`,
            );
        if (!campaign || isOotfArenaLevel(pc)) continue;
        const objClass = (o: PcLevel['list']['objects'][number]) => pc.classes.get(o.dbIndex)?.get(o.classId);
        const players = pc.list.objects.filter((o) => {
            const c = objClass(o);
            return c && (c.name.trim().toLowerCase() === 'rynn' || c.rflClass === RFL_PLAYER);
        });
        if (!players.length) errors.push(`${pc.path}: no player start (no Rynn object); the level cannot be played`);
        const transitions = pc.list.objects.map(objClass).filter((c) => c?.rflClass === RFL_TRANSITION);
        if (transitions.length && !transitions.some((c) => c && hasTransitionField(c)))
            errors.push(
                `${pc.path}: its ${transitions.length} level transition(s) have no "Transition To..." field; this install's class schema is localized or newer than the one the converter knows, so no exit would lead anywhere. Please report it on GitHub issue #3 with the converter log`,
            );
    }
    return { language, rrcPath: rrc.path, rrcStrings: rrc.strings.size, errors, warnings };
}

/**
 * A PS2 template level that names its own level database by a bare name (no folder), as `Level 0 - Intro` (LEVEL0RO) does,
 * or null. A level converted on it asks for `Levels/<converted level>/Level 0 - Intro.*`, which only loads because the
 * runtime serves the intro's files next to it; the intro also has no Visibility Toggler, morph or earthquake classes, so the
 * pack loses puzzle logic. Packs exported this way froze New Game for a German player (GitHub issue 1, item 4). The check
 * reads dependency paths only, so it is the same in every language tree.
 */
export function introTemplateWarning(dependencyPaths: readonly string[]): string | null {
    const bare = dependencyPaths.filter((p) => p.trim() !== '' && !/[\\/]/.test(p));
    if (!bare.length) return null;
    return `the PS2 template names its own level database without a folder (${bare.join(', ')}): it is the Intro level; levels converted on it lose puzzle classes (Visibility Toggler, morphs) and need the game's alias for the bare name. Choose Level 1A - Surdana as the template`;
}

/** Throw the profile's errors as one actionable message. */
export function assertOotfSource(p: OotfSourceProfile): void {
    if (!p.errors.length) return;
    throw new OotfSourceError(
        `This Order of the Flame install cannot be converted as it is (${p.language.language} source):\n- ${p.errors.join('\n- ')}`,
    );
}
