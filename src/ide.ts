import * as crypto from 'crypto';
import * as net from 'net';
import * as vscode from 'vscode';

/** A message on the console channel (JSON lines over loopback TCP). */
export type IdeMessage = { type: string; [key: string]: unknown };

/** A connection that hasn't sent a valid `hello` by then is dropped. */
const HELLO_TIMEOUT_MS = 10_000;
/** Longest `hello` line accepted; anything longer is not the console. */
const HELLO_MAX_BYTES = 4096;

/**
 * Server end of the channel to the terminal console (`better --ide <port>`).
 *
 * Any local user can connect to a loopback port, so the console proves itself
 * with a token it gets in `BETTER_IDE_TOKEN`: its first line must be
 * `{"type":"hello","token":"…"}`. Other connections are closed without ever
 * becoming the console.
 *
 * Messages sent while no console is connected are queued and delivered when
 * one connects, so Run Selection works while the console is still starting.
 */
export class IdeChannel implements vscode.Disposable {
    private socket: net.Socket | undefined;
    private readonly outbox: string[] = [];
    private readonly messages = new vscode.EventEmitter<IdeMessage>();
    readonly onMessage = this.messages.event;
    /** Pass to the console as `BETTER_IDE_TOKEN`, never on its command line. */
    readonly token = crypto.randomBytes(16).toString('hex');

    private constructor(
        private readonly server: net.Server,
        /** Pass to the console as `--ide <port>`. */
        readonly port: number,
    ) {}

    static listen(): Promise<IdeChannel> {
        return new Promise((resolve, reject) => {
            const server = net.createServer();
            server.once('error', reject);
            server.listen(0, '127.0.0.1', () => {
                const channel = new IdeChannel(server, (server.address() as net.AddressInfo).port);
                server.on('connection', (socket) => channel.handshake(socket));
                resolve(channel);
            });
        });
    }

    /** Waits for the connection's `hello`; only a matching token makes it the console. */
    private handshake(socket: net.Socket): void {
        socket.setNoDelay(true);
        socket.setEncoding('utf8');
        socket.on('error', () => socket.destroy());
        const timer = setTimeout(() => socket.destroy(), HELLO_TIMEOUT_MS);
        socket.once('close', () => clearTimeout(timer));
        let pending = '';
        const onData = (chunk: string) => {
            pending += chunk;
            const newline = pending.indexOf('\n');
            if (newline < 0) {
                if (pending.length > HELLO_MAX_BYTES) {
                    socket.destroy();
                }
                return;
            }
            socket.off('data', onData);
            clearTimeout(timer);
            if (!this.isValidHello(pending.slice(0, newline))) {
                socket.destroy();
                return;
            }
            this.attach(socket, pending.slice(newline + 1));
        };
        socket.on('data', onData);
    }

    private isValidHello(line: string): boolean {
        let msg: unknown;
        try {
            msg = JSON.parse(line);
        } catch {
            return false;
        }
        const token = (msg as { type?: unknown; token?: unknown } | null)?.token;
        if ((msg as { type?: unknown } | null)?.type !== 'hello' || typeof token !== 'string') {
            return false;
        }
        const given = Buffer.from(token, 'utf8');
        const expected = Buffer.from(this.token, 'utf8');
        return given.length === expected.length && crypto.timingSafeEqual(given, expected);
    }

    /** Makes an authenticated socket the console. `pending` is what followed its `hello`. */
    private attach(socket: net.Socket, pending: string): void {
        // One console at a time; a reopened console replaces the old one.
        this.socket?.destroy();
        this.socket = socket;
        const onData = (chunk: string) => {
            pending += chunk;
            let newline: number;
            while ((newline = pending.indexOf('\n')) >= 0) {
                const line = pending.slice(0, newline).trim();
                pending = pending.slice(newline + 1);
                if (line) {
                    try {
                        this.messages.fire(JSON.parse(line));
                    } catch {
                        // Ignore malformed lines.
                    }
                }
            }
        };
        socket.on('data', onData);
        socket.on('close', () => {
            if (this.socket === socket) {
                this.socket = undefined;
            }
        });
        onData('');
        for (const line of this.outbox.splice(0)) {
            socket.write(line);
        }
    }

    send(message: IdeMessage): void {
        const line = JSON.stringify(message) + '\n';
        if (this.socket) {
            this.socket.write(line);
        } else {
            this.outbox.push(line);
        }
    }

    dispose(): void {
        this.socket?.destroy();
        this.server.close();
        this.messages.dispose();
    }
}
