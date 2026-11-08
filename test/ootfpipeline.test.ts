// Synthetic stage outputs: no game assets. Exercise the pipeline's final object retention policy.
import { describe, expect, it, vi } from 'vitest';
import { convertOotfLevels, deathClipIds } from '../src/ootfpipeline.ts';
import { OotfSourceError } from '../src/ootfsource.ts';
import { loadPcLevel, type PcLevel } from '../src/pc.ts';
import { convertPcLevel, ps2ClassTables, writePs2Terrain } from '../src/convert.ts';
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
import { joinClassRecord } from '../src/odbwrite.ts';

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

describe('cinematic object retention', () => {
    it('keeps a converted skinned prop and its incoming link when a sequencer shares the level', async () => {
        const header: LvlHeader = {
            name: { text: 'Synthetic scene', raw: new Uint8Array([83, 0]) },
            maxWidth: 1,
            maxHeight: 1,
            dependencies: [],
            trailer: new Uint8Array(),
        };
        const cls = (id: number, name: string, rflClass: number): OdbClass => ({
            id,
            name,
            rflClass,
            runtimeClass: 0x10000 | rflClass,
            group: 1,
            fields: [],
            data: [],
        });
        const prop = { ...cls(100, 'Animated scene prop', 17), model: { id: 5, db: 0 } };
        const sequencer = cls(10, 'Stomp Player', 51);
        const object = (id: number, classId: number, links: number[]): LvlObject => ({
            id,
            classId,
            dbIndex: 8,
            prefix0: 0,
            prefix1: 0,
            flags: 1,
            pos: [0, 0, 0],
            rot: [0, 0, 0],
            scale: null,
            links,
            params: [],
            data: [],
            initialEvents: 0,
            radius: null,
            preSentinel: 0,
            sentinel: 0xffffffff,
        });
        const objects = { objects: [object(1000, 100, []), object(2000, 10, [1000])], warnings: [] };
        const pc = {
            path: 'Synthetic/scene.lvl',
            header,
            terrain: [],
            list: objects,
            classes: new Map([
                [
                    8,
                    new Map([
                        [100, prop],
                        [10, sequencer],
                    ]),
                ],
            ]),
            odbPaths: new Map([[8, 'Synthetic/scene.odb']]),
            warnings: [],
        } as unknown as PcLevel;
        const target = (id: number) => ({ dbIndex: 8, classId: id, cls: id === 100 ? prop : sequencer });
        const body = new Uint8Array(94);
        const bodyView = new DataView(body.buffer);
        bodyView.setUint16(0, 1, true);
        bodyView.setUint16(2, 5, true);
        bodyView.setUint16(14, 1, true);
        bodyView.setUint16(80, 17, true);
        bodyView.setUint16(82, 1, true);
        const plan: ClassPlan = {
            mapped: new Map(),
            unsupported: new Map(),
            resolve: (_db, id) => target(id),
            synthesized: [
                {
                    pcKeys: ['1:100'],
                    name: prop.name,
                    file: 'NPCS.ODB',
                    dbIndex: 8,
                    classId: 100,
                    group: 1,
                    rfl: 17,
                    template: { dbIndex: 8, classId: 9, name: 'Skinned template' },
                    record: joinClassRecord(prop.name, body),
                    cls: prop,
                    copied: [],
                    skipped: [],
                    coverage: 1,
                },
            ],
        };
        vi.mocked(loadPcLevel).mockResolvedValue(pc);
        vi.mocked(ps2ClassTables).mockReturnValue(new Map([[8, new Map([[10, sequencer]])]]));
        vi.mocked(planClassMapping).mockReturnValue(plan);
        vi.mocked(convertPcLevel).mockImplementation(() => ({
            header,
            objects: structuredClone(objects),
            terrain: [],
            objectIdMap: new Map([
                [1000, 1000],
                [2000, 2000],
            ]),
            report: {
                objectsIn: 2,
                objectsOut: 2,
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
        }));
        const payloads = new Map([
            [LVL_TYPE_HEADER, writeLevelHeader(header)],
            [LVL_TYPE_OBJECTS, writeObjectList({ objects: [], warnings: [] })],
            [LVL_TYPE_LAYERS, writePs2Terrain([], () => new Uint8Array())],
        ]);
        const template = {
            entries: [...payloads].map(([type], index) => ({ type, index })),
            readRaw: async (entry: { type: number }) => payloads.get(entry.type)!,
        } as unknown as SrscReader;
        const result = await convertOotfLevels(
            { list: async () => [], read: async () => null },
            [pc.path],
            {
                template,
                odbs: new Map(),
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
        expect(result.stages.filter((s) => !s.ok)).toEqual([]);
        expect(result.classPlan?.synthesized[0]?.cls.model).toEqual({ id: 5, db: 0 });
        expect(result.levels).toHaveLength(1);
        expect(result.levels[0]!.parts.objects.objects.map((o) => o.id)).toEqual([1000, 2000]);
        expect(result.levels[0]!.parts.objects.objects.find((o) => o.id === 2000)!.links).toEqual([1000]);
    });
});

describe('localized source checks (issue #3)', () => {
    it('stops before writing anything when placed objects come from a database the install lacks', async () => {
        const header: LvlHeader = {
            name: { text: '<0x9000>Ruinendorf', raw: new Uint8Array([82, 0]) },
            maxWidth: 1,
            maxHeight: 1,
            dependencies: [{ dbIndex: 3, path: { text: '../../Common/NPC/NPCs', raw: new Uint8Array([78, 0]) } }],
            trailer: new Uint8Array(),
        } as unknown as LvlHeader;
        const placed: LvlObject = {
            id: 1,
            classId: 1,
            dbIndex: 3,
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
        const pc = {
            path: 'Bergwelt/Ruinendorf/Ruinendorf.lvl',
            header,
            terrain: [],
            list: { objects: [placed], warnings: [] },
            classes: new Map(),
            odbPaths: new Map(),
            warnings: [],
        } as unknown as PcLevel;
        vi.mocked(loadPcLevel).mockResolvedValue(pc);
        vi.mocked(ps2ClassTables).mockReturnValue(new Map());
        vi.mocked(convertPcLevel).mockClear();
        const payloads = new Map([
            [LVL_TYPE_HEADER, writeLevelHeader({ ...header, dependencies: [] })],
            [LVL_TYPE_OBJECTS, writeObjectList({ objects: [], warnings: [] })],
            [LVL_TYPE_LAYERS, writePs2Terrain([], () => new Uint8Array())],
        ]);
        const template = {
            entries: [...payloads].map(([type], index) => ({ type, index })),
            readRaw: async (entry: { type: number }) => payloads.get(entry.type)!,
        } as unknown as SrscReader;
        await expect(
            convertOotfLevels({ list: async () => [], read: async () => null }, [pc.path], {
                template,
                odbs: new Map(),
            }),
        ).rejects.toThrow(OotfSourceError);
        await expect(
            convertOotfLevels({ list: async () => [], read: async () => null }, [pc.path], {
                template,
                odbs: new Map(),
            }),
        ).rejects.toThrow(/NPCs.*Copy the complete install/);
        expect(convertPcLevel).not.toHaveBeenCalled();
    });

    it('stops with the reader reasons and a hint when no selected level can be read', async () => {
        vi.mocked(loadPcLevel).mockReset();
        vi.mocked(loadPcLevel).mockRejectedValue(new Error('not a PC level (bad magic)'));
        vi.mocked(ps2ClassTables).mockReturnValue(new Map());
        const header = { name: { text: 'x', raw: new Uint8Array([0]) }, dependencies: [], trailer: new Uint8Array() };
        const payloads = new Map([
            [LVL_TYPE_HEADER, writeLevelHeader(header as unknown as LvlHeader)],
            [LVL_TYPE_OBJECTS, writeObjectList({ objects: [], warnings: [] })],
            [LVL_TYPE_LAYERS, writePs2Terrain([], () => new Uint8Array())],
        ]);
        const template = {
            entries: [...payloads].map(([type], index) => ({ type, index })),
            readRaw: async (entry: { type: number }) => payloads.get(entry.type)!,
        } as unknown as SrscReader;
        const run = convertOotfLevels({ list: async () => [], read: async () => null }, ['Bergwelt/a.lvl'], {
            template,
            odbs: new Map(),
        });
        await expect(run).rejects.toThrow(OotfSourceError);
        await expect(run).rejects.toThrow(/bad magic[\s\S]*folder of the installed game[\s\S]*issue #3/);
    });
});

describe('deathClipIds', () => {
    it('lists the clips of the death fields (arrays and plain), not the idle death or other clips', () => {
        const anim = 0x0009;
        const animArray = 0x1009;
        const cls = {
            fields: [
                { name: 'Death', type: animArray },
                { name: 'Forward Death ', type: animArray },
                { name: 'Sleep Death', type: anim },
                { name: 'Idle Death', type: animArray },
                { name: 'Attack Animations', type: animArray },
                { name: 'Death', type: 0x0001 },
            ],
            // arrays: (count << 16) | offset of the ids in the data area
            data: [(2 << 16) | 6, (1 << 16) | 8, 7003, (1 << 16) | 9, (1 << 16) | 10, 5, 7001, 7002, 7004, 7005, 7006],
        };
        expect(deathClipIds(cls)).toEqual([7001, 7002, 7004, 7003]);
    });
});
