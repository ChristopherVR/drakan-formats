// Drakan 2 textures in place of OotF ones (ootfps2tex.ts). Synthetic fixtures only: no game data.
import { describe, expect, it } from 'vitest';
import { SrscReader, parseModel } from '../src/index.ts';
import { OotfAssetBuilder } from '../src/ootfassets.ts';
import { writePs2Srsc } from '../src/ootfcontainer.ts';
import { PC_TEX_NEXT_FRAME, encodePs2Texture } from '../src/ootftex.ts';
import {
    DEFAULT_PS2_TEXTURE_SUBSTITUTIONS,
    Ps2TextureMapError,
    effectiveSubstitutions,
    ootfTextureKey,
    ps2TextureSwapFromEdits,
    resolvePs2Substitutes,
    substituteMismatch,
    type Ps2TextureSubstitution,
} from '../src/ootfps2tex.ts';
import type { PcFileSource } from '../src/pc.ts';

const u32 = (n: number): number[] => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];
const u16 = (n: number): number[] => [n & 255, (n >> 8) & 255];

/** PC texture record: 54-byte header and 8 bpp indices. */
function pcTex(w: number, h: number): Uint8Array {
    return Uint8Array.from([
        ...u32(w),
        ...u32(h),
        ...u32(w),
        ...u16(8),
        ...u16(0),
        0,
        0,
        ...u32(0xffffffff),
        ...u32(0),
        ...u32(0),
        ...u32(0),
        10,
        0,
        ...u16(0),
        ...u32(0),
        ...u32(1),
        ...u32(0),
        ...u32(w * h),
        ...new Array(w * h).fill(1),
    ]);
}

/** PC TXD with a two-colour palette and textures of the given sizes. */
function pcTxd(textures: Record<number, [number, number]>): Uint8Array {
    return writePs2Srsc([
        { type: 0x30, id: 0, sub: 0, data: Uint8Array.from([...u16(2), 0, 0, 0, 0, 200, 100, 50, 0]) },
        ...Object.entries(textures).map(([id, [w, h]]) => ({ type: 0x40, id: Number(id), sub: 0, data: pcTex(w, h) })),
    ]);
}

/** PC MOD with one model of one triangle whose texture is list entry `tex` of `texRefs` ([id, db] pairs). */
function pcMod(id: number, texRefs: number[][], tex = 0, character = false): Uint8Array {
    const rec = (type: number, data: number[]) => ({ type, id, sub: 0, data: Uint8Array.from(data) });
    const verts = [...u16(3)];
    for (const v of [0, 0, 0, 1, 0, 0, 0, 0, 1]) verts.push(...new Uint8Array(new Float32Array([v]).buffer));
    const poly = [...u16(1), ...u16(0), ...u16(3), ...u16(tex)];
    for (const [i, u, v] of [
        [0, 0, 0],
        [1, 1, 0],
        [2, 0, 1],
    ] as const)
        poly.push(...u16(i), ...new Uint8Array(new Float32Array([u, v]).buffer));
    const name = [...u16(4), 0x74, 0x72, 0x65, 0x65, ...u32(2)];
    const tl = [...u32(texRefs.length), ...texRefs.flatMap(([i, d]) => [...u16(i!), ...u16(d!)])];
    const recs = [rec(0x200, name), rec(0x206, tl), rec(0x203, verts), rec(0x204, poly)];
    if (character) recs.push(rec(0x208, new Array(70).fill(0)));
    return writePs2Srsc(recs);
}

/** A "disc" PS2 texture: a 2-colour picture of w x h encoded like the disc's 8 bpp textures; `key` sets a colour key (+20). */
function ps2Tex(w: number, h: number, colour: number, o: { key?: boolean; frame?: boolean } = {}): Uint8Array {
    const rgba = new Uint8Array(w * h * 4);
    for (let i = 0; i < w * h; i++) rgba.set(i % 2 ? [colour, 10, 20, 255] : [5, colour, 30, 255], i * 4);
    const body = encodePs2Texture({ width: w, height: h, rgba }, { mode: 'indexed' }).body;
    if (o.key) new DataView(body.buffer, body.byteOffset).setUint32(20, 0, true);
    if (o.frame) body[37] = body[37]! | PC_TEX_NEXT_FRAME;
    return body;
}

const discTxd = (textures: Record<number, Uint8Array>): Uint8Array =>
    writePs2Srsc(Object.entries(textures).map(([id, data]) => ({ type: 0x40, id: Number(id), sub: 0, data })));

const row = (ootf: string, ps2: string): Ps2TextureSubstitution => ({ ootf, ps2, label: ootf, why: 'test' });

describe('Drakan 2 texture table', () => {
    it('names each pair by container and id, with a reason, and parses', () => {
        expect(DEFAULT_PS2_TEXTURE_SUBSTITUTIONS.length).toBeGreaterThan(0);
        const seen = new Set<string>();
        for (const r of DEFAULT_PS2_TEXTURE_SUBSTITUTIONS) {
            const k = ootfTextureKey(r.ootf);
            expect(seen.has(k)).toBe(false);
            seen.add(k);
            expect(r.ps2).toMatch(/^[A-Z0-9_/]+\.TXD#\d+$/);
            expect(r.label.length).toBeGreaterThan(3);
            expect(r.why.length).toBeGreaterThan(10);
            expect(`${r.label} ${r.why}`).not.toMatch(/—/);
        }
    });

    it('turns rows off, adds and replaces rows, and is empty when disabled', () => {
        const table = [row('A/B#1', 'X/Y.TXD#2'), row('A/C#3', 'X/Y.TXD#4')];
        expect(effectiveSubstitutions({ table }).map((r) => r.ootf)).toEqual(['A/B#1', 'A/C#3']);
        expect(effectiveSubstitutions({ table, enabled: false })).toEqual([]);
        expect(effectiveSubstitutions({ table, off: ['a/b#1'] }).map((r) => r.ootf)).toEqual(['A/C#3']);
        const replaced = effectiveSubstitutions({
            table,
            extra: [row('a/c#3', 'X/Z.TXD#9'), row('D/E#5', 'X/Y.TXD#6')],
        });
        expect(replaced.map((r) => r.ps2)).toEqual(['X/Y.TXD#2', 'X/Z.TXD#9', 'X/Y.TXD#6']);
        expect(effectiveSubstitutions().length).toBe(DEFAULT_PS2_TEXTURE_SUBSTITUTIONS.length);
    });

    it('reads user edits: null turns a row off, a reference adds one, anything else is an error', () => {
        const o = ps2TextureSwapFromEdits([
            { ootf: 'A/B#1', ps2: null },
            { ootf: 'A/C#3', ps2: 'X/Y.TXD#4', label: 'Bark' },
        ]);
        expect(o.off).toEqual(['A/B#1']);
        expect(o.extra).toEqual([{ ootf: 'A/C#3', ps2: 'X/Y.TXD#4', label: 'Bark', why: 'user mapping' }]);
        expect(() => ps2TextureSwapFromEdits({})).toThrow(Ps2TextureMapError);
        expect(() => ps2TextureSwapFromEdits([{ ootf: 'A/B', ps2: 'X#1' }])).toThrow(/path#id/);
        expect(() => ps2TextureSwapFromEdits([{ ootf: 'A/B#1', ps2: 7 }])).toThrow(Ps2TextureMapError);
    });

    it('checks aspect ratio and the creature texture rule', () => {
        expect(substituteMismatch({ width: 256, height: 256, bpp: 8 }, 64, 64, false)).toBeNull();
        expect(substituteMismatch({ width: 128, height: 64, bpp: 8 }, 64, 64, false)).toMatch(/aspect/);
        expect(substituteMismatch({ width: 64, height: 64, bpp: 16 }, 64, 64, true)).toMatch(/creature/);
        expect(substituteMismatch({ width: 64, height: 64, bpp: 8 }, 32, 32, true)).toBeNull();
    });
});

describe('resolvePs2Substitutes', () => {
    it('reads the disc texture with its animation frames and alpha, and reports what is missing', async () => {
        const disc = discTxd({
            7: ps2Tex(16, 16, 200, { key: true }),
            8: ps2Tex(16, 16, 100, { frame: true }),
            9: ps2Tex(16, 16, 50),
            12: ps2Tex(16, 16, 50),
        });
        const read = async (p: string) => (p === 'LEVELS/LEVEL9ON/LEVEL9ON.TXD' ? disc : null);
        const set = await resolvePs2Substitutes(
            [
                row('Pc/A#1', 'LEVELS/LEVEL9ON/LEVEL9ON.TXD#7'),
                row('Pc/A#2', 'LEVELS/LEVEL9ON/LEVEL9ON.TXD#12'),
                row('Pc/A#3', 'LEVELS/LEVEL9ON/LEVEL9ON.TXD#99'),
                row('Pc/A#4', 'NOPE/NOPE.TXD#1'),
            ],
            read,
        );
        const a = set.byOotf.get('pc/a#1')!;
        expect(a.frames.length).toBe(2); // 7 and its next frame 8, not 9
        expect(a.frames[0]).toEqual(ps2Tex(16, 16, 200, { key: true }));
        expect([a.width, a.height, a.bpp, a.hasAlpha]).toEqual([16, 16, 8, true]);
        expect(set.byOotf.get('pc/a#2')!.hasAlpha).toBe(false);
        expect(set.skipped.map((s) => s.reason)).toEqual([
            'LEVELS/LEVEL9ON/LEVEL9ON.TXD has no texture 99',
            'NOPE/NOPE.TXD is not on the disc',
        ]);
    });
});

describe('OotfAssetBuilder with Drakan 2 textures', () => {
    const files = new Map<string, Uint8Array>([
        ['lvl/lvl.mod', pcMod(5, [[3, 0]])],
        ['lvl/lvl.txd', pcTxd({ 3: [32, 32], 4: [32, 16] })],
        ['lvl/wide.mod', pcMod(6, [[4, 0]])],
    ]);
    // the wide model lives in its own container with a copy of the level TXD
    files.set('lvl/wide.txd', files.get('lvl/lvl.txd')!);
    const src: PcFileSource = {
        read: async (p) => files.get(p.toLowerCase()) ?? null,
        list: async () => [...files.keys()],
    };
    const disc = discTxd({ 40: ps2Tex(64, 64, 220), 41: ps2Tex(64, 64, 90, { frame: true }) });

    const subsFor = async (rows: Ps2TextureSubstitution[]) =>
        (await resolvePs2Substitutes(rows, async () => disc)).byOotf;

    it('copies the disc texture byte for byte, with its frames, in place of the OotF one', async () => {
        const b = new OotfAssetBuilder(src, { ps2Textures: await subsFor([row('Lvl/Lvl#3', 'X/D.TXD#40')]) });
        expect(await b.addModelRef('Lvl/Lvl', 0, 5)).toBe(2);
        const out = b.build('out', 'test').files;
        const tx = await SrscReader.fromBytes(out['out/TEST.TXD']!);
        expect(tx.entries.filter((e) => e.type === 0x40).map((e) => e.id)).toEqual([1, 2]);
        expect(await tx.readRaw(tx.find(0x40, 1)!)).toEqual(ps2Tex(64, 64, 220));
        expect(await tx.readRaw(tx.find(0x40, 2)!)).toEqual(ps2Tex(64, 64, 90, { frame: true }));
        const m = (await parseModel(await SrscReader.fromBytes(out['out/TEST.MOD']!), 2))!;
        expect(m.textures).toEqual([
            { id: 1, db: 0 },
            { id: 2, db: 0 },
        ]); // the frame follows the first in the model's texture list
        expect([...b.report.ps2Textures!.values()]).toEqual([{ ps2: 'X/D.TXD#40', used: true }]);
    });

    it('keeps the OotF texture when the table is empty, the aspect differs or a creature needs 8 bpp square', async () => {
        const plain = new OotfAssetBuilder(src);
        await plain.addModelRef('Lvl/Lvl', 0, 5);
        const tx = await SrscReader.fromBytes(plain.build('out', 'test').files['out/TEST.TXD']!);
        expect(await tx.readRaw(tx.find(0x40, 1)!)).not.toEqual(ps2Tex(64, 64, 220));

        const wide = new OotfAssetBuilder(src, { ps2Textures: await subsFor([row('Lvl/Wide#4', 'X/D.TXD#40')]) });
        expect(await wide.addModelRef('Lvl/Wide', 0, 6)).toBe(2);
        expect(wide.report.ps2Textures!.get('Lvl/Wide#4')).toMatchObject({ used: false, reason: /aspect/ });
        expect(wide.report.textures.converted).toBe(1);
    });

    it('stores one copy when several OotF textures map to the same disc texture', async () => {
        const b = new OotfAssetBuilder(src, {
            ps2Textures: await subsFor([row('Lvl/Lvl#3', 'X/D.TXD#40'), row('Lvl/Wide#3', 'X/D.TXD#40')]),
        });
        expect(await b.addTexture('Lvl/Lvl', 3)).toBe(1);
        expect(await b.addTexture('Lvl/Wide', 3)).toBe(1);
        const tx = await SrscReader.fromBytes(b.build('out', 'test').files['out/TEST.TXD']!);
        expect(tx.entries.filter((e) => e.type === 0x40).length).toBe(2); // the texture and its frame, once
    });
});
