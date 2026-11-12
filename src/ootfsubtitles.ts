// Subtitles of converted Order of the Flame cut scenes.
//
// The PC game has no subtitle text: its sequences only play voice clips (STOMP action 3: sound ref, duration), and neither the
// SDB descriptors nor Dragon.rrc carry the spoken lines. The text therefore comes from a subtitle file made on the player's
// machine from the player's own voice clips (analysis/scripts/ootf_subtitles.py transcribes them; it can be edited by hand).
// The file is engine-neutral data: one line per voice clip, keyed by the PC sound bank and sound id, with timed cues relative
// to the start of the clip. Nothing in it is PS2 specific, so another engine can show the same cues.
//
// For the PS2 engine the converter writes each line into the clip's sound descriptor (SDB 0x0302, flag 0x2000), where the disc
// keeps the subtitles of its own speech, as timed pages (`subtitleClipText`). The runtime shows them while the clip plays,
// whichever actor plays it (the engine itself only subtitles actors with a speech controller, not a scene's camera or
// narrator). The pack also carries the lines it used as `story/subtitles.json` for other engines.

import { view } from './bytes.ts';
import { parseDbText } from './ootfcontainer.ts';
import type { PcFileSource } from './pc.ts';
import { resolvePcPath } from './pc.ts';
import { parsePcSequence } from './ootfseq.ts';
import { sdbKey } from './ootfsound.ts';
import { SSD_SEQUENCE } from './resources.ts';
import { SrscReader } from './srsc.ts';

export const SUBTITLE_FORMAT = 'drakan-subtitles';
export const SUBTITLE_VERSION = 1;

/** One piece of text and the span of its clip (seconds from the clip's first sample) during which it is spoken. */
export interface SubtitleCue {
    start: number;
    end: number;
    text: string;
}

/** The text of one voice clip. */
export interface SubtitleLine {
    /** PC sound bank: install-relative path without `.sdb`, lower case, `/` separators (`sdbKey`). */
    bank: string;
    /** Sound id inside the bank. */
    id: number;
    /** Sound name in the bank (informational). */
    name?: string;
    /** Clip length in seconds (informational). */
    duration?: number;
    cues: SubtitleCue[];
}

export interface SubtitleFile {
    format: typeof SUBTITLE_FORMAT;
    version: number;
    /** Language of the text (`english`, `german`, ...), as in drakan.ini `language`. */
    language: string;
    lines: SubtitleLine[];
}

export class SubtitleFileError extends Error {}

/** Validate parsed JSON as a subtitle file; throws SubtitleFileError naming the first fault. */
export function parseSubtitleFile(json: unknown): SubtitleFile {
    const bad = (m: string): never => {
        throw new SubtitleFileError(`subtitle file: ${m}`);
    };
    if (!json || typeof json !== 'object') return bad('not an object');
    const f = json as Record<string, unknown>;
    if (f['format'] !== SUBTITLE_FORMAT) return bad(`format is not "${SUBTITLE_FORMAT}"`);
    if (f['version'] !== SUBTITLE_VERSION) return bad(`version ${String(f['version'])} is not supported`);
    if (!Array.isArray(f['lines'])) return bad('no lines');
    const lines: SubtitleLine[] = [];
    (f['lines'] as unknown[]).forEach((raw, i) => {
        const l = raw as Record<string, unknown>;
        if (!l || typeof l['bank'] !== 'string' || !Number.isInteger(l['id']) || !Array.isArray(l['cues']))
            return bad(`line ${i}: needs bank, id and cues`);
        const cues: SubtitleCue[] = [];
        for (const rc of l['cues'] as unknown[]) {
            const c = rc as Record<string, unknown>;
            if (!c || typeof c['text'] !== 'string' || !Number.isFinite(c['start']) || !Number.isFinite(c['end']))
                return bad(`line ${i}: a cue needs start, end and text`);
            cues.push({ start: c['start'] as number, end: c['end'] as number, text: c['text'] });
        }
        cues.sort((a, b) => a.start - b.start);
        const line: SubtitleLine = { bank: sdbKey(l['bank']), id: l['id'] as number, cues };
        if (typeof l['name'] === 'string') line.name = l['name'];
        if (Number.isFinite(l['duration'])) line.duration = l['duration'] as number;
        lines.push(line);
    });
    return {
        format: SUBTITLE_FORMAT,
        version: SUBTITLE_VERSION,
        language: typeof f['language'] === 'string' ? f['language'] : 'english',
        lines,
    };
}

/**
 * Several subtitle files as one: a line of a later file replaces the same clip's line of an earlier one, also when the
 * later line is empty (a clip the author wants without a subtitle). So a hand-corrected file listed after a fresh
 * transcription wins. The language is the last file's.
 */
export function mergeSubtitleFiles(files: readonly SubtitleFile[]): SubtitleFile {
    const byKey = new Map<string, SubtitleLine>();
    for (const f of files) for (const l of f.lines) byKey.set(`${l.bank}#${l.id}`, l);
    return {
        format: SUBTITLE_FORMAT,
        version: SUBTITLE_VERSION,
        language: files.at(-1)?.language ?? 'english',
        lines: [...byKey.values()],
    };
}

/** Characters the engine's subtitle font and the cp1252 descriptor text cannot carry are replaced by plain ones. */
export function plainSubtitleText(text: string): string {
    return text
        .replace(/[\u2018\u2019\u201a\u2032]/g, "'")
        .replace(/[\u201c\u201d\u201e\u2033]/g, '"')
        .replace(/\s*[\u2013\u2014\u2015]\s*/g, ', ')
        .replace(/\u2026/g, '...')
        .replace(/\\/g, '/') // a backslash starts the engine's own page mark
        .replace(/[^\x20-\x7e\xa1-\xff]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

/** Longest text of one page: two bar lines of the engine's 350 px wrap hold about this many characters. */
export const SUBTITLE_PAGE_CHARS = 84;

/** Split a cue that is too long for one page at word boundaries; the pieces share its span by their length. */
export function splitLongCue(cue: SubtitleCue, maxChars = SUBTITLE_PAGE_CHARS): SubtitleCue[] {
    const text = plainSubtitleText(cue.text);
    if (text.length <= maxChars) return text ? [{ start: cue.start, end: cue.end, text }] : [];
    const words = text.split(' ');
    const pieces = Math.ceil(text.length / maxChars);
    const target = Math.ceil(text.length / pieces);
    const parts: string[] = [];
    let cur = '';
    for (const w of words) {
        if (cur && cur.length + 1 + w.length > maxChars) {
            parts.push(cur);
            cur = w;
        } else if (cur && cur.length >= target && parts.length < pieces - 1) {
            parts.push(cur);
            cur = w;
        } else cur = cur ? `${cur} ${w}` : w;
    }
    if (cur) parts.push(cur);
    const total = parts.reduce((n, p) => n + p.length, 0);
    const out: SubtitleCue[] = [];
    let t = cue.start;
    for (const p of parts) {
        const span = ((cue.end - cue.start) * p.length) / total;
        out.push({ start: t, end: t + span, text: p });
        t += span;
    }
    return out;
}

const cueMark = (seconds: number): string => `[[${(Math.round(Math.max(0, seconds) * 100) / 100).toString()}]]`;

/**
 * The descriptor text of a line: every page as `[[<start seconds>]]text`, then `[[<end seconds>]]` of the last page, e.g.
 * `[[0.4]]There are legends[[3.1]]of the Order[[6]]`. Times count from the clip's first sample. The runtime reads the marks
 * and shows each page for its span (settings/Subtitles.h `parseClipCues`). The engine's own page mark (a backslash and the
 * seconds a page stays) is not used: the engine only pages text on actors with a speech controller. Empty when the line has
 * no text; cut at a page end when the engine's text slot (`maxBytes`) would overflow.
 */
export function subtitleClipText(
    line: Pick<SubtitleLine, 'cues'>,
    maxChars = SUBTITLE_PAGE_CHARS,
    maxBytes = 1000,
): string {
    const pages = line.cues.flatMap((c) => splitLongCue(c, maxChars));
    let out = '';
    let end = 0;
    for (const p of pages) {
        const piece = `${cueMark(p.start)}${p.text.replace(/\[\[|\]\]/g, ' ').replace(/ +/g, ' ')}`;
        if (out.length + piece.length + 12 > maxBytes) break;
        out += piece;
        end = Math.max(p.end, p.start + 0.5);
    }
    return out ? out + cueMark(end) : '';
}

/** Lookup of the engine text by PC sound bank key and sound id. */
export class SubtitleTable {
    private readonly byKey = new Map<string, SubtitleLine>();
    readonly language: string;

    constructor(file: SubtitleFile) {
        this.language = file.language;
        for (const l of file.lines) if (l.cues.some((c) => plainSubtitleText(c.text))) this.byKey.set(`${l.bank}#${l.id}`, l);
    }

    get size(): number {
        return this.byKey.size;
    }

    line(bank: string, id: number): SubtitleLine | null {
        return this.byKey.get(`${sdbKey(bank)}#${id}`) ?? null;
    }

    /** Descriptor text of a sound, or null when the file has no text for it. */
    clipText(bank: string, id: number): string | null {
        const l = this.line(bank, id);
        const text = l ? subtitleClipText(l) : '';
        return text ? text : null;
    }
}

/** One use of a voice clip by a sequence. */
export interface SequenceSoundUse {
    /** Install-relative sequence database without `.ssd`. */
    ssd: string;
    sequenceId: number;
    sequence: string;
    actor: string;
    /** Seconds from the start of the sequence. */
    time: number;
    /** Authored length of the sound action in seconds. */
    duration: number;
}

export interface SequenceSound {
    /** `sdbKey` of the bank. */
    bank: string;
    /** Bank path as the install spells it (no extension). */
    bankPath: string;
    id: number;
    uses: SequenceSoundUse[];
}

/**
 * Every sound a sequence of the install plays (STOMP action 3), with the scenes that use it: the candidates for subtitles.
 * Sound refs are `(db << 16) | id` with `db` an index into the sequence database's own `.db` dependency list.
 */
export async function listSequenceSounds(src: PcFileSource): Promise<SequenceSound[]> {
    const paths = await src.list();
    const byLower = new Map(paths.map((p) => [p.toLowerCase(), p]));
    const out = new Map<string, SequenceSound>();
    for (const path of paths.filter((p) => /\.ssd$/i.test(p)).sort()) {
        const owner = path.replace(/\.ssd$/i, '');
        const bytes = await src.read(path);
        if (!bytes) continue;
        const dbBytes = await src.read(`${owner}.db`);
        const deps = dbBytes ? parseDbText(new TextDecoder('latin1').decode(dbBytes)) : new Map<number, string>();
        const dir = owner.split('/').slice(0, -1).join('/');
        const reader = await SrscReader.fromBytes(bytes);
        for (const e of reader.entries) {
            if (e.type !== SSD_SEQUENCE) continue;
            let seq;
            try {
                seq = parsePcSequence(e.id, e.sub, (await reader.read(e)).data);
            } catch {
                continue; // an unreadable sequence is reported by the converter itself
            }
            for (const actor of seq.actors) {
                for (const action of actor.actions) {
                    if (action.type !== 3) continue;
                    const dv = view(action.payload);
                    const ref = dv.getUint32(0, true);
                    const db = ref >>> 16;
                    const rel = db === 0 ? null : deps.get(db);
                    const bankPath = db === 0 ? owner : rel ? resolvePcPath(dir, rel) : null;
                    if (!bankPath) continue;
                    const real = byLower.get(`${bankPath}.sdb`.toLowerCase());
                    const spelled = real ? real.replace(/\.sdb$/i, '') : bankPath;
                    const key = `${sdbKey(spelled)}#${ref & 0xffff}`;
                    const s =
                        out.get(key) ??
                        out.set(key, { bank: sdbKey(spelled), bankPath: spelled, id: ref & 0xffff, uses: [] }).get(key)!;
                    s.uses.push({
                        ssd: owner,
                        sequenceId: e.id,
                        sequence: seq.name,
                        actor: actor.name,
                        time: action.time,
                        duration: dv.getFloat32(4, true),
                    });
                }
            }
        }
    }
    return [...out.values()].sort((a, b) => (a.bank === b.bank ? a.id - b.id : a.bank < b.bank ? -1 : 1));
}

/** Mono 16-bit PCM as a RIFF WAVE file (for the transcription tool). */
export function pcmWav(pcm: Int16Array, rate: number): Uint8Array {
    const out = new Uint8Array(44 + pcm.length * 2);
    const dv = view(out);
    const tag = (o: number, s: string): void => {
        for (let i = 0; i < 4; i++) out[o + i] = s.charCodeAt(i);
    };
    tag(0, 'RIFF');
    dv.setUint32(4, 36 + pcm.length * 2, true);
    tag(8, 'WAVE');
    tag(12, 'fmt ');
    dv.setUint32(16, 16, true);
    dv.setUint16(20, 1, true);
    dv.setUint16(22, 1, true);
    dv.setUint32(24, rate, true);
    dv.setUint32(28, rate * 2, true);
    dv.setUint16(32, 2, true);
    dv.setUint16(34, 16, true);
    tag(36, 'data');
    dv.setUint32(40, pcm.length * 2, true);
    for (let i = 0; i < pcm.length; i++) dv.setInt16(44 + i * 2, pcm[i]!, true);
    return out;
}
