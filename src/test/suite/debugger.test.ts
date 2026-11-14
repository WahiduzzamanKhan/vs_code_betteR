import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import type { BetterRApi } from '../../extension';
import type { Session } from '../../session';

const workspace = () => vscode.workspace.workspaceFolders![0].uri.fsPath;

async function waitFor<T>(what: string, probe: () => T | Promise<T>, ok: (v: T) => boolean, ms = 60_000): Promise<T> {
    const deadline = Date.now() + ms;
    let last: T | undefined;
    while (Date.now() < deadline) {
        try {
            last = await probe();
            if (ok(last)) {
                return last;
            }
        } catch {
            // Not ready yet.
        }
        await new Promise((r) => setTimeout(r, 300));
    }
    assert.fail(`timed out waiting for ${what}; last value: ${JSON.stringify(last)}`);
}

type Frame = { id: number; name: string; line: number; source?: { path?: string } };

async function topFrame(debug: vscode.DebugSession): Promise<Frame | undefined> {
    const { threads } = await debug.customRequest('threads');
    const { stackFrames } = await debug.customRequest('stackTrace', { threadId: threads[0].id });
    return stackFrames[0];
}

async function locals(debug: vscode.DebugSession, frameId: number): Promise<Record<string, string>> {
    const { scopes } = await debug.customRequest('scopes', { frameId });
    const { variables } = await debug.customRequest('variables', {
        variablesReference: scopes[0].variablesReference,
    });
    return Object.fromEntries(variables.map((v: { name: string; value: string }) => [v.name, v.value]));
}

/** Reads an R value by having the console write it to a temp file. */
async function rValue(session: Session, expr: string): Promise<string> {
    const file = path.join(os.tmpdir(), `betterr-value-${Date.now()}.txt`);
    session.execute(`writeLines(format(${expr}), ${JSON.stringify(file)})`);
    const value = await waitFor('R value', () => fs.readFileSync(file, 'utf8').trim(), (v) => v.length > 0);
    fs.rmSync(file, { force: true });
    return value;
}

const arkSession = () => (vscode.debug.activeDebugSession?.type === 'ark' ? vscode.debug.activeDebugSession : undefined);

suite('betterR debugger: browser() and breakpoints in VS Code', () => {
    let session: Session;
    let doc: vscode.TextDocument;
    let editor: vscode.TextEditor;

    suiteSetup(async () => {
        doc = await vscode.workspace.openTextDocument(path.join(workspace(), 'debug.R'));
        editor = await vscode.window.showTextDocument(doc);
        const ext = vscode.extensions.getExtension<BetterRApi>('betterr.betterr-vscode')!;
        session = await (await ext.activate()).ready();
        await waitFor('console to report its debugger port', () => session.dapPort, (p) => p !== undefined);
    });

    teardown(async () => {
        vscode.debug.removeBreakpoints(vscode.debug.breakpoints);
        if (session.paused) {
            session.execute('Q');
        }
        await waitFor('debug session to end', () => arkSession(), (s) => s === undefined, 20_000);
    });

    test('browser() in a function run from the editor stops VS Code on the real file line', async () => {
        editor.selection = new vscode.Selection(0, 0, 0, 0);
        await vscode.commands.executeCommand('betterR.runSelection');
        assert.strictEqual(editor.selection.active.line, 5, 'Cmd+Enter runs the whole function and moves past it');

        session.execute('res_add_one <- add_one(1)');
        const debug = await waitFor('debug session', () => arkSession(), (s) => s !== undefined);
        const frame = await waitFor('stop at browser()', () => topFrame(debug!), (f) => f?.line === 3);
        assert.strictEqual(frame!.source?.path, doc.uri.fsPath, 'frame points at the real file, not a copy');

        // VS Code itself is stopped (so it highlights the line), not just the adapter.
        await waitFor('VS Code focused stack frame', () => vscode.debug.activeStackItem, (i) => i instanceof vscode.DebugStackFrame);

        const vars = await locals(debug!, frame!.id);
        assert.strictEqual(vars.x, '1');
        assert.strictEqual(vars.y, '2');

        await vscode.commands.executeCommand('workbench.action.debug.stepOver');
        await waitFor('step to next line', () => topFrame(debug!), (f) => f?.line === 4);

        await vscode.commands.executeCommand('workbench.action.debug.continue');
        await waitFor('debug session to end after continue', () => arkSession(), (s) => s === undefined, 20_000);
        assert.strictEqual(await rValue(session, 'res_add_one'), '4');
    });

    test('a gutter breakpoint stops a function sent with Cmd+Enter', async () => {
        vscode.debug.addBreakpoints([
            new vscode.SourceBreakpoint(new vscode.Location(doc.uri, new vscode.Position(7, 0))),
        ]);
        // Breakpoints alone attach the debugger, so ark knows about them.
        const debug = await waitFor('debug session for breakpoints', () => arkSession(), (s) => s !== undefined);
        await new Promise((r) => setTimeout(r, 1000));

        editor.selection = new vscode.Selection(6, 0, 6, 0);
        await vscode.commands.executeCommand('betterR.runSelection');
        session.execute('res_times <- times_two(5)');

        const frame = await waitFor('stop at breakpoint', () => topFrame(debug!), (f) => f?.line === 8);
        assert.strictEqual(frame!.source?.path, doc.uri.fsPath);
        assert.strictEqual((await locals(debug!, frame!.id)).v, '5');

        await vscode.commands.executeCommand('workbench.action.debug.continue');
        assert.strictEqual(await rValue(session, 'res_times'), '10');
    });

    test('a function typed at the console is shown from an ark: virtual document', async () => {
        session.terminal!.sendText('f_console <- function() { a <- 1; browser(); a }\r', false);
        session.terminal!.sendText('f_console()\r', false);
        const debug = await waitFor('debug session', () => arkSession(), (s) => s !== undefined);
        const frame = await waitFor('stop in console function', () => topFrame(debug!), (f) => !!f?.source?.path);
        assert.match(frame!.source!.path!, /^ark:/);
        const vdoc = await vscode.workspace.openTextDocument(vscode.Uri.parse(frame!.source!.path!));
        assert.match(vdoc.getText(), /browser\(\)/);

        await vscode.commands.executeCommand('workbench.action.debug.continue');
    });
});
