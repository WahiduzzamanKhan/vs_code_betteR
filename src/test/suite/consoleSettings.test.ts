import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';
import type { BetteRApi } from '../../extension';
import type { Session } from '../../session';

const workspace = () => vscode.workspace.workspaceFolders![0].uri.fsPath;

async function waitFor<T>(what: string, probe: () => T | Promise<T>, ok: (v: T) => boolean, ms = 30_000): Promise<T> {
    const deadline = Date.now() + ms;
    let last: T | undefined;
    while (Date.now() < deadline) {
        last = await probe();
        if (ok(last)) {
            return last;
        }
        await new Promise((r) => setTimeout(r, 300));
    }
    assert.fail(`timed out waiting for ${what}; last value: ${JSON.stringify(last)?.slice(-600)}`);
}

/**
 * Everything the console terminal shows, including scrollback. Fails if the
 * console has exited, e.g. a `better` without `--set` ("unknown argument").
 */
async function consoleText(session: Session, terminal = session.terminal): Promise<string> {
    if (!terminal || terminal.exitStatus || terminal !== session.terminal) {
        assert.fail(`the console exited (code ${terminal?.exitStatus?.code}); does this better support --set?`);
    }
    terminal.show(false);
    await vscode.commands.executeCommand('workbench.action.terminal.selectAll');
    await vscode.commands.executeCommand('workbench.action.terminal.copySelection');
    await vscode.commands.executeCommand('workbench.action.terminal.clearSelection');
    return vscode.env.clipboard.readText();
}

/** The `--set` values the console terminal was started with. */
function terminalSets(session: Session): string[] {
    const args = (session.terminal!.creationOptions as vscode.TerminalOptions).shellArgs as string[];
    return args.flatMap((a, i) => (args[i - 1] === '--set' ? [a] : []));
}

/** The `--set` values the kernel was started with. */
function kernelSets(session: Session): string[] {
    const args = session.kernel.spawnargs;
    return args.flatMap((a, i) => (args[i - 1] === '--set' ? [a] : []));
}

const KEYS = ['startup.banner', 'completion.max_suggestions', 'editing.newline', 'startup.r_home'];

// Restarts R, so it runs just before the shutdown suite (see index.ts).
suite('betteR: console settings from VS Code', () => {
    let api: BetteRApi;
    let session: Session;
    const prompts: string[] = [];
    let answer: string | undefined;
    const showInformationMessage = vscode.window.showInformationMessage;
    const config = () => vscode.workspace.getConfiguration('betteR.console');

    suiteSetup(async function () {
        // Replaces a vscode.window function, which only reaches an extension
        // loaded from this repo (see BETTER_TEST_EXTENSION in runTest.ts).
        if (process.env.BETTER_TEST_EXTENSION) {
            this.skip();
        }
        const doc = await vscode.workspace.openTextDocument(path.join(workspace(), 'analysis.R'));
        await vscode.window.showTextDocument(doc);
        api = await vscode.extensions.getExtension<BetteRApi>('better.better-vscode')!.activate();
        session = await api.ready();
        (vscode.window as { showInformationMessage: unknown }).showInformationMessage = (message: string) => {
            prompts.push(message);
            return Promise.resolve(answer);
        };
    });

    suiteTeardown(async () => {
        if (process.env.BETTER_TEST_EXTENSION) {
            return;
        }
        answer = undefined;
        // Workspace scope: the test workspace is a temporary copy (runTest.ts).
        for (const key of KEYS) {
            await config().update(key, undefined, vscode.ConfigurationTarget.Workspace);
        }
        // Back to a session started without these settings.
        await vscode.commands.executeCommand('betteR.restart');
        (vscode.window as { showInformationMessage: unknown }).showInformationMessage = showInformationMessage;
        const fresh = await api.ready();
        fresh.openConsole(true);
    });

    test('a set betteR.console value reaches a newly opened console as --set; an unset one is not passed', async () => {
        if (session.terminal) {
            const closed = session.terminal;
            closed.dispose();
            await waitFor('the console to close', () => session.terminal, (t) => t !== closed);
        }
        prompts.length = 0;
        await config().update('startup.banner', false, vscode.ConfigurationTarget.Workspace);
        await config().update('completion.max_suggestions', 7, vscode.ConfigurationTarget.Workspace);
        await config().update('editing.newline', 'alt_enter', vscode.ConfigurationTarget.Workspace);
        await new Promise((r) => setTimeout(r, 500));
        assert.deepStrictEqual(prompts, [], 'no console was running, so nothing to restart');

        const terminal = session.openConsole();
        const sets = terminalSets(session);
        assert.ok(sets.includes('startup.banner=false'), JSON.stringify(sets));
        // Unset keys fall through to config.toml.
        assert.deepStrictEqual(sets, ['startup.banner=false', 'completion.max_suggestions=7', 'editing.newline=alt_enter']);
        assert.deepStrictEqual(kernelSets(session), [], 'the kernel started before any setting was set');

        // The console accepts them: it runs code, without its banner.
        terminal.sendText('6 * 7', true);
        const text = await waitFor('the console to run code', () => consoleText(session, terminal), (t) => t.includes('[1] 42'));
        assert.doesNotMatch(text, /Ctrl-D quits/, 'startup.banner = false still showed the banner');
        // With editing.newline = alt_enter, the extension's ESC CR still inserts a newline (--ide mode).
        terminal.sendText('70000 + 4', false);
        await vscode.commands.executeCommand('workbench.action.terminal.sendSequence', { text: '\u001b\r' });
        await new Promise((r) => setTimeout(r, 1500));
        assert.doesNotMatch(await consoleText(session, terminal), /\[1\] 70004/, 'ESC CR ran the line');
        terminal.sendText('80000 + 5\r', false);
        await waitFor('both lines to run', () => consoleText(session, terminal), (t) => /\[1\] 70004[\s\S]*\[1\] 80005/.test(t));
        assert.strictEqual(await session.evaluate<number>('1 + 1'), 2);
    });

    test('changing a setting while the console runs offers a restart, which passes startup.r_home to the kernel', async () => {
        assert.ok(session.terminal && session.terminal.exitStatus === undefined, 'the console should be running');
        const rHome = ([] as string[]).concat(await session.evaluate<string | string[]>('R.home()'))[0];
        prompts.length = 0;
        answer = 'Restart';
        await config().update('startup.r_home', rHome, vscode.ConfigurationTarget.Workspace);
        await waitFor('the restart prompt', () => prompts.length, (n) => n > 0, 10_000);
        assert.deepStrictEqual(prompts, ['Restart the R console to apply.']);
        answer = undefined;

        // Not api.ready() while restarting: between the old session ending
        // and the new one starting, it would start a session of its own.
        const old = session.terminal;
        await waitFor(
            'the restarted console',
            () => vscode.window.terminals.filter((t) => t !== old && t.name === 'R').length,
            (n) => n > 0,
            120_000,
        );
        const fresh = await api.ready();
        assert.notStrictEqual(fresh, session, 'a new session should have started');
        assert.deepStrictEqual(kernelSets(fresh), [`startup.r_home=${rHome}`]);
        assert.ok(terminalSets(fresh).includes(`startup.r_home=${rHome}`));
        assert.ok(terminalSets(fresh).includes('startup.banner=false'));
        assert.strictEqual(([] as string[]).concat(await fresh.evaluate<string | string[]>('R.home()'))[0], rHome);
        fresh.terminal!.sendText('7 * 8', true);
        await waitFor('the new console to run code', () => consoleText(fresh), (t) => t.includes('[1] 56'));
        session = fresh;
    });
});
