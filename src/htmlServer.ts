import * as crypto from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import * as vscode from 'vscode';

const MIME: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.htm': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.wasm': 'application/wasm',
};

/**
 * Serves the HTML files R hands us (htmlwidgets, `viewer` output) over
 * localhost so webviews can show them live, with their sibling `lib/` or
 * `*_files/` dependencies. Only directories explicitly registered are served,
 * each under an unguessable token.
 */
export class HtmlServer implements vscode.Disposable {
    private readonly roots = new Map<string, string>();
    /** Paths requested so far (tests use this to see that pages really ran). */
    readonly requests: string[] = [];

    private constructor(
        private readonly server: http.Server,
        readonly port: number,
    ) {}

    static start(): Promise<HtmlServer> {
        return new Promise((resolve, reject) => {
            const server = http.createServer();
            server.once('error', reject);
            server.listen(0, '127.0.0.1', () => {
                const html = new HtmlServer(server, (server.address() as { port: number }).port);
                server.on('request', (req, res) => html.serve(req, res));
                resolve(html);
            });
        });
    }

    /** Returns a URL that serves `file`, and the files next to it. */
    register(file: string): string {
        const resolved = path.resolve(file);
        const token = crypto.randomBytes(12).toString('hex');
        this.roots.set(token, path.dirname(resolved));
        return `http://127.0.0.1:${this.port}/${token}/${encodeURIComponent(path.basename(resolved))}`;
    }

    private serve(req: http.IncomingMessage, res: http.ServerResponse): void {
        const url = new URL(req.url ?? '/', 'http://localhost');
        this.requests.push(url.pathname);
        const [, token, ...rest] = url.pathname.split('/');
        const root = this.roots.get(token);
        const file = root && path.resolve(root, decodeURIComponent(rest.join('/')));
        if (!root || !file || (file !== root && !file.startsWith(root + path.sep))) {
            res.writeHead(404).end();
            return;
        }
        fs.readFile(file, (err, data) => {
            if (err) {
                res.writeHead(404).end();
                return;
            }
            res.writeHead(200, {
                'Content-Type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
                'Cache-Control': 'no-store',
            });
            res.end(data);
        });
    }

    dispose(): void {
        this.server.close();
    }
}

/** True for URLs served from this machine (Shiny, plumber, our own server). */
export function isLocalUrl(url: string): boolean {
    try {
        const host = new URL(url).hostname;
        return host === '127.0.0.1' || host === 'localhost' || host === '[::1]' || host === '::1';
    } catch {
        return false;
    }
}

/** Builds a webview page whose main area is an iframe for local web content. */
export function iframeCsp(nonce: string): string {
    return (
        `default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; ` +
        `frame-src http://127.0.0.1:* http://localhost:*;`
    );
}

/** Tells the embedding panel which page is showing (for history and title). */
const NAV_SCRIPT =
    '<script>parent.postMessage({ type: "betteR-nav", url: location.href, title: document.title }, "*");</script>';

/**
 * A localhost relay in front of another local server (ark's help proxy). It
 * keeps paths unchanged, so absolute links like `/doc/html/R.css` still work,
 * and adds one script to HTML pages that reports navigations to the panel:
 * the page is a cross-origin iframe, so the panel can't observe them itself.
 */
export class NavProxy implements vscode.Disposable {
    private constructor(
        private readonly server: http.Server,
        readonly target: URL,
        readonly port: number,
    ) {}

    static start(target: string): Promise<NavProxy> {
        const origin = new URL(target);
        return new Promise((resolve, reject) => {
            const server = http.createServer((req, res) => {
                const upstream = http.request(
                    { host: origin.hostname, port: origin.port, path: req.url, method: req.method, headers: { ...req.headers, host: origin.host } },
                    (up) => {
                        const isHtml = /text\/html/i.test(String(up.headers['content-type'] ?? ''));
                        if (!isHtml) {
                            res.writeHead(up.statusCode ?? 502, up.headers);
                            up.pipe(res);
                            return;
                        }
                        const chunks: Buffer[] = [];
                        up.on('data', (c: Buffer) => chunks.push(c));
                        up.on('end', () => {
                            const headers = { ...up.headers };
                            delete headers['content-length'];
                            delete headers['content-encoding'];
                            res.writeHead(up.statusCode ?? 200, headers);
                            res.end(Buffer.concat(chunks).toString('utf8') + NAV_SCRIPT);
                        });
                    },
                );
                upstream.on('error', () => res.writeHead(502).end());
                req.pipe(upstream);
            });
            server.once('error', reject);
            server.listen(0, '127.0.0.1', () =>
                resolve(new NavProxy(server, origin, (server.address() as { port: number }).port)),
            );
        });
    }

    /** The relay's address for a URL on the target server. */
    map(url: string): string {
        const u = new URL(url);
        return `http://127.0.0.1:${this.port}${u.pathname}${u.search}${u.hash}`;
    }

    dispose(): void {
        this.server.close();
    }
}
