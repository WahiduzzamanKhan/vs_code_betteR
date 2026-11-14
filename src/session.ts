import * as cp from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { LanguageClient, LanguageClientOptions, ServerOptions } from 'vscode-languageclient/node';
import { IdeChannel, IdeMessage } from './ide';

const CONSOLE_NAME = 'R';

function freePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.unref();
        server.on('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address() as net.AddressInfo;
            server.close(() => resolve(port));
        });
    });
}

function onPath(name: string): string | undefined {
    for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
        const candidate = path.join(dir, name);
        if (dir && fs.existsSync(candidate)) {
            return candidate;
        }
    }
    return undefined;
}

/** Setting, then env var, then PATH, then the in-repo development build. */
function resolveBinary(setting: string, envVar: string | undefined, name: string, devPath: string): string {
    const configured = vscode.workspace.getConfiguration('betterR').get<string>(setting);
    const candidates = [configured, envVar ? process.env[envVar] : undefined];
    for (const c of candidates) {
        if (c) {
            if (!fs.existsSync(c)) {
                throw new Error(`${name} not found at ${c}`);
            }
            return c;
        }
    }
    const found = onPath(name) ?? (fs.existsSync(devPath) ? devPath : undefined);
    if (!found) {
        throw new Error(`Could not find \`${name}\`. Set betterR.${setting}.`);
    }
    return found;
}

/** Console input is mirrored into this LSP document for completion. */
const CONSOLE_DOC_URI = 'untitled:betterr-console';

/** Location of `range` in `doc` with columns as UTF-8 byte offsets, as ark expects. */
function codeLocation(doc: vscode.TextDocument, range: vscode.Range) {
    const bytes = (pos: vscode.Position) =>
        Buffer.byteLength(doc.lineAt(pos.line).text.slice(0, pos.character), 'utf8');
    return {
        uri: doc.uri.toString(),
        range: {
            start: { line: range.start.line, character: bytes(range.start) },
            end: { line: range.end.line, character: bytes(range.end) },
        },
    };
}

function hasRBreakpoints(): boolean {
    return vscode.debug.breakpoints.some(
        (b) => b.enabled && b instanceof vscode.SourceBreakpoint && /\.r$/i.test(b.location.uri.fsPath),
    );
}

/**
 * One ark kernel shared by every view: the extension owns the process and its
 * connection file; the editor's language client and the terminal console both
 * attach to it. The console holds ark's debugger comm and reports to us over
 * the IDE channel; VS Code's debugger attaches to ark's DAP through a bridge.
 */
export class Session implements vscode.Disposable {
    terminal: vscode.Terminal | undefined;
    /** R is stopped at a browser prompt. */
    paused = false;
    dapPort: number | undefined;
    debugSession: vscode.DebugSession | undefined;
    private startingDebug = false;
    private detachTimer: NodeJS.Timeout | undefined;
    private consoleDocVersion = 0;
    private disposed = false;
    private readonly disposables: vscode.Disposable[] = [];

    private constructor(
        readonly kernel: cp.ChildProcess,
        readonly connectionFile: string,
        readonly logFile: string,
        private readonly dir: string,
        readonly consolePath: string,
        readonly cwd: string | undefined,
        readonly client: LanguageClient,
        readonly ide: IdeChannel,
        private readonly ideSocket: string,
        private readonly output: vscode.LogOutputChannel,
    ) {
        this.disposables.push(
            ide,
            ide.onMessage((msg) => this.onIdeMessage(msg)),
            vscode.window.onDidCloseTerminal((t) => {
                if (t === this.terminal) {
                    this.terminal = undefined;
                }
            }),
            vscode.debug.onDidStartDebugSession((s) => {
                if (s.type === 'ark') {
                    this.debugSession = s;
                }
            }),
            vscode.debug.onDidTerminateDebugSession((s) => {
                if (s === this.debugSession) {
                    this.debugSession = undefined;
                }
            }),
            vscode.debug.onDidChangeBreakpoints(() => this.syncDebugSession()),
        );
    }

    static async start(
        context: vscode.ExtensionContext,
        output: vscode.LogOutputChannel,
        onUnexpectedExit: (session: Session) => void,
    ): Promise<Session> {
        const repo = path.resolve(context.extensionPath, '..');
        const ark = resolveBinary('arkPath', 'ARK_PATH', 'ark', path.join(repo, 'vendor/ark/target/debug/ark'));
        const consolePath = resolveBinary(
            'consolePath',
            undefined,
            'betterr',
            path.join(repo, 'console/target/debug/betterr'),
        );

        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'betterr-vscode-'));
        const connectionFile = path.join(dir, 'kernel.json');
        const logFile = path.join(dir, 'ark.log');
        const ideSocket = path.join(dir, 'ide.sock');
        const info = {
            shell_port: await freePort(),
            iopub_port: await freePort(),
            stdin_port: await freePort(),
            control_port: await freePort(),
            hb_port: await freePort(),
            ip: '127.0.0.1',
            key: crypto.randomBytes(16).toString('hex'),
            transport: 'tcp',
            signature_scheme: 'hmac-sha256',
            kernel_name: 'ark',
        };
        // The connection file holds the HMAC key: owner-only.
        fs.writeFileSync(connectionFile, JSON.stringify(info, null, 2), { mode: 0o600 });
        const ide = await IdeChannel.listen(ideSocket);

        const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        output.appendLine(`Starting ark: ${ark}`);
        output.appendLine(`Connection file: ${connectionFile}`);
        const kernel = cp.spawn(
            ark,
            ['--connection_file', connectionFile, '--session-mode', 'console', '--log', logFile],
            { cwd: cwd ?? os.homedir(), stdio: 'ignore' },
        );

        const serverOptions: ServerOptions = {
            command: consolePath,
            args: ['--lsp-stdio', '--connection-file', connectionFile],
            options: { cwd },
        };
        const clientOptions: LanguageClientOptions = {
            documentSelector: [
                { scheme: 'file', language: 'r' },
                { scheme: 'untitled', language: 'r' },
            ],
            outputChannel: output,
            middleware: {
                // Half-typed console input isn't worth a Problems entry.
                handleDiagnostics: (uri, diagnostics, next) =>
                    next(uri, uri.toString() === CONSOLE_DOC_URI ? [] : diagnostics),
            },
        };
        const client = new LanguageClient('betterR', 'betterR (ark)', serverOptions, clientOptions);
        const session = new Session(kernel, connectionFile, logFile, dir, consolePath, cwd, client, ide, ideSocket, output);

        kernel.on('exit', (code, signal) => {
            output.appendLine(`ark exited (code ${code}, signal ${signal})`);
            if (!session.disposed) {
                onUnexpectedExit(session);
            }
        });

        await client.start();
        output.appendLine('Language client connected to ark.');
        return session;
    }

    get isRunning(): boolean {
        return this.kernel.exitCode === null && this.kernel.signalCode === null;
    }

    private onIdeMessage(msg: IdeMessage): void {
        switch (msg.type) {
            case 'dap_port':
                this.dapPort = msg.port as number;
                this.syncDebugSession();
                break;
            case 'debug':
                this.paused = msg.state === 'start';
                this.syncDebugSession();
                break;
            case 'complete':
                void this.completeForConsole(msg.id as number, msg.text as string, msg.offset as number);
                break;
        }
    }

    /**
     * VS Code's debugger is attached while R is paused or while R files have
     * breakpoints (ark needs a connected client to receive them), and detached
     * otherwise so the debug toolbar only shows when it means something.
     *
     * Detaching is debounced: every step briefly leaves the browser
     * (`stop_debug` then `start_debug`), and disconnecting mid-step would make
     * ark quit the browser.
     */
    syncDebugSession(): void {
        clearTimeout(this.detachTimer);
        const wanted = () => this.dapPort !== undefined && (this.paused || hasRBreakpoints());
        if (wanted() && !this.debugSession && !this.startingDebug) {
            this.startingDebug = true;
            void vscode.debug
                .startDebugging(
                    vscode.workspace.workspaceFolders?.[0],
                    { type: 'ark', request: 'attach', name: 'R' },
                    { suppressSaveBeforeStart: true },
                )
                .then(
                    () => (this.startingDebug = false),
                    () => (this.startingDebug = false),
                );
        } else if (!wanted() && this.debugSession) {
            this.detachTimer = setTimeout(() => {
                if (!wanted() && this.debugSession) {
                    void vscode.debug.stopDebugging(this.debugSession);
                }
            }, 750);
        }
    }

    /** Console completion runs through this (the kernel's only) LSP client. */
    private async completeForConsole(id: number, text: string, offset: number): Promise<void> {
        let items: unknown = [];
        try {
            this.consoleDocVersion += 1;
            if (this.consoleDocVersion === 1) {
                await this.client.sendNotification('textDocument/didOpen', {
                    textDocument: { uri: CONSOLE_DOC_URI, languageId: 'r', version: 1, text },
                });
            } else {
                await this.client.sendNotification('textDocument/didChange', {
                    textDocument: { uri: CONSOLE_DOC_URI, version: this.consoleDocVersion },
                    contentChanges: [{ text }],
                });
            }
            const before = Buffer.from(text, 'utf8').subarray(0, offset).toString('utf8');
            const line = before.split('\n').length - 1;
            const character = before.length - (before.lastIndexOf('\n') + 1);
            items =
                (await this.client.sendRequest('textDocument/completion', {
                    textDocument: { uri: CONSOLE_DOC_URI },
                    position: { line, character },
                })) ?? [];
        } catch (err) {
            this.output.appendLine(`Console completion failed: ${err}`);
        }
        this.ide.send({ type: 'complete_reply', id, items });
    }

    /** Shows the console terminal, creating it (attached to this session) if needed. */
    openConsole(preserveFocus = false): vscode.Terminal {
        if (!this.terminal) {
            this.terminal = vscode.window.createTerminal({
                name: CONSOLE_NAME,
                shellPath: this.consolePath,
                shellArgs: ['--connection-file', this.connectionFile, '--ide-socket', this.ideSocket],
                cwd: this.cwd,
                iconPath: new vscode.ThemeIcon('terminal'),
            });
        }
        this.terminal.show(preserveFocus);
        return this.terminal;
    }

    /**
     * Runs code in the console as if typed there. With a `location`, R gets
     * srcrefs into that file, so the debugger shows the real file and
     * breakpoints set in it apply.
     */
    execute(code: string, location?: ReturnType<typeof codeLocation>): void {
        this.openConsole(true);
        this.ide.send({ type: 'execute', code, location });
    }

    /** RStudio-style Cmd+Enter: the selection, or the whole statement at the cursor. */
    async runSelection(editor: vscode.TextEditor): Promise<void> {
        const { document, selection } = editor;
        const range = selection.isEmpty
            ? ((await this.statementRange(document, selection.active)) ?? document.lineAt(selection.active.line).range)
            : new vscode.Range(selection.start, selection.end);
        const code = document.getText(range);
        if (code.trim()) {
            this.execute(code, document.uri.scheme === 'file' ? codeLocation(document, range) : undefined);
        }
        if (selection.isEmpty && range.end.line + 1 < document.lineCount) {
            const next = new vscode.Position(range.end.line + 1, 0);
            editor.selection = new vscode.Selection(next, next);
            editor.revealRange(new vscode.Range(next, next));
        }
    }

    private async statementRange(doc: vscode.TextDocument, position: vscode.Position): Promise<vscode.Range | undefined> {
        try {
            const result = await this.client.sendRequest<{ kind: string; range?: unknown }>(
                'positron/textDocument/statementRange',
                {
                    textDocument: { uri: doc.uri.toString(), version: doc.version },
                    position: { line: position.line, character: position.character },
                },
            );
            if (result?.kind === 'success' && result.range) {
                return this.client.protocol2CodeConverter.asRange(result.range as any);
            }
        } catch {
            // Fall back to the current line.
        }
        return undefined;
    }

    /** Text of an `ark:` virtual document (e.g. a function defined at the console). */
    virtualDocument(uri: vscode.Uri): Promise<string> {
        return this.client.sendRequest<string>('ark/internal/virtualDocument', {
            path: uri.path.replace(/^\//, ''),
        });
    }

    async dispose(): Promise<void> {
        if (this.disposed) {
            return;
        }
        this.disposed = true;
        clearTimeout(this.detachTimer);
        if (this.debugSession) {
            await vscode.debug.stopDebugging(this.debugSession);
        }
        this.disposables.forEach((d) => d.dispose());
        this.terminal?.dispose();
        try {
            await this.client.stop(2000);
        } catch {
            // The server may already be gone with the kernel.
        }
        if (this.isRunning) {
            const exited = new Promise((resolve) => this.kernel.once('exit', resolve));
            this.kernel.kill('SIGTERM');
            await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 3000))]);
            if (this.isRunning) {
                this.kernel.kill('SIGKILL');
            }
            fs.rmSync(this.dir, { recursive: true, force: true });
        } else {
            // Kernel died on its own: keep its log for diagnosis.
            fs.rmSync(this.connectionFile, { force: true });
            this.output.appendLine(`ark log kept at ${this.logFile}`);
        }
    }
}
