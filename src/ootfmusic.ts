// Order of the Flame music on the PS2 engine.
// Evidence and call order: docs/journal/2026-10-31/ootf-campaign.md section 4. Facts (counts only, from the user's install):
//
//   * PC: music is placed as "Music Trigger" objects (engine class 129, 37 objects, plus differently named copies such as
//     "LairMusic"). A trigger has two slots, `Music 1 ID` and `Music 2 ID` (0 = none), each with a fade in / out time (f32 seconds),
//     and is switched by messages from linked detectors. The ids 1..11 are the DirectMusic segments (RIFF DMSG, type 0x401) of
//     `Music.rrc`; the same file holds the DLS wave banks (ids 256..266, RIFF DLS: colh/ins/rgn/wsmp), so the segments CAN be
//     rendered offline (the DLS banks are in the install; ootf-sound.md assumed they were not). The PC level class has no
//     "Initial Music File" field in this install; level start music comes from triggers near the start.
//   * PS2: music is `PS2MUSIC.SDB` (38 mono 22050 Hz tracks, group ids 2..6 / 27 / 44) played by objects of the "Triggered
//     Music Loop" class (PS2MUSIC.ODB class 20, engine class 6, runtime 0x10006): fields `Sounds` (array of sound ids of the
//     class's own database), `Plays overlay music (Triggered only) ?`, `Fade Out Time When Stopped`, `Fade In Time When
//     Started`, `Message To Send To Trigger On` (1) / `Off` (0) and `Start State For Triggered Sounds`. Surdana places its
//     music objects the same way (sound ids as plain numbers, switched by linked detectors).
//
// This module picks the PS2 track of each (level, PC music id) and rewrites the converted trigger objects. Rendering the real
// DirectMusic segments is phase 2 (see the journal note); the palette below is the concrete, shippable result today.

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

export interface MusicClassRef {
    /** `Triggered Music Loop` of PS2MUSIC.ODB: db index in the level's dependency table (14 in LEVEL1NA) and class id (20). */
    dbIndex: number;
    classId: number;
    fields: readonly ClassFieldDef[];
}

export interface ApplyMusicOptions {
    musicClass: MusicClassRef;
    /** Database bits of the sound refs (default 0: the class's own database, PS2MUSIC.SDB, like Surdana's music objects). */
    soundDb?: number;
    /** Set `Start State For Triggered Sounds` to 1 so the track plays as soon as the level is up (in-game test aid; PC music is started by detectors). */
    startOn?: boolean;
}

export interface ApplyMusicResult {
    /** Converted trigger objects switched to the music class (first slot). */
    replaced: number;
    /** Second-slot objects added (the overlay), linked from the same detectors. */
    added: number;
    /** Triggers with both slots 0 (a "stop music" trigger; no PS2 equivalent placed). */
    silent: number;
    /** Track ids used: id -> times. */
    tracks: Map<number, number>;
}

function specsFor(
    fields: readonly ClassFieldDef[],
    track: number,
    soundDb: number,
    overlay: boolean,
    fadeIn: number,
    fadeOut: number,
    startOn = false,
): ParamSpec[] {
    const out: ParamSpec[] = [];
    const add = (re: RegExp, value: number | number[]): void => {
        const i = fields.findIndex((f) => re.test(f.name.trim()));
        if (i < 0) return;
        const f = fields[i]!;
        out.push({ fieldIndex: i, type: f.type, name: f.name, value });
    };
    add(/^sounds$/i, [((soundDb << 16) | track) >>> 0]);
    add(/^plays overlay music/i, overlay ? 1 : 0);
    add(/^fade out time when stopped/i, fadeOut);
    add(/^fade in time when started/i, fadeIn);
    if (startOn) add(/^start state for triggered/i, 1);
    return out;
}

function retarget(o: LvlObject, c: MusicClassRef): void {
    o.classId = c.classId;
    o.dbIndex = c.dbIndex;
    o.flags &= ~FLAG_SCALED;
    o.scale = null;
    o.radius = null;
    o.flags &= ~0x10;
}

/**
 * Turn the converted trigger objects into PS2 music objects. The converter must have kept the objects (map the trigger classes
 * with `musicTriggerClassNames` to the music class in `ConvertOptions.classOverrides`, so ids and detector links survive);
 * a trigger whose object is missing is added at its position without links. Slot 1 reuses the object, slot 2 becomes a new
 * object that every object linking to the trigger also links to.
 */
export function applyMusicTriggers(
    list: LvlObjectList,
    triggers: readonly MusicTrigger[],
    levelPath: string,
    opt: ApplyMusicOptions,
): ApplyMusicResult {
    const res: ApplyMusicResult = { replaced: 0, added: 0, silent: 0, tracks: new Map() };
    const soundDb = opt.soundDb ?? 0;
    const use = (t: number): number => (res.tracks.set(t, (res.tracks.get(t) ?? 0) + 1), t);
    for (const t of triggers) {
        const slots: { slot: 1 | 2; id: number; fadeIn: number; fadeOut: number }[] = [];
        if (t.music1 > 0) slots.push({ slot: 1, id: t.music1, fadeIn: t.fadeIn1, fadeOut: t.fadeOut1 });
        if (t.music2 > 0) slots.push({ slot: 2, id: t.music2, fadeIn: t.fadeIn2, fadeOut: t.fadeOut2 });
        if (!slots.length) {
            res.silent++;
            continue;
        }
        let first = list.objects.find((o) => o.id === t.objectId);
        slots.forEach((s, k) => {
            const track = use(trackFor(levelPath, s.slot, s.id));
            const specs = specsFor(
                opt.musicClass.fields,
                track,
                soundDb,
                s.slot === 2,
                s.fadeIn,
                s.fadeOut,
                opt.startOn,
            );
            let obj: LvlObject;
            if (k === 0 && first) {
                obj = first;
                retarget(obj, opt.musicClass);
                res.replaced++;
            } else {
                const maxId = list.objects.reduce((m, o) => Math.max(m, o.id), 0);
                obj = addObject(list, {
                    classId: opt.musicClass.classId,
                    dbIndex: opt.musicClass.dbIndex,
                    pos: t.pos,
                    rot: t.rot,
                    id: maxId + 1,
                }).object;
                retarget(obj, opt.musicClass);
                if (k === 0) first = obj;
                else {
                    for (const src of list.objects) {
                        if (src !== obj && src.links.includes(t.objectId))
                            setObjectLinks(list, src.id, [...src.links, obj.id]);
                    }
                }
                res.added++;
            }
            setObjectParams(list, obj.id, specs);
        });
    }
    return res;
}

/** Round-trip helper for tests: the f32 seconds of a stored fade dword. */
export const fadeSeconds = (dword: number): number => bitsFloat(dword);
export const fadeBits = (seconds: number): number => floatBits(seconds);
