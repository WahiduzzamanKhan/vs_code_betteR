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
        await new Promise((r) => setTimeout(r, 200));
    }
    assert.fail(`timed out waiting for ${what}; last value: ${JSON.stringify(last)?.slice(0, 300)}`);
}

suite('betteR help: R documentation in an R Help panel', () => {
    let session: Session;

    suiteSetup(async () => {
        const doc = await vscode.workspace.openTextDocument(path.join(workspace(), 'analysis.R'));
        await vscode.window.showTextDocument(doc);
        const ext = vscode.extensions.getExtension<BetteRApi>('better.better-vscode')!;
        session = await (await ext.activate()).ready();
    });

    test('?topic typed in the console opens the help page in VS Code', async () => {
        session.terminal!.sendText('?mean\r', false);
        await waitFor('R Help to show mean', () => session.help.current, (u) => !!u && u.endsWith('/library/base/html/mean.html'));
        assert.ok(session.help.isVisible);
        // The page itself loaded and reported in (its title comes from the page).
        await waitFor('page to load in the panel', () => session.help.title, (t) => /Arithmetic Mean/.test(t));
    });

    test('help pages follow the VS Code theme', async () => {
        const theme = await waitFor('panel to report the theme', () => session.help.theme, (t) => !!t);
        const background = theme!.vars['--vscode-editor-background'];
        assert.ok(background, 'theme has an editor background');

        // Pages arrive already themed (no white flash), with the theme's own values.
        const html = await (await fetch(session.help.current!)).text();
        const head = html.slice(0, html.search(/R\.css/));
        assert.match(head, /html\.betteR-themed body/, 'theme styles come before R.css');
        assert.ok(head.includes(`--vscode-editor-background: ${background};`), 'theme colors are inlined');
        assert.match(head, /classList\.add\("betteR-themed"\)/);
    });

    test('help pages carry find, copy, paste and a context menu', async () => {
        // The page is a cross-origin iframe, out of reach of VS Code's own find and copy.
        const html = await (await fetch(session.help.current!)).text();
        assert.match(html, /"betteR-find"/, 'page answers the find bar');
        assert.match(html, /"betteR-copy"/, 'page sends its selection to copy');
        assert.match(html, /::highlight\(betteR-find\)/, 'matches are highlighted');
        assert.match(html, /"betteR-paste"/, 'page asks the panel for the clipboard');
        assert.match(html, /addEventListener\("contextmenu"/, 'page has its own context menu');
    });

    test('Back and Forward move through help history', async () => {
        session.execute('help("lm")');
        await waitFor('lm page', () => session.help.title, (t) => /Fitting Linear Models/.test(t));
        assert.strictEqual(session.help.index, session.help.history.length - 1);

        session.help.back();
        await waitFor('back to mean', () => session.help.title, (t) => /Arithmetic Mean/.test(t));
        session.help.forward();
        await waitFor('forward to lm', () => session.help.title, (t) => /Fitting Linear Models/.test(t));
    });

    test('help search (??) and package indexes show too', async () => {
        session.execute('??regression');
        await waitFor('search results', () => session.help.current, (u) => !!u && u.includes('/doc/html/Search'));
        session.execute('help(package = "stats")');
        await waitFor('stats index', () => session.help.current, (u) => !!u && u.endsWith('/library/stats/html/00Index.html'));
    });

    test('F1 shows help for the symbol at the cursor', async () => {
        const doc = await vscode.workspace.openTextDocument(path.join(workspace(), 'analysis.R'));
        const editor = await vscode.window.showTextDocument(doc);
        const line = doc.getText().split('\n').findIndex((l) => l.startsWith('mean('));
        editor.selection = new vscode.Selection(line, 1, line, 1);
        assert.strictEqual(await session.helpAt(doc, editor.selection.active), 'mean');
        await waitFor('mean via F1', () => session.help.current, (u) => !!u && u.endsWith('/library/base/html/mean.html'));

        const unknown = await vscode.workspace.openTextDocument({ language: 'r', content: 'not_a_function_xyz(1)\n' });
        assert.strictEqual(await session.helpAt(unknown, new vscode.Position(0, 3)), undefined);
    });
});
