// Synthetic fixtures only; no game bytes.
// Guard for save compatibility across pack rebuilds (docs/reference/modding.md "Saves and pack builds"): a converter
// change that adds a class must not renumber the others, and the pack build only changes when a save could break.
import { describe, expect, it } from 'vitest';
import { zlibSync } from 'fflate';
import {
    ClassIdPinner,
    LVL_SENTINEL,
    chooseSaveBuild,
    classIdPins,
    classSignature,
    compareSaveLayouts,
    encodeFieldList,
    packSaveLayout,
    saveLayoutId,
    stringToWords,
    writeLevelHeader,
    writeObjectList,
    type LvlHeader,
    type LvlObject,
    type OdbClass,
} from '../src/index.ts';
import { buildPlainClassRecord, planClassMapping, type Ps2OdbIn } from '../src/ootfclass.ts';
import { buildSrsc } from './fixtures.ts';

const T_INT = 1;
const T_FLOAT = 2;
const T_ENUM = 7;
const T_STR = 0x0a;
const f32 = (n: number): number => {
    const d = new DataView(new ArrayBuffer(4));
    d.setFloat32(0, n);
    return d.getUint32(0);
};
const timerFields: [number, string][] = [
    [T_FLOAT, 'Time Until Trigger'],
    [T_ENUM, 'Trigger Message'],
    [T_ENUM, 'Run after enabling?'],
    [T_STR, 'Debug Text'],
];
function cls(id: number, name: string, rfl: number, fields: [number, string][], data: number[]): OdbClass {
    return {
        id,
        name,
        group: 5,
        runtimeClass: 0x10000 + rfl,
        model: null,
        rflClass: rfl,
        icon: 1,
        fields: fields.map(([type, n]) => ({ type, name: n })),
        data,
    };
}
const timerData = (t: number): number[] => [f32(t), 1, 0, (3 << 16) | 4, ...stringToWords('abc')];
const ps2Timer = cls(10, 'Timer', 62, timerFields, timerData(1));
function fxOdb(): Ps2OdbIn {
    const raw = buildPlainClassRecord({
        name: 'Timer',
        group: 5,
        rfl: 62,
        icon: 1,
        fieldCount: 4,
        data: ps2Timer.data!,
    });
    return {
        dbIndex: 4,
        file: 'FX.ODB',
        classes: new Map([[10, ps2Timer]]),
        raw: (id) => (id === 10 ? raw : undefined),
        group: () => 5,
        fieldLists: { id: 0, sub: 0, stored: zlibSync(encodeFieldList([{ type: T_INT, name: 'a' }])) },
    };
}
/** PC timers with different values: each becomes its own cloned PS2 class. */
const pcTimer = (id: number, name: string) => ({ db: 1, id, cls: cls(id, name, 62, timerFields, timerData(id + 1)) });
const idsOf = (plan: ReturnType<typeof planClassMapping>): Map<string, number> =>
    new Map(plan.synthesized.map((s) => [s.name, s.classId]));
/** The `new/` class records a pack built from the plan would carry, for `classIdPins`. */
const packFiles = (plan: ReturnType<typeof planClassMapping>): Record<string, Uint8Array> =>
    Object.fromEntries(plan.synthesized.map((s) => [`new/${s.file}/0102_${s.classId}_${s.group}.bin`, s.record]));

describe('class id pins', () => {
    it('keeps the ids of the previous pack when a class is added in the middle of the plan order', () => {
        const before = planClassMapping([pcTimer(1, 'Alarm A'), pcTimer(3, 'Alarm C')], [fxOdb()]);
        const a = idsOf(before);
        expect(a.size).toBe(2);
        const grown = [pcTimer(1, 'Alarm A'), pcTimer(2, 'Alarm B'), pcTimer(3, 'Alarm C')];
        // Without pins the new class takes Alarm C's id: a save of the previous pack would restore C as B.
        const unpinned = idsOf(planClassMapping(grown, [fxOdb()]));
        expect(unpinned.get('Alarm B')).toBe(a.get('Alarm C'));
        const pinned = idsOf(planClassMapping(grown, [fxOdb()], { pinnedIds: classIdPins(packFiles(before)) }));
        expect(pinned.get('Alarm A')).toBe(a.get('Alarm A'));
        expect(pinned.get('Alarm C')).toBe(a.get('Alarm C'));
        expect(pinned.get('Alarm B')).toBeGreaterThan(Math.max(...a.values()));
    });

    it('never reuses the id of a class that is gone', () => {
        const before = planClassMapping([pcTimer(1, 'Alarm A'), pcTimer(3, 'Alarm C')], [fxOdb()]);
        const a = idsOf(before);
        const after = idsOf(
            planClassMapping([pcTimer(3, 'Alarm C'), pcTimer(4, 'Alarm D')], [fxOdb()], {
                pinnedIds: classIdPins(packFiles(before)),
            }),
        );
        expect(after.get('Alarm C')).toBe(a.get('Alarm C'));
        expect(after.get('Alarm D')).not.toBe(a.get('Alarm A'));
        expect(after.get('Alarm D')).toBeGreaterThan(Math.max(...a.values()));
    });

    it('pins classes of one name by occurrence and skips an id the disc now uses', () => {
        const pins = new Map([
            [
                'FX.ODB',
                new Map([
                    ['Spark|43', [40, 41]],
                    ['Spark|19', [42]],
                ]),
            ],
        ]);
        const p = new ClassIdPinner(pins);
        expect(p.take('fx.odb', 'Spark', 43)).toBe(40);
        expect(p.take('FX.ODB', 'Spark', 19)).toBe(42); // same name, another engine class
        expect(p.take('FX.ODB', 'Spark', 43, new Set([41]))).toBeUndefined();
        expect(p.take('FX.ODB', 'Spark', 43)).toBeUndefined();
        expect([...p.reserved('FX.ODB')].sort()).toEqual([40, 41, 42]);
        expect(p.top('FX.ODB')).toBe(42);
        expect(new ClassIdPinner().take('FX.ODB', 'Spark', 43)).toBeUndefined();
    });
});

const header = (deps: string[]): LvlHeader => {
    const str = (s: string) => {
        const n = s.length + 1;
        const raw = new Uint8Array(n + (n % 2));
        for (let i = 0; i < s.length; i++) raw[i] = s.charCodeAt(i);
        return { raw, text: s };
    };
    return {
        name: str('Test'),
        dependencies: deps.map((d, i) => ({ dbIndex: i + 1, zero: 0, path: str(d) })),
        maxWidth: 1,
        maxHeight: 1,
        trailer: new Uint8Array(0),
    };
};
const object = (id: number, classId: number, x = 0): LvlObject => ({
    id,
    classId,
    dbIndex: 3,
    prefix0: 0,
    prefix1: 0,
    pos: [x, 0, 0],
    flags: 1,
    initialEvents: 1,
    radius: null,
    links: [],
    rot: [0, 0, 0],
    scale: null,
    preSentinel: 0,
    sentinel: LVL_SENTINEL,
    data: [],
    params: [],
});

describe('save layout', () => {
    const record = (name: string, rfl = 62) =>
        buildPlainClassRecord({ name, group: 5, rfl, icon: 1, fieldCount: 4, data: timerData(1) });

    it('signs a class by name, engine class and field count only', () => {
        expect(classSignature(record('Alarm A'))).toBe('Alarm A|62|4');
        const other = buildPlainClassRecord({
            name: 'Alarm A',
            group: 9,
            rfl: 62,
            icon: 3,
            fieldCount: 4,
            data: timerData(7),
        });
        expect(classSignature(other)).toBe('Alarm A|62|4');
    });

    it('keeps the build while the layout only grows, and changes it when a class id changes meaning', () => {
        const prev = new Map([
            ['class|FX.ODB|100', 'Alarm A|62|4'],
            ['obj|files/l.lvl|5', '3:100'],
        ]);
        const grown = new Map([...prev, ['class|FX.ODB|101', 'Alarm B|62|4'], ['obj|files/l.lvl|6', '3:101']]);
        expect(chooseSaveBuild(grown, { build: 'cafe', layout: prev })).toMatchObject({ build: 'cafe', kept: true });
        const shifted = new Map([
            ['class|FX.ODB|100', 'Alarm B|62|4'],
            ['class|FX.ODB|101', 'Alarm A|62|4'],
            ['obj|files/l.lvl|5', '3:100'],
        ]);
        const c = chooseSaveBuild(shifted, { build: 'cafe', layout: prev });
        expect(c.kept).toBe(false);
        expect(c.build).toBe(saveLayoutId(shifted));
        expect(c.diff?.changed).toEqual(['class|FX.ODB|100: Alarm A|62|4 -> Alarm B|62|4']);
        expect(compareSaveLayouts(prev, new Map([['class|FX.ODB|100', 'Alarm A|62|4']])).removed).toEqual([
            'obj|files/l.lvl|5',
        ]);
        expect(chooseSaveBuild(prev)).toEqual({ build: saveLayoutId(prev), kept: false });
        expect(saveLayoutId(prev)).toMatch(/^[0-9a-f]{16}$/);
    });

    it('reads classes and level objects from pack files and ignores what a save does not name', async () => {
        const lvl = (objects: LvlObject[], deps = ['..\\FX\\FX']) =>
            buildSrsc([
                { type: 0x0000, id: 0, sub: 0, data: writeLevelHeader(header(deps)) },
                { type: 0x0020, id: 0, sub: 0, data: writeObjectList({ objects, warnings: [] }) },
            ]);
        const files = (objects: LvlObject[], extra: Record<string, Uint8Array> = {}) => ({
            'mod.toml': new Uint8Array([1]),
            'new/FX.ODB/0102_100_5.bin': record('Alarm A'),
            'files/ENGLISH/LEVELS/L/L.LVL': lvl(objects),
            'files/ENGLISH/COMMON/FX/FX.MOD': new Uint8Array([1, 2, 3]),
            ...extra,
        });
        const a = await packSaveLayout(files([object(5, 100)]));
        expect([...a.keys()].sort()).toEqual([
            'class|FX.ODB|100',
            'deps|files/english/levels/l/l.lvl',
            'obj|files/english/levels/l/l.lvl|5',
        ]);
        expect(a.get('obj|files/english/levels/l/l.lvl|5')).toBe('3:100');
        // moved objects, other models and a new object keep old saves
        const b = await packSaveLayout(
            files([object(5, 100, 400), object(6, 100)], { 'files/ENGLISH/COMMON/FX/FX.MOD': new Uint8Array([9]) }),
        );
        expect(compareSaveLayouts(a, b)).toMatchObject({ compatible: true, added: 1 });
        // an object id that now holds another class does not
        const c = await packSaveLayout(files([object(5, 101)]));
        expect(compareSaveLayouts(a, c).changed).toEqual(['obj|files/english/levels/l/l.lvl|5: 3:100 -> 3:101']);
    });
});
