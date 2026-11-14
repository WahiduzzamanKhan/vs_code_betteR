import * as cp from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { LanguageClient, LanguageClientOptions, ServerOptions } from 'vscode-languageclient/node';

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

/**
 * One ark kernel shared by every view: the extension owns the process and its
 * connection file; the editor's language client and the terminal console both
 * attach to it.
 */
export class Session implements vscode.Disposable {
    terminal: vscode.Terminal | undefined;
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
        private readonly output: vscode.LogOutputChannel,
    ) {
        this.disposables.push(
            vscode.window.onDidCloseTerminal((t) => {
                if (t === this.terminal) {
                    this.terminal = undefined;
                }
            }),
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
        };
        const client = new LanguageClient('betterR', 'betterR (ark)', serverOptions, clientOptions);
        const session = new Session(kernel, connectionFile, logFile, dir, consolePath, cwd, client, output);

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

    /** Shows the console terminal, creating it (attached to this session) if needed. */
    openConsole(preserveFocus = false): vscode.Terminal {
        if (!this.terminal) {
            this.terminal = vscode.window.createTerminal({
                name: CONSOLE_NAME,
                shellPath: this.consolePath,
                shellArgs: ['--connection-file', this.connectionFile],
                cwd: this.cwd,
                iconPath: new vscode.ThemeIcon('terminal'),
            });
        }
        this.terminal.show(preserveFocus);
        return this.terminal;
    }

    /** Types code into the console as a bracketed paste, then submits it. */
    sendToConsole(code: string): void {
        const terminal = this.openConsole(true);
        const text = code.replace(/\r\n/g, '\n').replace(/\n+$/, '');
        if (text.includes('\n')) {
            terminal.sendText(`\x1b[200~${text}\x1b[201~`, false);
        } else {
            terminal.sendText(text, false);
        }
        terminal.sendText('\r', false);
    }

    async dispose(): Promise<void> {
        if (this.disposed) {
            return;
        }
        this.disposed = true;
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
