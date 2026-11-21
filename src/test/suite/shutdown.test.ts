import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import type { BetteRApi } from '../../extension';
import { parseTasklistMemory } from '../../environment';

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

    test('Windows memory comes from tasklist, in any locale', () => {
        assert.strictEqual(parseTasklistMemory('"better.exe","4321","Console","1","123,456 K"\r\n'), 123456);
        assert.strictEqual(parseTasklistMemory('"better.exe","4321","Console","1","123.456 K"\r\n'), 123456);
        assert.strictEqual(parseTasklistMemory('"better.exe","4321","Console","1","123 456 Ko"\r\n'), 123456);
        assert.strictEqual(parseTasklistMemory('INFO: No tasks are running which match the specified criteria.\r\n'), undefined);
        assert.strictEqual(parseTasklistMemory(''), undefined);
    });
});
