/** 8.3 name mangling used by RSRCIOP (analysis/scripts/iop_mangle.py, docs/reference/iop-and-io.md section 5.3). */
export function mangleComponent(s: string): string {
    let out = '';
    for (const c of s) if (/[0-9A-Za-z_.]/.test(c)) out += c.toUpperCase();
    const k = out.lastIndexOf('.');
    if (k > 0) {
        if (k >= 9) out = out.slice(0, 6) + out.slice(k - 2);
    } else if (out.length >= 9) {
        out = out.slice(0, 6) + out.slice(-2);
    }
    return out;
}

function components(p: string): string[] {
    return p.split(/[\\/]/).filter((c) => c !== '');
}

export function manglePath(p: string): string {
    return components(p).map(mangleComponent).join('\\');
}

export interface LevelListEntry {
    /** Line as written, e.g. `\Levels\Level 1A - Surdana\Level 1A - Surdana.lvl`. */
    rawPath: string;
    /** Directory name, e.g. `Level 1A - Surdana`. */
    name: string;
    /** Mangled path of the .LVL relative to the language root, e.g. `LEVELS\LEVEL1NA\LEVEL1NA.LVL`. */
    lvlPath: string;
    /** Mangled directory, e.g. `LEVELS\LEVEL1NA`. */
    dirPath: string;
}

/** Parse `LEVELLST.TXT`: one `\Levels\<Name>\<Name>.lvl` per line. */
export function parseLevelList(text: string): LevelListEntry[] {
    const out: LevelListEntry[] = [];
    for (const line of text.split(/\r?\n/)) {
        const rawPath = line.trim();
        if (rawPath === '') continue;
        const comps = components(rawPath);
        if (comps.length < 2) continue;
        const lvlPath = manglePath(rawPath);
        out.push({
            rawPath,
            name: comps[comps.length - 2]!,
            lvlPath,
            dirPath: lvlPath.slice(0, Math.max(lvlPath.lastIndexOf('\\'), 0)),
        });
    }
    return out;
}

export interface DbDependency {
    index: number;
    /** Path as written, relative to the .DB's directory (no extension). */
    path: string;
}

export interface DbFile {
    version: number;
    declaredCount: number;
    dependencies: DbDependency[];
}

/** Parse a `.DB` text dependency list: `version 1 / dependencies N / <idx> <relative path>`. */
export function parseDb(text: string): DbFile {
    const db: DbFile = { version: 0, declaredCount: 0, dependencies: [] };
    for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim();
        if (line === '') continue;
        let m = /^version\s+(\d+)$/i.exec(line);
        if (m) {
            db.version = Number(m[1]);
            continue;
        }
        m = /^dependencies\s+(\d+)$/i.exec(line);
        if (m) {
            db.declaredCount = Number(m[1]);
            continue;
        }
        m = /^(\d+)\s+(.+)$/.exec(line);
        if (m) db.dependencies.push({ index: Number(m[1]), path: m[2]! });
    }
    return db;
}

/**
 * Resolve a dependency to the mangled path stem on disc (no extension; the loader appends `.DB`, `.ODB`, `.MOD`, ...).
 * `dbDir` is the mangled directory of the referencing .DB (for example `LEVELS\LEVEL5NE`). Same walk as
 * iop_mangle.py: `..` pops a component, anything else is mangled and appended.
 */
export function resolveDependencyStem(dbDir: string, depPath: string): string {
    const parts = components(dbDir);
    for (const c of components(depPath)) {
        if (c === '..') parts.pop();
        else if (c !== '.') parts.push(mangleComponent(c));
    }
    return parts.join('\\');
}
