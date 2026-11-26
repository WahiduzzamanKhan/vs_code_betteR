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

/** Everything the console terminal shows, including scrollback. */
async function consoleText(session: Session): Promise<string> {
    session.terminal!.show(false);
    await vscode.commands.executeCommand('workbench.action.terminal.selectAll');
    await vscode.commands.executeCommand('workbench.action.terminal.copySelection');
    await vscode.commands.executeCommand('workbench.action.terminal.clearSelection');
    return vscode.env.clipboard.readText();
}

type Keybinding = { command: string; key: string; args?: { text: string }; when: string };

/** The extension's binding of `key` that sends `text` to the console. */
function binding(key: string, text: string): Keybinding {
    const all = vscode.extensions.getExtension('better.better-vscode')!.packageJSON.contributes.keybindings as Keybinding[];
    return all.find((b) => b.key === key && b.args?.text === text)!;
}

// The extension binds the newline key itself (betteR.console.editing.newline,
// Shift+Enter by default) to ESC CR, and the other newline key to Enter.
suite('betteR console: the newline key', () => {
    let session: Session;

    suiteSetup(async () => {
        const doc = await vscode.workspace.openTextDocument(path.join(workspace(), 'analysis.R'));
        await vscode.window.showTextDocument(doc);
        const ext = vscode.extensions.getExtension<BetteRApi>('better.better-vscode')!;
        session = await (await ext.activate()).ready();
        session.openConsole();
    });

    test('the console banner offers Shift+Enter', async () => {
        const text = await waitFor('the console banner', () => consoleText(session), (t) => t.includes('Ctrl-D quits'));
        assert.match(text, /Shift[-+]Enter/);
    });

    test("Shift+Enter's binding inserts a newline", async () => {
        const b = binding('shift+enter', '\u001b\r');
        assert.ok(b, 'no Shift+Enter newline binding');
        session.terminal!.show(false);
        session.terminal!.sendText('40000 + 1', false);
        await vscode.commands.executeCommand(b.command, b.args);
        await new Promise((r) => setTimeout(r, 1500));
        assert.doesNotMatch(await consoleText(session), /\[1\] 40001/, 'the line ran instead of continuing');
        session.terminal!.sendText('50000 + 2\r', false);
        const text = await waitFor('both lines to run', () => consoleText(session), (t) => t.includes('[1] 50002'));
        assert.match(text, /\[1\] 40001[\s\S]*\[1\] 50002/);
    });

    test("Alt+Enter's binding (when Shift+Enter is the newline key) runs the line", async () => {
        const b = binding('alt+enter', '\r');
        assert.ok(b, 'no Alt+Enter binding that runs the line');
        session.terminal!.show(false);
        session.terminal!.sendText('60000 + 3', false);
        await vscode.commands.executeCommand(b.command, b.args);
        await waitFor('the line to run', () => consoleText(session), (t) => t.includes('[1] 60003'));
    });
});
