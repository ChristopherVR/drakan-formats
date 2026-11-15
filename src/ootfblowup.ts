/**
 * PC generators that show their own model until they burst into the objects they release. Ruined Village's "Blow Up Dragon
 * Generator" is the stone Arokh: the lair shows him as a statue until "arokh awakening", which sends the generator Blow Up
 * (its 15 stone pieces fly) and hides it as the living dragon appears.
 *
 * The PS2 generator never draws its class model: a clone with the statue model, its model flags 0 or 1 and any fade time
 * stayed invisible in game, while the same scene released the pieces. So the statue becomes a static prop of its own: a PC
 * class of the level's generic props (engine 17) with the generator's model, placed where the generator stands, and every
 * scene that shows or hides the generator does the same to the prop (`addBlowUpPropActors`). The generator keeps its role
 * without a model (ootfclass.ts plans it like every other generator).
 */

import type { OdbClass } from './odb.ts';
import { classFieldDefault } from './odb.ts';
import type { LvlObject } from './lvl.ts';
import type { PcLevel } from './pc.ts';
import type { PcSequence, PcSeqActor } from './ootfseq.ts';
import { GENERATOR_RFL } from './ootfclass.ts';

/** Engine id of the PC and PS2 generic prop (a static model). */
const PROP_RFL = 17;
/** PC scene action that shows (1) or hides (0) its actor. */
const VISIBILITY_ACTION = 6;
/** PC scene message action. */
const MESSAGE_ACTION = 7;

/** A PC generator with a model and Run Type 1: it shows the model until it bursts. */
export function blowUpGenerator(cls: Pick<OdbClass, 'rflClass' | 'model' | 'fields' | 'data'>): boolean {
    if (cls.rflClass !== GENERATOR_RFL || !cls.model) return false;
    const i = cls.fields?.findIndex((f) => f.name.trim().toLowerCase() === 'run type') ?? -1;
    return i >= 0 && classFieldDefault(cls, i) === 1;
}

export interface BlowUpProp {
    /** PC object id of the generator. */
    generator: number;
    /** PC object id of the new prop that shows its model. */
    prop: number;
    /** Class table (`db` index) and id of the prop's new PC class. */
    db: number;
    classId: number;
    cls: OdbClass;
}

/**
 * Add one static prop per blow-up generator object to the PC level (class and object), and return them. The prop class
 * copies the fields of a generic prop class of the level (engine 17 with a model, from the generator's own class table
 * first) and takes the generator's model, in the generator's table so the model reference keeps its meaning.
 */
export function addBlowUpProps(pc: PcLevel): BlowUpProp[] {
    const out: BlowUpProp[] = [];
    const tables = [...pc.classes];
    const propTemplate = (db: number): OdbClass | undefined => {
        const ordered = [...tables.filter(([d]) => d === db), ...tables.filter(([d]) => d !== db)];
        for (const [, table] of ordered)
            for (const c of table.values()) if (c.rflClass === PROP_RFL && c.model && c.fields?.length) return c;
        return undefined;
    };
    const madeFor = new Map<OdbClass, { db: number; id: number; cls: OdbClass }>();
    let nextObject = pc.list.objects.reduce((m, o) => Math.max(m, o.id), 0) + 1;
    for (const o of [...pc.list.objects]) {
        const gen = pc.classes.get(o.dbIndex)?.get(o.classId);
        if (!gen || !blowUpGenerator(gen)) continue;
        let made = madeFor.get(gen);
        if (!made) {
            const table = pc.classes.get(o.dbIndex)!;
            const tpl = propTemplate(o.dbIndex);
            if (!tpl) continue;
            const id = [...table.keys()].reduce((m, k) => Math.max(m, k), 0) + 1;
            const cls: OdbClass = { ...tpl, id, name: `${gen.name.trim()} Model`.slice(0, 31), model: gen.model };
            table.set(id, cls);
            made = { db: o.dbIndex, id, cls };
            madeFor.set(gen, made);
        }
        const prop: LvlObject = { ...o, id: nextObject++, classId: made.id, links: [], params: [] };
        pc.list.objects.push(prop);
        out.push({ generator: o.id, prop: prop.id, db: made.db, classId: made.id, cls: made.cls });
    }
    return out;
}

/**
 * Give a scene's blow-up generator actor a twin for its prop: the generator's show / hide actions. A scene that starts
 * the generator without hiding it after the start also hides the prop at the first message, so the statue does not stay
 * beside its own pieces.
 */
export function addBlowUpPropActors(seq: PcSequence, propOf: ReadonlyMap<number, number>): PcSequence {
    if (!propOf.size) return seq;
    const add: PcSeqActor[] = [];
    let next = seq.actors.reduce((m, a) => Math.max(m, a.id), 0) + 1;
    for (const a of seq.actors) {
        const prop = a.actorType === 1 ? propOf.get(a.objectId) : undefined;
        if (prop === undefined || seq.actors.some((b) => b.actorType === 1 && b.objectId === prop)) continue;
        const actions = a.actions.filter((x) => x.type === VISIBILITY_ACTION).map((x) => ({ ...x }));
        const start = a.actions.find((x) => x.type === MESSAGE_ACTION);
        const hidden = (x: { payload: Uint8Array }) =>
            new DataView(x.payload.buffer, x.payload.byteOffset, x.payload.byteLength).getUint32(0, true) === 0;
        if (start && !actions.some((x) => x.time >= start.time && hidden(x)))
            actions.push({ type: VISIBILITY_ACTION, time: start.time, payload: new Uint8Array(4) });
        if (!actions.length) continue;
        actions.sort((p, q) => p.time - q.time);
        add.push({ ...a, name: `${a.name} Model`, id: next++, objectId: prop, actions });
    }
    return add.length ? { ...seq, actors: [...seq.actors, ...add] } : seq;
}
