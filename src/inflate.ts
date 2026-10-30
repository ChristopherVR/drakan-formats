import { unzlibSync } from 'fflate';

function adler32(d: Uint8Array): number {
    let a = 1;
    let b = 0;
    for (let i = 0; i < d.length; i++) {
        a = (a + d[i]!) % 65521;
        b = (b + a) % 65521;
    }
    return ((b << 16) | a) >>> 0;
}

/**
 * Inflate a zlib stream; null if it is not a valid stream. fflate does not verify the Adler-32 trailer (and returns
 * an empty result for some garbage), so the trailer is checked here; a stream must end exactly at its trailer.
 */
export function inflate(data: Uint8Array): Uint8Array | null {
    try {
        const out = unzlibSync(data);
        const n = data.length;
        if (n < 6) return null;
        const want = ((data[n - 4]! << 24) | (data[n - 3]! << 16) | (data[n - 2]! << 8) | data[n - 1]!) >>> 0;
        return adler32(out) === want ? out : null;
    } catch {
        return null;
    }
}
