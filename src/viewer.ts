import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { iframeCsp } from './htmlServer';

/**
 * The "R Viewer" panel: live web content from the session, e.g. DT tables and
 * other htmlwidgets that aren't plots, `viewer` output, and local web apps
 * such as Shiny. It shows the latest item in an iframe.
 */
export class ViewerPanel implements vscode.Disposable {
    url: string | undefined;
    title = 'R Viewer';
    private panel: vscode.WebviewPanel | undefined;

    get isVisible(): boolean {
        return !!this.panel?.visible;
    }

    show(url: string, title: string): void {
        this.url = url;
        this.title = title || 'R Viewer';
        if (!this.panel) {
            this.panel = vscode.window.createWebviewPanel(
                'betteR.viewer',
                'R Viewer',
                { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
                { enableScripts: true, retainContextWhenHidden: true },
            );
            this.panel.webview.html = this.html();
            this.panel.webview.onDidReceiveMessage((msg: { type: string }) => {
                if (msg.type === 'ready') {
                    this.post();
                } else if (msg.type === 'browser' && this.url) {
                    void vscode.env.openExternal(vscode.Uri.parse(this.url));
                }
            });
            this.panel.onDidDispose(() => (this.panel = undefined));
        } else if (!this.panel.visible) {
            this.panel.reveal(undefined, true);
        }
        this.post();
    }

    private post(): void {
        void this.panel?.webview.postMessage({ type: 'show', url: this.url, title: this.title });
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
  button:hover { background: var(--vscode-toolbar-hoverBackground); }
  #title { flex: 1; opacity: .8; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  iframe { flex: 1; border: 0; width: 100%; background: white; }
</style></head>
<body>
  <div class="bar">
    <span id="title"></span>
    <button id="reload" title="Reload">Reload</button>
    <button id="browser" title="Open in your browser">Open in Browser</button>
  </div>
  <iframe id="frame"></iframe>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const frame = document.getElementById('frame');
  document.getElementById('reload').onclick = () => { frame.src = frame.src; };
  document.getElementById('browser').onclick = () => vscode.postMessage({ type: 'browser' });
  window.addEventListener('message', ({ data }) => {
    if (data.type !== 'show' || !data.url) return;
    document.getElementById('title').textContent = data.title;
    frame.src = data.url;
  });
  vscode.postMessage({ type: 'ready' });
</script>
</body></html>`;
    }

    dispose(): void {
        this.panel?.dispose();
    }
}
