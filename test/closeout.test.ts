// Object string references and exit destination texts (synthetic data only).
import { describe, expect, it } from 'vitest';
import {
    FIELD_STRING,
    exitDestinationText,
    objectStringRefs,
    withDestination,
    type LvlHeader,
    type LvlObject,
    type OdbClass,
} from '../src/index.ts';

describe('objectStringRefs', () => {
    const header = {
        dependencies: [{ dbIndex: 7, zero: 0, path: { raw: new Uint8Array(), text: '..\\Level 1\\LEVEL1ON' } }],
    } as unknown as LvlHeader;
    const cls: OdbClass = { id: 5, name: 'Sign', group: 1, runtimeClass: null, fields: [], data: [] };
    const odbs = new Map([['LEVEL1ON', new Map([[5, cls]])]]);
    const p = (type: number, name: string, fieldIndex = 0) => ({ fieldIndex, type, nameRaw: new Uint8Array(), name });
    const obj = (id: number, params: ReturnType<typeof p>[], data: number[]): LvlObject =>
        ({ id, classId: 5, dbIndex: 7, pos: [0, 0, 0], links: [], params, data }) as unknown as LvlObject;

    it('counts string ids of string parameters only', () => {
        const list = {
            objects: [
                obj(1, [p(FIELD_STRING, 'Text')], [12]),
                obj(2, [p(FIELD_STRING, 'Text')], [12]),
                obj(3, [p(FIELD_STRING, 'Text')], [0]), // none
                obj(4, [p(FIELD_STRING, 'Text')], [0x00080000 | 12]), // inline text, not an id
                obj(5, [p(1, 'Count')], [12]), // not a string field
                obj(6, [p(FIELD_STRING | 0x1000, 'Texts')], [12]), // array
            ],
            warnings: [],
        };
        const m = objectStringRefs(header, list, odbs);
        expect([...m.keys()]).toEqual([12]);
        expect(m.get(12)).toEqual([
            { objectId: 1, className: 'Sign', field: 'Text' },
            { objectId: 2, className: 'Sign', field: 'Text' },
        ]);
    });
});

describe('exit destinations', () => {
    it('keeps the form of the old text', () => {
        expect(exitDestinationText('Levels\\Level 2 - Shadowmire\\Level 2 - Shadowmire.lvl', 'Level 3 - Surdana')).toBe(
            'Levels\\Level 3 - Surdana\\Level 3 - Surdana.lvl',
        );
        expect(exitDestinationText('portal', 'Level 3')).toBe('Level 3');
        expect(exitDestinationText('Level 2', 'Level 3')).toBe('Level 3');
    });
    it('writes the text into every used language slot', () => {
        const s = withDestination({ id: 5, sub: 1, text: ['a', '', 'c'] }, 'X');
        expect(s.text.slice(0, 4)).toEqual(['X', '', 'X', '']);
        expect(s.text.length).toBe(8);
    });
});
