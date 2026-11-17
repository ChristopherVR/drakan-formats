/**
 * Drakan 2 disc models for placed Order of the Flame props and dungeon pieces, from the 2026-11-17 props survey (journal
 * 2026-11-17/ootf-world-surveys.md). WORLDCON carries a PS2 remake of the whole OotF dungeon kit ("(H) PS2" classes, same
 * grid size and origin), MOUNTAON the Wartok crate under the OotF model number, the other ODBs same-kind props. Every row
 * passes the converter's size and origin check (`discModelMismatch`), the table, chest and lid rows by stretching (`fit`);
 * Rynn collides with the OotF model. Names only, no game data. Part of DEFAULT_PS2_MODEL_SUBSTITUTIONS (ootfps2model.ts).
 */

import type { Ps2ModelSubstitution } from './ootfps2model.ts';

const prop = (
    pc: string,
    pcModel: string,
    odb: string,
    ps2: string,
    label: string,
    why: string,
    defaultOff = false,
    fit = false,
): Ps2ModelSubstitution => ({
    category: 'props',
    ootf: pc,
    pcModel,
    odb,
    ps2,
    label,
    why,
    ...(defaultOff ? { defaultOff } : {}),
    ...(fit ? { fit } : {}),
});

const WS_KIT_WHY =
    'Drakan 2 ships a PS2 remake of the Order of the Flame dungeon kit (WORLDCON "(H) PS2" classes, 300 to 900 triangles against 2 to 100 polygons, rough stone edges): same grid size and origin, so the pieces still join; Rynn collides with the OotF piece.';
const WS_STAIRS_WHY =
    'Drakan 2 ships a PS2 remake of the Order of the Flame dungeon kit (WORLDCON "(H) PS2" classes, 300 to 900 triangles against 2 to 100 polygons, rough stone edges): same grid size and origin, so the pieces still join; Rynn collides with the OotF piece. The Drakan 2 stairs carry arch frames at both ends and are 0.1 to 0.2 units wider and deeper (inside the size check).';
const WS_ENTRANCE_WHY =
    'Drakan 2 ships a PS2 remake of the Order of the Flame dungeon kit (WORLDCON "(H) PS2" classes, 300 to 900 triangles against 2 to 100 polygons, rough stone edges): same grid size and origin, so the pieces still join; Rynn collides with the OotF piece. The Drakan 2 entrance reaches about 0.34 units further into the rock and 0.15 higher (inside the size check, hidden in the rock).';
const WS_CRATE_WHY =
    'Drakan 2 MOUNTAON "Troll Crate" has the OotF model number and is its remake (iron bands, studs, painted shading; 156 triangles against 62 polygons), same size and origin; Rynn collides with the OotF crate.';
const WS_STRONG_WHY =
    'The Drakan 2 copy of the same crate (same model number and size) with its repainted iron-bound texture; Rynn collides with the OotF crate.';
const WS_WHEELS_WHY =
    'The Drakan 2 Grimstone-style mine cart wheel pair (478 triangles against 44 polygons), same size and origin; Rynn collides with the OotF wheels.';
const WS_COCOON_WHY =
    'The Drakan 2 spider cocoon is the same cocoon remade (216 triangles against 36), same size and origin; Rynn collides with the OotF cocoon.';
const WS_BED_WHY =
    'The Drakan 2 wooden bed (173 triangles against 21 polygons) of the same kind and footprint, a little taller at the head; Rynn collides with the OotF bed.';
const WS_ANVIL_WHY =
    'The Drakan 2 anvil is the same anvil model (same name and size) with a repainted dark iron texture; Rynn collides with the OotF anvil.';
const WS_SAME_WHY =
    'Drakan 2 carries the same model (same name, size and origin); drawn with the disc textures, which the HD texture pack covers. Low visual gain.';
const WS_CHEST_WHY =
    'A looser match: the Drakan 2 chest and lid of the same shape and nearly the same size, stretched onto the OotF chest and lid boxes (its origin sits at one end, the OotF one in the middle); the lid still opens on the OotF hinge and Rynn collides with the OotF chest.';
const WS_TABLE_WHY =
    'A looser match: the Drakan 2 plank table (68 triangles against 22 polygons), 20 % longer and wider, stretched onto the OotF table; Rynn collides with the OotF table.';

export const WORLD_PROP_SUBSTITUTIONS: readonly Ps2ModelSubstitution[] = [
    prop('Staright Piece', 'Straight01', 'WORLDCON', 'Straight01(H) PS2', 'Dungeon corridor', WS_KIT_WHY, false, false),
    prop('Left Turn', 'Left Turn', 'WORLDCON', 'Left Turn (H) PS2', 'Dungeon corridor turn', WS_KIT_WHY, false, false),
    prop('Ceiling', 'ceiling', 'WORLDCON', 'Ceiling (H) PS2', 'Dungeon ceiling', WS_KIT_WHY, false, false),
    prop('Ceiling', 'ceiling(temp)', 'WORLDCON', 'Ceiling (H) PS2', 'Dungeon ceiling', WS_KIT_WHY, false, false),
    prop(
        'Hall Entrance',
        'Hall Entrance01(L)',
        'WORLDCON',
        'Hall Entrance 01 (H) PS2',
        'Dungeon hall entrance',
        WS_KIT_WHY,
        false,
        false,
    ),
    prop('Arch', 'Archway01', 'WORLDCON', 'Archway 01 (H) PS2', 'Dungeon archway', WS_KIT_WHY, false, false),
    prop(
        'Stairs Straight',
        'Stairs Straight01(L)',
        'WORLDCON',
        'Stairs Straight01 (H) PS2',
        'Dungeon stairs',
        WS_STAIRS_WHY,
        false,
        false,
    ),
    prop(
        'Right Turn',
        'Right Turn',
        'WORLDCON',
        'Right Turn (H) PS2',
        'Dungeon corridor turn',
        WS_KIT_WHY,
        false,
        false,
    ),
    prop('Left Open', 'LeftOpen', 'WORLDCON', 'Left Open (H) PS2', 'Dungeon side opening', WS_KIT_WHY, false, false),
    prop('Left Open', 'LeftOpen(L)', 'WORLDCON', 'Left Open (H) PS2', 'Dungeon side opening', WS_KIT_WHY, false, false),
    prop('Corner', 'corner', 'WORLDCON', 'Corner (H) PS2', 'Dungeon corner', WS_KIT_WHY, false, false),
    prop('Corner', 'corner(temp)', 'WORLDCON', 'Corner (H) PS2', 'Dungeon corner', WS_KIT_WHY, false, false),
    prop(
        'Entrance',
        'Entrance',
        'WORLDCON',
        'Entrance_H(Light) PS2',
        'Dungeon entrance from rock',
        WS_ENTRANCE_WHY,
        false,
        false,
    ),
    prop('Half Wall', 'Half Wall', 'WORLDCON', 'Half Wall (H) PS2', 'Dungeon half wall', WS_KIT_WHY, false, false),
    prop(
        'Hall Turn',
        'Hall Turn01(L)',
        'WORLDCON',
        'Half Turn01 (H) PS2',
        'Dungeon hall turn',
        WS_KIT_WHY,
        false,
        false,
    ),
    prop(
        'Wall Corner no ceiling',
        'Wall Corner no ceiling',
        'WORLDCON',
        'Wall Corner No Ceiling PS2',
        'Dungeon open corner',
        WS_KIT_WHY,
        false,
        false,
    ),
    prop('Archway 01', 'Archway01', 'WORLDCON', 'Archway 01 (H) PS2', 'Dungeon archway', WS_KIT_WHY, false, false),
    prop('Pit Corner', 'Pit_Corner01', 'WORLDCON', 'Pit_Corner Ps2', 'Dungeon pit corner', WS_KIT_WHY, false, false),
    prop('Straight 01', 'Straight01', 'WORLDCON', 'Straight01(H) PS2', 'Dungeon corridor', WS_KIT_WHY, false, false),
    prop(
        'Alcove bottom',
        'Straight Alcove Bottom01(H)',
        'WORLDCON',
        'Straight Alcove Bottom01 (H) PS',
        'Dungeon alcove',
        WS_KIT_WHY,
        false,
        false,
    ),
    prop('Right Open', 'RightOpen', 'WORLDCON', 'Right Open (H) PS2', 'Dungeon side opening', WS_KIT_WHY, false, false),
    prop(
        'Right Open',
        'RightOpen(L)',
        'WORLDCON',
        'Right Open (H) PS2',
        'Dungeon side opening',
        WS_KIT_WHY,
        false,
        false,
    ),
    prop('Pit 2Side', 'Pit_2Sides', 'WORLDCON', 'Pit_2sides PS2', 'Dungeon pit', WS_KIT_WHY, false, false),
    prop(
        'Straight Short Alcove Open',
        'Straight Alcove Short Open01(H)',
        'WORLDCON',
        'Straight Alcove Short Open 01 P',
        'Dungeon alcove',
        WS_KIT_WHY,
        false,
        false,
    ),
    prop('Pit 1Side', 'Pit_1Side', 'WORLDCON', 'Pit_1Side Ps2', 'Dungeon pit', WS_KIT_WHY, false, false),
    prop('Straight 02', 'Straight02', 'WORLDCON', 'Straight02(H) PS2', 'Dungeon corridor', WS_KIT_WHY, false, false),
    prop('Pit 1X1', 'Pit_1x1', 'WORLDCON', 'Pit_1x1 PS2', 'Dungeon pit', WS_KIT_WHY, false, false),
    prop(
        'EntranceSmall',
        'Entrance Small',
        'WORLDCON',
        'Small Entrance_H(Light) PS2',
        'Small dungeon entrance',
        WS_ENTRANCE_WHY,
        false,
        false,
    ),
    prop(
        'Entrance (small)',
        'Entrance Small (mountain)',
        'WORLDCON',
        'Small Entrance_H(Light) PS2',
        'Small dungeon entrance',
        WS_ENTRANCE_WHY,
        false,
        false,
    ),
    prop('Pit End', 'Pit_End', 'WORLDCON', 'Pit_End PS2', 'Dungeon pit end', WS_KIT_WHY, false, false),
    prop(
        'Straight Alcove No Ceiling',
        'Sraight Alcove no ceiling',
        'WORLDCON',
        'Straight Alcove No Ceiling PS2',
        'Dungeon alcove',
        WS_KIT_WHY,
        false,
        false,
    ),
    prop(
        'Hall Turn 02',
        'Hall Turn02(L)',
        'WORLDCON',
        'Half Turn02 (H) PS2',
        'Dungeon hall turn',
        WS_KIT_WHY,
        false,
        false,
    ),
    prop(
        'Straight No Ceiling',
        'staight no ceiling (l)',
        'WORLDCON',
        'Straight Hall No Ceiling (H) PS',
        'Dungeon open corridor',
        WS_KIT_WHY,
        false,
        false,
    ),
    prop(
        'Alcove left',
        'Straight Alcove Left01(H)',
        'WORLDCON',
        'Straight Alcove Left 01 (H) PS2',
        'Dungeon alcove',
        WS_KIT_WHY,
        false,
        false,
    ),
    prop(
        'Alcove top',
        'Straight Alcove Top01(H)',
        'WORLDCON',
        'Straight Alcove Top01 (H) PS2',
        'Dungeon alcove',
        WS_KIT_WHY,
        false,
        false,
    ),
    prop(
        'Staight Alcove Open',
        'Straight Alcove Left Open01(H)',
        'WORLDCON',
        'Straight Alcove Left Open01 PS2',
        'Dungeon alcove',
        WS_KIT_WHY,
        false,
        false,
    ),
    prop('Troll Crate', 'TrollCrate01', 'MOUNTAON', 'Troll Crate', 'Wartok crate', WS_CRATE_WHY, false, false),
    prop('Grimstone crate', 'TrollCrate01', 'MOUNTAON', 'Troll Crate', 'Wartok crate', WS_CRATE_WHY, false, false),
    prop(
        'Strong Crate V',
        'Strong Crate(H)',
        'MOUNTAON',
        'Strong Crate V',
        'Iron-bound crate',
        WS_STRONG_WHY,
        false,
        false,
    ),
    prop(
        'Strong Crate H',
        'S Crate Hor(H)',
        'MOUNTAON',
        'Strong Crate H',
        'Iron-bound crate (lying)',
        WS_STRONG_WHY,
        false,
        false,
    ),
    prop(
        'Mine Cart Wheels',
        'MineCartWheels(H)',
        'LEVEL2RE',
        'CartWheels',
        'Mine cart wheels',
        WS_WHEELS_WHY,
        false,
        false,
    ),
    prop('Cocoon 01', 'Cocoon01', 'LEVEL2RE', 'Cacoon 1', 'Spider cocoon', WS_COCOON_WHY, false, false),
    prop('Cocoon 01 of Death', 'Cocoon01', 'LEVEL2RE', 'Cacoon 1', 'Spider cocoon', WS_COCOON_WHY, false, false),
    prop('bed', 'bed', 'WORLDCON', 'Bed03', 'Bed', WS_BED_WHY, false, false),
    prop('Anvil', 'Anvil01', 'LEVEL3ON', 'Anvil', 'Anvil', WS_ANVIL_WHY, false, false),
    prop('Rock Slide Boulder Generator', 'Boulder(H)', 'WORLDCON', 'Boulder', 'Boulder', WS_SAME_WHY, false, false),
    prop('Normal Pillar', 'full pillar', 'WORLDCON', 'Full Column', 'Column', WS_SAME_WHY, false, false),
    prop('Goblin Pillar', 'full pillar', 'WORLDCON', 'Full Column', 'Column', WS_SAME_WHY, false, false),
    prop(
        'Broken Column 01',
        'BrokenPillar01',
        'WORLDCON',
        'Broken Column 01',
        'Broken column',
        WS_SAME_WHY,
        false,
        false,
    ),
    prop(
        'Broken Column 02',
        'BrokenPillar02',
        'WORLDCON',
        'Broken Column 02',
        'Broken column',
        WS_SAME_WHY,
        false,
        false,
    ),
    prop('Pillar 01', 'BrokenPillar01', 'WORLDCON', 'Broken Column 01', 'Broken column', WS_SAME_WHY, false, false),
    prop('Pillar 02', 'BrokenPillar02', 'WORLDCON', 'Broken Column 02', 'Broken column', WS_SAME_WHY, false, false),
    prop('Chest', 'HChest01', 'WORLDCON', 'Chest Test', 'Chest', WS_CHEST_WHY, false, true),
    prop('Chest Lid', 'HChestLid01', 'WORLDCON', 'Chest Lid [1]', 'Chest lid', WS_CHEST_WHY, false, true),
    prop('Table (Big)', 'Tablea01', 'WORLDCON', 'Table', 'Table', WS_TABLE_WHY, false, true),
    prop('Table (Small)', 'Tablea02', 'WORLDCON', 'Table', 'Table', WS_TABLE_WHY, false, true),
    prop('Framer Table', 'Tablea02', 'WORLDCON', 'Table', 'Table', WS_TABLE_WHY, false, true),
];
