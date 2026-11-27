import * as vscode from 'vscode';
import { ArkDapBridge } from './dap';
import { ConsoleNeeded } from './compat';
import { offerInstall } from './install';
import { EnvironmentExplorer, EnvNode, rExpression } from './environment';
import { Session, trackConsoleFocus } from './session';

/** Returned from `activate`; used by the integration tests. */
export interface BetteRApi {
    ready(): Promise<Session>;
    environment: EnvironmentExplorer;
}

let current: Promise<Session> | undefined;
/** The started session, for synchronous callers (debug adapter, documents). */
let active: Session | undefined;

export function activate(context: vscode.ExtensionContext): BetteRApi {
    const output = vscode.window.createOutputChannel('betteR', { log: true });
    const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    status.command = 'betteR.openConsole';
    const explorer = new EnvironmentExplorer();
    context.subscriptions.push(output, status, explorer, trackConsoleFocus());

    const setStatus = (text: string, tooltip: string) => {
        status.text = text;
        status.tooltip = tooltip;
        status.show();
    };

    const onUnexpectedExit = (session: Session) => {
        const reason = session.exitReason();
        setStatus('$(debug-disconnect) R', reason ? `R session ended: ${reason}` : 'R session ended');
        explorer.attach(undefined);
        if (reason) {
            output.appendLine(`R session ended: ${reason}`);
        }
        void vscode.window
            .showWarningMessage(reason ? `The R session ended: ${reason}` : 'The R session ended.', 'Restart R')
            .then((choice) => choice && vscode.commands.executeCommand('betteR.restart'));
        void session.dispose();
    };

    const start = (): Promise<Session> => {
        setStatus('$(loading~spin) R', 'Starting R session…');
        const starting = Session.start(context, output, onUnexpectedExit);
        starting.then(
            (session) => {
                active = session;
                // Before the console opens, so the explorer gets ark's first variable list.
                explorer.attach(session);
                setStatus('$(terminal) R', `R session (ark) — ${session.connectionFile}`);
                if (vscode.workspace.getConfiguration('betteR').get<boolean>('openConsoleOnStart')) {
                    session.openConsole(true);
                }
            },
            (err: Error) => {
                setStatus('$(error) R', err.message);
                output.appendLine(`Failed to start R session: ${err.message}`);
                if (err instanceof ConsoleNeeded) {
                    void offerInstall(err.message, err.kind);
                } else {
                    void vscode.window.showErrorMessage(`betteR: ${err.message}`);
                }
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
        vscode.commands.registerCommand('betteR.helpAtCursor', async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                return;
            }
            const word = editor.document.getText(editor.document.getWordRangeAtPosition(editor.selection.active, /[\w.:]+/));
            const topic = await (await session()).helpAt(editor.document, editor.selection.active);
            if (!topic) {
                void vscode.window.showInformationMessage(`No R help found for '${word}'.`);
            }
        }),
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
            explorer.attach(undefined);
            await (await old?.catch(() => undefined))?.dispose();
            await start();
        }),
        vscode.commands.registerCommand('betteR.env.refresh', () => explorer.refresh()),
        vscode.commands.registerCommand('betteR.env.clear', () => explorer.clear()),
        vscode.commands.registerCommand('betteR.env.filter', () => explorer.promptFilter()),
        vscode.commands.registerCommand('betteR.env.clearFilter', () => explorer.setFilter('')),
        vscode.commands.registerCommand('betteR.env.showHidden', () => explorer.setShowHidden(true)),
        vscode.commands.registerCommand('betteR.env.hideHidden', () => explorer.setShowHidden(false)),
        vscode.commands.registerCommand('betteR.env.remove', (node: EnvNode) => node && explorer.remove([node])),
        vscode.commands.registerCommand('betteR.env.viewData', async (node: EnvNode) => {
            try {
                await explorer.view(node);
            } catch (err) {
                void vscode.window.showErrorMessage(`betteR: ${(err as Error).message}`);
            }
        }),
        vscode.commands.registerCommand('betteR.env.print', async (node: EnvNode) => {
            const expr = node && rExpression(node);
            if (expr) {
                (await session()).execute(expr);
            }
        }),
        vscode.commands.registerCommand('betteR.env.str', async (node: EnvNode) => {
            const expr = node && rExpression(node);
            if (expr) {
                (await session()).execute(`str(${expr})`);
            }
        }),
        vscode.commands.registerCommand('betteR.env.copy', async (node: EnvNode) => {
            const text = node && EnvironmentExplorer.copyText(node);
            if (text) {
                await vscode.env.clipboard.writeText(text);
            }
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

    // The console reads its settings when it starts (and the kernel
    // startup.r_home), so a change needs a restart.
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(async (e) => {
            if (!e.affectsConfiguration('betteR.console')) {
                return;
            }
            const s = active;
            const consoleRunning = s?.isRunning && s.terminal !== undefined && s.terminal.exitStatus === undefined;
            const kernelSetting = s?.isRunning && e.affectsConfiguration('betteR.console.startup.r_home');
            if (!consoleRunning && !kernelSetting) {
                return;
            }
            const choice = await vscode.window.showInformationMessage('Restart the R console to apply.', 'Restart');
            if (choice === 'Restart') {
                await vscode.commands.executeCommand('betteR.restart');
                if (consoleRunning) {
                    (await session()).openConsole();
                }
            }
        }),
    );

    void start();
    return { ready: () => session(), environment: explorer };
}

export async function deactivate(): Promise<void> {
    const s = await current?.catch(() => undefined);
    await s?.dispose();
}
