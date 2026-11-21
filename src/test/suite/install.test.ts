import * as assert from 'assert';
import * as vscode from 'vscode';
import { INSTALL_DOCS, installCommand, offerInstall } from '../../install';

type Stubbed = Record<string, unknown>;

/** Replaces `obj[name]` with `fake` while `fn` runs. */
async function stub<T>(obj: object, name: string, fake: unknown, fn: () => Promise<T>): Promise<T> {
    const real = (obj as Stubbed)[name];
    (obj as Stubbed)[name] = fake;
    try {
        return await fn();
    } finally {
        (obj as Stubbed)[name] = real;
    }
}

suite('betteR: installing the console', () => {
    test('the install command runs the release install script for the OS', () => {
        const unix = installCommand('linux');
        assert.strictEqual(installCommand('darwin'), unix);
        assert.match(unix, /^curl --proto '=https' --tlsv1\.2 -LsSf \S+\/releases\/latest\/download\/better-installer\.sh \| sh$/);
        assert.match(
            installCommand('win32'),
            /^powershell -ExecutionPolicy Bypass -c "irm \S+\/releases\/latest\/download\/better-installer\.ps1 \| iex"$/,
        );
    });

    /**
     * Runs `offerInstall` with the user clicking `click` on the error and
     * dismissing the follow-up; records what it did instead of doing it.
     */
    async function offer(click: string | undefined, kind: 'install' | 'update' = 'install') {
        const shown: { error?: string[]; info?: string; terminal?: string; sent?: string; opened?: string } = {};
        const fakeTerminal = { show: () => undefined, sendText: (t: string) => (shown.sent = t) };
        await stub(vscode.window, 'showErrorMessage', (m: string, ...items: string[]) => {
            shown.error = [m, ...items];
            return Promise.resolve(click);
        }, () =>
            stub(vscode.window, 'showInformationMessage', (m: string) => {
                shown.info = m;
                return Promise.resolve(undefined);
            }, () =>
                stub(vscode.window, 'createTerminal', (o: { name: string }) => {
                    shown.terminal = o.name;
                    return fakeTerminal;
                }, () =>
                    stub(vscode.env, 'openExternal', (uri: vscode.Uri) => {
                        shown.opened = uri.toString(true);
                        return Promise.resolve(true);
                    }, () => offerInstall('not installed', kind)),
                ),
            ),
        );
        return shown;
    }

    test('nothing runs or downloads until the user clicks', async () => {
        const shown = await offer(undefined);
        assert.deepStrictEqual(shown.error, ['betteR: not installed', 'Install', 'Copy Command', 'Instructions']);
        assert.strictEqual(shown.terminal, undefined);
        assert.strictEqual(shown.info, undefined);
        assert.deepStrictEqual((await offer(undefined, 'update')).error?.slice(1), ['Update', 'Copy Command', 'Instructions']);
    });

    test('Install runs the command in a terminal the user can see, then offers to start R', async () => {
        const shown = await offer('Install');
        assert.strictEqual(shown.terminal, 'Install betteR console');
        assert.strictEqual(shown.sent, installCommand());
        assert.match(shown.info ?? '', /start R/);
    });

    test('Copy Command copies it and runs nothing', async () => {
        await vscode.env.clipboard.writeText('');
        const shown = await offer('Copy Command');
        assert.strictEqual(await vscode.env.clipboard.readText(), installCommand());
        assert.strictEqual(shown.terminal, undefined);
        assert.match(shown.info ?? '', /copied/);
    });

    test('Instructions opens the install instructions', async () => {
        const shown = await offer('Instructions');
        assert.strictEqual(shown.opened, INSTALL_DOCS);
        assert.strictEqual(shown.terminal, undefined);
    });
});
