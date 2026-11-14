import * as vscode from 'vscode';
import { Session } from './session';

/** Returned from `activate`; used by the integration tests. */
export interface BetterRApi {
    ready(): Promise<Session>;
}

let current: Promise<Session> | undefined;

export function activate(context: vscode.ExtensionContext): BetterRApi {
    const output = vscode.window.createOutputChannel('betterR', { log: true });
    const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    status.command = 'betterR.openConsole';
    context.subscriptions.push(output, status);

    const setStatus = (text: string, tooltip: string) => {
        status.text = text;
        status.tooltip = tooltip;
        status.show();
    };

    const onUnexpectedExit = (session: Session) => {
        setStatus('$(debug-disconnect) R', 'R session ended');
        void vscode.window
            .showWarningMessage('The R session ended.', 'Restart R')
            .then((choice) => choice && vscode.commands.executeCommand('betterR.restart'));
        void session.dispose();
    };

    const start = (): Promise<Session> => {
        setStatus('$(loading~spin) R', 'Starting R session…');
        const starting = Session.start(context, output, onUnexpectedExit);
        starting.then(
            (session) => {
                setStatus('$(terminal) R', `R session (ark) — ${session.connectionFile}`);
                if (vscode.workspace.getConfiguration('betterR').get<boolean>('openConsoleOnStart')) {
                    session.openConsole(true);
                }
            },
            (err: Error) => {
                setStatus('$(error) R', err.message);
                output.appendLine(`Failed to start R session: ${err.message}`);
                void vscode.window.showErrorMessage(`betterR: ${err.message}`);
            },
        );
        current = starting;
        return starting;
    };

    const session = async (): Promise<Session> => {
        const s = await (current ?? start());
        return s.isRunning ? s : start();
    };

    context.subscriptions.push(
        vscode.commands.registerCommand('betterR.openConsole', async () => (await session()).openConsole()),
        vscode.commands.registerCommand('betterR.restart', async () => {
            const old = current;
            current = undefined;
            await (await old?.catch(() => undefined))?.dispose();
            await start();
        }),
        vscode.commands.registerCommand('betterR.runSelection', async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                return;
            }
            const { selection, document } = editor;
            const code = selection.isEmpty ? document.lineAt(selection.active.line).text : document.getText(selection);
            (await session()).sendToConsole(code);
            // Like RStudio: running a line moves the cursor to the next one.
            if (selection.isEmpty && selection.active.line + 1 < document.lineCount) {
                const next = new vscode.Position(selection.active.line + 1, 0);
                editor.selection = new vscode.Selection(next, next);
            }
        }),
    );

    void start();
    return { ready: () => session() };
}

export async function deactivate(): Promise<void> {
    const s = await current?.catch(() => undefined);
    await s?.dispose();
}
