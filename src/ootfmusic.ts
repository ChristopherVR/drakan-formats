// Order of the Flame music on the PS2 engine.
// Evidence and call order: docs/journal/2026-10-31/ootf-campaign.md section 4. Facts (counts only, from the user's install):
//
//   * PC: music is placed as "Music Trigger" objects (engine class 129, 37 objects, plus differently named copies such as
//     "LairMusic"; the engine calls it "Music Detector"). A trigger is a two-sided box with `Music 1 ID` (front) and `Music 2 ID`
//     (back), 0 = stop, each with a fade in / out time (f32 seconds); nothing links to it (see `applyLevelMusic`). The ids 1..11 are the DirectMusic segments (RIFF DMSG, type 0x401) of
//     `Music.rrc`; the same file holds the DLS wave banks (ids 256..266, RIFF DLS: colh/ins/rgn/wsmp), so the segments are
//     rendered offline (`ootfdmusic.ts`). The level class "Level Properties" (engine 54, never placed: the engine reads the
//     defaults of the level ODB's first class of that engine) has `Initial Music ID`, the music the level starts with
//     (Ruined Village 8, Wartok 1, Grotto 1, Mines 9, Succubus Lair 10, ...; the Intro 0), and the interface class
//     "User Interface Properties" of `Common/Interface/Interface.odb` has `Background Music ID` 4 (the title menu) and
//     `Credits Music ID` 7.
//   * PS2: music is `PS2MUSIC.SDB` (38 mono 22050 Hz tracks, group ids 2..6 / 27 / 44) played by objects of the "Triggered
//     Music Loop" class (PS2MUSIC.ODB class 20, engine class 6, runtime 0x10006): fields `Sounds` (array of sound ids of the
//     class's own database), `Plays overlay music (Triggered only) ?`, `Fade Out Time When Stopped`, `Fade In Time When
//     Started`, `Message To Send To Trigger On` (1) / `Off` (0) and `Start State For Triggered Sounds`. Surdana places its
//     music objects the same way (sound ids as plain numbers), switched by Ambient Transitions and detectors.
//
// This module maps each (level, PC music id) to a PS2 track and rewrites the converted trigger objects. With the rendered
// OotF tracks (`OotfMusicIds`, docs/journal/2026-11-08/ootf-main-music.md) a PC id maps to its own track; the palette of
// disc tracks below is the fallback when the install's `Music.rrc` is not available.

import { floatBits, bitsFloat, decodeFieldValue, type ClassFieldDef } from './fields.ts';
import {
    FLAG_SCALED,
    addObject,
    setObjectLinks,
    setObjectParams,
    type LvlObject,
    type LvlObjectList,
    type ParamSpec,
    type Vec3,
} from './lvl.ts';
import type { PcLevel } from './pc.ts';

// ---------------------------------------------------------------- PS2 tracks

export interface Ps2MusicTrack {
    /** Sound id in PS2MUSIC.SDB. */
    id: number;
    name: string;
    /** Group (`Aachen` 2, `Goblin Forest` 3, `Northland and Ice World` 4, `Sea Land` 5, `Desert and Floating Islands` 6, ...). */
    group: number;
    /** Descriptor flag 0x8: the sample itself loops. */
    loops: boolean;
    /** ADPCM bytes (length ~ bytes * 28 / 16 / 22050 s). */
    adpcm: number;
    role: 'ambient' | 'action' | 'stinger';
}

const T = (
    id: number,
    name: string,
    group: number,
    loops: boolean,
    adpcm: number,
    role: Ps2MusicTrack['role'],
): [number, Ps2MusicTrack] => [id, { id, name, group, loops, adpcm, role }];

/** The PS2 tracks the palettes draw from (ids and sizes read from the PAL disc's PS2MUSIC.SDB). */
export const PS2_TRACKS: ReadonlyMap<number, Ps2MusicTrack> = new Map([
    T(86, 'DualDragons', 2, true, 777408, 'action'),
    T(87, 'SkeletonKing', 2, true, 2206880, 'action'),
    T(88, 'SurdanaMedium', 2, false, 2186992, 'ambient'),
    T(89, 'SurdanaTown1', 2, false, 2401760, 'ambient'),
    T(91, 'SurdanaTown2', 2, false, 2708464, 'ambient'),
    T(93, 'DesertDroneHigh', 6, false, 3042064, 'ambient'),
    T(98, 'FloatingIslandsMedium', 6, false, 2315488, 'ambient'),
    T(101, 'GoblinAmbient', 3, true, 4440352, 'ambient'),
    T(105, 'HalfMenBase', 4, false, 2436448, 'action'),
    T(106, 'Malguk', 4, true, 781712, 'action'),
    T(107, 'NorthAction', 4, false, 2385104, 'action'),
    T(108, 'NorthMedium', 4, false, 2426496, 'ambient'),
    T(109, 'NorthSuperAmbient', 4, false, 4028000, 'ambient'),
    T(113, 'SeaHigh', 5, true, 2373248, 'action'),
    T(115, 'SeaLow', 5, false, 2201472, 'ambient'),
    T(116, 'SeaMedium', 5, false, 1682064, 'ambient'),
    T(117, 'SeaSupAmb1', 5, false, 1185984, 'ambient'),
    T(119, 'SeaSupAmb3', 5, false, 884144, 'ambient'),
    T(120, 'Wavedancer', 5, true, 837088, 'action'),
    T(189, 'JasadDuthane (master)', 6, true, 2280000, 'action'),
]);

export const trackSeconds = (t: Ps2MusicTrack): number => (t.adpcm / 16) * (28 / 22050);

// ---------------------------------------------------------------- palettes

export interface MusicPalette {
    /** Matches the lower-case PC level path. */
    match: RegExp;
    /** Tracks for Music 1 ID (the bed), chosen by `(pcId - 1) mod length`. */
    bed: readonly number[];
    /** Tracks for Music 2 ID (the overlay: combat, danger, set pieces). */
    overlay: readonly number[];
}

/**
 * Per level: ground stays on the world's own PS2 group (Mountain: Surdana / Goblin Forest / Northland, Islands and Rift: Sea Land
 * and Floating Islands, Volcanic: Desert), set pieces use the loop-flagged action tracks. Order matters: first match wins.
 */
export const MUSIC_PALETTES: readonly MusicPalette[] = [
    { match: /intro level\/intro\.lvl$/, bed: [91], overlay: [87] },
    { match: /ruined village book/, bed: [91], overlay: [87] },
    { match: /ruined village\//, bed: [89, 88, 91], overlay: [105, 87] },
    { match: /wartok/, bed: [93, 88], overlay: [86, 105] },
    { match: /grimstone mines|mines\.lvl/, bed: [109, 108], overlay: [105, 107] },
    { match: /grotto/, bed: [101, 109], overlay: [106, 105] },
    { match: /islands night/, bed: [115, 117], overlay: [120, 113] },
    { match: /alwarren/, bed: [98, 116], overlay: [120, 113] },
    { match: /rift crystal/, bed: [117, 119], overlay: [113, 120] },
    { match: /succubus lair/, bed: [119, 115], overlay: [87, 86] },
    { match: /islands world\//, bed: [116, 98, 115], overlay: [113, 120] },
    { match: /volcanic/, bed: [93, 109], overlay: [86, 87] },
    { match: /rift world/, bed: [189, 93], overlay: [87, 86] },
];

const FALLBACK: MusicPalette = { match: /./, bed: [88], overlay: [87] };

export function paletteFor(levelPath: string): MusicPalette {
    const p = levelPath.replace(/\\/g, '/').toLowerCase();
    return MUSIC_PALETTES.find((m) => m.match.test(p)) ?? FALLBACK;
}

/** PS2 sound id for PC music id `pcId` (1..11) of `slot` (1 bed, 2 overlay) in a level. */
export function trackFor(levelPath: string, slot: 1 | 2, pcId: number): number {
    const list = slot === 1 ? paletteFor(levelPath).bed : paletteFor(levelPath).overlay;
    return list[(Math.max(1, pcId) - 1) % list.length]!;
}

// ---------------------------------------------------------------- PC triggers

export interface MusicTrigger {
    objectId: number;
    className: string;
    pos: Vec3;
    rot: Vec3;
    links: number[];
    music1: number;
    music2: number;
    fadeOut1: number;
    fadeIn1: number;
    fadeOut2: number;
    fadeIn2: number;
}

const F_MUSIC1 = /^music 1 id/i;
const F_MUSIC2 = /^music 2 id/i;

/** PC classes (by name) that are music triggers: a field `Music 1 ID` and `Music 2 ID`. */
export function musicTriggerClassNames(pc: PcLevel): string[] {
    const names = new Set<string>();
    for (const t of pc.classes.values())
        for (const c of t.values())
            if (c.fields?.some((f) => F_MUSIC1.test(f.name)) && c.fields.some((f) => F_MUSIC2.test(f.name)))
                names.add(c.name);
    return [...names];
}

/** The music trigger objects of a PC level with their effective values (object override, else class default). */
export function findMusicTriggers(pc: PcLevel): MusicTrigger[] {
    const out: MusicTrigger[] = [];
    for (const o of pc.list.objects) {
        const c = pc.classes.get(o.dbIndex)?.get(o.classId);
        if (!c?.fields || !c.data) continue;
        if (!c.fields.some((f) => F_MUSIC1.test(f.name)) || !c.fields.some((f) => F_MUSIC2.test(f.name))) continue;
        const get = (re: RegExp, dflt: number): number => {
            const pi = o.params.findIndex((p) => re.test(p.name));
            if (pi >= 0) return Number(decodeFieldValue(o.params[pi]!.type, o.data[pi]!, o.data));
            const fi = c.fields!.findIndex((f) => re.test(f.name));
            return fi < 0 ? dflt : Number(decodeFieldValue(c.fields![fi]!.type, c.data![fi]!, c.data!));
        };
        out.push({
            objectId: o.id,
            className: c.name,
            pos: [...o.pos],
            rot: [...o.rot],
            links: [...o.links],
            music1: get(F_MUSIC1, 0),
            music2: get(F_MUSIC2, 0),
            fadeOut1: get(/^music 1 fade out/i, 3),
            fadeIn1: get(/^music 1 fade in/i, 3),
            fadeOut2: get(/^music 2 fade out/i, 3),
            fadeIn2: get(/^music 2 fade in/i, 3),
        });
    }
    return out;
}

// ---------------------------------------------------------------- applying to the converted list
//
// PC: a Music Trigger ("Music Detector" in the engine) is a two-sided box (the detector box model, +-0.5 model units scaled
// by the object, the same box as the Ambient Transition's) that the engine watches itself (no links): leaving it on the
// front side plays `Music 1 ID`, on the back side `Music 2 ID`, and 0 stops the music (a 0 / 0 trigger exists: Succubus
// Lair 3625). Front is the side an Ambient Transition of the same rotation calls front: Wartok's eight cave triggers each
// sit next to an Ambient Transition, and Music 1 (the cave music) is always on that transition's cave sound side.
//
// PS2: music is Triggered Music Loops switched by messages: each loop listens for its own `Message To Send To Trigger On`
// and the common Off (0) (Surdana: 1 or 19, and 0). The PS2 Ambient Transition (engine 131, Surdana's music switch) sends
// one message per side, and in game only the first of several transitions on the same box ever fires (the engine follows
// one transition at a time), so it cannot both stop the old music and start the new one. Trigger Detectors are
// independent: each trigger box becomes two halves, front and back of the mid plane (the PS2 front is local +z, world
// (cos ry, 0, sin ry) for a yaw-only rotation, measured in game), and each half holds an "off" detector (Off to every
// loop but its music) and an "on" detector (that loop's On message). Entering a half switches to its music, so the
// switch happens at the mid plane in both directions, like the PC exit side. Rotation and size stay the PC box's; a half
// is at least `MIN_HALF` model units thick so a fast player cannot step over it. Both classes are template classes
// (FX / PS2MUSIC are LEVEL1NA dependencies), so no class is appended. docs/journal/2026-11-08/ootf-level-music-triggers.md

export interface MusicClassRef {
    /** `Triggered Music Loop` of PS2MUSIC.ODB: db index in the level's dependency table (14 in LEVEL1NA) and class id (20). */
    dbIndex: number;
    classId: number;
    fields: readonly ClassFieldDef[];
}

/** Messages the music loops of a level listen for to start, one per PC music id (Off = 0 stops every loop). */
export const MUSIC_ON_MESSAGES: readonly number[] = [1, 19, 20, 21, 10, 11, 12, 13, 14, 15, 16, 17, 22];
/** Off: every loop stops on it (the class default `Message To Send To Trigger Off`). */
export const MUSIC_OFF_MESSAGE = 0;
/** Thinnest half box (model units, 2048 world units each) of a converted trigger. */
export const MIN_HALF = 0.25;
const MODEL_UNIT = 2048;

export interface LevelMusicOptions {
    musicClass: MusicClassRef;
    /** The PS2 Trigger Detector class (engine 61) the trigger boxes become; null = the triggers are dropped. */
    detectorClass: MusicClassRef | null;
    /** Level key for the palette fallback (`trackFor`). */
    levelPath: string;
    /** PC music id the level starts with (`pcInitialMusicId`), 0 = none. */
    initialPcId: number;
    /** Where the music loops sit (Rynn's start; the loops play everywhere). */
    loopPos: Vec3;
    /** PC music id -> PS2MUSIC.SDB sound id of the rendered OotF track; ids it lacks fall back to the palette. */
    trackIds?: ReadonlyMap<number, number>;
    /** Database bits of the sound refs (default 0: the class's own database, PS2MUSIC.SDB, like Surdana's music objects). */
    soundDb?: number;
}

export interface LevelMusicResult {
    /** PC music id -> object id of its Triggered Music Loop. */
    loops: Map<number, number>;
    /** PC music id -> PS2 track id. */
    tracks: Map<number, number>;
    /** Detector objects written (the converted trigger objects reused plus the added ones). */
    detectors: number;
    /** Triggers whose converted object was missing (placed from the PC transform). */
    missing: number;
    /** Triggers dropped (no detector class). */
    dropped: number;
    warnings: string[];
}

type Values = readonly (readonly [RegExp, number | number[]])[];

function specsOf(fields: readonly ClassFieldDef[], values: Values): ParamSpec[] {
    const out: ParamSpec[] = [];
    for (const [re, value] of values) {
        const i = fields.findIndex((f) => re.test(f.name.trim()));
        if (i < 0) continue;
        const f = fields[i]!;
        out.push({ fieldIndex: i, type: f.type, name: f.name, value });
    }
    return out;
}

function loopSpecs(
    fields: readonly ClassFieldDef[],
    track: number,
    soundDb: number,
    fade: { fadeIn: number; fadeOut: number },
    on: boolean,
    onMessage?: number,
): ParamSpec[] {
    const v: [RegExp, number | number[]][] = [
        [/^sounds$/i, [((soundDb << 16) | track) >>> 0]],
        [/^plays overlay music/i, 0],
        [/^fade out time when stopped/i, fade.fadeOut],
        [/^fade in time when started/i, fade.fadeIn],
    ];
    if (onMessage !== undefined) {
        v.push([/^message to send to trigger on$/i, onMessage]);
        v.push([/^message to send to trigger off$/i, MUSIC_OFF_MESSAGE]);
    }
    if (on) v.push([/^start state for triggered/i, 1]);
    return specsOf(fields, v);
}

function retarget(o: LvlObject, c: MusicClassRef): void {
    o.classId = c.classId;
    o.dbIndex = c.dbIndex;
    o.radius = null;
    o.flags &= ~0x10;
    o.flags &= ~FLAG_SCALED;
    o.scale = null;
}

const nextId = (list: LvlObjectList): number => list.objects.reduce((m, o) => Math.max(m, o.id), 0) + 1;

/** World direction of a box's local +z (its front) for LVL rotation degrees; yaw only (pitch and roll are ignored). */
export function boxFront(rot: readonly number[]): Vec3 {
    const r = ((rot[1] ?? 0) * Math.PI) / 180;
    return [Math.cos(r), 0, Math.sin(r)];
}

/** The two half boxes of a trigger box: centre and scale (model units) of the front half and of the back half. */
export function triggerHalves(
    pos: readonly number[],
    rot: readonly number[],
    scale: readonly number[] | null,
): { front: { pos: Vec3; scale: Vec3 }; back: { pos: Vec3; scale: Vec3 } } {
    const s = scale ?? [1, 1, 1];
    const half = Math.max(s[2]! / 2, MIN_HALF);
    const n = boxFront(rot);
    const at = (sign: number): Vec3 => [0, 1, 2].map((k) => pos[k]! + (sign * n[k]! * half * MODEL_UNIT) / 2) as Vec3;
    const sc: Vec3 = [s[0]!, s[1]!, half];
    return { front: { pos: at(1), scale: [...sc] }, back: { pos: at(-1), scale: [...sc] } };
}

/**
 * Give a converted level its music: one Triggered Music Loop per PC music id (the start music on from the start) and the
 * PC Music Trigger boxes as Trigger Detectors that switch them (see the comment above). The converted trigger object (kept
 * by the class resolver) is reused for the first detector; a trigger without one uses its PC transform.
 */
export function applyLevelMusic(
    list: LvlObjectList,
    triggers: readonly MusicTrigger[],
    opt: LevelMusicOptions,
): LevelMusicResult {
    const res: LevelMusicResult = {
        loops: new Map(),
        tracks: new Map(),
        detectors: 0,
        missing: 0,
        dropped: 0,
        warnings: [],
    };
    const soundDb = opt.soundDb ?? 0;
    const dc = opt.detectorClass;
    const live = dc ? triggers : [];
    if (!dc && triggers.length) {
        res.dropped = triggers.length;
        res.warnings.push(`${triggers.length} music trigger(s) dropped: the template has no Trigger Detector class`);
    }
    // PC ids in order of first use (start music first), with the fades of the first slot that plays them.
    const ids = new Map<number, { slot: 1 | 2; fadeIn: number; fadeOut: number }>();
    // The start music only plays a rendered track (without Music.rrc the level keeps no start music, as before).
    if (opt.initialPcId > 0 && opt.trackIds?.has(opt.initialPcId))
        ids.set(opt.initialPcId, { slot: 1, fadeIn: 3, fadeOut: 3 });
    for (const t of live) {
        if (t.music1 > 0 && !ids.has(t.music1)) ids.set(t.music1, { slot: 1, fadeIn: t.fadeIn1, fadeOut: t.fadeOut1 });
        if (t.music2 > 0 && !ids.has(t.music2)) ids.set(t.music2, { slot: 2, fadeIn: t.fadeIn2, fadeOut: t.fadeOut2 });
    }
    const onMessage = new Map<number, number>();
    for (const [pcId, s] of ids) {
        const k = onMessage.size;
        if (k >= MUSIC_ON_MESSAGES.length) {
            res.warnings.push(
                `music ${pcId}: more than ${MUSIC_ON_MESSAGES.length} music ids in one level; not placed`,
            );
            continue;
        }
        const track = opt.trackIds?.get(pcId) ?? trackFor(opt.levelPath, s.slot, pcId);
        const obj = addObject(list, {
            classId: opt.musicClass.classId,
            dbIndex: opt.musicClass.dbIndex,
            pos: opt.loopPos,
            rot: [0, 0, 0],
            id: nextId(list),
        }).object;
        retarget(obj, opt.musicClass);
        const msg = MUSIC_ON_MESSAGES[k]!;
        onMessage.set(pcId, msg);
        // Without triggers the loop needs no messages (the level start music alone keeps the class defaults).
        const specs = loopSpecs(
            opt.musicClass.fields,
            track,
            soundDb,
            s,
            pcId === opt.initialPcId,
            live.length ? msg : undefined,
        );
        setObjectParams(list, obj.id, specs);
        res.loops.set(pcId, obj.id);
        res.tracks.set(pcId, track);
    }
    if (!dc) return res;
    const allLoops = [...res.loops.values()];
    for (const t of live) {
        const box = list.objects.find((o) => o.id === t.objectId);
        if (!box) res.missing++;
        const pos = box ? box.pos : t.pos;
        const rot = box ? box.rot : t.rot;
        const halves = triggerHalves(pos, rot, box ? box.scale : null);
        let reuse = box;
        for (const [side, pcId] of [
            ['front', t.music1],
            ['back', t.music2],
        ] as const) {
            const loop = pcId > 0 ? res.loops.get(pcId) : undefined;
            const parts: { links: number[]; message: number }[] = [
                { links: allLoops.filter((id) => id !== loop), message: MUSIC_OFF_MESSAGE },
            ];
            if (loop !== undefined) parts.push({ links: [loop], message: onMessage.get(pcId)! });
            for (const p of parts) {
                if (!p.links.length) continue;
                const h = halves[side];
                let obj: LvlObject;
                if (reuse) {
                    obj = reuse;
                    reuse = undefined;
                    obj.classId = dc.classId;
                    obj.dbIndex = dc.dbIndex;
                    obj.pos = [...h.pos];
                } else {
                    obj = addObject(list, {
                        classId: dc.classId,
                        dbIndex: dc.dbIndex,
                        pos: h.pos,
                        rot,
                        id: nextId(list),
                    }).object;
                }
                obj.rot = [...rot] as Vec3;
                obj.flags = (obj.flags | FLAG_SCALED | 0x01) & ~0x10;
                obj.radius = null;
                obj.scale = [...h.scale];
                setObjectLinks(list, obj.id, p.links);
                setObjectParams(
                    list,
                    obj.id,
                    specsOf(dc.fields, [
                        [/^task$/i, 6],
                        [/^trigger message$/i, p.message],
                        [/^detect only once\?$/i, 0],
                    ]),
                );
                res.detectors++;
            }
        }
        if (reuse) {
            // Nothing to switch (a 0 / 0 trigger in a level without music): the converted object goes.
            list.objects.splice(list.objects.indexOf(reuse), 1);
        }
    }
    return res;
}

// ---------------------------------------------------------------- level start and interface music

const F_INITIAL = /^initial music id/i;

/** A class default as a number (0 when the field is missing). */
function classNumber(
    c: { fields?: readonly ClassFieldDef[] | null; data?: readonly number[] | null },
    re: RegExp,
): number {
    const i = c.fields?.findIndex((f) => re.test(f.name.trim())) ?? -1;
    if (i < 0 || !c.data) return 0;
    return Number(decodeFieldValue(c.fields![i]!.type, c.data[i] ?? 0, c.data)) || 0;
}

/**
 * The PC music id a level starts with: `Initial Music ID` of its Level Properties class (engine 54), the first such class in
 * dependency order, the same class `ensureSingletons` copies the other level properties from. 0 = none.
 */
export function pcInitialMusicId(pc: PcLevel): number {
    for (const table of [...pc.classes].sort((a, b) => a[0] - b[0]).map((x) => x[1]))
        for (const c of table.values()) if (c.rflClass === 54) return classNumber(c, F_INITIAL);
    return 0;
}

/** `Background Music ID` (title menu) and `Credits Music ID` of the PC `User Interface Properties` class, 0 when absent. */
export function pcInterfaceMusic(
    classes: ReadonlyMap<number, { fields?: readonly ClassFieldDef[] | null; data?: readonly number[] | null }>,
): {
    background: number;
    credits: number;
} {
    for (const c of classes.values()) {
        const background = classNumber(c, /^background music id/i);
        const credits = classNumber(c, /^credits music id/i);
        if (background || credits) return { background, credits };
    }
    return { background: 0, credits: 0 };
}

/**
 * Add a Triggered Music Loop that is on from the start (Start State 1) playing the level's initial music. On the PC the level
 * property starts it; the PS2 class has no level-wide field the engine reads (every disc level leaves `Initial Music File` 0
 * and places music objects), so the object carries it. Returns the new object id or null (no music / no track).
 */
export function addLevelStartMusic(
    list: LvlObjectList,
    pcId: number,
    pos: Vec3,
    opt: { musicClass: MusicClassRef; trackIds: ReadonlyMap<number, number>; soundDb?: number },
): number | null {
    const r = applyLevelMusic(list, [], {
        ...opt,
        detectorClass: null,
        levelPath: '',
        initialPcId: pcId,
        loopPos: pos,
    });
    return r.loops.get(pcId) ?? null;
}

/** Round-trip helper for tests: the f32 seconds of a stored fade dword. */
export const fadeSeconds = (dword: number): number => bitsFloat(dword);
export const fadeBits = (seconds: number): number => floatBits(seconds);
