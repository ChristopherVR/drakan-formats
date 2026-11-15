// Synthetic names only; no game assets.
import { describe, expect, it } from 'vitest';
import { clipKey } from '../src/ootfpipeline.ts';

describe('clipKey', () => {
    it('matches a PC clip name with a disc clip name that carries a suffix', () => {
        expect(clipKey('run.rea')).toBe(clipKey('Run'));
        expect(clipKey(' ShuffleLoop.REA ')).toBe('shuffleloop');
        expect(clipKey('attack low')).toBe('attack low');
        expect(clipKey('ready')).not.toBe(clipKey('readypose'));
    });
});
