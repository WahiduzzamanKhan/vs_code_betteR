import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { iframeCsp, NavProxy } from './htmlServer';

/**
 * The "R Help" panel: R's HTML help (`?topic`, `help()`, `??search`, package
 * indexes) from ark's help server, with Back/Forward across both requested
 * pages and links followed inside the panel.
 */
export class HelpPanel implements vscode.Disposable {
    readonly history: string[] = [];
    index = -1;
    title = '';
    private proxy: NavProxy | undefined;
    private panel: vscode.WebviewPanel | undefined;
    /** Navigation started by Back/Forward, so the next report isn't a new entry. */
    private traversing = false;

    get current(): string | undefined {
        return this.history[this.index];
    }

    get isVisible(): boolean {
        return !!this.panel?.visible;
    }

    /** Shows a help URL from ark (on its local help server). */
    async show(url: string): Promise<void> {
        const origin = new URL(url).origin;
        if (this.proxy?.target.origin !== origin) {
            this.proxy?.dispose();
            this.proxy = await NavProxy.start(origin);
        }
        const mapped = (await vscode.env.asExternalUri(vscode.Uri.parse(this.proxy.map(url)))).toString(true);
        this.push(mapped);
        this.open();
        this.post(true);
    }

    back(): void {
        this.go(this.index - 1);
    }

    forward(): void {
        this.go(this.index + 1);
    }

    private go(i: number): void {
        if (i >= 0 && i < this.history.length) {
            this.index = i;
            this.traversing = true;
            this.post(true);
        }
    }

    private push(url: string): void {
        if (this.current === url) {
            return;
        }
        this.history.splice(this.index + 1);
        this.history.push(url);
        this.index = this.history.length - 1;
    }

    /** A page finished loading in the panel (a requested page or a followed link). */
    private onNavigated(url: string, title: string): void {
        this.title = title;
        if (this.traversing) {
            this.traversing = false;
        } else {
            this.push(url);
        }
        this.post(false);
    }

    private open(): void {
        if (this.panel) {
            if (!this.panel.visible) {
                this.panel.reveal(undefined, true);
            }
            return;
        }
        this.panel = vscode.window.createWebviewPanel(
            'betteR.help',
            'R Help',
            { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
            { enableScripts: true, retainContextWhenHidden: true },
        );
        this.panel.webview.html = this.html();
        this.panel.webview.onDidReceiveMessage((msg: { type: string; url?: string; title?: string }) => {
            switch (msg.type) {
                case 'ready':
                    this.post(true);
                    break;
                case 'nav':
                    this.onNavigated(msg.url!, msg.title ?? '');
                    break;
                case 'back':
                    this.back();
                    break;
                case 'forward':
                    this.forward();
                    break;
                case 'browser':
                    if (this.current) {
                        void vscode.env.openExternal(vscode.Uri.parse(this.current));
                    }
                    break;
            }
        });
        this.panel.onDidDispose(() => (this.panel = undefined));
    }

    /** Updates the toolbar; with `load`, also points the iframe at the current page. */
    private post(load: boolean): void {
        void this.panel?.webview.postMessage({
            type: 'state',
            url: load ? this.current : undefined,
            title: this.title,
            canBack: this.index > 0,
            canForward: this.index < this.history.length - 1,
        });
    }

    private html(): string {
        const nonce = crypto.randomBytes(16).toString('base64');
        return `<!DOCTYPE html>
<html><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${iframeCsp(nonce)}">
<style>
  html, body { height: 100%; margin: 0; overflow: hidden; color: var(--vscode-foreground); font-family: var(--vscode-font-family); }
  body { display: flex; flex-direction: column; }
  .bar { display: flex; gap: 4px; align-items: center; padding: 4px 6px; border-bottom: 1px solid var(--vscode-panel-border); }
  button { background: none; color: inherit; border: 1px solid transparent; border-radius: 3px; padding: 2px 8px; cursor: pointer; }
  button:hover:not(:disabled) { background: var(--vscode-toolbar-hoverBackground); }
  button:disabled { opacity: .4; cursor: default; }
  #title { flex: 1; opacity: .8; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  iframe { flex: 1; border: 0; width: 100%; background: white; }
</style></head>
<body>
  <div class="bar">
    <button id="back" title="Back" disabled>&#9664;</button>
    <button id="forward" title="Forward" disabled>&#9654;</button>
    <span id="title"></span>
    <button id="browser" title="Open in your browser">Open in Browser</button>
  </div>
  <iframe id="frame"></iframe>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const frame = document.getElementById('frame');
  for (const id of ['back', 'forward', 'browser']) {
    document.getElementById(id).onclick = () => vscode.postMessage({ type: id });
  }
  window.addEventListener('message', ({ data, source }) => {
    if (source === frame.contentWindow && data && data.type === 'betteR-nav') {
      vscode.postMessage({ type: 'nav', url: data.url, title: data.title });
      return;
    }
    if (data.type !== 'state') return;
    document.getElementById('back').disabled = !data.canBack;
    document.getElementById('forward').disabled = !data.canForward;
    document.getElementById('title').textContent = data.title;
    if (data.url) frame.src = data.url;
  });
  vscode.postMessage({ type: 'ready' });
</script>
</body></html>`;
    }

    dispose(): void {
        this.panel?.dispose();
        this.proxy?.dispose();
    }
}
