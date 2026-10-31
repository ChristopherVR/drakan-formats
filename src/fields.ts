/**
 * Class field model shared by the ODB class records (defaults) and the LVL object parameters (overrides): the field type
 * word and the value encoding. Layout and evidence: docs/reference/level-format.md sections 2 and 12. The type table,
 * the data-area layout (one dword per field, strings and arrays as `u16 offset, u16 length` into the trailing part) and
 * the colour order follow OpenDrakan (Zalasus, GPL-3.0, github.com/Zalasus/opendrakan, doc/riot_database_format.txt).
 */

export const FIELD_INT = 1;
export const FIELD_FLOAT = 2;
export const FIELD_CLASS = 3;
export const FIELD_MODEL = 4;
export const FIELD_SOUND = 5;
export const FIELD_BOOL = 6;
export const FIELD_ENUM = 7;
export const FIELD_CHANNEL = 8;
export const FIELD_ANIMATION = 9;
export const FIELD_STRING = 0x0a;
export const FIELD_SEQUENCE = 0x0b;
export const FIELD_LAYER = 0x0c;
export const FIELD_TEXTURE = 0x0e;
export const FIELD_COLOUR = 0x0f;
/** Second type byte 0x10 (word bit 0x1000): the field is an array of the base type. */
export const FIELD_ARRAY = 0x1000;

/** A field definition: type word and name (the 0x0103 list entry / the LVL `field_def`). */
export interface ClassFieldDef {
    type: number;
    name: string;
}

export type ClassFieldValue = number | string | number[];

export const fieldBase = (type: number): number => type & 0xff;
export const fieldIsArray = (type: number): boolean => (type & FIELD_ARRAY) !== 0;
/** Strings and arrays keep their payload in the trailing part of the data area. */
export const fieldIsIndirect = (type: number): boolean => fieldIsArray(type) || fieldBase(type) === FIELD_STRING;

const scratch = new DataView(new ArrayBuffer(4));

export function floatBits(v: number): number {
    scratch.setFloat32(0, v);
    return scratch.getUint32(0);
}
export function bitsFloat(bits: number): number {
    scratch.setUint32(0, bits >>> 0);
    return scratch.getFloat32(0);
}

/** Dwords of a string payload: NUL terminated and padded to a whole dword. */
export function stringToWords(text: string): number[] {
    const bytes: number[] = [];
    for (let i = 0; i < text.length; i++) bytes.push(text.charCodeAt(i) & 0xff);
    bytes.push(0);
    while (bytes.length % 4) bytes.push(0);
    const out: number[] = [];
    for (let i = 0; i < bytes.length; i += 4) {
        out.push((bytes[i]! | (bytes[i + 1]! << 8) | (bytes[i + 2]! << 16) | (bytes[i + 3]! << 24)) >>> 0);
    }
    return out;
}

export function wordsToString(words: readonly number[]): string {
    const bytes: number[] = [];
    for (const w of words) bytes.push(w & 255, (w >>> 8) & 255, (w >>> 16) & 255, w >>> 24);
    const z = bytes.indexOf(0);
    return String.fromCharCode(...(z < 0 ? bytes : bytes.slice(0, z)));
}

/**
 * Typed view of one data-area dword: strings decoded, arrays as their element dwords (raw, not retyped), int signed,
 * float f32, everything else as the stored u32. An out-of-range offset/length yields an empty string/array.
 */
export function decodeFieldValue(type: number, dword: number, data: readonly number[]): ClassFieldValue {
    const base = fieldBase(type);
    if (fieldIsIndirect(type)) {
        const off = dword & 0xffff;
        const len = dword >>> 16;
        const words = off + len <= data.length ? data.slice(off, off + len) : [];
        return base === FIELD_STRING && !fieldIsArray(type) ? wordsToString(words) : words;
    }
    if (base === FIELD_FLOAT) return bitsFloat(dword);
    if (base === FIELD_INT) return dword | 0;
    return dword >>> 0;
}

/** The dword a scalar value is stored as. */
export function encodeScalar(type: number, value: number): number {
    if (fieldBase(type) === FIELD_FLOAT) return floatBits(value);
    return value >>> 0;
}

/**
 * Element value of an array field (raw dwords): floats are f32 bits, ints signed, the rest unsigned.
 */
export function decodeElement(type: number, word: number): number {
    const base = fieldBase(type);
    if (base === FIELD_FLOAT) return bitsFloat(word);
    if (base === FIELD_INT) return word | 0;
    return word >>> 0;
}
export const encodeElement = encodeScalar;

/** `(db << 16) | id` reference to a resource (class, model, sound, texture, ...); db 0 = the owning database. */
export interface ResourceRef {
    id: number;
    db: number;
}
export const refParts = (v: number): ResourceRef => ({ id: v & 0xffff, db: (v >>> 16) & 0xffff });
export const refValue = (db: number, id: number): number => (((db & 0xffff) << 16) | (id & 0xffff)) >>> 0;
