import * as assert from 'assert';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { BetteRApi } from '../../extension';
import type { Session } from '../../session';

const workspace = () => vscode.workspace.workspaceFolders![0].uri.fsPath;

function installedPackages(): string {
    return cp.execFileSync('Rscript', ['-e', 'cat(sort(rownames(installed.packages())), sep = "\\n")'], {
        encoding: 'utf8',
    });
}

/** The pristine fixture the test workspace was copied from. */
const fixture = path.resolve(__dirname, '../../../test-fixtures/workspace');

/**
 * File name -> contents. `.vscode/` is skipped: the fresh VS Code profile used
 * by the test harness creates it on startup, before any extension runs (a
 * normal window doesn't).
 */
function snapshot(dir: string): Record<string, string> {
    const snap: Record<string, string> = {};
    for (const f of fs.readdirSync(dir, { recursive: true }) as string[]) {
        const full = path.join(dir, f);
        if (f.split(path.sep)[0] !== '.vscode' && fs.statSync(full).isFile()) {
            snap[f] = fs.readFileSync(full, 'utf8');
        }
    }
    return snap;
}

async function completionLabels(uri: vscode.Uri, pos: vscode.Position): Promise<string[]> {
    const list = await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        uri,
        pos,
    );
    return list.items.map((i) => (typeof i.label === 'string' ? i.label : i.label.label));
}

async function waitFor<T>(what: string, probe: () => Promise<T>, ok: (v: T) => boolean, ms = 90_000): Promise<T> {
    const deadline = Date.now() + ms;
    let last: T | undefined;
    while (Date.now() < deadline) {
        last = await probe();
        if (ok(last)) {
            return last;
        }
        await new Promise((r) => setTimeout(r, 500));
    }
    assert.fail(`timed out waiting for ${what}; last value: ${JSON.stringify(last)}`);
}

suite('betteR: one live R session shared by console and editor', () => {
    let packagesBefore: string;
    let doc: vscode.TextDocument;
    let session: Session;

    suiteSetup(async () => {
        packagesBefore = installedPackages();

        doc = await vscode.workspace.openTextDocument(path.join(workspace(), 'analysis.R'));
        await vscode.window.showTextDocument(doc);
        const ext = vscode.extensions.getExtension<BetteRApi>('better.better-vscode')!;
        session = await (await ext.activate()).ready();
    });

    test('console opens in a terminal attached to the session', () => {
        assert.ok(session.terminal, 'console terminal should open on start');
        assert.ok(session.isRunning);
    });

    test('object created in the console completes in the editor (y <- mtcars; y$)', async () => {
        // Typed into the terminal console, exactly as a user would.
        session.terminal!.sendText('y <- mtcars\r', false);
        const labels = await waitFor(
            'mtcars columns at y$',
            () => completionLabels(doc.uri, new vscode.Position(4, 2)),
            (l) => l.includes('mpg'),
        );
        for (const col of ['mpg', 'cyl', 'hp', 'carb']) {
            assert.ok(labels.includes(col), `missing ${col} in ${labels}`);
        }
    });

    test('hover shows R help from the live session', async () => {
        const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
            'vscode.executeHoverProvider',
            doc.uri,
            new vscode.Position(2, 1),
        );
        const text = hovers
            .flatMap((h) => h.contents)
            .map((c) => (typeof c === 'string' ? c : c.value))
            .join('\n');
        assert.match(text, /Arithmetic Mean/);
    });

    test('the console gets signature help from the editor language client', async () => {
        // What the console sends while the cursor is inside `mean(1:10, )`.
        const replies: { id: number; help: { signatures: { label: string }[]; activeParameter?: number } }[] = [];
        const send = session.ide.send.bind(session.ide);
        session.ide.send = (msg) => {
            if (msg.type === 'signature_reply') {
                replies.push(msg as never);
            }
            send(msg);
        };
        try {
            (session as unknown as { onIdeMessage(msg: object): void }).onIdeMessage({
                type: 'signature',
                id: 4242,
                text: 'mean(1:10, )',
                offset: 11,
            });
            const [reply] = await waitFor('signature reply', async () => replies, (r) => r.length > 0, 15_000);
            assert.strictEqual(reply.id, 4242);
            assert.match(reply.help.signatures[0].label, /^mean\(x, \.\.\.\)/);
            assert.strictEqual(reply.help.activeParameter, 1);
        } finally {
            session.ide.send = send;
        }
    });

    test('the console gets help for a completion from the editor language client', async () => {
        const replies: { id: number; item: { documentation?: { value?: string } } }[] = [];
        const send = session.ide.send.bind(session.ide);
        session.ide.send = (msg) => {
            if (msg.type === 'resolve_reply') {
                replies.push(msg as never);
            }
            send(msg);
        };
        try {
            // The completion item ark gives for `mean`, as the console sends it back.
            (session as unknown as { onIdeMessage(msg: object): void }).onIdeMessage({
                type: 'resolve',
                id: 4343,
                item: { label: 'mean', kind: 3, data: { Function: { name: 'mean', package: 'base' } } },
            });
            const [reply] = await waitFor('resolve reply', async () => replies, (r) => r.length > 0, 15_000);
            assert.strictEqual(reply.id, 4343);
            assert.match(reply.item.documentation?.value ?? '', /Arithmetic Mean/);
        } finally {
            session.ide.send = send;
        }
    });

    test('Run Selection sends editor code to the console session', async () => {
        const editor = await vscode.window.showTextDocument(doc);
        editor.selection = new vscode.Selection(1, 0, 1, 0);
        await vscode.commands.executeCommand('betteR.runSelection');
        // The name is built at runtime, so only the live session can know it.
        await waitFor(
            'runtime-only symbol from Run Selection',
            () => completionLabels(doc.uri, new vscode.Position(3, 9)),
            (l) => l.includes('dyn_from_editor'),
        );
        assert.strictEqual(editor.selection.active.line, 2, 'cursor advances to the next line');
    });

    test('nothing is installed into the R library or written to the project', () => {
        assert.strictEqual(installedPackages(), packagesBefore, 'R library changed');
        assert.deepStrictEqual(snapshot(workspace()), snapshot(fixture), 'project files (incl. renv.lock) changed');
    });
});
