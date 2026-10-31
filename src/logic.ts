/**
 * Level logic vocabulary: the message list, which classes send and receive messages, and the enum item names the
 * engine's class definitions carry. Pure data and small helpers, no game bytes; the evidence for every entry is in
 * docs/reference/level-format.md ("Level logic") and docs/journal/2026-10-31/level-logic.md.
 *
 * Tags used in comments: [elf] item names read from the engine's property tables (string pool of the PAL executable),
 * [disc] statistics over the 14 PAL level LVLs (which classes link to which, with which message value), [inf] inference.
 */

/**
 * The message enum. Every field named "... Message" (type 7) stores an index into this list [elf]: the list sits in the
 * string pool right after the "Activate Message" property of the generator class and is shared by every message field.
 * Which message a handler understands is checked against the links that exist on the disc ([disc]): `Play Sequence` (4)
 * and `Load` (23) reach cut scene players, `Start Conversation` (28) and `Quest Complete` (18) reach conversation
 * handlers, `Move to WayPoint` (7) reaches creatures, `Unlock` (3) and `Lock` (2) reach doors, `I'm Dead` (8) is what
 * a creature sends on death and what counters decrement on.
 */
export const MESSAGE_NAMES: readonly string[] = [
    'Off',
    'On',
    'Lock',
    'Unlock',
    'Play Sequence',
    'Blow Up',
    'Triggered',
    'Move to WayPoint',
    "I'm Dead",
    'Gib',
    'Attack Linked AI',
    'Follow',
    'Make Vulnerable',
    'Make Invincible',
    'Stop Speaking',
    'Stop Following',
    'Play Next Dialog',
    'Alert AI',
    'Quest Complete',
    'Positive',
    'Negative',
    'Neutral',
    'Enrage',
    'Load',
    'Shoot',
    'Random',
    'Cyclic',
    'Simultaneous',
    'Start Conversation',
    'Attack(Stomp)',
    'Quest Initiate',
    'Item PickedUp',
    '<none>',
];

export const MESSAGE_OFF = 0;
export const MESSAGE_ON = 1;
export const MESSAGE_LOCK = 2;
export const MESSAGE_UNLOCK = 3;
export const MESSAGE_PLAY_SEQUENCE = 4;
export const MESSAGE_BLOW_UP = 5;
export const MESSAGE_TRIGGERED = 6;
export const MESSAGE_MOVE_TO_WAYPOINT = 7;
export const MESSAGE_IM_DEAD = 8;
export const MESSAGE_QUEST_COMPLETE = 18;
export const MESSAGE_LOAD = 23;
export const MESSAGE_START_CONVERSATION = 28;
export const MESSAGE_QUEST_INITIATE = 30;
export const MESSAGE_NONE = 32;

/** Name of a message value; unknown values (the data uses up to 32) read `message N`. */
export function messageName(v: number): string {
    return MESSAGE_NAMES[v] ?? `message ${v}`;
}

/** Messages worth offering first in a picker: the ones the shipped levels send to something. */
export const COMMON_MESSAGES: readonly number[] = [1, 0, 3, 2, 4, 23, 5, 7, 28, 18, 30, 8, 6];

/**
 * True for a message-valued field: an enum (type 7, not an array) whose name says message. Excludes yes/no questions
 * ("Can be Triggered by Message ?", "Pass All Other Msgs Thru?", "Send msg to LINKED objects on collision?").
 */
export function isMessageField(name: string, type: number): boolean {
    if ((type & 0xff) !== 7 || (type & 0x1000) !== 0) return false;
    if (/\?/.test(name) || /string|screen|list/i.test(name)) return false;
    return /messag|msg/i.test(name);
}

// ---------------------------------------------------------------------------------------------------------------------
// Enum item names [elf]: the property tables list the names as one comma separated string right after the field's name.
// Keyed by `<rfl class>:<field name>`; only fields whose list is unambiguous in the pool are included.

const E = (s: string): readonly string[] => s.split(',');

export const FIELD_ENUMS: Readonly<Record<string, readonly string[]>> = {
    '0x3d:Task': E(
        'Transfer Link,Enable/Disable Saving,Message Screen,No-Fly Zone,Play Sequence,Wait For Data,Trigger Only,Cave Entrance,Message,Teleport Dragon,Steal Inventory',
    ),
    '0x3d:Detect Which?': E(
        'Rynn On Ground,Rynn On Mount,Both,Rynn or Mount or NPC,Pushable,Only Linked NPCs,Mount Only',
    ),
    '0x3d:Detect Method': E('Outside To Inside,Inside To Outside'),
    '0x3d:Initial State': E('Enabled,Disabled'),
    '0x3e:Start Mode': E('Run Instantly,Run When Triggered By Any Message,Run When Triggered By Trigger On Message'),
    '0x33:List Play Order': E('In Order Once,In Order Loop,One Scene Per Trigger And Looped,Randomly,All at Once'),
    '0x33:Initial State': E('Triggered,On'),
    '0x79:Trigger Mode': E('Toggle Visibility,Depends on Message'),
    '0x07:When Triggered?': E('-1 on any message,Depends on message (below)'),
    '0x1d:Send Message When': E('Reached Top,Reached Bottom,Both,Never'),
    '0x1d:When Triggered': E('Rise,Enable,Both'),
    '0x37:Maintain Player Position': E('No,Yes'),
};

/** Item names of an enum field of the class with RFL id `rfl`, or undefined when the engine's list is not known. */
export function enumNames(rfl: number | null | undefined, name: string, type: number): readonly string[] | undefined {
    if ((type & 0xff) !== 7) return undefined;
    if (isMessageField(name, type)) return MESSAGE_NAMES;
    if (rfl === null || rfl === undefined) return undefined;
    return FIELD_ENUMS[`0x${rfl.toString(16)}:${name}`];
}

// ---------------------------------------------------------------------------------------------------------------------
// Logic classes. `rfl` is the low 16 bits of the runtime class (`OdbClass.rflClass`, level-format.md section 5).

export type LogicRole =
    | 'detector'
    | 'timer'
    | 'counter'
    | 'relay'
    | 'switch'
    | 'door'
    | 'cutscene'
    | 'movie'
    | 'conversation'
    | 'exit'
    | 'elevator'
    | 'plate'
    | 'lock'
    | 'visibility'
    | 'sound'
    | 'creature'
    | 'quest'
    | 'chest'
    | 'teleporter'
    | 'mechanism'
    | 'waypoint'
    | 'other';

export interface MessagePort {
    /** Exact class field name holding the message value. */
    field: string;
    /** Short edge label ("on", "when dead"). */
    label: string;
}

export interface LogicClass {
    rfl: number;
    role: LogicRole;
    /** Human name of the role for this class ("Trigger volume"). */
    title: string;
    /**
     * Fields holding messages this object sends to every object in its link list, in the order the editor shows them
     * (the first one is the "primary" message used for the edge label).
     */
    out: MessagePort[];
    /** Fields naming the messages this object listens for (it acts when it receives that message). */
    in: MessagePort[];
    /** Message values the class always understands, independent of fields [disc]/[inf]. */
    accepts?: number[];
    /** True when the class has a box volume (its `scale` is the box size in cells). */
    volume?: boolean;
    /** True when a link from this object only makes sense towards objects of the same class (patrol chains). */
    chain?: boolean;
    note?: string;
}

const P = (field: string, label: string): MessagePort => ({ field, label });

const creature = (rfl: number, title: string): LogicClass => ({
    rfl,
    role: 'creature',
    title,
    out: [P('Message To Send', 'when dead')],
    in: [],
    accepts: [MESSAGE_MOVE_TO_WAYPOINT, MESSAGE_BLOW_UP, 10, 22],
    note: 'Sends "Message To Send" (default I\'m Dead) to its links when it dies [disc]; "Move to WayPoint" starts its patrol [disc].',
});

export const LOGIC_CLASSES: readonly LogicClass[] = [
    {
        rfl: 0x3d,
        role: 'detector',
        title: 'Trigger volume',
        out: [P('Trigger Message', 'enters')],
        in: [P('Can be Triggered by Message ?', 'enable')],
        volume: true,
        note: 'A scaled box (a unit cube model, 1 scale = 1 cell = 2048 units). Sends Trigger Message to every link when the player (Detect Which) enters; "Detect Only Once", "Initial State" Enabled/Disabled [elf][disc].',
    },
    {
        rfl: 0x3e,
        role: 'timer',
        title: 'Timer',
        out: [P('Trigger Message', 'after delay')],
        in: [
            P('Trigger On Message', 'starts'),
            P('Disable/Re-Enable Message', 'enable/disable'),
            P('Reset Message (stops timer and reset countdown)', 'reset'),
        ],
        note: 'After "Time Until Trigger" seconds sends Trigger Message to its links. Start Mode: instantly, on any message, or on its Trigger On Message [elf][disc].',
    },
    {
        rfl: 0x07,
        role: 'counter',
        title: 'Counter',
        out: [P('Message To Send', 'at zero')],
        in: [P('Decrement (-1) Message', '-1'), P('Increment (+1) Message', '+1'), P('Reset Message', 'reset')],
        note: 'Counts down from Initial Counter Value on each Decrement message (default I\'m Dead) and sends Message To Send at zero: the "kill every enemy" gate [disc].',
    },
    {
        rfl: 0xe0,
        role: 'relay',
        title: 'Message relay',
        out: [P('Outgoing Message', 'sends')],
        in: [P('Incoming Message', 'listens')],
        note: 'Translates one message into another [elf].',
    },
    {
        rfl: 0x0d,
        role: 'switch',
        title: 'Lever / button',
        out: [P('Message to send when on', 'on'), P('Message to send when off', 'off')],
        in: [P('Activate Switch Message', 'activate'), P('Deactivate Switch Message', 'deactivate')],
        note: 'Sends the on/off message to its links when pulled [disc].',
    },
    {
        rfl: 0x13,
        role: 'door',
        title: 'Door / gate',
        out: [P('Msg Sent When Opened', 'opened'), P('Msg Sent When Closed', 'closed')],
        in: [],
        accepts: [MESSAGE_ON, MESSAGE_OFF, MESSAGE_LOCK, MESSAGE_UNLOCK],
        note: 'Locked, Auto-Open, distances. Unlock/Lock reach doors from detectors and timers on the disc [disc]; On/Off from levers (open/close) [inf].',
    },
    {
        rfl: 0x33,
        role: 'cutscene',
        title: 'Cut scene player',
        out: [],
        in: [P('Message To Play Next', 'plays next')],
        accepts: [MESSAGE_PLAY_SEQUENCE, MESSAGE_LOAD],
        note: 'Sequence List (SSD sequence ids), List Play Order, Initial State (Triggered / On). Play Sequence (4) and Load (23) start it [disc].',
    },
    {
        rfl: 0x16,
        role: 'movie',
        title: 'Movie player',
        out: [P('Message To Send When Done', 'when done'), P('Message To Send When 1 second left', '1 s left')],
        in: [],
        note: 'Plays an FMV; only the intro level has one [disc].',
    },
    {
        rfl: 0xb4,
        role: 'conversation',
        title: 'Conversation handler',
        out: [
            P('Message to send after Beginning dialog', 'begun'),
            P('Message to send after Incomplete dialog', 'incomplete'),
            P('Message to send after Complete dialog', 'complete'),
            P('Message to send after Complete w/o dialog', 'complete (skipped)'),
            P('Message to send after Done dialog', 'done'),
        ],
        in: [],
        accepts: [MESSAGE_START_CONVERSATION, MESSAGE_QUEST_COMPLETE, MESSAGE_QUEST_INITIATE],
        note: 'Quest giver state machine: five dialog exchanges, items and gold. Receives Start Conversation / Quest Complete [disc].',
    },
    {
        rfl: 0x37,
        role: 'exit',
        title: 'Level exit',
        out: [P('Send This Message', 'on exit')],
        in: [],
        note: 'Level transition: destination text, portal flag, exit sequence. The arrival marker is an exit of the destination level whose destination is this level [dec].',
    },
    {
        rfl: 0xe1,
        role: 'elevator',
        title: 'Elevator handler',
        out: [P('Send Elevator Up Outgoing Message', 'up'), P('Send Elevator Down Outgoing Message', 'down')],
        in: [
            P('Go Up Incoming Message', 'go up'),
            P('Go Down Incoming Message', 'go down'),
            P('Activate Message', 'activate'),
            P('Deactivate Message', 'deactivate'),
        ],
        note: 'Drives lift mechanisms and switch lights from lever messages [disc].',
    },
    {
        rfl: 0x1d,
        role: 'plate',
        title: 'Pressure plate',
        out: [P('Message To Send At Bottom', 'pressed'), P('Message To Send At Top', 'released')],
        in: [],
        volume: false,
        note: 'Sinks under the player; sends a message at the bottom and at the top [elf].',
    },
    {
        rfl: 0xdf,
        role: 'lock',
        title: 'Combo lock',
        out: [P('Message to Send on Success', 'solved'), P('Message to Send on Failure', 'failed')],
        in: [P('Reset Message', 'reset'), P('Activate Message', 'activate'), P('Deactivate Message', 'deactivate')],
        note: 'Solved by receiving the Message List in order [elf].',
    },
    {
        rfl: 0x22,
        role: 'lock',
        title: 'Key lock',
        out: [P('Trigger To Send', 'unlocked')],
        in: [],
        note: 'Lock Plate: opens with the item whose code matches Lock Code [elf].',
    },
    {
        rfl: 0x79,
        role: 'visibility',
        title: 'Visibility toggler',
        out: [],
        in: [P('Show Message', 'show'), P('Hide Message', 'hide')],
        note: 'Shows or hides every linked object (books, candles, props) [disc].',
    },
    {
        rfl: 0x06,
        role: 'sound',
        title: 'Sound / music',
        out: [P('Message To Send when Sound Ends', 'sound ends')],
        in: [P('Message To Send To Trigger On', 'on'), P('Message To Send To Trigger Off', 'off')],
        accepts: [MESSAGE_ON, MESSAGE_OFF],
    },
    {
        rfl: 0x68,
        role: 'quest',
        title: 'Journal entry',
        out: [],
        in: [],
        accepts: [MESSAGE_QUEST_INITIATE, MESSAGE_QUEST_COMPLETE],
        note: 'Quest journal / map entry (Journal Entry text, Map X/Y) [elf].',
    },
    {
        rfl: 0xdc,
        role: 'quest',
        title: 'Quest marker',
        out: [],
        in: [],
        note: 'Level Number + Handler ID pair that identifies a quest event (story/cinematics content) [elf].',
    },
    {
        rfl: 0xc5,
        role: 'chest',
        title: 'Chest',
        out: [],
        in: [],
        note: 'Links to the gold it spews (SackoGold objects) [disc].',
    },
    { rfl: 0xc6, role: 'teleporter', title: 'Teleporter', out: [], in: [], accepts: [MESSAGE_TRIGGERED] },
    { rfl: 0xb5, role: 'other', title: 'Proximity dialog', out: [], in: [] },
    {
        rfl: 0xd0,
        role: 'detector',
        title: 'Line-of-sight detector',
        out: [P('Trigger Message', 'sees')],
        in: [P('Can be Triggered by Message ?', 'enable')],
    },
    {
        rfl: 0x83,
        role: 'detector',
        title: 'Ambient transition',
        out: [P('Front Exit Message', 'front'), P('Back Exit Message', 'back')],
        in: [],
        note: 'Crossing it plays the linked music/ambience [disc].',
    },
    {
        rfl: 0x70,
        role: 'waypoint',
        title: 'Waypoint',
        out: [P('Message to send', 'arrives')],
        in: [],
        chain: true,
        note: 'Patrol path node; links join the waypoints of one creature [disc].',
    },
    {
        rfl: 0x23,
        role: 'mechanism',
        title: 'Mechanism',
        out: [],
        in: [],
        accepts: [MESSAGE_ON, MESSAGE_OFF],
        note: 'Moving level geometry (lifts, cranks, wheels) driven by messages [disc].',
    },
    {
        rfl: 0x25,
        role: 'mechanism',
        title: 'Prop / turret',
        out: [P('Message To Send', 'sends')],
        in: [P('Message to Switch Move-To Point', 'switch point')],
    },
    {
        rfl: 0x11,
        role: 'mechanism',
        title: 'Breakable',
        out: [P('Message To Send', 'when broken')],
        in: [],
        accepts: [MESSAGE_BLOW_UP],
    },
    creature(0x31, 'Creature'),
    creature(0x29, 'Creature'),
    creature(0x28, 'Creature'),
    creature(0x1e, 'Dragon / flyer'),
    creature(0x9d, 'Villager'),
    creature(0xad, 'Archer / shaman'),
    creature(0x44, 'Creature'),
    creature(0x52, 'Mage'),
    creature(0x3b, 'Giant'),
    creature(0x42, 'Mount'),
    creature(0xb0, 'Golem'),
    creature(0xbc, 'Lord'),
    creature(0xbd, 'Golem'),
    creature(0xc1, 'Djinn'),
    creature(0xc2, 'Sea dragon'),
];

const BY_RFL = new Map<number, LogicClass>(LOGIC_CLASSES.map((c) => [c.rfl, c]));

/** Logic description of a class by its RFL id, or undefined for a class that takes part in no logic. */
export function logicClass(rfl: number | null | undefined): LogicClass | undefined {
    return rfl === null || rfl === undefined ? undefined : BY_RFL.get(rfl);
}

/** Roles that are drawn as nodes of the logic graph by default (creatures and waypoints only when connected). */
export const CORE_ROLES: readonly LogicRole[] = [
    'detector',
    'timer',
    'counter',
    'relay',
    'switch',
    'door',
    'cutscene',
    'movie',
    'conversation',
    'exit',
    'elevator',
    'plate',
    'lock',
    'quest',
    'teleporter',
];

/** Display name of a role for the legend and filters. */
export const ROLE_LABELS: Readonly<Record<LogicRole, string>> = {
    detector: 'Trigger',
    timer: 'Timer',
    counter: 'Counter',
    relay: 'Relay',
    switch: 'Switch',
    door: 'Door',
    cutscene: 'Cut scene',
    movie: 'Movie',
    conversation: 'Conversation',
    exit: 'Exit',
    elevator: 'Elevator',
    plate: 'Plate',
    lock: 'Lock',
    visibility: 'Visibility',
    sound: 'Sound',
    creature: 'Creature',
    quest: 'Quest',
    chest: 'Chest',
    teleporter: 'Teleporter',
    mechanism: 'Mechanism',
    waypoint: 'Waypoint',
    other: 'Other',
};
