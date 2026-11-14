import * as net from 'net';
import * as vscode from 'vscode';

type DapMessage = { type: string; command?: string; event?: string; body?: any; [key: string]: unknown };

/**
 * In-process debug adapter that forwards DAP between VS Code and ark's DAP
 * server (TCP). ark doesn't replay `stopped` to a client that attaches while R
 * is already paused at a browser prompt, so the bridge announces it once the
 * attach handshake completes.
 */
export class ArkDapBridge implements vscode.DebugAdapter {
    private readonly emitter = new vscode.EventEmitter<vscode.DebugProtocolMessage>();
    readonly onDidSendMessage = this.emitter.event;
    private readonly socket: net.Socket;
    private buffer = Buffer.alloc(0);
    private threadId = 1;
    private attached = false;
    private configured = false;
    private announced = false;

    constructor(port: number, private readonly isPaused: () => boolean) {
        this.socket = net.connect(port, '127.0.0.1');
        this.socket.on('data', (data) => this.receive(data));
        this.socket.on('error', () => this.socket.destroy());
        this.socket.on('close', () => this.emit({ type: 'event', event: 'terminated', body: {} }));
    }

    handleMessage(message: vscode.DebugProtocolMessage): void {
        const body = Buffer.from(JSON.stringify(message), 'utf8');
        this.socket.write(`Content-Length: ${body.length}\r\n\r\n`);
        this.socket.write(body);
    }

    private receive(data: Buffer): void {
        this.buffer = Buffer.concat([this.buffer, data]);
        for (;;) {
            const headerEnd = this.buffer.indexOf('\r\n\r\n');
            if (headerEnd < 0) {
                return;
            }
            const match = /Content-Length:\s*(\d+)/i.exec(this.buffer.subarray(0, headerEnd).toString('ascii'));
            const length = match ? Number(match[1]) : 0;
            const start = headerEnd + 4;
            if (this.buffer.length < start + length) {
                return;
            }
            const message = JSON.parse(this.buffer.subarray(start, start + length).toString('utf8')) as DapMessage;
            this.buffer = this.buffer.subarray(start + length);
            this.forward(message);
        }
    }

    private forward(message: DapMessage): void {
        if (message.type === 'event' && message.event === 'thread' && message.body?.threadId) {
            this.threadId = message.body.threadId;
        }
        this.emit(message);
        if (message.type === 'response' && message.command === 'attach') {
            this.attached = true;
        }
        if (message.type === 'response' && message.command === 'configurationDone') {
            this.configured = true;
        }
        if (this.attached && this.configured && !this.announced) {
            this.announced = true;
            if (this.isPaused()) {
                this.emit({
                    type: 'event',
                    event: 'stopped',
                    body: { reason: 'step', threadId: this.threadId, allThreadsStopped: true },
                });
            }
        }
    }

    private emit(message: DapMessage): void {
        this.emitter.fire({ seq: 0, ...message } as vscode.DebugProtocolMessage);
    }

    dispose(): void {
        this.socket.destroy();
        this.emitter.dispose();
    }
}
