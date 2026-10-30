// Synthetic fixtures built entirely here. No real game bytes are ever read or stored.
import { zlibSync } from 'fflate';

const SECTOR = 2048;

function u16(n: number): number[] {
    return [n & 255, (n >> 8) & 255];
}
function u32(n: number): number[] {
    return [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];
}

export interface SrscSpec {
    type: number;
    id: number;
    sub: number;
    data: Uint8Array;
}

/** Build an SRSC file: 16-byte header, 8-byte aligned payloads, trailing index. */
export function buildSrsc(specs: SrscSpec[], pad = [0xaa, 0xbb]): Uint8Array {
    const body: number[] = [];
    const entries: { spec: SrscSpec; off: number }[] = [];
    let pos = 16;
    for (const spec of specs) {
        while (pos % 8) {
            body.push(0x55);
            pos++;
        }
        entries.push({ spec, off: pos });
        body.push(...spec.data);
        pos += spec.data.length;
    }
    const idxOff = pos;
    const head = [0x53, 0x52, 0x53, 0x43, ...u16(0x0101), ...u32(idxOff), ...u32(specs.length), ...pad];
    const idx: number[] = [];
    for (const { spec, off } of entries)
        idx.push(...u16(spec.type), ...u16(spec.id), ...u16(spec.sub), ...u32(off), ...u32(spec.data.length));
    return Uint8Array.from([...head, ...body, ...idx]);
}

export type TxdSpec =
    | { bpp: 8; kind: 1; w: number; h: number; pal: number[][]; idx: number[]; zlibIdx?: boolean }
    | { bpp: 8; kind: 2; w: number; h: number; pal: number[]; idx: number[] }
    | { bpp: 16; w: number; h: number; px: number[]; zlibPlane?: boolean }
    | { bpp: 24; w: number; h: number; px: number[] }
    | { bpp: 32; w: number; h: number; px: number[]; zlibPlane?: boolean };

/** Build a texture blob as documented in analysis/scripts/txd_decode.py. */
export function buildTxd(s: TxdSpec): Uint8Array {
    const hdr = new Array<number>(0x40).fill(0);
    hdr.splice(0, 20, ...u32(s.w), ...u32(s.h), ...u32(s.w * (s.bpp / 8)), ...u32(s.bpp), ...u32(0));
    const out = [...hdr];
    if (s.bpp === 8 && s.kind === 1) {
        out.push(...u32(1), ...u32(256), ...u32(0), ...u32(0));
        for (let i = 0; i < 256; i++) {
            const [r, g, b, a] = s.pal[i] ?? [0, 0, 0, 0];
            out.push(b!, g!, r!, a!); // stored BGRA
        }
        if (s.zlibIdx) {
            const z = zlibSync(Uint8Array.from(s.idx));
            out.push(...u32(z.length), ...z);
        } else out.push(...s.idx);
    } else if (s.bpp === 8) {
        out.push(...u32(2), ...u32(256), ...u32(0), ...u32(0));
        for (let i = 0; i < 256; i++) out.push(...u16(s.pal[i] ?? 0));
        out.push(...s.idx);
    } else if (s.bpp === 16) {
        const plane = s.px.flatMap((v) => u16(v));
        if (s.zlibPlane) {
            const z = zlibSync(Uint8Array.from(plane));
            out.push(...u32(z.length), ...z);
        } else out.push(...plane);
    } else if (s.bpp === 32 && s.zlibPlane) {
        const z = zlibSync(Uint8Array.from(s.px));
        out.push(...u32(z.length), ...z);
    } else {
        out.push(...s.px);
    }
    return Uint8Array.from(out);
}

export interface IsoFileSpec {
    path: string; // e.g. ENGLISH/LEVELLST.TXT (stored with ;1)
    data: Uint8Array;
}

/** Build a tiny ISO 9660 image (PVD + directories + file data) with `\` or `/` separated paths. */
export function buildIso(files: IsoFileSpec[], volumeId = 'SYNTHETIC'): Uint8Array {
    interface Node {
        name: string;
        dirs: Map<string, Node>;
        files: { name: string; data: Uint8Array }[];
        extent: number;
        size: number;
    }
    const mk = (name: string): Node => ({ name, dirs: new Map(), files: [], extent: 0, size: 0 });
    const root = mk('');
    for (const f of files) {
        const parts = f.path.split('/');
        let cur = root;
        for (const p of parts.slice(0, -1)) {
            if (!cur.dirs.has(p)) cur.dirs.set(p, mk(p));
            cur = cur.dirs.get(p)!;
        }
        cur.files.push({ name: parts[parts.length - 1]!, data: f.data });
    }
    const record = (name: number[], extent: number, size: number, isDir: boolean): number[] => {
        let len = 33 + name.length;
        if (len % 2) len++;
        const r = new Array<number>(len).fill(0);
        r[0] = len;
        r.splice(2, 8, ...u32(extent), ...u32(extent).reverse());
        r.splice(10, 8, ...u32(size), ...u32(size).reverse());
        r[25] = isDir ? 2 : 0;
        r[32] = name.length;
        r.splice(33, name.length, ...name);
        return r;
    };
    const ascii = (s: string): number[] => [...s].map((c) => c.charCodeAt(0));

    // assign extents: PVD at 16, terminator at 17, directories after, then files
    let next = 18;
    const dirs: Node[] = [];
    const collect = (n: Node): void => {
        dirs.push(n);
        for (const d of [...n.dirs.values()].sort((a, b) => a.name.localeCompare(b.name))) collect(d);
    };
    collect(root);
    for (const d of dirs) {
        d.extent = next++; // all test directories fit one sector
    }
    const fileExtent = new Map<Uint8Array, number>();
    for (const d of dirs) {
        for (const f of d.files) {
            fileExtent.set(f.data, next);
            next += Math.max(1, Math.ceil(f.data.length / SECTOR));
        }
    }
    const img = new Uint8Array(next * SECTOR);
    const parentOf = new Map<Node, Node>();
    for (const d of dirs) for (const c of d.dirs.values()) parentOf.set(c, d);
    for (const d of dirs) {
        const parent = parentOf.get(d) ?? d;
        const recs = [
            ...record([0], d.extent, SECTOR, true),
            ...record([1], parent.extent, SECTOR, true),
            ...[...d.dirs.values()].flatMap((c) => record(ascii(c.name), c.extent, SECTOR, true)),
            ...d.files.flatMap((f) => record(ascii(f.name + ';1'), fileExtent.get(f.data)!, f.data.length, false)),
        ];
        if (recs.length > SECTOR) throw new Error('test directory too large');
        img.set(recs, d.extent * SECTOR);
    }
    for (const d of dirs) for (const f of d.files) img.set(f.data, fileExtent.get(f.data)! * SECTOR);
    const pvd = new Uint8Array(SECTOR);
    pvd[0] = 1;
    pvd.set(ascii('CD001'), 1);
    pvd[6] = 1;
    pvd.set(ascii(volumeId.padEnd(32, ' ')), 40);
    pvd.set(u32(next), 80);
    pvd.set(record([0], root.extent, SECTOR, true), 156);
    img.set(pvd, 16 * SECTOR);
    img.set([255, ...ascii('CD001'), 1], 17 * SECTOR);
    return img;
}
