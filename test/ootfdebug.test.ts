import { afterEach, describe, expect, it, vi } from 'vitest';
import { ootfClassDebug, ootfDebugFlag } from '../src/ootfdebug.ts';
import { encodePs2Texture } from '../src/ootftex.ts';

afterEach(() => vi.unstubAllEnvs());
describe('OotF investigation switches', () => {
    it('suppresses only the texture alpha flag, not its pixel bytes', () => {
        const image = { width: 1, height: 1, rgba: new Uint8Array([10, 20, 30, 100]) };
        vi.stubEnv('OOTF_NO_ALPHA_FLAG', '0');
        const normal = encodePs2Texture(image, { mode: 'truecolor' }).body;
        vi.stubEnv('OOTF_NO_ALPHA_FLAG', '1');
        const diagnostic = encodePs2Texture(image, { mode: 'truecolor' }).body;
        expect(normal[37]).toBe(2);
        expect(diagnostic[37]).toBe(0);
        const expected = normal.slice();
        expected[37] = 0;
        expect(diagnostic).toEqual(expected);
    });
    it('has no effect when unset and accepts 0 as disabled', () => {
        for (const key of ['DRAKAN_DBG_NAMEMAP', 'DRAKAN_DBG_TPLFORCE', 'DRAKAN_DBG_NOMODEL', 'OOTF_NO_ALPHA_FLAG'])
            vi.stubEnv(key, '');
        expect(ootfClassDebug()).toEqual({ names: new Map(), templates: new Map(), noModel: null });
        expect(ootfDebugFlag('OOTF_NO_ALPHA_FLAG')).toBe(false);
        vi.stubEnv('OOTF_NO_ALPHA_FLAG', '0');
        expect(ootfDebugFlag('OOTF_NO_ALPHA_FLAG')).toBe(false);
        vi.stubEnv('OOTF_NO_ALPHA_FLAG', '1');
        expect(ootfDebugFlag('OOTF_NO_ALPHA_FLAG')).toBe(true);
    });
    it('parses trimmed, case-insensitive class names and a non-stateful model pattern', () => {
        vi.stubEnv('DRAKAN_DBG_NAMEMAP', ' Short Sword = Steel Club;Bow=Long Bow;');
        vi.stubEnv('DRAKAN_DBG_TPLFORCE', 'AXE=Battle Axe');
        vi.stubEnv('DRAKAN_DBG_NOMODEL', 'sword|bow');
        const debug = ootfClassDebug();
        expect(debug.names.get('short sword')).toBe('Steel Club');
        expect(debug.templates.get('axe')).toBe('Battle Axe');
        expect(debug.noModel?.test('Bow')).toBe(true);
        expect(debug.noModel?.test('Bow')).toBe(true);
    });
    it('fails clearly for malformed, duplicate mappings and invalid regexes', () => {
        vi.stubEnv('DRAKAN_DBG_NAMEMAP', 'Sword');
        expect(ootfClassDebug).toThrow(/mapping must/);
        vi.stubEnv('DRAKAN_DBG_NAMEMAP', 'Sword=A;sword=B');
        expect(ootfClassDebug).toThrow(/Duplicate/);
        vi.stubEnv('DRAKAN_DBG_NAMEMAP', '');
        vi.stubEnv('DRAKAN_DBG_NOMODEL', '[');
        expect(ootfClassDebug).toThrow(/regular expression/);
    });
});
