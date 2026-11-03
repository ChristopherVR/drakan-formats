// Converter investigation controls. Never enabled by default; shared by Node tools and inert in the browser.
const env = (): Record<string, string | undefined> =>
    (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};

export function ootfDebugFlag(name: 'OOTF_SYNTH_BOUNDS' | 'OOTF_NO_CLSTEXT' | 'OOTF_NO_ALPHA_FLAG'): boolean {
    const value = env()[name];
    return !!value && value !== '0';
}

function names(value: string | undefined): ReadonlyMap<string, string> {
    const result = new Map<string, string>();
    for (const pair of value?.split(';') ?? []) {
        if (!pair.trim()) continue;
        const at = pair.indexOf('=');
        const from = pair.slice(0, at).trim().toLowerCase();
        const to = pair.slice(at + 1).trim();
        if (at < 1 || !from || !to) throw new Error('OotF debug mapping must be "PC class=PS2 class;...".');
        if (result.has(from)) throw new Error(`Duplicate OotF debug mapping for "${from}".`);
        result.set(from, to);
    }
    return result;
}

export function ootfClassDebug(): {
    names: ReadonlyMap<string, string>;
    templates: ReadonlyMap<string, string>;
    noModel: RegExp | null;
} {
    const e = env();
    let noModel: RegExp | null = null;
    if (e['DRAKAN_DBG_NOMODEL']) {
        try {
            noModel = new RegExp(e['DRAKAN_DBG_NOMODEL'], 'i');
        } catch {
            throw new Error('DRAKAN_DBG_NOMODEL must be a valid regular expression.');
        }
    }
    return { names: names(e['DRAKAN_DBG_NAMEMAP']), templates: names(e['DRAKAN_DBG_TPLFORCE']), noModel };
}
