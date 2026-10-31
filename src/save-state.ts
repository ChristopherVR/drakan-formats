import { latin1, view } from './bytes.ts';
import {
    AROKH_RESOURCE,
    CLASS_OFFSET,
    GOLD_CLASS,
    RYNN_CLASS,
    LEVEL_NAME_ID,
    SaveFieldError,
    TYPE_RECORD,
    TYPE_TEXT,
    decodeScreenshot,
    listSkills,
    probeField,
    progressTable,
    recordPosition,
    type FieldEdit,
    type FieldValue,
    type RecordInfo,
    type SaveFile,
} from './save.ts';

/**
 * Read-only views and checks built on the field table of `save.ts`: the item panel kept in Rynn's record, record
 * labels, the validate/repair report and the plan for moving values between two saves. Layout evidence is in
 * `docs/journal/2026-10-31/save-editor.md` ("Inventory, equipment and state" section).
 */

// ------------------------------------------------------------------------------------------------- labels

export function recordLabel(r: Pick<RecordInfo, 'classId' | 'resource'>): string {
    if (r.classId === RYNN_CLASS) return 'Rynn (player)';
    if (r.resource === AROKH_RESOURCE) return 'Arokh (dragon)';
    if (r.classId === GOLD_CLASS) return 'Gold counter';
    return '';
}

// ------------------------------------------------------------------------------------------------- item panel

export interface ItemPanel {
    /** Item name line (the item the player last inspected on the Equipment page). */
    name: string;
    /** The detail lines that follow the name: skill needed, damage, speed, range, durability or arrows. */
    lines: string[];
    durability?: { current: number; max: number };
    hand?: 'left' | 'right';
    /** Payload offset of the "Needed:" line in Rynn's record. */
    offset: number;
}

/** Truncated line starts seen in saves (the first bytes of a UI line are overwritten) and what they stand for. */
const REPAIRS: [RegExp, string][] = [
    [/^ill Needed:/, 'Skill Needed:'],
    [/^kill Needed:/, 'Skill Needed:'],
    [/^ange:/, 'Range:'],
    [/^urability:/, 'Durability:'],
    [/^rrows:/, 'Arrows:'],
    [/^mage:/, 'Damage:'],
    [/^oden Arrows/, 'Wooden Arrows'],
];

function cleanLine(run: string): string {
    let t = run;
    const eq = t.slice(0, 3).search(/[=?]/);
    if (eq >= 0) t = t.slice(eq + 1);
    t = t.trim();
    for (const [re, to] of REPAIRS) if (re.test(t)) return t.replace(re, to);
    return t;
}

function printableRuns(data: Uint8Array, from: number, to: number): { at: number; text: string }[] {
    const out: { at: number; text: string }[] = [];
    let start = -1;
    for (let i = from; i <= to && i <= data.length; i++) {
        const c = i < to && i < data.length ? data[i]! : 0;
        const ok = c >= 32 && c < 127;
        if (ok && start < 0) start = i;
        if (!ok && start >= 0) {
            const text = latin1(data, start, i);
            if (/[A-Za-z]{3}/.test(text)) out.push({ at: start, text });
            start = -1;
        }
    }
    return out;
}

const LINE_OK = /^[A-Za-z' ]+: ?[\w/ ]+$|^In (left|right) hand$|^Equips to|^Indestructible$/;

/**
 * The item text the inventory screen keeps in Rynn's record: name, requirement, damage, speed, range, and durability
 * or arrows. It describes the item selected on the Equipment page when the save was written, not the full inventory.
 */
export function readItemPanel(save: SaveFile): ItemPanel | null {
    const rec = save.entries.find(
        (e) =>
            e.type === TYPE_RECORD &&
            e.data.length > CLASS_OFFSET + 4 &&
            view(e.data).getUint32(CLASS_OFFSET, true) === RYNN_CLASS,
    );
    if (!rec) return null;
    const d = rec.data;
    const m = /ed: \d/.exec(latin1(d, 0, d.length));
    if (!m) return null;
    const anchor = m.index;
    const runs = printableRuns(d, Math.max(0, anchor - 0x60), anchor + 0x1f0);
    const need = runs.find((r) => /Need/.test(r.text) && r.at <= anchor && anchor < r.at + r.text.length);
    const needAt = need ? need.at : anchor;
    const nameRun = runs.filter((r) => r.at + r.text.length <= needAt).pop();
    const lines: string[] = [];
    for (const r of runs) {
        if (r.at < needAt) continue;
        const t = cleanLine(r.text);
        if ((LINE_OK.test(t) || /Needed/.test(t)) && !lines.includes(t)) lines.push(t);
    }
    const panel: ItemPanel = { name: nameRun ? cleanLine(nameRun.text) : '', lines, offset: anchor };
    for (const l of lines) {
        const dm = /(\d+)\/(\d+)/.exec(l);
        if (dm && /(Durability|Arrows)/.test(l)) panel.durability = { current: Number(dm[1]), max: Number(dm[2]) };
        if (/left hand/i.test(l)) panel.hand = 'left';
        else if (/right hand/i.test(l)) panel.hand = 'right';
    }
    return panel;
}

// ------------------------------------------------------------------------------------------------- validate

export type Severity = 'error' | 'warn' | 'info';

export interface Issue {
    code: string;
    severity: Severity;
    message: string;
    /** Edits that resolve the issue when applied through the normal pending-edit path. */
    fix?: { label: string; edits: FieldEdit[] };
}

const issue = (code: string, severity: Severity, message: string, fix?: Issue['fix']): Issue => ({
    code,
    severity,
    message,
    ...(fix ? { fix } : {}),
});

export function validateSave(save: SaveFile): Issue[] {
    const out: Issue[] = [];
    const seen = new Map<string, number>();
    for (const e of save.entries) {
        if (e.type === TYPE_TEXT && e.id === LEVEL_NAME_ID) continue; // every save carries two level-name entries
        const k = `${e.type}/${e.id}/${e.sub}`;
        seen.set(k, (seen.get(k) ?? 0) + 1);
    }
    const dups = [...seen.entries()].filter(([, n]) => n > 1);
    if (dups.length) {
        out.push(
            issue(
                'duplicate-entries',
                'error',
                `${dups.length} entry key(s) (type/id/sub) occur more than once, e.g. ${dups[0]![0]}. Edits match by key and may hit the wrong one.`,
            ),
        );
    }
    const path = save.entries.find((e) => e.type === 0x400);
    const pathText = path && path.data.length > 2 ? latin1(path.data, 2, path.data.length).replace(/\u0000+$/, '') : '';
    if (!pathText) out.push(issue('level-path', 'warn', 'The level path entry (type 0x400) is missing.'));
    else if (!/\.lvl$/i.test(pathText)) {
        out.push(issue('level-path', 'warn', `The level path "${pathText}" does not end in .lvl.`));
    }
    const shot = save.entries.find((e) => e.type === 0x23);
    if (!shot) out.push(issue('thumbnail', 'info', 'No screenshot entry (type 0x23); the slot list shows no picture.'));
    else if (!decodeScreenshot(shot.data)) {
        out.push(issue('thumbnail', 'warn', 'The screenshot entry is not a 16-bit image the editor can decode.'));
    }
    try {
        for (const r of listSkills(save)) {
            if (r.level > r.max) {
                out.push(
                    issue('skill-over-max', 'error', `${r.name}: level ${r.level} exceeds its max ${r.max}.`, {
                        label: `Set ${r.name} level to ${r.max}`,
                        edits: [{ name: `skill.${r.id}`, value: r.max }],
                    }),
                );
            }
            if (r.max > 99) {
                out.push(
                    issue('skill-max', 'warn', `${r.name}: max ${r.max} is far above the 8 seen in normal saves.`),
                );
            }
        }
    } catch (e) {
        if (!(e instanceof SaveFieldError)) throw e;
        out.push(issue('skills', 'warn', `Skill table not recognised: ${e.message}`));
    }
    const players = save.entries.filter(
        (e) =>
            e.type === TYPE_RECORD && e.data.length > 23 && view(e.data).getUint32(CLASS_OFFSET, true) === RYNN_CLASS,
    );
    if (players.length === 0) {
        out.push(issue('player', 'info', 'No Rynn record in this save, so health and position cannot be edited.'));
    }
    if (players.length > 1) out.push(issue('player', 'error', `${players.length} Rynn records found; expected one.`));
    for (const p of players) {
        const dv = view(p.data);
        const raw = [dv.getFloat32(12, true), dv.getFloat32(16, true), dv.getFloat32(20, true)];
        if (raw.some((x) => !Number.isFinite(x))) {
            out.push(
                issue(
                    'player-pos',
                    'error',
                    'Rynn position holds a NaN or infinity; the game would place her at an invalid spot.',
                ),
            );
        } else if (!recordPosition(p.data)) {
            out.push(issue('player-pos', 'warn', 'Rynn position is zero or out of range.'));
        }
    }
    const gold = probeField(save, 'gold');
    if (gold.status !== 'missing' && typeof gold.value === 'number' && gold.value > 10_000_000) {
        out.push(
            issue(
                'gold-range',
                'warn',
                `Gold reads ${gold.value}; values this large come from a second record layout, not real gold.`,
            ),
        );
    }
    const hp = probeField(save, 'hp');
    if (hp.status === 'unconfirmed') {
        out.push(
            issue(
                'hp-layout',
                'info',
                'Health is read from a layout verified only for entry id 56 (needs an explicit unlock).',
            ),
        );
    }
    if (hp.status === 'ok' && typeof hp.value === 'number' && hp.value > 100_000) {
        out.push(issue('hp-range', 'warn', `Health reads ${hp.value}, which is not a plausible HP.`));
    }
    try {
        const t = progressTable(save);
        if (t.rows.length === 0)
            out.push(issue('progress', 'warn', 'The state table at the end of the text payload has no rows.'));
        const keys = new Set<number>();
        let dup = 0;
        for (const r of t.rows) {
            if (keys.has(r.key)) dup++;
            keys.add(r.key);
        }
        if (dup) out.push(issue('progress-dup', 'error', `${dup} state table key(s) repeat.`));
    } catch (e) {
        if (!(e instanceof SaveFieldError)) throw e;
    }
    const gaps = save.entries.reduce((n, e) => n + e.gap.length, 0);
    if (gaps || save.tail.length) {
        out.push(
            issue(
                'container',
                'info',
                `Container keeps ${gaps} gap byte(s) between payloads and ${save.tail.length} tail byte(s); they are preserved on save.`,
            ),
        );
    }
    return out;
}

// ------------------------------------------------------------------------------------------------- transfer

export interface TransferRow {
    name: string;
    label: string;
    from: FieldValue;
    to: FieldValue | null;
    /** Edits to apply to the destination when this row is ticked. */
    edits: FieldEdit[];
    /** Null when the row can be applied, else the reason it cannot. */
    blocked: string | null;
}

/**
 * What can move from `src` to `dst`: gold, Rynn's health, skill levels (raising max when the source level needs it)
 * and, when both saves are from the same level, the player and Arokh positions. Items are not listed: their slots
 * are not decoded (see the journal), so there is nothing safe to move.
 */
export function transferPlan(src: SaveFile, dst: SaveFile, sameLevel: boolean): TransferRow[] {
    const rows: TransferRow[] = [];
    const read = (s: SaveFile, name: string): FieldValue | null => {
        const p = probeField(s, name);
        return p.status === 'missing' ? null : p.value;
    };
    const simple = (name: string, label: string, needsSameLevel = false): void => {
        const from = read(src, name);
        if (from === null) return;
        const to = read(dst, name);
        const unconfirmed = probeField(dst, name).status === 'unconfirmed';
        rows.push({
            name,
            label,
            from,
            to,
            edits: [{ name, value: from, force: unconfirmed }],
            blocked:
                to === null
                    ? 'not present in the destination'
                    : needsSameLevel && !sameLevel
                      ? 'saves are from different levels'
                      : null,
        });
    };
    simple('gold', 'Gold');
    simple('hp', 'Health');
    try {
        const dstSkills = new Map(listSkills(dst).map((r) => [r.id, r]));
        for (const s of listSkills(src)) {
            const d = dstSkills.get(s.id);
            const edits: FieldEdit[] = [];
            if (d && s.max > d.max) edits.push({ name: `skill.${s.id}.max`, value: s.max });
            edits.push({ name: `skill.${s.id}`, value: s.level });
            rows.push({
                name: `skill.${s.id}`,
                label: `${s.name} level`,
                from: s.level,
                to: d ? d.level : null,
                edits,
                blocked: d ? null : 'skill not present in the destination',
            });
        }
    } catch (e) {
        if (!(e instanceof SaveFieldError)) throw e;
    }
    simple('pos', 'Rynn position', true);
    simple('arokh.pos', 'Arokh position', true);
    return rows;
}
