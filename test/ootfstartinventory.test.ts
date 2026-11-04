// Synthetic fixtures only; no original game bytes.
import { describe, expect, it } from 'vitest';
import { carryStartingInventory, type StartingInventoryLevel } from '../src/ootfstartinventory.ts';
import { LVL_SENTINEL, type LvlObject } from '../src/lvl.ts';
import type { OdbClass } from '../src/odb.ts';

const object = (id: number, classId: number, dbIndex = 3): LvlObject => ({
    id,
    classId,
    dbIndex,
    prefix0: 0,
    prefix1: 0,
    pos: [100, 200, 300],
    flags: 1,
    initialEvents: 1,
    radius: null,
    links: [],
    rot: [0, 30, 0],
    scale: null,
    preSentinel: 0,
    sentinel: LVL_SENTINEL,
    data: [],
    params: [],
});
const cls = (id: number, rflClass: number): OdbClass => ({
    id,
    name: `Class ${id}`,
    group: 1,
    runtimeClass: 0x10000 + rflClass,
    rflClass,
});
const playerClass = cls(90, 9),
    itemClass = cls(70, 14),
    propClass = cls(80, 17);
const classOf = (o: LvlObject): OdbClass | undefined =>
    [playerClass, itemClass, propClass].find((c) => c.id === o.classId);
const dependency = (
    dbIndex: number,
    text = 'Common\\Resources',
): StartingInventoryLevel['target']['dependencies'][number] => ({
    dbIndex,
    zero: 0,
    path: { text, raw: new Uint8Array() },
});
function fixture(): StartingInventoryLevel[] {
    const synthetic = object(1, 90, 8),
        player = object(9, 90),
        sword = object(7, 70);
    synthetic.pos = [1000, 2000, 3000];
    sword.pos = [110, 180, 330];
    sword.params = [{ fieldIndex: 0, type: 3, name: 'Effect', nameRaw: new Uint8Array([69]) }];
    sword.data = [0x20042]; // already relocated in the owning ODB namespace, not the level namespace
    player.links = [7, 7];
    const tables = new Map([
        [
            3,
            new Map([
                [90, playerClass],
                [70, itemClass],
            ]),
        ],
    ]);
    return [
        {
            source: { path: 'World/Intro.lvl', list: { objects: [] }, classes: new Map() },
            target: {
                dependencies: [dependency(8, 'common/resources')],
                objects: { objects: [synthetic, object(7, 80, 8)], warnings: [] },
                objectIdMap: new Map(),
            },
        },
        {
            source: { path: 'World/First.lvl', list: { objects: [player, sword] }, classes: tables },
            target: {
                dependencies: [dependency(3)],
                objects: { objects: [player, sword], warnings: [] },
                objectIdMap: new Map([
                    [9, 9],
                    [7, 7],
                ]),
            },
        },
    ];
}

describe('campaign opening inventory', () => {
    it('links actual source loadout onto the existing synthetic player with collision-free ids and bank relocation', () => {
        const levels = fixture(),
            start = levels[0]!,
            source = levels[1]!;
        const result = carryStartingInventory(levels, classOf);
        expect(result).toEqual({ copied: 1, warnings: [], sourceKeys: ['world/first.lvl#7'] });
        const clone = start.target.objects.objects.find((o) => o.classId === 70)!;
        expect(clone.id).toBe(8);
        expect(clone.dbIndex).toBe(8);
        expect(clone.pos).toEqual([1010, 1980, 3030]);
        expect(clone.data).toEqual([0x20042]);
        expect(start.target.objects.objects[0]!.links).toEqual([8]);
        expect(source.target.objects.objects[0]!.links).toEqual([7, 7]);
        expect(source.target.objects.objects[1]!.pos).toEqual([110, 180, 330]);
        expect(start.target.objects.objects.filter((o) => o.classId === 90)).toHaveLength(1);
        clone.data[0] = 123;
        clone.params[0]!.nameRaw[0] = 0;
        expect(source.target.objects.objects[1]!.data).toEqual([0x20042]);
        expect(source.target.objects.objects[1]!.params[0]!.nameRaw[0]).toBe(69);
        expect(carryStartingInventory(levels, classOf).copied).toBe(0);
        expect(start.target.objects.objects).toHaveLength(3);
    });

    it('leaves standalone conversions and starts with an authored player unchanged', () => {
        const one = fixture();
        expect(carryStartingInventory(one.slice(1), classOf).copied).toBe(0);
        const authored = fixture();
        authored[0]!.source.list.objects.push(object(2, 90));
        authored[0]!.source.classes = authored[1]!.source.classes;
        expect(carryStartingInventory(authored, classOf).copied).toBe(0);
        expect(authored[0]!.target.objects.objects).toHaveLength(2);
    });

    it('does not invent a player or overwrite an existing loadout', () => {
        const none = fixture();
        none[0]!.target.objects.objects = [object(7, 80)];
        expect(carryStartingInventory(none, classOf).warnings).toHaveLength(1);
        expect(none[0]!.target.objects.objects).toHaveLength(1);
        const existing = fixture();
        existing[0]!.target.objects.objects[0]!.links = [99];
        expect(carryStartingInventory(existing, classOf).copied).toBe(0);
        expect(existing[0]!.target.objects.objects[0]!.links).toEqual([99]);
    });

    it('does nothing when there is no authored player or linked equipment', () => {
        const none = fixture();
        none[1]!.source.list.objects = [object(7, 70)];
        expect(carryStartingInventory(none, classOf).copied).toBe(0);
        const empty = fixture();
        empty[1]!.source.list.objects[0]!.links = [];
        expect(carryStartingInventory(empty, classOf).copied).toBe(0);
    });

    it('rejects missing class banks and unconverted source equipment without partial changes', () => {
        const bank = fixture();
        bank[0]!.target.dependencies = [dependency(8, 'Other/Bank')];
        const before = JSON.stringify(bank[0]!.target);
        expect(carryStartingInventory(bank, classOf).warnings[0]).toContain('no destination class bank');
        expect(JSON.stringify(bank[0]!.target)).toBe(before);
        expect(bank[0]!.target.objects.objects).toHaveLength(2);
        const missing = fixture();
        missing[1]!.target.objectIdMap = new Map([[9, 9]]);
        expect(carryStartingInventory(missing, classOf).warnings[0]).toContain('was not converted');
        expect(missing[0]!.target.objects.objects[0]!.links).toEqual([]);
    });

    it('relocates loadout back-links and refuses links into another level story', () => {
        const linked = fixture();
        linked[1]!.target.objects.objects[1]!.links = [9];
        expect(carryStartingInventory(linked, classOf).copied).toBe(1);
        expect(linked[0]!.target.objects.objects.find((o) => o.classId === 70)!.links).toEqual([1]);
        const external = fixture();
        external[1]!.target.objects.objects[1]!.links = [1234];
        expect(carryStartingInventory(external, classOf).warnings[0]).toContain('links outside the loadout');
        expect(external[0]!.target.objects.objects).toHaveLength(2);
    });
    it('preserves two distinct source items and relocates their mutual links and player link', () => {
        const levels = fixture(),
            source = levels[1]!,
            start = levels[0]!;
        const second = object(8, 70);
        second.links = [7];
        source.source.list.objects.push(second);
        source.target.objects.objects.push(second);
        source.target.objectIdMap = new Map([
            [9, 9],
            [7, 7],
            [8, 8],
        ]);
        source.source.list.objects[0]!.links = [7, 8, 7];
        source.target.objects.objects[1]!.links = [8, 9];
        const result = carryStartingInventory(levels, classOf);
        expect(result.sourceKeys).toEqual(['world/first.lvl#7', 'world/first.lvl#8']);
        expect(result.copied).toBe(2);
        const items = start.target.objects.objects.filter((o) => o.classId === 70);
        expect(items.map((o) => [o.id, o.links])).toEqual([
            [8, [9, 1]],
            [9, [8]],
        ]);
        expect(start.target.objects.objects[0]!.links).toEqual([8, 9]);
    });

    it('rejects a uint32 object-id overflow atomically instead of serializing a wrapped collision', () => {
        const levels = fixture(),
            target = levels[0]!.target;
        target.objects.objects.push(object(0xffffffff, 80));
        const before = JSON.stringify(target);
        const result = carryStartingInventory(levels, classOf);
        expect(result.copied).toBe(0);
        expect(result.warnings[0]).toContain('exceeds the LVL uint32');
        expect(JSON.stringify(target)).toBe(before);
    });
});
