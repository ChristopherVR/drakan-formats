import { ENGINE_CLASSES } from './ootfclass.ts';
import type { LvlDependency, LvlObject, LvlObjectList } from './lvl.ts';
import type { OdbClass } from './odb.ts';

export interface StartingInventoryLevel {
    source: {
        path: string;
        list: Pick<LvlObjectList, 'objects'>;
        classes: ReadonlyMap<number, ReadonlyMap<number, OdbClass>>;
    };
    target: {
        dependencies: readonly LvlDependency[];
        objects: LvlObjectList;
        objectIdMap: ReadonlyMap<number, number>;
    };
}

/**
 * A cinematic-only campaign start needs a synthetic native player. Seed that player's links with the first authored
 * player's real loadout: native New Game initialization copies linked items into carried inventory, whereas subsequent
 * level initialization discards its world templates. Call only for the campaign's ordered levels, never standalone maps.
 */
export function carryStartingInventory(
    levels: readonly StartingInventoryLevel[],
    targetClass: (object: LvlObject) => OdbClass | undefined,
): { copied: number; warnings: string[]; sourceKeys: string[] } {
    const result = { copied: 0, warnings: [] as string[], sourceKeys: [] as string[] };
    if (levels.length < 2) return result;
    const sourceClass = (level: StartingInventoryLevel, object: LvlObject): OdbClass | undefined =>
        level.source.classes.get(object.dbIndex)?.get(object.classId);
    const authoredPlayer = (level: StartingInventoryLevel): LvlObject | undefined =>
        level.source.list.objects.find((o) => sourceClass(level, o)?.rflClass === 9);
    const start = levels[0]!;
    if (authoredPlayer(start)) return result;
    const first = levels.slice(1).find((l) => authoredPlayer(l));
    if (!first) return result;
    const player = authoredPlayer(first)!;
    const players = start.target.objects.objects.filter((o) => targetClass(o)?.rflClass === 9);
    if (players.length !== 1) {
        result.warnings.push('starting inventory: cinematic start must have exactly one synthetic player');
        return result;
    }
    const synthetic = players[0]!;
    // Existing links belong to an already seeded/custom loadout. Do not replace it or duplicate items on another pass.
    if (synthetic.links.length) return result;
    const sourcePlayerId = first.target.objectIdMap.get(player.id);
    const sourcePlayer = first.target.objects.objects.find((o) => o.id === sourcePlayerId);
    if (!sourcePlayer) {
        result.warnings.push(`starting inventory: no converted player for ${first.source.path}#${player.id}`);
        return result;
    }
    const prepared: { sourceId: number; object: LvlObject; dbIndex: number }[] = [];
    const normalized = (path: string): string => path.replace(/\\/g, '/').trim().toLowerCase();
    for (const id of new Set(player.links)) {
        const original = first.source.list.objects.find((o) => o.id === id);
        if (!original) {
            result.warnings.push(`starting inventory: missing source object ${first.source.path}#${id}`);
            return result;
        }
        const kind = ENGINE_CLASSES.get(sourceClass(first, original)?.rflClass ?? -1)?.kind;
        if (kind !== 'item' && kind !== 'weapon') continue;
        const convertedId = first.target.objectIdMap.get(id);
        const object = first.target.objects.objects.find((o) => o.id === convertedId);
        if (!object) {
            result.warnings.push(`starting inventory: source item ${first.source.path}#${id} was not converted`);
            return result;
        }
        const dependency = first.target.dependencies.find((d) => d.dbIndex === object.dbIndex);
        const bank =
            dependency &&
            start.target.dependencies.find((d) => normalized(d.path.text) === normalized(dependency.path.text));
        if (!bank) {
            result.warnings.push(`starting inventory: no destination class bank for ${first.source.path}#${id}`);
            return result;
        }
        prepared.push({ sourceId: id, object, dbIndex: bank.dbIndex });
    }
    if (!prepared.length) return result;
    const carriedIds = new Set(prepared.map((p) => p.object.id));
    for (const p of prepared)
        if (p.object.links.some((id) => id !== sourcePlayerId && !carriedIds.has(id))) {
            result.warnings.push(
                `starting inventory: item ${first.source.path}#${p.sourceId} links outside the loadout`,
            );
            return result;
        }
    if (start.target.objects.objects.length + prepared.length > 0xffff) {
        result.warnings.push('starting inventory: opening would exceed the LVL 65535-object limit');
        return result;
    }
    const taken = new Set(start.target.objects.objects.map((o) => o.id));
    const validId = (id: number): boolean => Number.isInteger(id) && id >= 0 && id <= 0xffffffff;
    if ([...taken].some((id) => !validId(id)) || prepared.some((p) => !validId(p.object.id))) {
        result.warnings.push('starting inventory: object id is outside the LVL uint32 range');
        return result;
    }
    let next = Math.max(0, ...taken) + 1;
    const copiedIds = new Map<number, number>();
    for (const p of prepared) {
        let id = p.object.id;
        if (taken.has(id)) {
            while (taken.has(next)) ++next;
            if (!validId(next)) {
                result.warnings.push('starting inventory: collision allocation exceeds the LVL uint32 object-id range');
                return result;
            }
            id = next++;
        }
        taken.add(id);
        copiedIds.set(p.object.id, id);
    }
    for (const p of prepared) {
        const object = p.object;
        start.target.objects.objects.push({
            ...object,
            id: copiedIds.get(object.id)!,
            dbIndex: p.dbIndex,
            pos: object.pos.map((v, i) => synthetic.pos[i]! + v - sourcePlayer.pos[i]!) as LvlObject['pos'],
            rot: [...object.rot],
            scale: object.scale ? [...object.scale] : null,
            links: object.links.map((id) => (id === sourcePlayerId ? synthetic.id : copiedIds.get(id)!)),
            // These refs already use the item's owning native ODB namespace. Only the level class bank changes.
            data: [...object.data],
            params: object.params.map((p) => ({ ...p, nameRaw: p.nameRaw.slice() })),
        });
        result.sourceKeys.push(`${normalized(first.source.path)}#${p.sourceId}`);
    }
    synthetic.links = prepared.map((p) => copiedIds.get(p.object.id)!);
    result.copied = prepared.length;
    return result;
}
