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

    test('Windows memory comes from tasklist, in any locale', () => {
        assert.strictEqual(parseTasklistMemory('"better.exe","4321","Console","1","123,456 K"\r\n'), 123456);
        assert.strictEqual(parseTasklistMemory('"better.exe","4321","Console","1","123.456 K"\r\n'), 123456);
        assert.strictEqual(parseTasklistMemory('"better.exe","4321","Console","1","123 456 Ko"\r\n'), 123456);
        assert.strictEqual(parseTasklistMemory('INFO: No tasks are running which match the specified criteria.\r\n'), undefined);
        assert.strictEqual(parseTasklistMemory(''), undefined);
    });
});
