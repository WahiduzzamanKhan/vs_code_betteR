import * as crypto from 'crypto';
import * as fs from 'fs';
import * as vscode from 'vscode';

export interface PlotImage {
    data: string;
    mime_type: string;
    settings?: { size: { width: number; height: number }; pixel_ratio: number };
}

export interface PlotHost {
    renderPlot(commId: string, size: { width: number; height: number }, pixelRatio: number, format: 'png' | 'svg'): Promise<PlotImage>;
    setPlotSize(size: { width: number; height: number }, pixelRatio: number): void;
    closePlot(commId: string): void;
}

interface PlotEntry {
    commId: string;
    image?: PlotImage;
}

interface Viewport {
    width: number;
    height: number;
    ratio: number;
}

/**
 * The "R Plots" panel: plot history from the live session, each plot
 * re-rendered by ark at the panel's exact size and pixel ratio (no httpgd).
 */
export class PlotsPanel implements vscode.Disposable {
    readonly plots: PlotEntry[] = [];
    index = -1;
    private panel: vscode.WebviewPanel | undefined;
    private viewport: Viewport | undefined;
    private renderSeq = 0;

    constructor(private readonly host: PlotHost) {}

    get current(): PlotEntry | undefined {
        return this.plots[this.index];
    }

    get isVisible(): boolean {
        return !!this.panel?.visible;
    }

    onOpen(commId: string, preRender: PlotImage | undefined): void {
        this.plots.push({ commId, image: preRender ?? undefined });
        this.index = this.plots.length - 1;
        this.show();
        void this.refresh();
    }

    onUpdate(commId: string, preRender: PlotImage | undefined): void {
        const i = this.plots.findIndex((p) => p.commId === commId);
        if (i < 0) {
            return;
        }
        if (preRender) {
            this.plots[i].image = preRender;
        }
        // A plot that changes (e.g. `lines()` after `plot()`) comes to the front.
        this.index = i;
        this.show();
        void this.refresh();
    }

    onClose(commId: string): void {
        const i = this.plots.findIndex((p) => p.commId === commId);
        if (i >= 0) {
            this.plots.splice(i, 1);
            this.index = Math.min(this.index, this.plots.length - 1);
            void this.refresh();
        }
    }

    showIndex(i: number): void {
        if (i >= 0 && i < this.plots.length) {
            this.index = i;
            void this.refresh();
        }
    }

    removeCurrent(): void {
        const entry = this.current;
        if (entry) {
            this.host.closePlot(entry.commId);
            this.onClose(entry.commId);
        }
    }

    show(): void {
        if (this.panel) {
            if (!this.panel.visible) {
                this.panel.reveal(undefined, true);
            }
            return;
        }
        this.panel = vscode.window.createWebviewPanel(
            'betterR.plots',
            'R Plots',
            { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
            { enableScripts: true, retainContextWhenHidden: true },
        );
        this.panel.webview.html = this.html();
        this.panel.webview.onDidReceiveMessage((msg) => this.onMessage(msg));
        this.panel.onDidDispose(() => {
            this.panel = undefined;
            this.viewport = undefined;
        });
    }

    private onMessage(msg: { type: string; width?: number; height?: number; ratio?: number }): void {
        switch (msg.type) {
            case 'ready':
                this.post();
                break;
            case 'resize':
                if (msg.width && msg.height && msg.width > 10 && msg.height > 10) {
                    this.viewport = { width: Math.round(msg.width), height: Math.round(msg.height), ratio: msg.ratio ?? 1 };
                    this.host.setPlotSize({ width: this.viewport.width, height: this.viewport.height }, this.viewport.ratio);
                    void this.refresh();
                }
                break;
            case 'prev':
                this.showIndex(this.index - 1);
                break;
            case 'next':
                this.showIndex(this.index + 1);
                break;
            case 'remove':
                this.removeCurrent();
                break;
            case 'save':
                void this.save();
                break;
        }
    }

    /** Shows the current plot now, then swaps in a render at the panel's size. */
    private async refresh(): Promise<void> {
        this.post();
        const entry = this.current;
        const viewport = this.viewport;
        if (!entry || !viewport) {
            return;
        }
        const size = entry.image?.settings?.size;
        if (size?.width === viewport.width && size?.height === viewport.height && entry.image?.settings?.pixel_ratio === viewport.ratio) {
            return;
        }
        const seq = ++this.renderSeq;
        try {
            const image = await this.host.renderPlot(entry.commId, viewport, viewport.ratio, 'png');
            entry.image = image;
            if (seq === this.renderSeq && entry === this.current) {
                this.post();
            }
        } catch {
            // Keep the pre-render; e.g. the plot was closed meanwhile.
        }
    }

    private post(): void {
        const entry = this.current;
        void this.panel?.webview.postMessage({
            type: 'plot',
            src: entry?.image ? `data:${entry.image.mime_type};base64,${entry.image.data}` : undefined,
            index: this.index,
            count: this.plots.length,
        });
    }

    private async save(): Promise<void> {
        const entry = this.current;
        if (!entry) {
            return;
        }
        const target = await vscode.window.showSaveDialog({
            filters: { 'PNG image': ['png'], 'SVG image': ['svg'] },
            saveLabel: 'Save Plot',
        });
        if (!target) {
            return;
        }
        const format = target.fsPath.toLowerCase().endsWith('.svg') ? 'svg' : 'png';
        const size = this.viewport ?? { width: 800, height: 600, ratio: 1 };
        const image = await this.host.renderPlot(entry.commId, size, format === 'png' ? 2 : 1, format);
        fs.writeFileSync(target.fsPath, Buffer.from(image.data, 'base64'));
    }

    private html(): string {
        const nonce = crypto.randomBytes(16).toString('base64');
        return `<!DOCTYPE html>
<html><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  html, body { height: 100%; margin: 0; overflow: hidden; color: var(--vscode-foreground); font-family: var(--vscode-font-family); }
  body { display: flex; flex-direction: column; }
  .bar { display: flex; gap: 4px; align-items: center; padding: 4px 6px; border-bottom: 1px solid var(--vscode-panel-border); }
  button { background: none; color: inherit; border: 1px solid transparent; border-radius: 3px; padding: 2px 8px; cursor: pointer; }
  button:hover:not(:disabled) { background: var(--vscode-toolbar-hoverBackground); }
  button:disabled { opacity: .4; cursor: default; }
  #count { margin: 0 6px; opacity: .8; font-variant-numeric: tabular-nums; }
  .spacer { flex: 1; }
  #view { flex: 1; min-height: 0; display: flex; align-items: center; justify-content: center; }
  #plot { max-width: 100%; max-height: 100%; }
  #empty { opacity: .6; }
</style></head>
<body>
  <div class="bar">
    <button id="prev" title="Previous plot">&#9664;</button>
    <span id="count">0 / 0</span>
    <button id="next" title="Next plot">&#9654;</button>
    <span class="spacer"></span>
    <button id="save" title="Save as PNG or SVG">Save…</button>
    <button id="remove" title="Remove this plot">Remove</button>
  </div>
  <div id="view"><span id="empty">No plots yet. Plot something in the R console.</span><img id="plot" hidden alt="R plot"></div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const view = document.getElementById('view'), img = document.getElementById('plot');
  for (const id of ['prev', 'next', 'save', 'remove']) {
    document.getElementById(id).onclick = () => vscode.postMessage({ type: id });
  }
  let timer;
  new ResizeObserver(() => {
    clearTimeout(timer);
    timer = setTimeout(() => vscode.postMessage({
      type: 'resize', width: view.clientWidth, height: view.clientHeight, ratio: window.devicePixelRatio || 1,
    }), 150);
  }).observe(view);
  window.addEventListener('message', ({ data }) => {
    if (data.type !== 'plot') return;
    document.getElementById('count').textContent = data.count ? (data.index + 1) + ' / ' + data.count : '0 / 0';
    document.getElementById('prev').disabled = data.index <= 0;
    document.getElementById('next').disabled = data.index >= data.count - 1;
    document.getElementById('save').disabled = document.getElementById('remove').disabled = !data.src;
    document.getElementById('empty').hidden = !!data.src;
    img.hidden = !data.src;
    if (data.src) img.src = data.src;
  });
  vscode.postMessage({ type: 'ready' });
</script>
</body></html>`;
    }

    dispose(): void {
        this.panel?.dispose();
    }
}
