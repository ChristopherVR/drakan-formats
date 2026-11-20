// Dump Drakan: The Ancients' Gates (PS2) disc models to OBJ + PNG textures + a skeleton JSON, for reference in Blender.
// The PS2 counterpart of dump-pc-model.ts, with the same output, so analysis/scripts/blender/import_pc_model.py opens it.
//
//   node --no-warnings scripts/dump-ps2-model.ts \
//        --iso <disc image> --container ENGLISH/COMMON/NPC/NPCS --list
//   node --no-warnings scripts/dump-ps2-model.ts \
//        --iso <disc image> --container ENGLISH/COMMON/NPC/NPCS --out <dir> "Villager Female" 3727 ...
//
// --container is the disc path of a MOD without its extension (the TXD and ODB beside it are used when present). A model is
// picked by id, by exact model name, or by the exact name of an ODB class that uses it (case-insensitive). --list prints every
// model with its counts and the classes of the container's ODB that use it. Output per model: <name>.obj/.mtl (LOD 0, model
// space: Y up, game units of about 1 mm like the PC dumps), <name>_tex<id>.png, and for skinned models <name>.skeleton.json
// (joint names, parents, inverse bind matrices in PC order, LOD 0 weights). Textures named with a `db` index come from the
// container listed in the MOD's .DB. Output is game data: keep it under build/.
import { closeSync, fstatSync, mkdirSync, openSync, readSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import {
    Iso9660,
    SrscReader,
    TXD_ENTRY_TYPE,
    decodeTxd,
    jointParents,
    listModelIds,
    parseSkeleton,
    readPs2Neutral,
    skinnedLodPolygons,
    type ByteSource,
    type IsoEntry,
    type TxdImage,
} from '../src/index.ts';
import { odbStemForDependency, parseOdbClasses } from '../src/odb.ts';

const MOD_CHARACTER = 0x0208;

const opt: Record<string, string> = {};
const free: string[] = [];
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--list') opt.list = '1';
    else if (a.startsWith('--')) opt[a.slice(2)] = argv[++i] ?? '';
    else free.push(a);
}
if (!opt.iso || !opt.container || (!opt.list && (!opt.out || free.length === 0))) {
    console.error(
        'usage: dump-ps2-model.ts --iso <disc image> --container <ENGLISH/COMMON/NPC/NPCS> (--list | --out <dir> <id|name>...)',
    );
    process.exit(2);
}

/** The disc image read on demand (it is several GB). */
function fileSource(path: string): ByteSource & { close(): void } {
    const fd = openSync(path, 'r');
    const size = fstatSync(fd).size;
    return {
        size,
        read(offset, length) {
            const n = Math.max(0, Math.min(length, size - offset));
            const b = Buffer.alloc(n);
            if (n) readSync(fd, b, 0, n, offset);
            return Promise.resolve(new Uint8Array(b.buffer, b.byteOffset, n));
        },
        close: () => closeSync(fd),
    };
}

const src = fileSource(opt.iso!);
const iso = await Iso9660.open(src);
const container = opt.container!.replace(/\\/g, '/');
const lang = container.split('/')[0]!.toUpperCase();
const stem = container.split('/').pop()!.toUpperCase();

async function open(path: string): Promise<SrscReader | null> {
    const e = await iso.find(path).catch(() => null);
    return e && !e.isDir ? SrscReader.fromBytes(await iso.read(e)) : null;
}

/** Disc files by upper-case name, the container's language first (for the `.DB` dependencies). */
let files: Map<string, IsoEntry> | null = null;
async function fileNamed(name: string): Promise<IsoEntry | null> {
    if (!files) {
        files = new Map();
        const all = (await iso.walk()).filter((e) => !e.isDir);
        for (const e of all.sort((a, b) => Number(b.path.startsWith(lang)) - Number(a.path.startsWith(lang))))
            if (!files.has(e.name.toUpperCase())) files.set(e.name.toUpperCase(), e);
    }
    return files.get(name.toUpperCase()) ?? null;
}

/** TXD behind a texture `db` index (0 = the container's own; else a line `<db> <path>` of the container's .DB). */
const txds = new Map<number, Promise<{ name: string; txd: SrscReader | null }>>();
const dbText = await (async () => {
    const e = await iso.find(`${container}.DB`).catch(() => null);
    return e ? new TextDecoder('latin1').decode(await iso.read(e)) : '';
})();
function txdFor(db: number): Promise<{ name: string; txd: SrscReader | null }> {
    let p = txds.get(db);
    if (!p) {
        p = (async () => {
            if (db === 0) return { name: stem, txd: await open(`${container}.TXD`) };
            for (const m of dbText.matchAll(/^(\d+)\s+(.+?)\s*$/gm)) {
                if (Number(m[1]) !== db) continue;
                const s = odbStemForDependency(m[2]!);
                const e = await fileNamed(`${s}.TXD`);
                return { name: s, txd: e ? await SrscReader.fromBytes(await iso.read(e)) : null };
            }
            return { name: `db${db}`, txd: null };
        })();
        txds.set(db, p);
    }
    return p;
}

function png(img: { width: number; height: number; rgba: Uint8Array }): Uint8Array {
    const chunk = (type: string, data: Uint8Array): Buffer => {
        const head = Buffer.alloc(8);
        head.writeUInt32BE(data.length, 0);
        head.write(type, 4, 'latin1');
        const crc = Buffer.alloc(4);
        crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
        return Buffer.concat([head, data, crc]);
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(img.width, 0);
    ihdr.writeUInt32BE(img.height, 4);
    ihdr[8] = 8; // bit depth
    ihdr[9] = 6; // RGBA
    const row = img.width * 4;
    const raw = Buffer.alloc((row + 1) * img.height);
    for (let y = 0; y < img.height; y++) raw.set(img.rgba.subarray(y * row, (y + 1) * row), y * (row + 1) + 1);
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', ihdr),
        chunk('IDAT', deflateSync(raw)),
        chunk('IEND', new Uint8Array(0)),
    ]);
}

/** Model name from its 0x0200 record only (parsing whole models to search by name is slow). */
async function modelName(id: number): Promise<string> {
    const e = mod!.find(0x0200, id);
    if (!e) return '';
    const b = await mod!.readRaw(e);
    const n = b[0]! | (b[1]! << 8);
    let s = '';
    for (let i = 2; i < 2 + n && i < b.length && b[i] !== 0; i++) s += String.fromCharCode(b[i]!);
    return s;
}

const safe = (s: string): string => s.replace(/[^A-Za-z0-9_.-]+/g, '_').replace(/^_+|_+$/g, '') || 'model';

const mod = await open(`${container}.MOD`);
if (!mod) throw new Error(`${container}.MOD not found on ${opt.iso}`);
const ids = listModelIds(mod);
// Classes of the container's ODB by the model they use (own models only: db 0).
const odb = await open(`${container}.ODB`);
const classesOf = new Map<number, { name: string; rfl: number | null }[]>();
for (const c of odb ? (await parseOdbClasses(odb)).values() : [])
    if (c.model && c.model.db === 0) {
        const l = classesOf.get(c.model.id) ?? [];
        l.push({ name: c.name, rfl: c.runtimeClass === null ? null : c.runtimeClass & 0xffff });
        classesOf.set(c.model.id, l);
    }

if (opt.list) {
    for (const id of ids) {
        const m = await readPs2Neutral(mod, id).catch(() => null);
        if (!m) continue;
        const skinned = mod.find(MOD_CHARACTER, id) ? '\tskinned' : '';
        const cls = (classesOf.get(id) ?? []).map((c) => `${c.name} [${c.rfl}]`).join(', ');
        console.log(
            `${id}\t${m.name}\t${m.positions.length / 3} verts\t${m.polygons.length} polys${skinned}${cls ? `\t${cls}` : ''}`,
        );
    }
    src.close();
    process.exit(0);
}

mkdirSync(opt.out!, { recursive: true });
for (const want of free) {
    let id = /^\d+$/.test(want) ? Number(want) : -1;
    if (id < 0) for (const i of ids) if ((await modelName(i)).toLowerCase() === want.toLowerCase()) id = i;
    if (id < 0) for (const [i, l] of classesOf) if (l.some((c) => c.name.toLowerCase() === want.toLowerCase())) id = i;
    const m = id >= 0 ? await readPs2Neutral(mod, id) : null;
    if (!m) {
        console.error(`no model ${want}`);
        continue;
    }
    const base = safe(m.name);
    let first = 0;
    let count = m.positions.length / 3;
    let polys = m.polygons;
    let skeleton: unknown = null;
    const ch = mod.find(MOD_CHARACTER, id);
    if (ch) {
        const sk = parseSkeleton(await mod.readRaw(ch), 'ps2');
        const L = sk.lods[0]!;
        first = L.firstVertex;
        count = L.vertexCount;
        polys = skinnedLodPolygons(m.polygons, sk); // LOD 0 without the limb stump caps
        const parent = jointParents(sk);
        const names = new Array<string>(sk.joints.length).fill('');
        for (const n of sk.nodes)
            if (n.joint >= 0 && n.joint < names.length && !names[n.joint]) names[n.joint] = n.name;
        skeleton = {
            model: m.name,
            note: 'inverseBind: model-to-joint 3x4, rotation rows then translation (PC order; the PS2 record stores translation first); weights index LOD 0 vertices',
            joints: sk.joints.map((j, i) => ({
                name: names[i] || `joint${i}`,
                parent: parent[i],
                inverseBind: j.xform,
                weights: (j.weights[0] ?? []).map((w) => [w.vertex, w.weight]),
            })),
            channels: sk.channels.map((c) => c.joint),
        };
        writeFileSync(join(opt.out!, `${base}.skeleton.json`), JSON.stringify(skeleton, null, 1));
    }
    // textures (first frame of animated ones)
    const mtl: string[] = [];
    const texInfo: string[] = [];
    m.textures.forEach((t, i) => {
        mtl.push(`newmtl tex${i}`, 'Kd 1 1 1');
        mtl.push(`map_Kd ${base}_tex${t.id}.png`, '');
    });
    for (const t of m.textures) {
        const { name, txd } = await txdFor(t.db);
        const e = txd?.find(TXD_ENTRY_TYPE, t.id);
        if (!txd || !e) {
            console.error(`  texture ${t.id} (db ${t.db}, ${name}.TXD) not found; skipped`);
            continue;
        }
        let tex: TxdImage;
        try {
            tex = decodeTxd((await txd.read(e)).data);
        } catch (err) {
            console.error(`  texture ${t.id}: ${err instanceof Error ? err.message : String(err)}`);
            continue;
        }
        texInfo.push(
            `${t.id} ${tex.width}x${tex.height} ${tex.bpp}bpp${tex.paletteKind ? ` pal${tex.paletteKind}` : ''} ${name}`,
        );
        writeFileSync(join(opt.out!, `${base}_tex${t.id}.png`), png(tex));
    }
    writeFileSync(join(opt.out!, `${base}.mtl`), mtl.join('\n'));
    // geometry: OBJ (vertex numbers are LOD-relative, matching the skeleton weights)
    const obj: string[] = [`# ${m.name} (PS2 ${stem} id ${id})`, `mtllib ${base}.mtl`, `o ${base}`];
    for (let v = 0; v < count; v++) {
        const k = (first + v) * 3;
        obj.push(`v ${m.positions[k]} ${m.positions[k + 1]} ${m.positions[k + 2]}`);
    }
    let vt = 0;
    let cur = -1;
    for (const p of polys) {
        if (p.texture !== cur) {
            cur = p.texture;
            obj.push(`usemtl tex${cur}`);
        }
        const f: string[] = [];
        for (let k = 0; k < p.indices.length; k++) {
            obj.push(`vt ${p.uvs[k * 2]} ${p.uvs[k * 2 + 1]}`); // PS2 v already runs bottom-up against the upright PNG
            f.push(`${p.indices[k]! + 1}/${++vt}`);
        }
        obj.push(`f ${f.join(' ')}`);
    }
    writeFileSync(join(opt.out!, `${base}.obj`), obj.join('\n') + '\n');
    console.log(
        `${id} ${m.name}: ${count} verts, ${polys.length} polys (${polys.filter((q) => q.indices.length === 4).length} quads, ${polys.filter((q) => q.flags & 2).length} double sided), ${m.textures.length} textures (${texInfo.join('; ')})${skeleton ? ', skeleton' : ''} -> ${base}.obj`,
    );
}
src.close();
