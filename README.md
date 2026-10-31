# drakan-formats

Readers, writers and converters for the file formats of the Drakan games (Surreal Software / Riot engine),
in dependency-free TypeScript (one runtime dependency, `fflate`). It runs in Node and in the browser.

It started inside [Drakan2PC](https://github.com/ChristopherVR/Drakan2PC) (the PS2 static recompilation of
_Drakan: The Ancients' Gates_ and its level editor) and lives here so other tools can use it.

**No game data is included or accepted into this repository.** Bring your own copies of the games.

## What is in it

| Area                                                 | Modules                                                                                                                               |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Containers                                           | `srsc` (SRSC resource files, PS2 and PC headers, byte-identical writer), `iso9660`, `levellist`                                       |
| Levels                                               | `lvl` (header, objects), `terrain` (layers, PS2 and PC), `terrainblob`, `odb`, `fields`                                               |
| Models, textures, sounds                             | `model`, `txd`, `ootfmodel`, `ootftex`, `ootfsound` (PS-ADPCM encoder)                                                                |
| Story                                                | `story/*` (sequences, conversations, text), `xdb`, `quests`, `save`                                                                   |
| **Order of the Flame (PC) to Ancients' Gates (PS2)** | `pc` (read OotF), `convert` (level conversion), `ootfclass`, `ootfseq`, `ootfmodel`, `ootftex`, `ootfsound`, `ootfanim`, `ootfassets` |

### Converter status

Verified against real files on both sides (see `docs/` in Drakan2PC for the investigation notes):
level header, object placement, terrain layers, class and parameter mapping by name, static models and textures,
sound banks, cutscene sequences. A converted level has been loaded and walked in the recompiled PS2 game.

Not finished: skeleton and animation conversion (decoders exist, the rotation basis change is unresolved), the PS2
display-list copy of models (0x0211), and music. Objects whose class has no PS2 counterpart are left out and listed in
the conversion report.

## Use

```ts
import { loadPcLevel, convertPcLevel, buildPs2Lvl, ps2BlobFor } from '@drakan/formats';
```

`scripts/pc-level-to-ps2.ts` is a small command line example (Node 24):

```sh
npm install
node --experimental-transform-types --no-warnings scripts/pc-level-to-ps2.ts \
  --ootf "<OotF install>" --ps2 "<extracted PS2 files>" --template LEVEL1NA --out out.LVL "Multiplayer/Ground/Relic/Relic.lvl"
```

## Development

```sh
npm run typecheck && npm test && npm run format:check
```

Tests use synthetic fixtures only.

## Credits and license

GPL-3.0-only, see `LICENSE`. Several layouts (SRSC, level header, layer definition, PC object and class records, field
types, PC model records, STOMP sequences) follow [OpenDrakan](https://github.com/Zalasus/opendrakan) by Zalasus
(GPL-3.0), which in turn credits aluigi's `drakan.bms` and community reverse engineering. The PS2 layouts were worked
out against the PAL disc. Individual source files say which parts come from where.
