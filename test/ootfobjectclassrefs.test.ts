// Synthetic classes and databases only: no game assets. Class refs in object parameters (a detector's "Trigger Only If
// Carrying Item...") number their database in the .db of the object's class ODB on both games, not in the level header.
import { describe, expect, it, vi } from 'vitest';
import { convertOotfLevels } from '../src/ootfpipeline.ts';
import { loadPcLevel, type PcLevel } from '../src/pc.ts';
import { convertPcLevel, encodeString, ps2ClassTables, writePs2Terrain, type ConvertOptions } from '../src/convert.ts';
import { planClassMapping, type ClassPlan } from '../src/ootfclass.ts';
import {
    writeLevelHeader,
    writeObjectList,
    LVL_TYPE_HEADER,
    LVL_TYPE_OBJECTS,
    type LvlHeader,
    type LvlObject,
} from '../src/lvl.ts';
import { LVL_TYPE_LAYERS } from '../src/terrain.ts';
import type { OdbClass } from '../src/odb.ts';
import type { SrscReader } from '../src/srsc.ts';

vi.mock('../src/pc.ts', async (original) => ({
    ...(await original<typeof import('../src/pc.ts')>()),
    loadPcLevel: vi.fn(),
}));
vi.mock('../src/convert.ts', async (original) => ({
    ...(await original<typeof import('../src/convert.ts')>()),
    convertPcLevel: vi.fn(),
    ps2ClassTables: vi.fn(),
}));
vi.mock('../src/ootfclass.ts', async (original) => ({
    ...(await original<typeof import('../src/ootfclass.ts')>()),
    planClassMapping: vi.fn(),
}));
vi.mock('../src/terrain.ts', async (original) => ({
    ...(await original<typeof import('../src/terrain.ts')>()),
    parsePs2Terrain: () => [],
}));

const cls = (id: number, name: string, rflClass: number): OdbClass => ({
    id,
    name,
    rflClass,
    runtimeClass: 0x10000 | rflClass,
    group: 1,
    fields: [],
    data: [],
});

const dep = (dbIndex: number, path: string) => ({ dbIndex, zero: 0, path: encodeString(path) });

describe('object class references', () => {
    it("maps a detector's carried-item class through the class ODB's .db on both sides", async () => {
        // PC: the detector's class lives in the level's own ODB (LVL db 2), whose .db names Resources as its db 2. The LVL
        // header uses db 2 for the level ODB itself and db 4 for Resources, where the key class 77 sits; the level ODB has
        // its own unrelated class 77, which the header numbering would have picked.
        const detector = cls(10, 'Detector', 61);
        const key = cls(77, 'Rune Cage Key', 33);
        const unrelated = cls(77, 'Wrong class', 17);
        const header: LvlHeader = {
            name: encodeString('Synthetic volcano'),
            maxWidth: 1,
            maxHeight: 1,
            dependencies: [dep(2, 'Volcano'), dep(4, '..\\..\\Common\\Resources\\Resources')],
            trailer: new Uint8Array(),
        };
        const object: LvlObject = {
            id: 1994,
            classId: 10,
            dbIndex: 2,
            prefix0: 0,
            prefix1: 0,
            flags: 1,
            pos: [0, 0, 0],
            rot: [0, 0, 0],
            scale: null,
            links: [],
            params: [],
            data: [],
            initialEvents: 0,
            radius: null,
            preSentinel: 0,
            sentinel: 0xffffffff,
        };
        const keyObject: LvlObject = { ...object, id: 2785, classId: 77, dbIndex: 4 };
        const pc = {
            path: 'World/Volcano/volcano.lvl',
            header,
            terrain: [],
            list: { objects: [object, keyObject], warnings: [] },
            classes: new Map([
                [
                    2,
                    new Map([
                        [10, detector],
                        [77, unrelated],
                    ]),
                ],
                [4, new Map([[77, key]])],
            ]),
            odbPaths: new Map([
                [2, 'World/Volcano/Volcano.odb'],
                [4, 'Common/Resources/Resources.odb'],
            ]),
            warnings: [],
        } as unknown as PcLevel;
        const pcDb: Record<string, string> = {
            'world/volcano/volcano.db':
                'version 1\ndependencies 2\n1 ..\\..\\Common\\System\\System\n2 ..\\..\\Common\\Resources\\Resources\n',
        };
        // PS2: the detector maps to FX (template db 4), the key to Resources (template db 3); FX.DB names Resources as 1.
        const fxDetector = cls(8409, 'detector', 61);
        const ps2Key = cls(900, 'Rune Cage Key', 33);
        const ps2Header: LvlHeader = {
            ...header,
            dependencies: [dep(3, '..\\..\\Common\\Resources\\Resources'), dep(4, '..\\..\\Common\\FX\\FX')],
        };
        const plan: ClassPlan = {
            mapped: new Map(),
            unsupported: new Map(),
            resolve: (_db, id) =>
                id === 10
                    ? { dbIndex: 4, classId: 8409, cls: fxDetector }
                    : id === 77
                      ? { dbIndex: 3, classId: 900, cls: ps2Key }
                      : null,
            synthesized: [],
        };
        vi.mocked(loadPcLevel).mockResolvedValue(pc);
        vi.mocked(ps2ClassTables).mockReturnValue(
            new Map([
                [3, new Map([[900, ps2Key]])],
                [4, new Map([[8409, fxDetector]])],
            ]),
        );
        vi.mocked(planClassMapping).mockReturnValue(plan);
        let seen: ConvertOptions | undefined;
        vi.mocked(convertPcLevel).mockImplementation((_pc, opts) => {
            seen = opts;
            return {
                header: ps2Header,
                objects: { objects: [], warnings: [] },
                terrain: [],
                objectIdMap: new Map(),
                report: {
                    objectsIn: 2,
                    objectsOut: 0,
                    unmappedClasses: new Map(),
                    mappedClasses: new Map(),
                    objectsPlaceholder: 0,
                    linksDropped: 0,
                    idsRenumbered: 0,
                    droppedParams: new Map(),
                    zeroedResourceParams: 0,
                    cellsFallback: 0,
                    cellsMapped: 0,
                    layers: 0,
                    warnings: [],
                },
            };
        });
        const payloads = new Map([
            [LVL_TYPE_HEADER, writeLevelHeader(ps2Header)],
            [LVL_TYPE_OBJECTS, writeObjectList({ objects: [], warnings: [] })],
            [LVL_TYPE_LAYERS, writePs2Terrain([], () => new Uint8Array())],
        ]);
        const template = {
            entries: [...payloads].map(([type], index) => ({ type, index })),
            readRaw: async (entry: { type: number }) => payloads.get(entry.type)!,
        } as unknown as SrscReader;
        const text = (s: string) => new TextEncoder().encode(s);
        await convertOotfLevels(
            {
                list: async () => [],
                read: async (p: string) => (pcDb[p.toLowerCase()] ? text(pcDb[p.toLowerCase()]!) : null),
            },
            [pc.path],
            {
                template,
                odbs: new Map(),
                dbFiles: new Map([
                    [
                        'FX',
                        {
                            dir: 'ENGLISH/COMMON/FX',
                            text: 'version 1\ndependencies 2\n1 ..\\Resources\\Resources\n2 ..\\System\\System\n',
                        },
                    ],
                ]),
            },
            {
                models: false,
                textures: false,
                sounds: false,
                sequences: false,
                singletons: false,
                music: false,
                texts: false,
                terrainShading: false,
                campaign: false,
            },
        );
        const hook = seen?.mapClassRef;
        expect(hook).toBeTypeOf('function');
        const ctx = {
            pc,
            ownerDb: 2,
            classId: 10,
            field: 'Trigger Only If Carrying Item...',
            target: { dbIndex: 4, classId: 8409, cls: fxDetector },
        };
        // PC (2 << 16) | 77 is Resources' key in Volcano.db numbering; PS2 FX.DB numbers Resources 1.
        expect(hook!((2 << 16) | 77, ctx)).toBe((1 << 16) | 900);
        // db 0 is the class ODB itself: the level ODB's own class 77 is not planned here.
        expect(hook!(77, ctx)).toBeNull();
        // A database the class ODB's .db does not list resolves to nothing instead of a header-numbered guess.
        expect(hook!((4 << 16) | 77, ctx)).toBeNull();
    });
});
