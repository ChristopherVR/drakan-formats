import { addObject, objectParamSpecs, type LvlObject, type LvlObjectList, type Vec3 } from './lvl.ts';
import { classFieldDefault, type OdbClass } from './odb.ts';
import { pcLevelProperties, type PcFileSource, type PcLevel } from './pc.ts';

export type OotfArenaReward =
    | { kind: 'item'; resource: number }
    | { kind: 'health' | 'dragon_health' | 'dragon_protection'; amount: number }
    | { kind: 'speed' | 'invisibility' | 'invulnerability'; resource: number; durationMs: number }
    | { kind: 'fire_ring'; resource: number; durationMs: number; speed: number; damage: number }
    | { kind: 'soul_crystal' };

export interface OotfArenaPickup {
    pos: Vec3;
    name: string;
    respawn: number;
    rewards: OotfArenaReward[];
    visual?: number;
}

export function ootfPickupDisplay(cls: OdbClass): OdbClass | undefined {
    if (!cls.model || ![10, 14, 45, 79, 86, 89, 91, 120, 126, 138].includes(cls.rflClass ?? 0)) return undefined;
    return { ...cls, name: `MP display: ${cls.name.trim()}`, rflClass: 17, fields: [], data: [] };
}

export function ootfPickupItemRefs(cls: OdbClass, object: LvlObject): number[] {
    const refs = pickupField(cls, object, 'Item List');
    return Array.isArray(refs) ? refs.filter((ref): ref is number => typeof ref === 'number') : [];
}

export function findOotfStartingWeapon(pc: PcLevel) {
    for (const [db, table] of pc.classes)
        for (const [id, cls] of table)
            if (cls.rflClass === 14 && /^Start\s*:\s*Ugly Stick$/i.test(cls.name.trim())) return { db, id, cls };
    return undefined;
}

/** Make the original items' converted native models available to the actor factory. */
export function preloadOotfArenaItems(list: LvlObjectList, pickups: readonly OotfArenaPickup[], starter: number) {
    const place = (resource: number, pos: Vec3) => {
        const dbIndex = resource >>> 16;
        const classId = resource & 0xffff;
        if (
            !list.objects.some(
                (o) => o.dbIndex === dbIndex && o.classId === classId && o.pos.every((v, i) => v === pos[i]),
            )
        )
            addObject(list, { dbIndex, classId, pos });
    };
    const player = list.objects.find((o) => o.dbIndex === 2 && o.classId === 2640);
    if (starter && player) place(starter, player.pos);
    for (const p of pickups) {
        if (p.visual) place(p.visual, p.pos);
        else for (const reward of p.rewards) if (reward.kind === 'item') place(reward.resource, p.pos);
    }
}

export async function readOotfArenaOrder(src: PcFileSource): Promise<Map<string, number>> {
    const order = new Map<string, number>();
    for (const file of (await src.list()).filter((path) => /\.lfl$/i.test(path)).sort()) {
        const bytes = await src.read(file);
        if (!bytes) continue;
        const [signature, ...entries] = new TextDecoder('windows-1252').decode(bytes).split(/\r?\n/);
        if (signature?.trim() !== 'LL') continue;
        for (const entry of entries) {
            const path = entry.trim().replace(/\\/g, '/').toLowerCase();
            if (/\.lvl$/.test(path) && !order.has(path)) order.set(path, order.size);
        }
    }
    return order;
}

interface ItemClass {
    cls: OdbClass;
    resource?: number;
    visual?: number;
}

export interface OotfNeutralDragon {
    yaw: number;
    health: number;
    flySpeed: number;
    climbSpeed: number;
    damage: number;
    reloadMs: number;
    energy: number;
    energyCost: number;
    energyRecharge: number;
    projectile: number;
}

export function readOotfNeutralDragon(
    pc: PcLevel,
    resolve: (from: OdbClass, ref: number) => ItemClass | undefined,
): OotfNeutralDragon | undefined {
    const classes = (o: LvlObject) => pc.classes.get(o.dbIndex)?.get(o.classId);
    const launch = pc.list.objects.find(
        (o) => classes(o)?.rflClass === 128 && /^red\s*dragon/i.test(classes(o)?.name ?? ''),
    );
    const pad = launch && classes(launch);
    if (!launch || !pad) return undefined;
    const dragonRef = pickupField(pad, launch, 'Model');
    const dragon = typeof dragonRef === 'number' ? resolve(pad, dragonRef)?.cls : undefined;
    if (!dragon || dragon.rflClass !== 28) return undefined;
    const weaponRef = pickupField(dragon, undefined, 'Default Weapon');
    const weapon = typeof weaponRef === 'number' ? resolve(dragon, weaponRef) : undefined;
    if (!weapon) return undefined;
    const numberField = (cls: OdbClass, name: string) => {
        const value = pickupField(cls, undefined, name);
        return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
    };
    const properties = pcLevelProperties(pc);
    const multiplier = properties && pickupField(properties, undefined, 'Recharge Rate Multiplier');
    const profile: OotfNeutralDragon = {
        yaw: launch.rot[1],
        health: numberField(dragon, 'Begin Health'),
        flySpeed: numberField(dragon, 'Max Fly Speed (lu/s)') * 1000,
        climbSpeed: numberField(dragon, 'Up Strafe Speed (lu/s)') * 1000,
        damage: numberField(weapon.cls, 'Damage'),
        reloadMs: Math.round(numberField(weapon.cls, 'Reloading Time (sec)') * 1000),
        energy: numberField(weapon.cls, 'New Energy Limit'),
        energyCost: numberField(weapon.cls, 'Energy Cost (0-100)'),
        energyRecharge:
            numberField(weapon.cls, 'Multiplayer Energy Recharge') *
            (typeof multiplier === 'number' && multiplier >= 0 ? multiplier : 1),
        projectile: weapon.resource ?? 0,
    };
    return profile.health &&
        profile.flySpeed &&
        profile.climbSpeed &&
        profile.damage &&
        profile.reloadMs &&
        profile.energy &&
        profile.energyCost
        ? profile
        : undefined;
}

export function readOotfArenaPickups(
    pc: PcLevel,
    resolveItem: (ownerDb: number, ref: number) => ItemClass | undefined,
    resolveEffect: (from: OdbClass, ref: number) => ItemClass | undefined,
    visualOf: (from: OdbClass) => number | undefined,
    warn: (message: string) => void,
): OotfArenaPickup[] {
    const pickups: OotfArenaPickup[] = [];
    for (const object of pc.list.objects) {
        const cls = pc.classes.get(object.dbIndex)?.get(object.classId);
        if (!cls) continue;
        const name = cls.name.trim();
        let visual = visualOf(cls);
        if (cls.rflClass === 86) {
            pickups.push({ pos: [...object.pos], name, respawn: 1, rewards: [{ kind: 'soul_crystal' }], visual });
            continue;
        }
        if (cls.rflClass !== 120 && cls.rflClass !== 126 && cls.rflClass !== 138) continue;
        const field = (name: string) => pickupField(cls, object, name);
        const respawn = field('Respawn Interval (Sec)');
        if (typeof respawn !== 'number' || !Number.isFinite(respawn) || respawn <= 0) continue;
        const rewards: OotfArenaReward[] = [];
        if (cls.rflClass === 120) {
            for (const ref of ootfPickupItemRefs(cls, object)) {
                const item = resolveItem(object.dbIndex, ref);
                if (!item) continue;
                visual ??= item.visual;
                if (item.cls.rflClass === 10) {
                    const health = pickupField(item.cls, undefined, 'Health Boost');
                    if (typeof health === 'number' && health > 0) rewards.push({ kind: 'health', amount: health });
                } else if (item.cls.rflClass === 89) {
                    const kind = ['invisibility', 'invulnerability', 'speed'][
                        Number(pickupField(item.cls, undefined, 'FX Type'))
                    ];
                    const amount = pickupField(item.cls, undefined, 'Duration (sec)');
                    if (
                        item.resource &&
                        (kind === 'invisibility' || kind === 'invulnerability' || kind === 'speed') &&
                        typeof amount === 'number' &&
                        amount > 0
                    )
                        rewards.push({ kind, resource: item.resource, durationMs: Math.round(amount * 1000) });
                } else if (item.cls.rflClass === 91 && pickupField(item.cls, undefined, 'Discharge On Contact') === 1) {
                    const ref = pickupField(item.cls, undefined, 'Effect');
                    const effect = typeof ref === 'number' ? resolveEffect(item.cls, ref) : undefined;
                    if (effect?.resource && effect.cls.rflClass === 90) {
                        const life = pickupField(effect.cls, undefined, 'Life length (s)');
                        const speed = pickupField(effect.cls, undefined, 'Initial Velocity (wu/s)');
                        const damage = pickupField(effect.cls, undefined, 'Damage');
                        if (
                            typeof life === 'number' &&
                            life > 0 &&
                            typeof speed === 'number' &&
                            speed > 0 &&
                            typeof damage === 'number' &&
                            damage > 0
                        )
                            rewards.push({
                                kind: 'fire_ring',
                                resource: effect.resource,
                                durationMs: Math.round(life * 1000),
                                speed,
                                damage,
                            });
                    }
                } else if (item.resource && [14, 45, 79].includes(item.cls.rflClass ?? 0)) {
                    rewards.push({ kind: 'item', resource: item.resource });
                }
            }
        } else if (cls.rflClass === 138) {
            const amount = field('Health Boost');
            if (typeof amount === 'number' && amount > 0)
                rewards.push({ kind: field('Object Type') === 1 ? 'dragon_health' : 'health', amount });
        } else {
            const amount = field('Duration (sec)');
            if (typeof amount === 'number' && amount > 0) rewards.push({ kind: 'dragon_protection', amount });
        }
        if (rewards.length) pickups.push({ pos: [...object.pos], name, respawn, rewards, visual });
        else warn(`arena pickup ${name} (object ${object.id}): no supported item or effect`);
    }
    return pickups;
}

function pickupField(cls: OdbClass, object: LvlObject | undefined, name: string) {
    const index = cls.fields?.findIndex((field) => field.name.trim().toLowerCase() === name.toLowerCase()) ?? -1;
    if (index < 0) return undefined;
    const override = object && objectParamSpecs(object).find((spec) => spec.fieldIndex === index);
    return override?.value ?? classFieldDefault(cls, index);
}
