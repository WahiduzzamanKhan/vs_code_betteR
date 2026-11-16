import * as fs from 'fs';
import * as net from 'net';
import * as vscode from 'vscode';

/** A message on the console channel (JSON lines over a Unix socket). */
export type IdeMessage = { type: string; [key: string]: unknown };

/**
 * Server end of the channel to the terminal console (`better --ide-socket`).
 * Messages sent while no console is connected are queued and delivered when
 * one connects, so Run Selection works while the console is still starting.
 */
export class IdeChannel implements vscode.Disposable {
    private socket: net.Socket | undefined;
    private readonly outbox: string[] = [];
    private readonly messages = new vscode.EventEmitter<IdeMessage>();
    readonly onMessage = this.messages.event;

    private constructor(private readonly server: net.Server) {}

    static listen(path: string): Promise<IdeChannel> {
        fs.rmSync(path, { force: true });
        return new Promise((resolve, reject) => {
            const server = net.createServer();
            const channel = new IdeChannel(server);
            server.on('connection', (socket) => channel.attach(socket));
            server.once('error', reject);
            server.listen(path, () => resolve(channel));
        });
    }

    private attach(socket: net.Socket): void {
        // One console at a time; a reopened console replaces the old one.
        this.socket?.destroy();
        this.socket = socket;
        socket.setEncoding('utf8');
        let pending = '';
        socket.on('data', (chunk: string) => {
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
        });
        socket.on('close', () => {
            if (this.socket === socket) {
                this.socket = undefined;
            }
        });
        socket.on('error', () => socket.destroy());
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
