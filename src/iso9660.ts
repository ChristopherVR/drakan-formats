import { type ByteSource, latin1, sliceSource, view } from './bytes.ts';

const SECTOR = 2048;

export interface IsoEntry {
    /** Name as stored, e.g. `LEVELLST.TXT;1`. */
    rawName: string;
    /** Name with the `;version` suffix removed. */
    name: string;
    /** Absolute path from the root using `\`, e.g. `ENGLISH\LEVELS`. */
    path: string;
    isDir: boolean;
    /** First sector (LBA) of the extent. */
    extent: number;
    size: number;
}

export class IsoError extends Error {}

function stripVersion(name: string): string {
    const i = name.lastIndexOf(';');
    return i >= 0 ? name.slice(0, i) : name;
}

function splitPath(path: string): string[] {
    const p = path.replace(/^cdrom0?:/i, '').replace(/\\/g, '/');
    return p.split('/').filter((c) => c !== '' && c !== '.');
}

/** Minimal ISO 9660 reader (primary volume descriptor, 2048-byte user-data sectors; no Joliet/Rock Ridge). */
export class Iso9660 {
    private readonly dirCache = new Map<string, IsoEntry[]>();

    private constructor(
        readonly source: ByteSource,
        readonly volumeId: string,
        readonly root: IsoEntry,
        readonly volumeSectors: number,
    ) {}

    static async open(source: ByteSource): Promise<Iso9660> {
        for (let lba = 16; lba < 16 + 32; lba++) {
            const d = await source.read(lba * SECTOR, SECTOR);
            if (d.length < SECTOR) break;
            if (latin1(d, 1, 6) !== 'CD001') throw new IsoError('not an ISO 9660 image (no CD001 descriptor)');
            const type = d[0]!;
            if (type === 255) break;
            if (type !== 1) continue;
            const dv = view(d);
            const root = Iso9660.parseRecord(d.subarray(156, 156 + 34), '')!;
            return new Iso9660(source, latin1(d, 40, 72).trimEnd(), root, dv.getUint32(80, true));
        }
        throw new IsoError('primary volume descriptor not found');
    }

    private static parseRecord(r: Uint8Array, parentPath: string): IsoEntry | null {
        const len = r[0]!;
        if (len < 33 || r.length < len) return null;
        const dv = view(r);
        const nameLen = r[32]!;
        const nameBytes = r.subarray(33, 33 + nameLen);
        const rawName = nameLen === 1 && (nameBytes[0] === 0 || nameBytes[0] === 1) ? '' : latin1(nameBytes);
        const name = stripVersion(rawName);
        return {
            rawName,
            name,
            path: parentPath === '' ? name : parentPath + '\\' + name,
            isDir: (r[25]! & 2) !== 0,
            extent: dv.getUint32(2, true),
            size: dv.getUint32(10, true),
        };
    }

    private async readDir(dir: IsoEntry): Promise<IsoEntry[]> {
        const cached = this.dirCache.get(dir.path);
        if (cached) return cached;
        const data = await this.source.read(dir.extent * SECTOR, dir.size);
        const out: IsoEntry[] = [];
        let pos = 0;
        while (pos < data.length) {
            const len = data[pos]!;
            if (len === 0) {
                // records never straddle sectors; zero length pads to the next one
                pos = (Math.floor(pos / SECTOR) + 1) * SECTOR;
                continue;
            }
            const e = Iso9660.parseRecord(data.subarray(pos, pos + len), dir.path);
            if (e && e.rawName !== '') out.push(e);
            pos += len;
        }
        this.dirCache.set(dir.path, out);
        return out;
    }

    /** Resolve a path (case-insensitive, `\` or `/`, `;1` ignored, optional `cdrom0:` prefix). */
    async find(path: string): Promise<IsoEntry | null> {
        let cur = this.root;
        for (const comp of splitPath(path)) {
            if (!cur.isDir) return null;
            const want = stripVersion(comp).toUpperCase();
            const next = (await this.readDir(cur)).find((e) => e.name.toUpperCase() === want);
            if (!next) return null;
            cur = next;
        }
        return cur;
    }

    async list(path = ''): Promise<IsoEntry[]> {
        const dir = await this.find(path);
        if (!dir || !dir.isDir) throw new IsoError(`not a directory: ${path}`);
        return this.readDir(dir);
    }

    /** Every file under `path`, depth first. */
    async walk(path = ''): Promise<IsoEntry[]> {
        const out: IsoEntry[] = [];
        const visit = async (p: string): Promise<void> => {
            for (const e of await this.list(p)) {
                if (e.isDir) await visit(e.path);
                else out.push(e);
            }
        };
        await visit(path);
        return out;
    }

    private async resolveFile(file: IsoEntry | string): Promise<IsoEntry> {
        const e = typeof file === 'string' ? await this.find(file) : file;
        if (!e || e.isDir) throw new IsoError(`not a file: ${typeof file === 'string' ? file : file.path}`);
        return e;
    }

    async read(file: IsoEntry | string, offset = 0, length?: number): Promise<Uint8Array> {
        const e = await this.resolveFile(file);
        const end = length === undefined ? e.size : Math.min(e.size, offset + length);
        if (offset >= end) return new Uint8Array(0);
        return this.source.read(e.extent * SECTOR + offset, end - offset);
    }

    /** A ByteSource over one file, for random access without reading it whole. */
    async openFile(file: IsoEntry | string): Promise<ByteSource> {
        const e = await this.resolveFile(file);
        return sliceSource(this.source, e.extent * SECTOR, e.size);
    }
}
