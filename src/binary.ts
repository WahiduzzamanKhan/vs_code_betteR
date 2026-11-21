import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * The file name of an executable on this platform: `better.exe` on Windows.
 * Only `.exe`, not every `PATHEXT` entry: Node can't spawn a `.cmd` or `.bat`
 * without a shell, so finding one would only fail later.
 */
export function executableName(name: string): string {
    return process.platform === 'win32' && !name.toLowerCase().endsWith('.exe') ? `${name}.exe` : name;
}

function isFile(p: string): boolean {
    return fs.statSync(p, { throwIfNoEntry: false })?.isFile() ?? false;
}

/** `p` if it is a file, else `p` with `.exe` on Windows if that is; otherwise undefined. */
export function existingFile(p: string): string | undefined {
    if (isFile(p)) {
        return p;
    }
    const exe = executableName(p);
    return exe !== p && isFile(exe) ? exe : undefined;
}

/** The first `name` (`name.exe` on Windows) in a directory on `PATH`. */
export function findOnPath(name: string, pathVar = process.env.PATH ?? ''): string | undefined {
    const file = executableName(name);
    for (const entry of pathVar.split(path.delimiter)) {
        // Windows allows quoted entries, e.g. "C:\Program Files\x".
        const dir = entry.replace(/^"(.*)"$/, '$1');
        if (dir && isFile(path.join(dir, file))) {
            return path.join(dir, file);
        }
    }
    return undefined;
}

/**
 * Where betteR's install scripts put `better`: `$CARGO_HOME/bin`, else
 * `~/.cargo/bin` (also where `cargo install` puts it).
 */
export function installDir(env: NodeJS.ProcessEnv = process.env, home = os.homedir()): string {
    return path.join(env.CARGO_HOME || path.join(home, '.cargo'), 'bin');
}

/**
 * `name` (`name.exe` on Windows) in `installDir`. The install scripts add that
 * directory to `PATH`, but VS Code keeps the `PATH` it started with, so a
 * console installed since then is only found here.
 */
export function findInstalled(name: string, env: NodeJS.ProcessEnv = process.env, home = os.homedir()): string | undefined {
    return existingFile(path.join(installDir(env, home), executableName(name)));
}
