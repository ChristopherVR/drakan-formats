import { describe, expect, it } from 'vitest';
import { blockCacheSource, bufferSource, type ByteSource } from '../src/index.ts';

function counted(data: Uint8Array): { src: ByteSource; reads: () => number } {
    const inner = bufferSource(data);
    let n = 0;
    return {
        src: {
            size: inner.size,
            read(o, l) {
                n++;
                return inner.read(o, l);
            },
        },
        reads: () => n,
    };
}

const data = Uint8Array.from({ length: 1000 }, (_, i) => i & 0xff);

describe('blockCacheSource', () => {
    it('returns the same bytes as the source, across block edges and at the end', async () => {
        const c = blockCacheSource(bufferSource(data), { blockSize: 64, bypass: 10_000 });
        for (const [o, l] of [
            [0, 10],
            [60, 10],
            [63, 130],
            [990, 50],
            [1000, 5],
            [-5, 3],
        ] as const) {
            const want = await bufferSource(data).read(o, l);
            expect([...(await c.read(o, l))]).toEqual([...want]);
        }
    });

    it('reads each block once for many small reads', async () => {
        const { src, reads } = counted(data);
        const c = blockCacheSource(src, { blockSize: 256 });
        for (let o = 0; o < 1000; o += 8) await c.read(o, 8);
        expect(reads()).toBe(4);
    });

    it('drops the least recently used block and bypasses long reads', async () => {
        const { src, reads } = counted(data);
        const c = blockCacheSource(src, { blockSize: 100, maxBlocks: 2, bypass: 300 });
        await c.read(0, 1);
        await c.read(100, 1);
        await c.read(0, 1); // block 0 is now the most recent
        await c.read(200, 1); // drops block 1
        expect(reads()).toBe(3);
        await c.read(0, 1);
        expect(reads()).toBe(3);
        await c.read(100, 1);
        expect(reads()).toBe(4);
        await c.read(0, 500);
        expect(reads()).toBe(5);
    });

    it('hands out copies (a transferred result does not damage the cache)', async () => {
        const c = blockCacheSource(bufferSource(data), { blockSize: 64 });
        const a = await c.read(0, 4);
        a.fill(9);
        expect([...(await c.read(0, 4))]).toEqual([0, 1, 2, 3]);
    });
});
