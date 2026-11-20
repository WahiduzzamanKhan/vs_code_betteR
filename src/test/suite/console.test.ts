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

// Unix only: on Windows the console reads Shift-Enter through the console API.
(process.platform === 'win32' ? suite.skip : suite)('betteR console: Shift-Enter inserts a newline', () => {
    let session: Session;

    suiteSetup(async () => {
        const doc = await vscode.workspace.openTextDocument(path.join(workspace(), 'analysis.R'));
        await vscode.window.showTextDocument(doc);
        const ext = vscode.extensions.getExtension<BetteRApi>('better.better-vscode')!;
        session = await (await ext.activate()).ready();
        session.openConsole();
    });

    test('the console offers Shift-Enter, as VS Code reports it (kitty keyboard protocol)', async () => {
        const kitty = vscode.workspace.getConfiguration('terminal.integrated').get<boolean>('enableKittyKeyboardProtocol');
        assert.strictEqual(kitty, true, 'this VS Code should enable the kitty keyboard protocol by default');
        // The extension only tells the console about Shift-Enter when VS Code
        // can't report it, so this banner comes from the terminal's own answer.
        const text = await waitFor('the console banner', () => consoleText(session), (t) => t.includes('Ctrl-D quits'));
        assert.match(text, /Shift-Enter newline/);
    });

    test("the Shift-Enter keybinding's sequence (for terminals that can't report it) inserts a newline", async () => {
        const binding = (vscode.extensions.getExtension('better.better-vscode')!.packageJSON.contributes.keybindings as {
            command: string;
            key: string;
            args?: unknown;
        }[]).find((b) => b.key === 'shift+enter')!;
        session.terminal!.show(false);
        session.terminal!.sendText('40000 + 1', false);
        await vscode.commands.executeCommand(binding.command, binding.args);
        await new Promise((r) => setTimeout(r, 1500));
        assert.doesNotMatch(await consoleText(session), /\[1\] 40001/, 'the line ran instead of continuing');
        session.terminal!.sendText('50000 + 2\r', false);
        const text = await waitFor('both lines to run', () => consoleText(session), (t) => t.includes('[1] 50002'));
        assert.match(text, /\[1\] 40001[\s\S]*\[1\] 50002/);
    });
});
