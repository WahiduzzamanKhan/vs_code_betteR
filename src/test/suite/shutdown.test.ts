import * as assert from 'assert';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import type { BetteRApi } from '../../extension';
import { parseTasklistMemory } from '../../environment';

/** PIDs of the R kernels this extension host started that are still running. */
function runningKernels(): number[] {
    if (process.platform === 'win32') {
        const filter = `ParentProcessId=${process.pid}`;
        const script =
            `Get-CimInstance Win32_Process -Filter '${filter}' | ` +
            `Where-Object { $_.CommandLine -match '--connection_file' } | ForEach-Object { $_.ProcessId }`;
        return cp
            .execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
                encoding: 'utf8',
                windowsHide: true,
            })
            .split(/\s+/)
            .filter(Boolean)
            .map(Number);
    }
    return cp
        .execFileSync('ps', ['-ax', '-o', 'pid=,ppid=,command='], { encoding: 'utf8' })
        .split('\n')
        .map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/))
        .filter((m): m is RegExpMatchArray => m !== null && Number(m[2]) === process.pid && m[3].includes('--connection_file'))
        .map((m) => Number(m[1]));
}

/** `runningKernels()`, once kernels being shut down have had time to exit. */
async function settledKernels(expected = 1): Promise<number[]> {
    const deadline = Date.now() + 10_000;
    let pids = runningKernels();
    while (pids.length > expected && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        pids = runningKernels();
    }
    return pids.sort((a, b) => a - b);
}

// Runs last (see index.ts): restarting R would disturb any suite after it.
suite('betteR: shutting R down', () => {
    test('Restart lets R quit cleanly: .Last runs and its temp directory is removed', async () => {
        const api = await vscode.extensions.getExtension<BetteRApi>('better.better-vscode')!.activate();
        const session = await api.ready();
        const marker = path.join(os.tmpdir(), `better-last-${process.pid}.txt`);
        fs.rmSync(marker, { force: true });
        const tmp = ([] as string[]).concat(
            await session.evaluate<string | string[]>(
                `.Last <- function() writeLines("ran", ${JSON.stringify(marker)}); tempdir()`,
            ),
        )[0];
        assert.ok(fs.existsSync(tmp), `R's tempdir ${tmp} should exist while R runs`);

        await vscode.commands.executeCommand('betteR.restart');

        // A killed R does neither of these.
        assert.ok(fs.existsSync(marker), '.Last did not run');
        assert.ok(!fs.existsSync(tmp), `R's tempdir ${tmp} was left behind`);
        fs.rmSync(marker, { force: true });
        const fresh = await api.ready();
        assert.notStrictEqual(fresh, session, 'a new session should have started');
        assert.strictEqual(await fresh.evaluate<number>('1 + 1'), 2);
    });

    test('a kernel that dies says why: the reason in its log is shown', async function () {
        if (process.platform === 'win32') {
            this.skip(); // The stand-in kernel is a shell script.
        }
        // Replaces a vscode.window function, which only reaches an extension
        // loaded from this repo (see BETTER_TEST_EXTENSION in runTest.ts).
        if (process.env.BETTER_TEST_EXTENSION) {
            this.skip();
        }
        this.timeout(120_000);
        const api = await vscode.extensions.getExtension<BetteRApi>('better.better-vscode')!.activate();
        // A stand-in for ark that fails at startup the way ark does with R 4.1.
        const fake = path.join(os.tmpdir(), `better-fake-ark-${process.pid}.sh`);
        fs.writeFileSync(
            fake,
            [
                '#!/bin/sh',
                'while [ $# -gt 0 ]; do [ "$1" = --log ] && log=$2; shift; done',
                `printf '  t ERROR  Panic! In file '"'"'x'"'"' at line 55: Unsupported R version 4.1.2. Ark requires R >= 4.2.0\\nBacktrace:\\n' > "$log"`,
                'exit 1',
                '',
            ].join('\n'),
            { mode: 0o755 },
        );
        const config = vscode.workspace.getConfiguration('betteR');
        const warnings: string[] = [];
        const showWarningMessage = vscode.window.showWarningMessage;
        (vscode.window as { showWarningMessage: unknown }).showWarningMessage = (message: string) => {
            warnings.push(message);
            return Promise.resolve(undefined);
        };
        try {
            await config.update('arkPath', fake, vscode.ConfigurationTarget.Global);
            void vscode.commands.executeCommand('betteR.restart').then(undefined, () => undefined);
            const deadline = Date.now() + 60_000;
            while (!warnings.length && Date.now() < deadline) {
                await new Promise((resolve) => setTimeout(resolve, 200));
            }
            assert.deepStrictEqual(warnings, [
                'The R session ended: Unsupported R version 4.1.2. Ark requires R >= 4.2.0',
            ]);
        } finally {
            (vscode.window as { showWarningMessage: unknown }).showWarningMessage = showWarningMessage;
            await config.update('arkPath', undefined, vscode.ConfigurationTarget.Global);
            fs.rmSync(fake, { force: true });
        }
        await vscode.commands.executeCommand('betteR.restart');
        assert.strictEqual(await (await api.ready()).evaluate<number>('1 + 1'), 2, 'R starts again with the real kernel');
    });

    test('overlapping restarts leave one R session, not orphans', async () => {
        const api = await vscode.extensions.getExtension<BetteRApi>('better.better-vscode')!.activate();
        const before = await api.ready();
        // A double-clicked Restart, and a command asking for R meanwhile.
        await Promise.all([
            vscode.commands.executeCommand('betteR.restart'),
            vscode.commands.executeCommand('betteR.restart'),
            api.ready(),
        ]);
        const session = await api.ready();
        assert.notStrictEqual(session, before, 'a new session should have started');
        assert.strictEqual(await session.evaluate<number>('1 + 1'), 2);
        assert.deepStrictEqual(await settledKernels(), [session.kernel.pid]);
    });

    test('a kernel that cannot run fails the start cleanly, and R starts once it is fixed', async function () {
        this.timeout(120_000);
        const api = await vscode.extensions.getExtension<BetteRApi>('better.better-vscode')!.activate();
        // Passes the existence check, but can't be run.
        const notAProgram = fs.mkdtempSync(path.join(os.tmpdir(), 'better-not-ark-'));
        const sessionDirs = () => new Set(fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith('better-vscode-')));
        const config = vscode.workspace.getConfiguration('betteR');
        try {
            await config.update('arkPath', notAProgram, vscode.ConfigurationTarget.Global);
            const dirsBefore = sessionDirs();
            await vscode.commands.executeCommand('betteR.restart');
            const failure = await Promise.race([
                api.ready().then(
                    () => 'started',
                    (err: Error) => err.message,
                ),
                new Promise<string>((resolve) => setTimeout(() => resolve('still starting after 60 s'), 60_000)),
            ]);
            assert.match(failure, /Couldn't start the R kernel/);
            const left = [...sessionDirs()].filter((name) => !dirsBefore.has(name));
            assert.deepStrictEqual(left, [], 'the failed start left its temp directory');
            assert.deepStrictEqual(await settledKernels(0), [], 'no R kernel should be running');
        } finally {
            await config.update('arkPath', undefined, vscode.ConfigurationTarget.Global);
            fs.rmSync(notAProgram, { recursive: true, force: true });
        }
        // No Restart: the next request for R starts it again.
        const session = await api.ready();
        assert.strictEqual(await session.evaluate<number>('1 + 1'), 2);
        assert.deepStrictEqual(await settledKernels(), [session.kernel.pid]);
    });

    test('Windows memory comes from tasklist, in any locale', () => {
        assert.strictEqual(parseTasklistMemory('"better.exe","4321","Console","1","123,456 K"\r\n'), 123456);
        assert.strictEqual(parseTasklistMemory('"better.exe","4321","Console","1","123.456 K"\r\n'), 123456);
        assert.strictEqual(parseTasklistMemory('"better.exe","4321","Console","1","123 456 Ko"\r\n'), 123456);
        assert.strictEqual(parseTasklistMemory('INFO: No tasks are running which match the specified criteria.\r\n'), undefined);
        assert.strictEqual(parseTasklistMemory(''), undefined);
    });
});
