import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';
import type { BetteRApi } from '../../extension';
import type { EnvironmentExplorer, EnvNode } from '../../environment';
import type { Session } from '../../session';

const workspace = () => vscode.workspace.workspaceFolders![0].uri.fsPath;

async function waitFor<T>(what: string, probe: () => T | Promise<T>, ok: (v: T) => boolean, ms = 30_000): Promise<T> {
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
        await new Promise((r) => setTimeout(r, 200));
    }
    assert.fail(`timed out waiting for ${what}; last value: ${JSON.stringify(last)?.slice(0, 500)}`);
}

const varNamed = (nodes: EnvNode[], name: string) =>
    nodes.find((n) => n.type === 'var' && n.variable.display_name === name) as Extract<EnvNode, { type: 'var' }> | undefined;

suite('betteR environment explorer: the live session in the side bar', () => {
    let session: Session;
    let explorer: EnvironmentExplorer;
    const envRoots = () => explorer.environment.getChildren() as EnvNode[];

    suiteSetup(async () => {
        const doc = await vscode.workspace.openTextDocument(path.join(workspace(), 'analysis.R'));
        await vscode.window.showTextDocument(doc);
        const api = await vscode.extensions.getExtension<BetteRApi>('better.better-vscode')!.activate();
        session = await api.ready();
        explorer = api.environment;
    });

    test('objects created in the console appear live, and expand into their parts', async () => {
        session.terminal!.sendText('env_df <- data.frame(a = 1:3, b = c("x", "y", "z"))\r', false);
        const node = await waitFor('env_df in the explorer', () => varNamed(envRoots(), 'env_df'), (n) => !!n);
        assert.strictEqual(node!.variable.kind, 'table');
        assert.ok(node!.variable.has_children);
        const columns = (await explorer.environment.getChildren(node)) as EnvNode[];
        assert.deepStrictEqual(
            columns.map((c) => c.type === 'var' && c.variable.display_name),
            ['a', 'b'],
        );

        session.terminal!.sendText('rm(env_df)\r', false);
        await waitFor('env_df to disappear', () => varNamed(envRoots(), 'env_df'), (n) => !n);
    });

    test('while R is paused, the explorer shows the debug frame', async () => {
        session.execute('env_f <- function() { frame_local <- 42; browser(); invisible() }');
        session.execute('env_f()');
        try {
            await waitFor('frame_local in the debug frame', () => varNamed(envRoots(), 'frame_local'), (n) => !!n);
            assert.ok(explorer.browsing);
        } finally {
            session.execute('Q');
        }
        await waitFor('back to the global env', () => varNamed(envRoots(), 'env_f'), (n) => !!n);
        assert.ok(!explorer.browsing);
    });

    test('search path, loaded namespaces and session info come from the live session', async () => {
        session.execute('library(tools)');
        await explorer.refresh();
        const search = await waitFor(
            'tools on the search path',
            async () => (await explorer.refresh(), explorer.searchPath.getChildren() as EnvNode[]),
            (nodes) => nodes.some((n) => n.type === 'search' && n.name === 'package:tools'),
        );
        const stats = search.find((n) => n.type === 'search' && n.name === 'package:stats')!;
        assert.match((stats as { version: string }).version, /^\d+\.\d+\.\d+$/);
        const objects = (await explorer.searchPath.getChildren(stats)) as EnvNode[];
        assert.ok(objects.some((o) => o.type === 'object' && o.name === 'sd'), 'stats exports sd');

        const namespaces = explorer.namespaces.getChildren() as EnvNode[];
        const base = namespaces.find((n) => n.type === 'namespace' && n.name === 'base');
        assert.ok(base && base.type === 'namespace' && base.attached && base.version);

        const info = explorer.info.getChildren() as EnvNode[];
        const version = info.find((n) => n.type === 'info' && n.label === 'R version');
        assert.match(version && version.type === 'info' ? version.value : '', /^R version \d/);
        session.execute('detach("package:tools")');
    });

    test('removing an object updates the view at once, without running anything', async () => {
        session.execute('env_gone <- 1');
        const node = await waitFor('env_gone listed', () => varNamed(envRoots(), 'env_gone'), (n) => !!n);
        const confirm = vscode.window.showWarningMessage;
        (vscode.window as { showWarningMessage: unknown }).showWarningMessage = async () => 'Remove';
        try {
            await vscode.commands.executeCommand('betteR.env.remove', node);
        } finally {
            (vscode.window as { showWarningMessage: unknown }).showWarningMessage = confirm;
        }
        assert.ok(!varNamed(envRoots(), 'env_gone'), 'gone right after Remove');
        // Refresh lists ark's last scan, which still has it until the next prompt.
        await explorer.refresh();
        assert.ok(!varNamed(envRoots(), 'env_gone'), 'still gone after Refresh');

        // Recreating it later shows it again.
        session.execute('env_gone <- 2');
        await waitFor('env_gone back', () => varNamed(envRoots(), 'env_gone'), (n) => !!n);
        session.execute('rm(env_gone)');
    });

    test('hidden objects show on request and can be removed', async () => {
        session.execute('.env_hidden <- list(1, 2)');
        await explorer.setShowHidden(true);
        const hidden = await waitFor(
            '.env_hidden listed',
            async () => (await explorer.refresh(), varNamed(envRoots(), '.env_hidden')),
            (n) => !!n,
        );
        assert.strictEqual(((await explorer.environment.getChildren(hidden)) as EnvNode[]).length, 2);

        const confirm = vscode.window.showWarningMessage;
        (vscode.window as { showWarningMessage: unknown }).showWarningMessage = async () => 'Remove';
        try {
            await vscode.commands.executeCommand('betteR.env.remove', hidden);
        } finally {
            (vscode.window as { showWarningMessage: unknown }).showWarningMessage = confirm;
        }
        await waitFor('.env_hidden removed', async () => (await explorer.refresh(), varNamed(envRoots(), '.env_hidden')), (n) => !n);
        await explorer.setShowHidden(false);
    });
});
