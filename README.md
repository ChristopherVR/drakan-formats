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

### Converter investigation switches (Node only)

Unset by default and inert in the browser. Use only for controlled comparisons; generated packs still contain the
player's game data and must not be committed. `OOTF_*` boolean switches accept `1` to enable and `0`/empty to disable.

| Variable                                          | Effect                                                                           |
| ------------------------------------------------- | -------------------------------------------------------------------------------- |
| `DRAKAN_DBG_NAMEMAP="PC class=PS2 class;..."`     | Map named PC classes to existing PS2 classes without cloning.                    |
| `DRAKAN_DBG_TPLFORCE="PC class=PS2 template;..."` | Select a matching template from the class's eligible template pool.              |
| `DRAKAN_DBG_NOMODEL="regex"`                      | Keep template models for matching PC classes instead of converting their models. |
| `OOTF_SYNTH_BOUNDS=1`                             | Ignore the source model bounds and synthesize them from geometry.                |
| `OOTF_NO_CLSTEXT=1`                               | Disable class-text rewriting in the pipeline.                                    |
| `OOTF_NO_ALPHA_FLAG=1`                            | Suppress the output texture alpha header flag without changing pixel bytes.      |

Mapping source names are case-insensitive and trimmed. Duplicate/malformed mappings and invalid regular expressions
fail with an explicit diagnostic. A template override that is not eligible falls back to normal selection; compare
the conversion report rather than assuming the override was applied. These switches are not fixes for weapon or
controller lifecycle problems. Tests: `test/ootfdebug.test.ts`, plus the converter/model/texture regression suites.

```sh
npm run typecheck && npm test && npm run format:check
```

Tests use synthetic fixtures only.

## Credits and license

GPL-3.0-only, see `LICENSE`. Several layouts (SRSC, level header, layer definition, PC object and class records, field
types, PC model records, STOMP sequences) follow [OpenDrakan](https://github.com/Zalasus/opendrakan) by Zalasus
(GPL-3.0), which in turn credits aluigi's `drakan.bms` and community reverse engineering. The PS2 layouts were worked
out against the PAL disc. Individual source files say which parts come from where.
