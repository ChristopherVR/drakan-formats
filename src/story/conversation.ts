// Conversations: the "Conversation Handler" class (runtime class 0x100b4) and the dialog line classes it points at
// (runtime class 0x100ba, `Greeting`, `Farmer - C103FA01`, ...). Both are ordinary ODB classes of the level's own ODB, so
// everything is read with `parseOdbClasses` and edited with `patchClassData` (odbwrite.ts).
// Evidence: docs/reference/level-format.md "Cut scenes, conversations and sequences".
//
// Proven (LEVEL1ON: 232 dialog line classes, 6 handler classes, 52 placed handlers in LEVEL1NA; 14 levels read):
//   - dialog line `Sound` (array, usually one element) is `(db << 16) | id` into the level's SDB (db 0 = its own `.SDB`);
//     228 of 232 resolve to a sound whose descriptor carries the line's subtitle; the class name is `<speaker> - <sound
//     name>` (`Farmer - C103FA01` -> sound `C103FA01`).
//   - dialog line `Animation` (array) is the ADB animation the speaker plays (id 3009 = talking, 1526 = Rynn).
//   - the handler fields are arrays of dialog line classes per phase: Beginning / Incomplete / Complete / Complete
//     without beginning / Done; a placed handler overrides them per instance (object parameters).
// Inferred: `Sound Play Mode` 1 = the sound list is played as one spoken exchange (several clips), 0 = one clip;
// `Camera Position` enum values (1 Rynn, 5 speaker, ...) and the message numbers (1 = start the quest, 18 = complete).

import { decodeFieldValue, refParts, type ClassFieldDef } from '../fields.ts';
import type { OdbClass } from '../odb.ts';

export const RUNTIME_CONVERSATION_HANDLER = 0x100b4;
export const RUNTIME_DIALOG_LINE = 0x100ba;
export const RUNTIME_STOMP_PLAYER = 0x10033;

export const isDialogLine = (c: Pick<OdbClass, 'runtimeClass'>): boolean => c.runtimeClass === RUNTIME_DIALOG_LINE;
export const isConversationHandler = (c: Pick<OdbClass, 'runtimeClass'>): boolean =>
    c.runtimeClass === RUNTIME_CONVERSATION_HANDLER;

type WithFields = Pick<OdbClass, 'fields' | 'data'>;

function index(c: WithFields, name: string): number {
    return c.fields?.findIndex((f) => f.name === name) ?? -1;
}

function scalar(c: WithFields, name: string, dflt = 0): number {
    const i = index(c, name);
    return i < 0 || !c.data ? dflt : c.data[i]!;
}

/** Array field: element values (raw dwords) and the data-area index of the first element (-1 when empty / missing). */
function array(c: WithFields, name: string): { values: number[]; at: number } {
    const i = index(c, name);
    if (i < 0 || !c.data || !c.fields) return { values: [], at: -1 };
    const word = c.data[i]!;
    const v = decodeFieldValue(c.fields[i]!.type, word, c.data) as number[];
    return { values: Array.isArray(v) ? v : [], at: word & 0xffff };
}

export interface DialogLine {
    classId: number;
    /** Class name (`Farmer - C103FA01`). */
    name: string;
    /** Part of the name before ` - `, or the whole name for generic lines (`Greeting`). */
    speaker: string;
    /** Sound refs `(db << 16) | id`. */
    sounds: number[];
    animations: number[];
    delay: number;
    headAnimation: boolean;
    playMode: number;
    /** Camera position enum, the transition enum and the distances (inferred meanings). */
    camera: { position: number; transition: number; transitionTime: number };
    debugText: string;
    /** Data-area index of the first sound element, for `dialogLineSoundEdit` (-1 when no sound array). */
    soundAt: number;
}

export function parseDialogLine(c: OdbClass): DialogLine | null {
    if (!c.fields || !c.data || !isDialogLine(c)) return null;
    const dash = c.name.indexOf(' - ');
    const sounds = array(c, 'Sound');
    const dbg = index(c, 'Debug Text');
    return {
        classId: c.id,
        name: c.name,
        speaker: dash > 0 ? c.name.slice(0, dash) : c.name,
        sounds: sounds.values,
        animations: array(c, 'Animation').values,
        delay: decodeFieldValue(2, scalar(c, 'Delay'), c.data) as number,
        headAnimation: scalar(c, 'Maintain special head animation during anim?') !== 0,
        playMode: scalar(c, 'Sound Play Mode'),
        camera: {
            position: scalar(c, 'Camera Position'),
            transition: scalar(c, 'Camera Transition'),
            transitionTime: decodeFieldValue(
                2,
                scalar(c, 'Time to Transition Camera (sec) (0 = default)'),
                c.data,
            ) as number,
        },
        debugText: dbg < 0 ? '' : (decodeFieldValue(c.fields[dbg]!.type, c.data[dbg]!, c.data) as string),
        soundAt: sounds.at,
    };
}

/** `dialogLine.soundAt` edit: `ref` for element `i` of the sound array, as a map for `patchClassData`. */
export function dialogLineSoundEdit(line: DialogLine, i: number, ref: number): Map<number, number> {
    if (line.soundAt < 0 || i < 0 || i >= line.sounds.length) throw new Error('dialog line has no such sound element');
    return new Map([[line.soundAt + i, ref >>> 0]]);
}

export const HANDLER_PHASES = [
    {
        key: 'beginning',
        label: 'Beginning',
        field: 'Beginning Dialog Exchange',
        message: 'Message to send after Beginning dialog',
    },
    {
        key: 'incomplete',
        label: 'Incomplete',
        field: 'Incomplete Dialog Eschange',
        message: 'Message to send after Incomplete dialog',
    },
    {
        key: 'complete',
        label: 'Complete',
        field: 'Complete Dialogs Eschange',
        message: 'Message to send after Complete dialog',
    },
    {
        key: 'completeNoBegin',
        label: 'Complete without beginning',
        field: 'Completed w/o beginning Dialogs Eschange',
        message: 'Message to send after Complete w/o dialog',
    },
    { key: 'done', label: 'Done', field: 'Done Dialogs Exchange', message: 'Message to send after Done dialog' },
] as const;

export type HandlerPhaseKey = (typeof HANDLER_PHASES)[number]['key'];

export interface HandlerPhase {
    key: HandlerPhaseKey;
    label: string;
    /** Dialog line class refs `(db << 16) | class id` (db 0 = the level's own ODB), played in order. */
    lines: number[];
    /** Message sent to the linked objects after the phase (0 = none). */
    message: number;
}

export interface ConversationHandler {
    classId: number;
    name: string;
    phases: HandlerPhase[];
    initiallyActive: boolean;
    distance: number;
    hasQuest: boolean;
    goldOnComplete: number;
    /** Item class refs the player has to bring / gets (inferred from the field names; not decoded further). */
    itemsToGetBegin: number[];
    itemsToGiveBegin: number[];
    itemsToGetComplete: number[];
    itemsToGiveComplete: number[];
}

/** Handler defaults of a class. `override` supplies an instance's parameter values by field name (arrays as dword lists). */
export function parseConversationHandler(
    c: OdbClass,
    override: ReadonlyMap<string, number | number[]> = new Map(),
): ConversationHandler | null {
    if (!c.fields || !c.data || !isConversationHandler(c)) return null;
    const num = (name: string): number => {
        const o = override.get(name);
        return typeof o === 'number' ? o : scalar(c, name);
    };
    const arr = (name: string): number[] => {
        const o = override.get(name);
        return Array.isArray(o) ? o : array(c, name).values;
    };
    return {
        classId: c.id,
        name: c.name,
        phases: HANDLER_PHASES.map((p) => ({
            key: p.key,
            label: p.label,
            lines: arr(p.field),
            message: num(p.message),
        })),
        initiallyActive: num('Initially active?') !== 0,
        distance: decodeFieldValue(2, num('Distance From Rynn'), c.data) as number,
        hasQuest: num('Is there a quest?') !== 0,
        goldOnComplete: num('Gold to give when complete') | 0,
        itemsToGetBegin: arr('Items to get from Rynn when beginning'),
        itemsToGiveBegin: arr('Items to give to Rynn when beginning'),
        itemsToGetComplete: arr('Items to get from Rynn when complete'),
        itemsToGiveComplete: arr('Items to give to Rynn when complete'),
    };
}

/** Class id of a phase line ref: db 0 = same ODB (other dbs are resolved by the caller through the ODB's .DB list). */
export const lineClassId = (ref: number): number => refParts(ref).id;

/** The speaker / sound name pair of a class name `Speaker - NAME`. */
export function splitLineName(name: string): { speaker: string; sound: string } {
    const m = /^(.*?)\s+-\s+(\S+?)(?:\s+-\s+.*)?$/.exec(name);
    return m ? { speaker: m[1]!, sound: m[2]! } : { speaker: name, sound: '' };
}

export type FieldDefs = readonly ClassFieldDef[];
