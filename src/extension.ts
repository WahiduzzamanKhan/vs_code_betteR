import * as vscode from 'vscode';
import { ArkDapBridge } from './dap';
import { Session } from './session';

/** Returned from `activate`; used by the integration tests. */
export interface BetteRApi {
    ready(): Promise<Session>;
}

let current: Promise<Session> | undefined;
/** The started session, for synchronous callers (debug adapter, documents). */
let active: Session | undefined;

export function activate(context: vscode.ExtensionContext): BetteRApi {
    const output = vscode.window.createOutputChannel('betteR', { log: true });
    const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    status.command = 'betteR.openConsole';
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
            .then((choice) => choice && vscode.commands.executeCommand('betteR.restart'));
        void session.dispose();
    };

    const start = (): Promise<Session> => {
        setStatus('$(loading~spin) R', 'Starting R session…');
        const starting = Session.start(context, output, onUnexpectedExit);
        starting.then(
            (session) => {
                active = session;
                setStatus('$(terminal) R', `R session (ark) — ${session.connectionFile}`);
                if (vscode.workspace.getConfiguration('betteR').get<boolean>('openConsoleOnStart')) {
                    session.openConsole(true);
                }
            },
            (err: Error) => {
                setStatus('$(error) R', err.message);
                output.appendLine(`Failed to start R session: ${err.message}`);
                void vscode.window.showErrorMessage(`betteR: ${err.message}`);
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
        vscode.commands.registerCommand('betteR.openConsole', async () => (await session()).openConsole()),
        vscode.commands.registerCommand('betteR.showPlots', async () => (await session()).plots.show()),
        vscode.commands.registerCommand('betteR.clearPlots', async () => (await session()).plots.confirmClear()),
        vscode.commands.registerCommand('betteR.showViewer', async () => {
            const s = await session();
            if (s.viewer.url) {
                s.viewer.show(s.viewer.url, s.viewer.title);
            } else {
                void vscode.window.showInformationMessage('Nothing to view yet. htmlwidgets and Shiny apps from R appear here.');
            }
        }),
        vscode.commands.registerCommand('betteR.restart', async () => {
            const old = current;
            current = undefined;
            active = undefined;
            await (await old?.catch(() => undefined))?.dispose();
            await start();
        }),
        vscode.commands.registerCommand('betteR.runSelection', async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                return;
            }
            await (await session()).runSelection(editor);
        }),
        vscode.debug.registerDebugAdapterDescriptorFactory('ark', {
            createDebugAdapterDescriptor: () => {
                const s = active;
                if (!s?.dapPort) {
                    throw new Error('The R console is not connected to the debugger yet.');
                }
                return new vscode.DebugAdapterInlineImplementation(new ArkDapBridge(s.dapPort, () => s.paused));
            },
        }),
        vscode.workspace.registerTextDocumentContentProvider('ark', {
            provideTextDocumentContent: async (uri) => (active ? active.virtualDocument(uri) : ''),
        }),
    );

    void start();
    return { ready: () => session() };
}

export async function deactivate(): Promise<void> {
    const s = await current?.catch(() => undefined);
    await s?.dispose();
}
