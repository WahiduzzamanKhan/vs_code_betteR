import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { iframeCsp, NavProxy } from './htmlServer';

/** VS Code theme variables the help page uses; the panel reads their current values. */
const THEME_VARS = [
    'editor-background',
    'editor-foreground',
    'descriptionForeground',
    'textLink-foreground',
    'textLink-activeForeground',
    'textCodeBlock-background',
    'panel-border',
    'list-hoverBackground',
    'editor-selectionBackground',
    'scrollbarSlider-background',
    'scrollbarSlider-hoverBackground',
    'scrollbarSlider-activeBackground',
    'font-family',
    'editor-font-family',
].map((v) => `--vscode-${v}`);

export interface HelpTheme {
    vars: Record<string, string>;
    dark: boolean;
}

/**
 * Restyles R's help pages (R.css: white, black, greys) with the theme's
 * colors and fonts. Applies once the page has the `betteR-themed` class, so a
 * page without a theme looks as R made it.
 */
const THEME_CSS = `
html.betteR-themed body { background: var(--vscode-editor-background) !important; color: var(--vscode-editor-foreground) !important; font-family: var(--vscode-font-family) !important; }
html.betteR-themed :is(h1, h2, h3, h4, h5, h6) { background: transparent !important; color: var(--vscode-descriptionForeground) !important; font-family: var(--vscode-editor-font-family), monospace !important; }
html.betteR-themed :is(a:link, a:visited) { background: transparent !important; color: var(--vscode-textLink-foreground) !important; }
html.betteR-themed :is(a:hover, a:active) { color: var(--vscode-textLink-activeForeground) !important; }
html.betteR-themed :is(code, kbd, samp, tt, pre, span.env, span.file, span.option, span.samp) { font-family: var(--vscode-editor-font-family), monospace !important; }
html.betteR-themed pre { background: var(--vscode-textCodeBlock-background) !important; padding: 8px 10px; border-radius: 4px; overflow-x: auto; }
html.betteR-themed hr { border: 0; border-top: 1px solid var(--vscode-panel-border); }
html.betteR-themed span.rlang { color: var(--vscode-descriptionForeground) !important; }
html.betteR-themed div.vignettes a:hover { background: var(--vscode-list-hoverBackground) !important; }
html.betteR-themed ::selection { background: var(--vscode-editor-selectionBackground); }
html.betteR-themed ::-webkit-scrollbar { width: 10px; height: 10px; }
html.betteR-themed ::-webkit-scrollbar-corner { background: transparent; }
html.betteR-themed ::-webkit-scrollbar-thumb { background: var(--vscode-scrollbarSlider-background); }
html.betteR-themed ::-webkit-scrollbar-thumb:hover { background: var(--vscode-scrollbarSlider-hoverBackground); }
html.betteR-themed ::-webkit-scrollbar-thumb:active { background: var(--vscode-scrollbarSlider-activeBackground); }
`;

/** Applies themes the panel sends later (the user switched theme). */
const THEME_LISTENER = `<script>addEventListener("message", function (e) {
  if (e.source !== parent || !e.data || e.data.type !== "betteR-theme") return;
  var root = document.documentElement;
  for (var k in e.data.vars) if (/^--vscode-[\\w-]+$/.test(k)) root.style.setProperty(k, e.data.vars[k]);
  root.style.colorScheme = e.data.dark ? "dark" : "light";
  root.classList.add("betteR-themed");
});</script>`;

/** Markup for the top of each help page: the theme as of now, so pages load already themed. */
export function themeHead(theme: HelpTheme | undefined): string {
    let head = `<style>${THEME_CSS}</style>${THEME_LISTENER}`;
    if (theme) {
        // Values go into a style element: keep them to plain CSS values.
        const decls = Object.entries(theme.vars)
            .filter(([k]) => THEME_VARS.includes(k))
            .map(([k, v]) => `${k}: ${v.replace(/[<>{};\n\r]/g, '')};`)
            .join(' ');
        head += `<style>:root { ${decls} color-scheme: ${theme.dark ? 'dark' : 'light'}; }</style>`;
        head += '<script>document.documentElement.classList.add("betteR-themed");</script>';
    }
    return head;
}

/**
 * The "R Help" panel: R's HTML help (`?topic`, `help()`, `??search`, package
 * indexes) from ark's help server, with Back/Forward across both requested
 * pages and links followed inside the panel.
 */
export class HelpPanel implements vscode.Disposable {
    readonly history: string[] = [];
    index = -1;
    title = '';
    /** The VS Code theme, as last reported by the panel. */
    theme: HelpTheme | undefined;
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
            this.proxy = await NavProxy.start(origin, () => themeHead(this.theme));
        }
        const mapped = (await vscode.env.asExternalUri(vscode.Uri.parse(this.proxy.map(url)))).toString(true);
        this.push(mapped);
        // A new panel loads the page once it reports ready (after its theme).
        if (this.open()) {
            this.post(true);
        }
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

    /** Shows the panel; returns false if it had to be created. */
    private open(): boolean {
        if (this.panel) {
            if (!this.panel.visible) {
                this.panel.reveal(undefined, true);
            }
            return true;
        }
        this.panel = vscode.window.createWebviewPanel(
            'betteR.help',
            'R Help',
            { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
            { enableScripts: true, retainContextWhenHidden: true },
        );
        this.panel.webview.html = this.html();
        this.panel.webview.onDidReceiveMessage((msg: { type: string; url?: string; title?: string; theme?: HelpTheme }) => {
            switch (msg.type) {
                case 'theme':
                    this.theme = msg.theme;
                    break;
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
        return false;
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
  iframe { flex: 1; border: 0; width: 100%; background: var(--vscode-editor-background); }
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
  // The help page is cross-origin, so it gets the theme's values, not the variables.
  const THEME_VARS = ${JSON.stringify(THEME_VARS)};
  const readTheme = () => {
    const style = getComputedStyle(document.documentElement);
    const vars = {};
    for (const name of THEME_VARS) {
      const value = style.getPropertyValue(name).trim();
      if (value) vars[name] = value;
    }
    const kind = document.body.classList;
    return { vars, dark: kind.contains('vscode-dark') || kind.contains('vscode-high-contrast') };
  };
  let theme = readTheme();
  const sendTheme = () => frame.contentWindow && frame.contentWindow.postMessage({ type: 'betteR-theme', ...theme }, '*');
  const onThemeChange = () => {
    const next = readTheme();
    if (JSON.stringify(next) === JSON.stringify(theme)) return;
    theme = next;
    vscode.postMessage({ type: 'theme', theme });
    sendTheme();
  };
  // VS Code sets theme variables on <html> and the theme kind as a <body> class.
  new MutationObserver(onThemeChange).observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'class'] });
  new MutationObserver(onThemeChange).observe(document.body, { attributes: true, attributeFilter: ['class'] });
  // Covers a page that loaded before the extension had the theme.
  frame.addEventListener('load', sendTheme);
  vscode.postMessage({ type: 'theme', theme });
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
