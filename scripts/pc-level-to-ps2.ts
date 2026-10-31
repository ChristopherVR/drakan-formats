// Convert one Drakan: Order of the Flame (PC) level to a Drakan: The Ancients' Gates (PS2) .LVL.
//
//   node --experimental-transform-types --no-warnings scripts/pc-level-to-ps2.ts \
//        --ootf <OotF install dir> --ps2 <dir with extracted PS2 LEVEL*.LVL and *.ODB> \
//        --template LEVEL1NA --out out.LVL "Multiplayer/Ground/Relic/Relic.lvl"
//
// Bring your own game files: nothing is bundled. The PS2 side only needs the template level and the ODBs it depends on.
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import {
    LVL_TYPE_LAYERS,
    SrscReader,
    buildOdbIndex,
    buildPs2Lvl,
    convertPcLevel,
    dominantTexture,
    loadPcLevel,
    parsePs2Terrain,
    ps2BlobBuilder,
    ps2ClassTables,
    ps2LevelTag,
    readLvl,
    type PcFileSource,
} from '../src/index.ts';

const opt: Record<string, string> = {};
const free: string[] = [];
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith('--')) opt[a.slice(2)] = argv[++i] ?? '';
    else free.push(a);
}
const need = (k: string): string => opt[k] ?? (console.error(`missing --${k}`), process.exit(2));
if (free.length !== 1) {
    console.error('give exactly one PC level path (relative to the OotF install)');
    process.exit(2);
}

const root = need('ootf');
const all: string[] = [];
(function walk(d: string) {
    for (const f of readdirSync(d)) {
        const p = join(d, f);
        statSync(p).isDirectory() ? walk(p) : all.push(relative(root, p).split(sep).join('/'));
    }
})(root);
const byLower = new Map(all.map((p) => [p.toLowerCase(), p]));
const src: PcFileSource = {
    read: async (p) => {
        const r = byLower.get(p.toLowerCase());
        return r ? new Uint8Array(readFileSync(join(root, r))) : null;
    },
    list: async () => all,
};

const ps2 = need('ps2');
const template = await SrscReader.fromBytes(
    new Uint8Array(readFileSync(join(ps2, `${need('template').toUpperCase()}.LVL`))),
);
const tpl = await readLvl(template);
const odbs = new Map<string, SrscReader>();
for (const f of readdirSync(ps2).filter((x) => /\.ODB$/i.test(x))) {
    odbs.set(f.slice(0, -4).toUpperCase(), await SrscReader.fromBytes(new Uint8Array(readFileSync(join(ps2, f)))));
}
const classes = ps2ClassTables(tpl.header, await buildOdbIndex(odbs));
const layers = await template.readRaw(template.entries.find((e) => e.type === LVL_TYPE_LAYERS)!);
const parts = convertPcLevel(await loadPcLevel(src, free[0]!), {
    template: { header: tpl.header, classes },
    textureFallback: dominantTexture(parsePs2Terrain(layers)),
});
writeFileSync(need('out'), await buildPs2Lvl(template, parts, ps2BlobBuilder(ps2LevelTag(layers) ?? 0x18)));
const R = parts.report;
console.log(`${R.objectsOut}/${R.objectsIn} objects, ${R.layers} layers, ${R.unmappedClasses.size} classes left out`);
