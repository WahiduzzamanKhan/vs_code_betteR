import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runTests } from '@vscode/test-electron';

/**
 * The R kernels a betteR window starts: `better --kernel` (or a separate
 * `ark`) with a connection file in a `better-vscode-*` temp directory. Paths
 * may use `/` or `\\`, end in `.exe` and be quoted (Windows command lines).
 */
const KERNEL = /(?:^|[\\/"])(?:better(?:\.exe)?"?\s+--kernel|ark(?:\.exe)?"?)\s+--connection_file\s+(?:"[^"]*|[^"\s]*)better-vscode-/i;

/** PIDs of running betteR kernels, with their command lines. */
function kernels(): Map<number, string> {
    let processes: { pid: number; command: string }[];
    if (process.platform === 'win32') {
        const json = cp.execFileSync(
            'powershell.exe',
            ['-NoProfile', '-NonInteractive', '-Command',
             'Get-CimInstance Win32_Process | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress'],
            { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true },
        );
        const list = ([] as { ProcessId: number; CommandLine: string | null }[]).concat(JSON.parse(json));
        processes = list.map((p) => ({ pid: p.ProcessId, command: p.CommandLine ?? '' }));
    } else {
        processes = cp
            .execFileSync('ps', ['-ax', '-o', 'pid=,command='], { encoding: 'utf8' })
            .split('\n')
            .map((line) => line.trim().match(/^(\d+)\s+(.*)$/))
            .filter((m): m is RegExpMatchArray => m !== null)
            .map((m) => ({ pid: Number(m[1]), command: m[2] }));
    }
    return new Map(processes.filter((p) => KERNEL.test(p.command)).map((p) => [p.pid, p.command]));
}

/** R's per-session temp directories (`Rtmp*`), which R removes when it quits cleanly. */
function rTempDirs(): Set<string> {
    return new Set(fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith('Rtmp')));
}

async function main(): Promise<void> {
    const extensionDevelopmentPath = path.resolve(__dirname, '../../');
    const extensionTestsPath = path.resolve(__dirname, './suite/index');

    // Kernels of betteR windows already open (e.g. the developer's own) aren't ours.
    const before = kernels();
    const rtmpBefore = rTempDirs();

    // Work on a copy so anything R writes can't touch the repo fixture.
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'better-ws-'));
    fs.cpSync(path.join(extensionDevelopmentPath, 'test-fixtures/workspace'), workspace, { recursive: true });

    try {
        await runTests({
            extensionDevelopmentPath,
            extensionTestsPath,
            // Other R extensions (e.g. REditorSupport) would register competing language servers.
            launchArgs: [workspace, '--disable-extensions', '--disable-workspace-trust'],
        });
    } finally {
        fs.rmSync(workspace, { recursive: true, force: true });
    }

    // Closing VS Code must not leave an R session behind.
    await new Promise((r) => setTimeout(r, 1000));
    const orphans = [...kernels()].filter(([pid]) => !before.has(pid)).map(([pid, command]) => `${pid} ${command}`);
    if (orphans.length) {
        throw new Error(`ark still running after VS Code exited:\n${orphans.join('\n')}`);
    }
    console.log('No orphaned ark processes.');

    // R quitting cleanly removes its temp directory; a killed R leaves it behind.
    const leaked = [...rTempDirs()].filter((name) => !rtmpBefore.has(name));
    if (leaked.length) {
        throw new Error(
            `R temp directories left behind in ${os.tmpdir()} (R killed instead of shut down? ` +
                `Or another R started during the run): ${leaked.join(', ')}`,
        );
    }
    console.log('No R temp directories left behind.');
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
