import * as cp from 'child_process';
import * as fs from 'fs';

/**
 * Compatibility between this extension and the console (`better`), which are
 * installed separately and so can come from different releases.
 *
 * - `PROTOCOL` is the version of the IDE channel's messages (`src/ide.ts`,
 *   `../betteR/src/ide.rs`). The console sends its own in its `hello`.
 * - `MIN_CONSOLE_VERSION` is the oldest `better` whose command line (`--kernel`,
 *   `--lsp-stdio`, `--shutdown`, …) and protocol this extension can use.
 *
 * Whenever `PROTOCOL` changes, raise `MIN_CONSOLE_VERSION` to the first
 * console release that speaks it, and bump the console's `PROTOCOL` to match.
 */
export const PROTOCOL = 1;
export const MIN_CONSOLE_VERSION = '0.2.0';

/**
 * The console has to be installed (`install`) or updated (`update`) before a
 * session can start; the message says why. The extension offers the install
 * command (`src/install.ts`).
 */
export class ConsoleNeeded extends Error {
    constructor(
        message: string,
        readonly kind: 'install' | 'update',
    ) {
        super(message);
    }
}

type Version = [number, number, number];

/**
 * `1.2.3` from `better 1.2.3` (what `better --version` prints). A pre-release
 * suffix (`0.2.0-rc.1`) is ignored, so a release candidate counts as its release.
 */
export function parseVersion(text: string): Version | undefined {
    const m = /(\d+)\.(\d+)\.(\d+)/.exec(text);
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined;
}

function atLeast(v: Version, min: Version): boolean {
    for (let i = 0; i < 3; i++) {
        if (v[i] !== min[i]) {
            return v[i] > min[i];
        }
    }
    return true;
}

/**
 * Why the console that printed `versionOutput` can't be used, or `undefined`
 * if it can, or if its version can't be read (an unknown build isn't refused).
 */
export function consoleVersionProblem(versionOutput: string, consolePath: string): string | undefined {
    const version = /^better\s+(\S+)/m.exec(versionOutput.trim())?.[1];
    const parsed = version ? parseVersion(version) : undefined;
    const min = parseVersion(MIN_CONSOLE_VERSION)!;
    if (!parsed || atLeast(parsed, min)) {
        return undefined;
    }
    return (
        `The betteR console at ${consolePath} is version ${version}, too old for this extension, ` +
        `which needs ${MIN_CONSOLE_VERSION} or newer.`
    );
}

/** A console that speaks another protocol: what to tell the user and the console, and which side to update. */
export interface ProtocolProblem {
    message: string;
    update: 'console' | 'extension';
}

/**
 * The problem when the console's `hello` carries `protocol` (`undefined`
 * from consoles before the field existed), or `undefined` if it matches.
 */
export function protocolProblem(protocol: unknown): ProtocolProblem | undefined {
    if (protocol === PROTOCOL) {
        return undefined;
    }
    const theirs = typeof protocol === 'number' ? protocol : undefined;
    const update = theirs !== undefined && theirs > PROTOCOL ? 'extension' : 'console';
    const name = update === 'extension' ? 'the betteR VS Code extension' : 'the betteR console (`better`)';
    return {
        message:
            `The betteR console and the VS Code extension can't work together: the console speaks ` +
            `protocol ${theirs ?? '0 (before versioning)'}, the extension protocol ${PROTOCOL}. Update ${name}.`,
        update,
    };
}

const checked = new Map<string, string>();

/**
 * Runs `better --version` and throws if that console is too old. The result
 * is kept per binary (path, size and modification time), so restarts don't
 * pay for it again. A console whose version can't be read is logged and
 * allowed: the handshake's protocol check still applies.
 */
export async function checkConsoleVersion(consolePath: string, log: (line: string) => void): Promise<void> {
    let key = consolePath;
    try {
        const st = fs.statSync(consolePath);
        key = `${consolePath}\0${st.size}\0${st.mtimeMs}`;
    } catch {
        // Spawning will report a missing file.
    }
    let output = checked.get(key);
    if (output === undefined) {
        output = await new Promise<string>((resolve) =>
            cp.execFile(consolePath, ['--version'], { timeout: 10_000, windowsHide: true }, (err, stdout) => {
                if (err) {
                    log(`Could not read the console's version (${consolePath} --version): ${err.message}`);
                }
                resolve(err ? '' : stdout);
            }),
        );
        checked.set(key, output);
        if (output) {
            log(`Console: ${output.trim()} (${consolePath})`);
            if (!parseVersion(output)) {
                log('Unexpected `--version` output; not checking the console version.');
            }
        }
    }
    const problem = consoleVersionProblem(output, consolePath);
    if (problem) {
        throw new ConsoleNeeded(problem, 'update');
    }
}
