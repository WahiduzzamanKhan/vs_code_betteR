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
    'editor-findMatchBackground',
    'editor-findMatchHighlightBackground',
    'menu-background',
    'menu-foreground',
    'menu-selectionBackground',
    'menu-selectionForeground',
    'menu-border',
    'menu-separatorBackground',
    'widget-shadow',
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
html, body { -webkit-user-select: text; user-select: text; }
::highlight(betteR-find) { background-color: var(--vscode-editor-findMatchHighlightBackground, rgba(234, 92, 0, 0.33)); }
::highlight(betteR-find-current) { background-color: var(--vscode-editor-findMatchBackground, rgba(255, 150, 50, 0.7)); }
.betteR-menu { position: fixed; z-index: 2147483647; min-width: 180px; padding: 4px 0; background: var(--vscode-menu-background, #fff); color: var(--vscode-menu-foreground, #222); border: 1px solid var(--vscode-menu-border, rgba(0, 0, 0, 0.15)); border-radius: 5px; box-shadow: 0 2px 8px var(--vscode-widget-shadow, rgba(0, 0, 0, 0.3)); font: 13px var(--vscode-font-family, system-ui, sans-serif); -webkit-user-select: none; user-select: none; }
.betteR-menu button { display: flex; width: 100%; gap: 24px; justify-content: space-between; padding: 4px 12px; margin: 0; border: 0; background: none; color: inherit; font: inherit; text-align: left; cursor: default; }
.betteR-menu button:is(:hover, :focus):not(:disabled) { background: var(--vscode-menu-selectionBackground, #0060c0); color: var(--vscode-menu-selectionForeground, #fff); outline: none; }
.betteR-menu button:disabled { opacity: 0.4; }
.betteR-menu-key { opacity: 0.7; }
.betteR-menu-sep { height: 1px; margin: 4px 0; background: var(--vscode-menu-separatorBackground, rgba(0, 0, 0, 0.15)); }
`;

/**
 * Find, copy, paste and a context menu inside the page. The page is a
 * cross-origin iframe in the webview, so VS Code's clipboard, find and context
 * menu never reach it: the page sends its selection to the panel to copy, asks
 * the panel for the clipboard to paste into its fields, passes Find shortcuts
 * up to the panel's find bar, searches itself when the find bar asks (marking
 * matches with CSS highlights, so the page's DOM is left alone), and draws its
 * own right-click menu.
 */
const PAGE_SCRIPT = `<script>(function () {
  var mac = /Mac/.test(navigator.platform);
  var post = function (m) { parent.postMessage(m, "*"); };
  var matches = [], current = -1;
  function clear() {
    CSS.highlights.delete("betteR-find");
    CSS.highlights.delete("betteR-find-current");
    matches = [];
    current = -1;
  }
  function search(query) {
    clear();
    if (!query || !document.body) return;
    // Search the page's text as a whole, so a match may span elements (e.g. "mean(x").
    var nodes = [], text = "";
    var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, { acceptNode: function (n) {
      return n.parentElement && !n.parentElement.closest("script, style, noscript") ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    } });
    for (var n; (n = walker.nextNode()); ) { nodes.push({ node: n, start: text.length }); text += n.data; }
    var hay = text.toLowerCase(), needle = query.toLowerCase(), k = 0;
    if (hay.length !== text.length) { hay = text; needle = query; }
    for (var i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + needle.length)) {
      var end = i + needle.length, r = new Range();
      while (nodes[k].start + nodes[k].node.data.length <= i) k++;
      r.setStart(nodes[k].node, i - nodes[k].start);
      var j = k;
      while (nodes[j].start + nodes[j].node.data.length < end) j++;
      r.setEnd(nodes[j].node, end - nodes[j].start);
      matches.push(r);
    }
    if (matches.length) CSS.highlights.set("betteR-find", new Highlight(...matches));
  }
  function select(i) {
    current = i;
    var h = new Highlight(matches[i]);
    h.priority = 1;
    CSS.highlights.set("betteR-find-current", h);
    var rect = matches[i].getBoundingClientRect();
    if (rect.top < 0 || rect.bottom > innerHeight || rect.left < 0 || rect.right > innerWidth) {
      matches[i].startContainer.parentElement.scrollIntoView({ block: "center", inline: "nearest" });
    }
  }
  addEventListener("message", function (e) {
    if (e.source !== parent || !e.data || e.data.type !== "betteR-find") return;
    if (e.data.step === 0) {
      // A new search starts at the first match on screen, like a browser's.
      search(String(e.data.query || ""));
      if (matches.length) {
        var first = matches.findIndex(function (r) { return r.getBoundingClientRect().bottom >= 0; });
        select(first === -1 ? 0 : first);
      }
    } else if (matches.length) {
      select((current + e.data.step + matches.length) % matches.length);
    }
    post({ type: "betteR-found", count: matches.length, current: current });
  });
  function isField(el) {
    return !!el && (el.tagName === "TEXTAREA" || (el.tagName === "INPUT" && typeof el.selectionStart === "number"));
  }
  function selectedText() {
    var a = document.activeElement;
    return isField(a) ? a.value.slice(a.selectionStart, a.selectionEnd) : String(getSelection());
  }
  function copy() {
    var text = selectedText();
    if (text) post({ type: "betteR-copy", text: text });
  }
  function cut() {
    var a = document.activeElement;
    if (!isField(a) || a.readOnly || a.selectionStart === a.selectionEnd) return;
    copy();
    if (!document.execCommand("delete")) a.setRangeText("", a.selectionStart, a.selectionEnd, "end");
  }
  // Paste: the panel reads the clipboard and sends it back for the field that asked.
  var pasteTarget = null;
  function paste() {
    var a = document.activeElement;
    if (!isField(a) || a.readOnly) return;
    pasteTarget = a;
    post({ type: "betteR-paste" });
  }
  addEventListener("message", function (e) {
    if (e.source !== parent || !e.data || e.data.type !== "betteR-paste-text") return;
    var a = pasteTarget;
    pasteTarget = null;
    if (!a || document.activeElement !== a) return;
    var text = String(e.data.text);
    if (!document.execCommand("insertText", false, text)) {
      a.setRangeText(text, a.selectionStart, a.selectionEnd, "end");
      a.dispatchEvent(new Event("input", { bubbles: true }));
    }
  });
  function selectAll() {
    var a = document.activeElement;
    if (isField(a)) a.select();
    else getSelection().selectAllChildren(document.body);
  }

  // The context menu: VS Code's doesn't reach into the page, so the page has its own.
  var menu = null, menuItems = [], menuIndex = -1;
  var keyName = function (k) { return (mac ? "⌘" : "Ctrl+") + k; };
  function closeMenu() {
    if (menu) menu.remove();
    menu = null;
    menuItems = [];
    menuIndex = -1;
  }
  function focusItem(i) {
    if (!menuItems.length) return;
    menuIndex = (i + menuItems.length) % menuItems.length;
    menuItems[menuIndex].focus();
  }
  function openMenu(e) {
    closeMenu();
    var field = isField(e.target) ? e.target : null;
    if (field && document.activeElement !== field) field.focus();
    var link = !field && e.target.closest && e.target.closest("a[href]");
    var hasSel = !!selectedText();
    var editable = field && !field.readOnly;
    var entries = [];
    if (link) entries.push({ label: "Copy Link Address", run: function () { post({ type: "betteR-copy", text: link.href }); } }, null);
    if (field) entries.push({ label: "Cut", key: keyName("X"), enabled: editable && hasSel, run: cut });
    entries.push({ label: "Copy", key: keyName("C"), enabled: hasSel, run: copy });
    if (field) entries.push({ label: "Paste", key: keyName("V"), enabled: editable, run: paste });
    entries.push(null, { label: "Select All", key: keyName("A"), run: selectAll });
    if (!field) entries.push({ label: "Find in Page", key: keyName("F"), run: function () { post({ type: "betteR-key", key: "find" }); } });
    menu = document.createElement("div");
    menu.className = "betteR-menu";
    menu.setAttribute("role", "menu");
    // Keep the focus (and selection) where it is while the menu is used.
    menu.addEventListener("mousedown", function (ev) { ev.preventDefault(); });
    entries.forEach(function (entry) {
      if (!entry) {
        if (menu.lastChild && menu.lastChild.className !== "betteR-menu-sep") {
          var sep = document.createElement("div");
          sep.className = "betteR-menu-sep";
          menu.appendChild(sep);
        }
        return;
      }
      var item = document.createElement("button");
      item.type = "button";
      item.setAttribute("role", "menuitem");
      item.tabIndex = -1;
      item.disabled = entry.enabled === false;
      var label = document.createElement("span");
      label.textContent = entry.label;
      item.appendChild(label);
      if (entry.key) {
        var key = document.createElement("span");
        key.className = "betteR-menu-key";
        key.textContent = entry.key;
        item.appendChild(key);
      }
      item.addEventListener("click", function () { closeMenu(); entry.run(); });
      menu.appendChild(item);
      if (!item.disabled) menuItems.push(item);
    });
    document.body.appendChild(menu);
    var w = menu.offsetWidth, h = menu.offsetHeight;
    menu.style.left = Math.max(0, Math.min(e.clientX, innerWidth - w - 2)) + "px";
    menu.style.top = Math.max(0, e.clientY + h > innerHeight ? e.clientY - h : e.clientY) + "px";
  }
  addEventListener("contextmenu", function (e) {
    if (menu && menu.contains(e.target)) { e.preventDefault(); return; }
    e.preventDefault();
    openMenu(e);
  });
  addEventListener("mousedown", function (e) { if (menu && !menu.contains(e.target)) closeMenu(); }, true);
  addEventListener("blur", closeMenu);
  addEventListener("resize", closeMenu);
  addEventListener("scroll", closeMenu, true);

  addEventListener("keydown", function (e) {
    if (menu) {
      if (e.key === "Escape") closeMenu();
      else if (e.key === "ArrowDown") focusItem(menuIndex + 1);
      else if (e.key === "ArrowUp") focusItem(menuIndex - 1);
      else if (e.key === "Enter" || e.key === " ") { if (menuItems[menuIndex]) menuItems[menuIndex].click(); }
      else if (e.key === "Tab") closeMenu();
      else return;
      e.preventDefault();
      return;
    }
    var mod = mac ? e.metaKey : e.ctrlKey, key = e.key.toLowerCase(), plain = mod && !e.altKey && !e.shiftKey;
    if (plain && key === "c") copy();
    else if (plain && key === "x") cut();
    else if (plain && key === "v") paste();
    else if (plain && key === "a") selectAll();
    else if (mod && !e.altKey && key === "f") post({ type: "betteR-key", key: "find" });
    else if ((mod && key === "g") || e.key === "F3") post({ type: "betteR-key", key: e.shiftKey ? "findPrevious" : "findNext" });
    else if (e.key === "Escape") { post({ type: "betteR-key", key: "escape" }); return; }
    else if ((e.shiftKey && e.key === "F10") || e.key === "ContextMenu") {
      // The keyboard's menu key: open the menu at the focused element, or the selection.
      var sel = getSelection(), r = sel.rangeCount && !sel.isCollapsed ? sel.getRangeAt(0).getBoundingClientRect() : null;
      var el = document.activeElement && document.activeElement !== document.body ? document.activeElement : null;
      var box = r || (el ? el.getBoundingClientRect() : { left: 20, bottom: 20 });
      openMenu({ target: el || document.body, clientX: box.left, clientY: box.bottom });
      focusItem(0);
    }
    else return;
    e.preventDefault();
  }, true);
})();</script>`;

/** Applies themes the panel sends later (the user switched theme). */
const THEME_LISTENER = `<script>addEventListener("message", function (e) {
  if (e.source !== parent || !e.data || e.data.type !== "betteR-theme") return;
  var root = document.documentElement;
  for (var k in e.data.vars) if (/^--vscode-[\\w-]+$/.test(k)) root.style.setProperty(k, e.data.vars[k]);
  root.style.colorScheme = e.data.dark ? "dark" : "light";
  root.classList.add("betteR-themed");
});</script>`;

/**
 * Markup for the top of each help page: find and copy support, and the theme
 * as of now, so pages load already themed.
 */
export function themeHead(theme: HelpTheme | undefined): string {
    let head = `<style>${THEME_CSS}</style>${THEME_LISTENER}${PAGE_SCRIPT}`;
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
        this.panel.webview.onDidReceiveMessage((msg: { type: string; url?: string; title?: string; text?: string; theme?: HelpTheme }) => {
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
                case 'copy':
                    void vscode.env.clipboard.writeText(msg.text ?? '');
                    break;
                case 'paste':
                    void vscode.env.clipboard.readText().then((text) => this.panel?.webview.postMessage({ type: 'paste', text }));
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
  .page { flex: 1; display: flex; position: relative; min-height: 0; }
  iframe { flex: 1; border: 0; width: 100%; background: var(--vscode-editor-background); }
  .find { position: absolute; top: 0; right: 14px; display: flex; gap: 2px; align-items: center; padding: 4px; background: var(--vscode-editorWidget-background); color: var(--vscode-editorWidget-foreground); box-shadow: 0 0 8px 2px var(--vscode-widget-shadow); border-radius: 0 0 4px 4px; }
  .find[hidden] { display: none; }
  .find input { width: 180px; padding: 3px 6px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent); border-radius: 2px; font: inherit; outline: none; }
  .find input:focus { border-color: var(--vscode-focusBorder); }
  #find-count { min-width: 64px; padding: 0 4px; font-size: 12px; opacity: .8; white-space: nowrap; }
  #find-count.none { color: var(--vscode-errorForeground); opacity: 1; }
  .find button { padding: 2px 6px; }
</style></head>
<body>
  <div class="bar">
    <button id="back" title="Back" disabled>&#9664;</button>
    <button id="forward" title="Forward" disabled>&#9654;</button>
    <span id="title"></span>
    <button id="find-open" title="Find (${process.platform === 'darwin' ? '⌘F' : 'Ctrl+F'})">Find</button>
    <button id="browser" title="Open in your browser">Open in Browser</button>
  </div>
  <div class="page">
    <iframe id="frame"></iframe>
    <div class="find" id="find" hidden>
      <input id="find-input" type="text" placeholder="Find" aria-label="Find in page" spellcheck="false">
      <span id="find-count" aria-live="polite"></span>
      <button id="find-previous" title="Previous Match (Shift+Enter)" aria-label="Previous match">&#8593;</button>
      <button id="find-next" title="Next Match (Enter)" aria-label="Next match">&#8595;</button>
      <button id="find-close" title="Close (Escape)" aria-label="Close find">&#10005;</button>
    </div>
  </div>
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
  // Find in the page: the page searches itself (it's cross-origin) and reports the count.
  const find = document.getElementById('find');
  const findInput = document.getElementById('find-input');
  const findCount = document.getElementById('find-count');
  const sendFind = (step) => frame.contentWindow && frame.contentWindow.postMessage({ type: 'betteR-find', query: find.hidden ? '' : findInput.value, step }, '*');
  const showCount = (count, current) => {
    findCount.textContent = !findInput.value ? '' : count ? (current + 1) + ' of ' + count : 'No results';
    findCount.classList.toggle('none', !!findInput.value && !count);
  };
  const openFind = () => {
    find.hidden = false;
    findInput.focus();
    findInput.select();
    if (findInput.value) sendFind(0);
  };
  const closeFind = () => {
    if (find.hidden) return;
    find.hidden = true;
    showCount(0, -1);
    sendFind(0);
    frame.focus();
  };
  const findStep = (step) => (find.hidden ? openFind() : findInput.value && sendFind(step));
  findInput.addEventListener('input', () => (findInput.value ? sendFind(0) : (sendFind(0), showCount(0, -1))));
  findInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      findStep(e.shiftKey ? -1 : 1);
    }
  });
  document.getElementById('find-open').onclick = openFind;
  document.getElementById('find-previous').onclick = () => findStep(-1);
  document.getElementById('find-next').onclick = () => findStep(1);
  document.getElementById('find-close').onclick = closeFind;
  const onKey = (key) => {
    if (key === 'find') openFind();
    else if (key === 'findNext') findStep(1);
    else if (key === 'findPrevious') findStep(-1);
    else if (key === 'escape') closeFind();
  };
  const MAC = navigator.platform.startsWith('Mac');
  document.addEventListener('keydown', (e) => {
    const mod = MAC ? e.metaKey : e.ctrlKey;
    const key = e.key.toLowerCase();
    if (mod && !e.altKey && key === 'f') onKey('find');
    else if ((mod && key === 'g') || e.key === 'F3') onKey(e.shiftKey ? 'findPrevious' : 'findNext');
    else if (e.key === 'Escape') onKey('escape');
    else return;
    e.preventDefault();
  });
  // A new page gets the open search too.
  frame.addEventListener('load', () => !find.hidden && findInput.value && sendFind(0));
  window.addEventListener('message', ({ data, source }) => {
    if (!data) return;
    if (source === frame.contentWindow) {
      if (data.type === 'betteR-nav') vscode.postMessage({ type: 'nav', url: data.url, title: data.title });
      else if (data.type === 'betteR-copy') vscode.postMessage({ type: 'copy', text: String(data.text) });
      // Only while the page has the focus: a paste follows a key press or menu click there.
      else if (data.type === 'betteR-paste' && document.activeElement === frame && document.hasFocus()) vscode.postMessage({ type: 'paste' });
      else if (data.type === 'betteR-key') onKey(data.key);
      else if (data.type === 'betteR-found') showCount(data.count, data.current);
      return;
    }
    if (data.type === 'paste') {
      if (frame.contentWindow) frame.contentWindow.postMessage({ type: 'betteR-paste-text', text: data.text }, '*');
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
