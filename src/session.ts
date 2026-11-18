import * as cp from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { LanguageClient, LanguageClientOptions, ServerOptions } from 'vscode-languageclient/node';
import { IdeChannel, IdeMessage } from './ide';
import { DataExplorers } from './dataExplorer';
import { HelpPanel } from './help';
import { HtmlServer, isLocalUrl } from './htmlServer';
import { PlotImage, PlotsPanel } from './plots';
import { ViewerPanel } from './viewer';

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

/** Setting, then env var, then PATH, then a development build in a sibling checkout. */
function resolveBinary(setting: string, envVar: string | undefined, name: string, devPath: string): string {
    const configured = vscode.workspace.getConfiguration('betteR').get<string>(setting);
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
        throw new Error(`Could not find \`${name}\`. Set betteR.${setting}.`);
    }
    return found;
}

/** Console input is mirrored into this LSP document for completion. */
const CONSOLE_DOC_URI = 'untitled:better-console';

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
    /** The current stop came from input typed in the console. */
    private keepConsoleFocus = false;
    readonly plots: PlotsPanel;
    readonly viewer = new ViewerPanel();
    readonly help = new HelpPanel();
    readonly dataExplorers: DataExplorers;
    private nextHelpId = 1;
    private readonly pendingHelp = new Map<number, (found: boolean) => void>();
    private nextRenderId = 1;
    private readonly killOnHostExit = () => {
        if (this.isRunning) {
            this.kernel.kill('SIGKILL');
        }
    };
    private readonly pendingRenders = new Map<number, { resolve: (img: PlotImage) => void; reject: (e: Error) => void }>();
    private nextRpcId = 1;
    private readonly pendingRpcs = new Map<number, { resolve: (result: unknown) => void; reject: (e: Error) => void }>();
    private readonly variablesEvents = new vscode.EventEmitter<{ method: string; params: unknown }>();
    /** ark's variables comm: `refresh` (full list) or `update` (diff) after each execution. */
    readonly onVariablesEvent = this.variablesEvents.event;
    private readonly promptStates = new vscode.EventEmitter<{ input_prompt: string; continuation_prompt: string }>();
    /** R returned to a prompt (sent after every execution). */
    readonly onPromptState = this.promptStates.event;
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
        readonly htmlServer: HtmlServer,
        private readonly output: vscode.LogOutputChannel,
    ) {
        // Backstop for an extension host that exits without deactivating us:
        // never leave an orphaned R process behind.
        process.on('exit', this.killOnHostExit);
        this.plots = new PlotsPanel({
            renderPlot: (commId, size, pixelRatio, format) => this.renderPlot(commId, size, pixelRatio, format),
            setPlotSize: (size, pixelRatio) => ide.send({ type: 'plot_settings', size, pixel_ratio: pixelRatio }),
            closePlot: (commId) => ide.send({ type: 'plot_close', comm_id: commId }),
        });
        this.dataExplorers = new DataExplorers({
            rpc: (commId, method, params) => this.commRpc({ id: commId }, method, params, 60_000),
            close: (commId) => ide.send({ type: 'comm_close', comm_id: commId }),
        });
        this.disposables.push(
            ide,
            htmlServer,
            this.plots,
            this.viewer,
            this.help,
            this.dataExplorers,
            this.variablesEvents,
            this.promptStates,
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
            vscode.debug.onDidChangeActiveStackItem((item) => {
                if (item && this.keepConsoleFocus) {
                    this.keepConsoleFocus = false;
                    this.returnFocusToConsole();
                }
            }),
        );
    }

    static async start(
        context: vscode.ExtensionContext,
        output: vscode.LogOutputChannel,
        onUnexpectedExit: (session: Session) => void,
    ): Promise<Session> {
        // `better` is the console and, in `--kernel` mode, the R kernel (ark is
        // built in). Dev layout: the betteR repo next to this one.
        const consolePath = resolveBinary(
            'consolePath',
            undefined,
            'better',
            path.join(path.resolve(context.extensionPath, '..'), 'betteR/target/debug/better'),
        );
        // Optional: a separate ark build instead of the built-in kernel.
        const arkOverride = vscode.workspace.getConfiguration('betteR').get<string>('arkPath');
        if (arkOverride && !fs.existsSync(arkOverride)) {
            throw new Error(`ark not found at ${arkOverride}`);
        }
        const [kernelCommand, kernelArgs] = arkOverride ? [arkOverride, []] : [consolePath, ['--kernel']];

        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'better-vscode-'));
        const connectionFile = path.join(dir, 'kernel.json');
        const logFile = path.join(dir, 'ark.log');
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
        const ide = await IdeChannel.listen();
        const htmlServer = await HtmlServer.start();

        const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        output.appendLine(`Starting R kernel: ${[kernelCommand, ...kernelArgs].join(' ')}`);
        output.appendLine(`Connection file: ${connectionFile}`);
        const kernel = cp.spawn(
            kernelCommand,
            [...kernelArgs, '--connection_file', connectionFile, '--session-mode', 'console', '--log', logFile],
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
        const client = new LanguageClient('betteR', 'betteR (ark)', serverOptions, clientOptions);
        const session = new Session(kernel, connectionFile, logFile, dir, consolePath, cwd, client, ide, htmlServer, output);

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
                this.keepConsoleFocus = this.paused && msg.origin === 'console';
                this.syncDebugSession();
                break;
            case 'complete':
                void this.completeForConsole(msg.id as number, msg.text as string, msg.offset as number);
                break;
            case 'signature':
                void this.signatureForConsole(msg.id as number, msg.text as string, msg.offset as number);
                break;
            case 'resolve':
                void this.resolveForConsole(msg.id as number, msg.item);
                break;
            case 'plot_open':
                this.plots.onOpen(msg.comm_id as string, msg.pre_render as PlotImage | undefined);
                break;
            case 'plot_update':
                this.plots.onUpdate(msg.comm_id as string, msg.pre_render as PlotImage | undefined);
                break;
            case 'plot_close':
                this.plots.onClose(msg.comm_id as string);
                break;
            case 'show_html_file':
                void this.showHtmlFile(msg.params as { path: string; title: string; destination: string });
                break;
            case 'show_url':
                void this.showUrl((msg.params as { url: string }).url);
                break;
            case 'show_help': {
                const params = msg.params as { content: string; kind: string };
                if (params.kind === 'url') {
                    void this.help.show(params.content);
                }
                break;
            }
            case 'help_topic_reply':
                this.pendingHelp.get(msg.id as number)?.(msg.found as boolean);
                this.pendingHelp.delete(msg.id as number);
                break;
            case 'comm_open':
                if (msg.target === 'positron.dataExplorer') {
                    const data = msg.data as { title?: string } | null;
                    this.dataExplorers.open(msg.comm_id as string, data?.title || 'Data');
                }
                break;
            case 'comm_event':
                this.dataExplorers.onEvent(msg.comm_id as string, msg.method as string);
                break;
            case 'comm_closed':
                this.dataExplorers.onClosed(msg.comm_id as string);
                break;
            case 'variables_event':
                this.variablesEvents.fire({ method: msg.method as string, params: msg.params });
                break;
            case 'prompt_state':
                this.promptStates.fire(msg.params as { input_prompt: string; continuation_prompt: string });
                break;
            case 'comm_rpc_reply': {
                const pending = this.pendingRpcs.get(msg.id as number);
                this.pendingRpcs.delete(msg.id as number);
                const error = msg.error as { message?: string } | null | undefined;
                if (error) {
                    pending?.reject(new Error(error.message ?? 'R request failed'));
                } else {
                    pending?.resolve(msg.result);
                }
                break;
            }
            case 'open_with_system':
                void vscode.env.openExternal(vscode.Uri.file((msg.params as { path: string }).path));
                break;
            case 'plot_render_reply': {
                const pending = this.pendingRenders.get(msg.id as number);
                this.pendingRenders.delete(msg.id as number);
                const result = msg.result as PlotImage | null;
                if (result?.data) {
                    pending?.resolve(result);
                } else {
                    pending?.reject(new Error((msg.error as { message?: string } | null)?.message ?? 'Plot render failed'));
                }
                break;
            }
        }
    }

    /**
     * An HTML file from R: an htmlwidget (plotly, leaflet, DT, ...) or `viewer`
     * output. Plot-like widgets join the plot history; the rest go to the Viewer.
     */
    private async showHtmlFile(params: { path: string; title: string; destination: string }): Promise<void> {
        const url = (await vscode.env.asExternalUri(vscode.Uri.parse(this.htmlServer.register(params.path)))).toString(true);
        if (params.destination === 'plot') {
            this.plots.onHtml(url, params.title);
        } else {
            this.viewer.show(url, params.title);
        }
    }

    /** A URL from R (`browseURL()`, Shiny): local apps in the Viewer, the rest in the browser. */
    private async showUrl(url: string): Promise<void> {
        if (isLocalUrl(url)) {
            const external = (await vscode.env.asExternalUri(vscode.Uri.parse(url))).toString(true);
            this.viewer.show(external, new URL(url).host);
        } else {
            await vscode.env.openExternal(vscode.Uri.parse(url));
        }
    }

    /**
     * Help for the symbol at `position` (F1), like RStudio: ark's LSP picks the
     * topic (e.g. `dplyr::filter`), ark's help shows it. Returns the topic, or
     * undefined if there's no help for it.
     */
    async helpAt(doc: vscode.TextDocument, position: vscode.Position): Promise<string | undefined> {
        const result = await this.client.sendRequest<{ topic: string } | null>('positron/textDocument/helpTopic', {
            textDocument: { uri: doc.uri.toString(), version: doc.version },
            position: { line: position.line, character: position.character },
        });
        const topic = result?.topic;
        if (!topic) {
            return undefined;
        }
        const id = this.nextHelpId++;
        const found = await new Promise<boolean>((resolve) => {
            const timer = setTimeout(() => (this.pendingHelp.delete(id), resolve(false)), 10_000);
            this.pendingHelp.set(id, (ok) => (clearTimeout(timer), resolve(ok)));
            this.ide.send({ type: 'help_topic', id, topic });
        });
        return found ? topic : undefined;
    }

    /** Asks ark (via the console) to render a plot at a given size and format. */
    renderPlot(
        commId: string,
        size: { width: number; height: number },
        pixelRatio: number,
        format: 'png' | 'svg',
    ): Promise<PlotImage> {
        const id = this.nextRenderId++;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pendingRenders.delete(id);
                reject(new Error('Plot render timed out'));
            }, 15_000);
            this.pendingRenders.set(id, {
                resolve: (img) => (clearTimeout(timer), resolve(img)),
                reject: (err) => (clearTimeout(timer), reject(err)),
            });
            this.ide.send({
                type: 'plot_render',
                id,
                comm_id: commId,
                size: { width: size.width, height: size.height },
                pixel_ratio: pixelRatio,
                format,
            });
        });
    }

    /**
     * A JSON-RPC request on one of ark's comms held by the console: the
     * variables comm (`list`, `inspect`, `delete`, `clear`, `view`), the UI
     * comm (`evaluate_code`) or a data explorer (`{ id }`). Answered once R is idle.
     */
    commRpc<T = unknown>(
        comm: 'variables' | 'ui' | { id: string },
        method: string,
        params?: object,
        timeoutMs = 15_000,
    ): Promise<T> {
        const id = this.nextRpcId++;
        return new Promise<T>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pendingRpcs.delete(id);
                reject(new Error(`R did not answer \`${method}\` (busy?)`));
            }, timeoutMs);
            this.pendingRpcs.set(id, {
                resolve: (result) => (clearTimeout(timer), resolve(result as T)),
                reject: (err) => (clearTimeout(timer), reject(err)),
            });
            const target = typeof comm === 'string' ? { comm } : { comm_id: comm.id };
            this.ide.send({ type: 'comm_rpc', id, ...target, method, params });
        });
    }

    /** Evaluates R code silently in the global env (no console echo) and returns its value as JSON. */
    async evaluate<T = unknown>(code: string): Promise<T> {
        const reply = await this.commRpc<{ result: T }>('ui', 'evaluate_code', { code });
        return reply.result;
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
                    // The R terminal is the debug console; keep VS Code's from replacing it.
                    { type: 'ark', request: 'attach', name: 'R', internalConsoleOptions: 'neverOpen' },
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

    /**
     * VS Code focuses the editor when it shows a stopped frame. That's right
     * for steps clicked in the toolbar, but when you're stepping by typing in
     * the console, focus should stay there. The frame is selected (line
     * highlighted) first, then the editor opens, so hand focus back once it has.
     */
    private returnFocusToConsole(): void {
        const done = () => {
            clearTimeout(fallback);
            listener.dispose();
            setTimeout(() => this.terminal?.show(false), 50);
        };
        const listener = vscode.window.onDidChangeTextEditorSelection(done);
        const fallback = setTimeout(done, 500);
    }

    /**
     * Console completion and signature help run through this (the kernel's
     * only) LSP client, against a document mirroring the console's input.
     * Returns the LSP position of byte `offset` in `text`.
     */
    private async syncConsoleDoc(text: string, offset: number): Promise<{ line: number; character: number }> {
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
        return { line: before.split('\n').length - 1, character: before.length - (before.lastIndexOf('\n') + 1) };
    }

    private async completeForConsole(id: number, text: string, offset: number): Promise<void> {
        let items: unknown = [];
        try {
            const position = await this.syncConsoleDoc(text, offset);
            items = (await this.client.sendRequest('textDocument/completion', { textDocument: { uri: CONSOLE_DOC_URI }, position })) ?? [];
        } catch (err) {
            this.output.appendLine(`Console completion failed: ${err}`);
        }
        this.ide.send({ type: 'complete_reply', id, items });
    }

    /** Help for the completion the console has selected (`completionItem/resolve`), shown beside its menu. */
    private async resolveForConsole(id: number, item: unknown): Promise<void> {
        let resolved = item;
        try {
            resolved = (await this.client.sendRequest('completionItem/resolve', item)) ?? item;
        } catch (err) {
            this.output.appendLine(`Console completion help failed: ${err}`);
        }
        this.ide.send({ type: 'resolve_reply', id, item: resolved });
    }

    /** The signature of the call around the console's cursor, shown under its input. */
    private async signatureForConsole(id: number, text: string, offset: number): Promise<void> {
        let help: unknown = null;
        try {
            const position = await this.syncConsoleDoc(text, offset);
            help = (await this.client.sendRequest('textDocument/signatureHelp', { textDocument: { uri: CONSOLE_DOC_URI }, position })) ?? null;
        } catch (err) {
            this.output.appendLine(`Console signature help failed: ${err}`);
        }
        this.ide.send({ type: 'signature_reply', id, help });
    }

    /** Shows the console terminal, creating it (attached to this session) if needed. */
    openConsole(preserveFocus = false): vscode.Terminal {
        if (!this.terminal) {
            this.terminal = vscode.window.createTerminal({
                name: CONSOLE_NAME,
                shellPath: this.consolePath,
                shellArgs: ['--connection-file', this.connectionFile, '--ide', String(this.ide.port)],
                // In the environment, not argv: other users can see process arguments.
                env: { BETTER_IDE_TOKEN: this.ide.token },
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
        // Stop R first: VS Code allows deactivation very little time, and
        // nothing else here may get to run before the extension host exits.
        const crashed = !this.isRunning;
        const exited = crashed ? Promise.resolve() : new Promise((resolve) => this.kernel.once('exit', resolve));
        if (!crashed) {
            this.kernel.kill('SIGTERM');
        }
        if (this.debugSession) {
            void vscode.debug.stopDebugging(this.debugSession);
        }
        this.disposables.forEach((d) => d.dispose());
        this.terminal?.dispose();
        try {
            await this.client.stop(2000);
        } catch {
            // The server goes away with the kernel.
        }
        await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 3000))]);
        if (this.isRunning) {
            this.kernel.kill('SIGKILL');
        }
        process.off('exit', this.killOnHostExit);
        if (crashed) {
            // Kernel died on its own: keep its log for diagnosis.
            fs.rmSync(this.connectionFile, { force: true });
            this.output.appendLine(`ark log kept at ${this.logFile}`);
        } else {
            fs.rmSync(this.dir, { recursive: true, force: true });
        }
    }
}
