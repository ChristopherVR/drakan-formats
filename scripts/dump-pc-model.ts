// Dump Drakan: Order of the Flame (PC) models to OBJ + PNG textures + a skeleton JSON, for reference in Blender.
//
//   node --experimental-transform-types --no-warnings scripts/dump-pc-model.ts \
//        --ootf <OotF data dir> --container Common/NPC/NPCs --list
//   node --experimental-transform-types --no-warnings scripts/dump-pc-model.ts \
//        --ootf <OotF data dir> --container Common/NPC/NPCs --out <dir> "Delon(h)" 3727 ...
//
// <OotF data dir> holds Dragon.rrc and Common/ (an install, or analysis/scripts/ootf_cab.py output). A model is picked by id
// or by exact name (case-insensitive). Output per model: <name>.obj/.mtl (LOD 0, model space, metres-ish game units),
// <name>_tex<id>.png, and for skinned models <name>.skeleton.json (joint names, parents, bind matrices, LOD 0 weights)
// that analysis/scripts/blender/import_pc_model.py turns into an armature. Output is game data: keep it under build/.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import {
    SrscReader,
    isSkip,
    jointParents,
    listPcModelIds,
    parsePcModel,
    parseSkeleton,
    readPcTexture,
    skinnedLodPolygons,
    type RgbaImage,
} from '../src/index.ts';

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
if (!opt.ootf || !opt.container || (!opt.list && (!opt.out || free.length === 0))) {
    console.error(
        'usage: dump-pc-model.ts --ootf <dir> --container <Common/NPC/NPCs> (--list | --out <dir> <id|name>...)',
    );
    process.exit(2);
}

async function open(ext: string): Promise<SrscReader | null> {
    try {
        return await SrscReader.fromBytes(readFileSync(join(opt.ootf!, `${opt.container}.${ext}`)));
    } catch {
        return null;
    }
}

function png(img: RgbaImage): Uint8Array {
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

const mod = await open('mod');
if (!mod) throw new Error(`${opt.container}.mod not found under ${opt.ootf}`);
const ids = listPcModelIds(mod);

if (opt.list) {
    for (const id of ids) {
        const m = await parsePcModel(mod, id).catch(() => null);
        if (m)
            console.log(
                `${id}\t${m.name}\t${m.positions.length / 3} verts\t${m.polygons.length} polys${m.character ? '\tskinned' : ''}`,
            );
    }
    process.exit(0);
}

const txd = await open('txd');
mkdirSync(opt.out!, { recursive: true });
for (const want of free) {
    let id = /^\d+$/.test(want) ? Number(want) : -1;
    if (id < 0) {
        for (const i of ids) if ((await modelName(i)).toLowerCase() === want.toLowerCase()) id = i;
    }
    const pc = id >= 0 ? await parsePcModel(mod, id) : null;
    if (!pc) {
        console.error(`no model ${want}`);
        continue;
    }
    const base = safe(pc.name);
    let first = 0;
    let count = pc.positions.length / 3;
    let polys = pc.polygons;
    let skeleton: unknown = null;
    if (pc.character) {
        const sk = parseSkeleton(await mod.readRaw(mod.find(MOD_CHARACTER, id)!), 'pc');
        const L = sk.lods[0]!;
        first = L.firstVertex;
        count = L.vertexCount;
        polys = skinnedLodPolygons(pc.polygons, sk); // LOD 0 without the limb stump caps
        const parent = jointParents(sk);
        const names = new Array<string>(sk.joints.length).fill('');
        for (const n of sk.nodes)
            if (n.joint >= 0 && n.joint < names.length && !names[n.joint]) names[n.joint] = n.name;
        skeleton = {
            model: pc.name,
            note: 'inverseBind: model-to-joint 3x4, rotation rows then translation (PC order); weights index LOD 0 vertices',
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
    // textures
    const mtl: string[] = [];
    pc.textures.forEach((t, i) => {
        mtl.push(`newmtl tex${i}`, 'Kd 1 1 1');
        mtl.push(`map_Kd ${base}_tex${t.id}.png`, '');
    });
    for (const t of pc.textures) {
        if (!txd || t.db !== 0) {
            console.error(`  texture ${t.id} (db ${t.db}) not in ${opt.container}.txd; skipped`);
            continue;
        }
        const tex = await readPcTexture(txd, t.id);
        if (isSkip(tex)) console.error(`  texture ${t.id}: ${tex.reason}`);
        else writeFileSync(join(opt.out!, `${base}_tex${t.id}.png`), png(tex.image));
    }
    writeFileSync(join(opt.out!, `${base}.mtl`), mtl.join('\n'));
    // geometry: OBJ (vertex numbers are LOD-relative, matching the skeleton weights)
    const obj: string[] = [`# ${pc.name} (PC id ${id})`, `mtllib ${base}.mtl`, `o ${base}`];
    for (let v = 0; v < count; v++) {
        const k = (first + v) * 3;
        obj.push(`v ${pc.positions[k]} ${pc.positions[k + 1]} ${pc.positions[k + 2]}`);
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
            obj.push(`vt ${p.uvs[k * 2]} ${1 - p.uvs[k * 2 + 1]!}`);
            f.push(`${p.indices[k]! + 1}/${++vt}`);
        }
        obj.push(`f ${f.join(' ')}`);
    }
    writeFileSync(join(opt.out!, `${base}.obj`), obj.join('\n') + '\n');
    console.log(
        `${id} ${pc.name}: ${count} verts, ${polys.length} polys, ${pc.textures.length} textures${skeleton ? ', skeleton' : ''} -> ${base}.obj`,
    );
}
