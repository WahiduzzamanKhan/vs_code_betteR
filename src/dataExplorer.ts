import * as crypto from 'crypto';
import * as vscode from 'vscode';

/** The console's link to ark's data explorer comms. */
export interface DataExplorerHost {
    rpc<T>(commId: string, method: string, params?: object): Promise<T>;
    close(commId: string): void;
}

export interface ColumnSchema {
    column_name: string;
    column_index: number;
    type_name: string;
    type_display: string;
    [key: string]: unknown;
}

export interface RowFilter {
    filter_id: string;
    filter_type: string;
    column_schema?: ColumnSchema;
    condition: 'and' | 'or';
    is_valid?: boolean | null;
    error_message?: string | null;
    params?: Record<string, unknown> | null;
}

export interface SortKey {
    column_index: number;
    ascending: boolean;
}

interface BackendState {
    display_name: string;
    table_shape: { num_rows: number; num_columns: number };
    table_unfiltered_shape: { num_rows: number; num_columns: number };
    has_row_labels: boolean;
    row_filters: RowFilter[];
    sort_keys: SortKey[];
}

/** A formatted value, or one of ark's special value codes (NA, NaN, ...). */
export type CellValue = string | number;

/** A new row filter on one column, as built by the filter form. */
export interface FilterSpec {
    column_index: number;
    filter_type: string;
    params?: Record<string, unknown>;
}

export interface CellRange {
    r0: number;
    r1: number;
    c0: number;
    c1: number;
}

/** How ark formats values; numbers as R prints them, without thousands separators. */
const FORMAT_OPTIONS = {
    large_num_digits: 2,
    small_num_digits: 4,
    max_integral_digits: 7,
    max_value_length: 1000,
    thousands_sep: null,
};

const GLOBAL_SEARCH_ID = 'betteR-global-search';

/**
 * The tallest canvas the grid scrolls, in px. Chromium clamps layout sizes at
 * about 33.5M px, so a canvas of rows × row height stops near 1.5M rows. A
 * taller table scrolls a canvas of this height instead, with the scroll
 * position mapped to rows by ratio.
 */
const MAX_SCROLL_HEIGHT = 10_000_000;

// The grid's geometry. Plain functions, so tests can call them; the webview
// script includes their source.

/** Row height in px for the editor font size: 22 at the usual 12-14px, taller for larger fonts. */
export function rowHeight(fontSize: number): number {
    return Math.max(22, Math.round(fontSize * 1.6) || 0);
}

/** Height of the canvas the rows scroll in: the rows' full height, up to MAX_SCROLL_HEIGHT. */
export function canvasRowsHeight(rowsHeight: number): number {
    return Math.min(rowsHeight, MAX_SCROLL_HEIGHT);
}

/**
 * How far down the full table (`rowsHeight` px tall) the viewport starts, at
 * scroll position `scrollTop` of `maxScroll`. `view` is the height of the
 * rows' viewport. One to one while the table fits the canvas; otherwise the
 * ends of the scroll range map to the first and last rows. The last scroll
 * pixel counts as the end, since a fractional device pixel ratio can stop
 * the scrollbar just short of `maxScroll`.
 */
export function rowsTop(scrollTop: number, maxScroll: number, rowsHeight: number, view: number): number {
    if (rowsHeight <= MAX_SCROLL_HEIGHT || maxScroll <= 0) {
        return scrollTop;
    }
    const end = Math.max(0, rowsHeight - view);
    return scrollTop >= maxScroll - 1 ? end : (Math.max(scrollTop, 0) / maxScroll) * end;
}

/** The scroll position at which the viewport starts `top` px down the full table: the inverse of rowsTop. */
export function scrollTopFor(top: number, maxScroll: number, rowsHeight: number, view: number): number {
    if (rowsHeight <= MAX_SCROLL_HEIGHT || maxScroll <= 0) {
        return top;
    }
    const range = rowsHeight - view;
    return range > 0 ? (Math.min(Math.max(top, 0), range) / range) * maxScroll : 0;
}

/**
 * One data frame in an editor tab. ark's data explorer comm holds the table
 * (sorted and filtered on ark's side) and serves cell values a block at a
 * time, so tables of any size scroll smoothly. Opened by `View(df)` or the
 * Environment view; follows the variable as it changes.
 */
export class DataExplorerPanel {
    readonly panel: vscode.WebviewPanel;
    state: BackendState | undefined;
    schema: ColumnSchema[] = [];
    search = '';
    /** Set once ark has closed the comm (e.g. the variable was removed). */
    closed: string | undefined;
    /** Bumped whenever cached cell values become stale. */
    private gen = 0;
    /** What the grid last drew (for tests): top-left cell and number of cells. */
    lastRender: { row: number; col: number; text: string; cells: number; filterForm: boolean } | undefined;
    private disposed = false;

    constructor(
        private readonly host: DataExplorerHost,
        public commId: string,
        public title: string,
        private readonly onDispose: (panel: DataExplorerPanel) => void,
    ) {
        this.panel = vscode.window.createWebviewPanel(
            'betteR.dataExplorer',
            title,
            { viewColumn: vscode.ViewColumn.Active, preserveFocus: true },
            { enableScripts: true, retainContextWhenHidden: true },
        );
        this.panel.webview.html = html();
        this.panel.webview.onDidReceiveMessage((msg) => void this.onMessage(msg));
        this.panel.onDidDispose(() => this.dispose());
    }

    /** Shows a new comm in this tab (`View()` of a data frame with the same title). */
    attach(commId: string): void {
        if (!this.closed && commId !== this.commId) {
            this.host.close(this.commId);
        }
        this.commId = commId;
        this.closed = undefined;
        this.search = '';
        this.panel.reveal(undefined, true);
        void this.load();
    }

    async load(): Promise<void> {
        try {
            const state = await this.rpc<BackendState>('get_state');
            const n = state.table_unfiltered_shape.num_columns;
            const schema = await this.rpc<{ columns: ColumnSchema[] }>('get_schema', {
                column_indices: Array.from({ length: n }, (_, i) => i),
            });
            this.schema = schema.columns ?? [];
            this.setState(state);
        } catch (err) {
            this.post({ type: 'error', message: (err as Error).message });
        }
    }

    /** Re-reads ark's state (shape, filters, sort) and invalidates cached values. */
    async refresh(): Promise<void> {
        try {
            this.setState(await this.rpc<BackendState>('get_state'));
        } catch (err) {
            this.post({ type: 'error', message: (err as Error).message });
        }
    }

    private setState(state: BackendState): void {
        this.state = state;
        this.gen++;
        this.post({
            type: 'state',
            gen: this.gen,
            title: this.title,
            numRows: state.table_shape.num_rows,
            numCols: state.table_shape.num_columns,
            unfilteredRows: state.table_unfiltered_shape.num_rows,
            hasRowLabels: state.has_row_labels,
            schema: this.schema.map((c) => ({ name: c.column_name, type: c.type_name, display: c.type_display })),
            sortKeys: state.sort_keys ?? [],
            rowFilters: this.columnFilters(),
            search: this.search,
            closed: this.closed,
        });
    }

    /** Formatted values for rows `r0..r1` of columns `c0..c1`, one array per column. */
    async values(r0: number, r1: number, c0: number, c1: number): Promise<CellValue[][]> {
        const columns = [];
        for (let c = c0; c <= c1; c++) {
            columns.push({ column_index: c, spec: { first_index: r0, last_index: r1 } });
        }
        const data = await this.rpc<{ columns: CellValue[][] }>('get_data_values', {
            columns,
            format_options: FORMAT_OPTIONS,
        });
        return data.columns;
    }

    async rowLabels(r0: number, r1: number): Promise<string[]> {
        const data = await this.rpc<{ row_labels: string[][] }>('get_row_labels', {
            selection: { first_index: r0, last_index: r1 },
            format_options: FORMAT_OPTIONS,
        });
        return data.row_labels[0] ?? [];
    }

    async sort(keys: SortKey[]): Promise<void> {
        await this.rpc('set_sort_columns', { sort_keys: keys });
        await this.refresh();
    }

    columnFilters(): RowFilter[] {
        return (this.state?.row_filters ?? []).filter((f) => f.filter_type !== 'global_search');
    }

    async addFilter(spec: FilterSpec): Promise<void> {
        const filter: RowFilter = {
            filter_id: crypto.randomUUID(),
            filter_type: spec.filter_type,
            column_schema: this.schema[spec.column_index],
            condition: 'and',
            params: spec.params,
        };
        await this.setFilters([...this.columnFilters(), filter]);
    }

    async removeFilter(id: string): Promise<void> {
        await this.setFilters(this.columnFilters().filter((f) => f.filter_id !== id));
    }

    /** Keeps rows where any cell contains `term` (empty: no search). */
    async setSearch(term: string): Promise<void> {
        this.search = term;
        await this.setFilters(this.columnFilters());
    }

    private async setFilters(filters: RowFilter[]): Promise<void> {
        const all = [...filters];
        if (this.search) {
            all.push({ filter_id: GLOBAL_SEARCH_ID, filter_type: 'global_search', condition: 'and', params: { term: this.search } });
        }
        await this.rpc('set_row_filters', { filters: all });
        await this.refresh();
    }

    /** The cells in `range` (of the sorted, filtered table) as TSV or CSV, as ark exports them. */
    async export(range: CellRange, format: 'tsv' | 'csv'): Promise<string> {
        const single = range.r0 === range.r1 && range.c0 === range.c1;
        const selection = single
            ? { kind: 'single_cell', selection: { row_index: range.r0, column_index: range.c0 } }
            : {
                  kind: 'cell_range',
                  selection: {
                      first_row_index: range.r0,
                      last_row_index: range.r1,
                      first_column_index: range.c0,
                      last_column_index: range.c1,
                  },
              };
        const result = await this.rpc<{ data: string }>('export_data_selection', { selection, format });
        return result.data;
    }

    async copy(range: CellRange, format: 'tsv' | 'csv'): Promise<void> {
        await vscode.env.clipboard.writeText(await this.export(range, format));
        const rows = range.r1 - range.r0 + 1;
        const cols = range.c1 - range.c0 + 1;
        vscode.window.setStatusBarMessage(
            `Copied ${rows.toLocaleString()} × ${cols.toLocaleString()} cell${rows * cols === 1 ? '' : 's'}${format === 'csv' ? ' as CSV' : ''}`,
            3000,
        );
    }

    /**
     * Acts on the grid as the user would (for tests): presses a key (`mod`:
     * Ctrl/Cmd), turns the wheel by `wheel` px, or drags the scrollbar to a
     * fraction `scroll` of its range.
     */
    simulate(input: { key: string; mod?: boolean } | { wheel: number } | { scroll: number }): void {
        this.post({ type: 'simulate', ...input });
    }

    /** ark's change notifications: the variable was reassigned or modified. */
    onEvent(method: string): void {
        if (method === 'schema_update') {
            void this.load();
        } else if (method === 'data_update') {
            void this.refresh();
        }
    }

    onClosed(): void {
        this.closed = `${this.title} is no longer available in the R session.`;
        this.post({ type: 'closed', message: this.closed });
    }

    private rpc<T>(method: string, params?: object): Promise<T> {
        if (this.closed) {
            return Promise.reject(new Error(this.closed));
        }
        return this.host.rpc<T>(this.commId, method, params);
    }

    private post(message: object): void {
        if (!this.disposed) {
            void this.panel.webview.postMessage(message);
        }
    }

    private async onMessage(msg: { type: string; [key: string]: any }): Promise<void> {
        try {
            switch (msg.type) {
                case 'ready':
                    await this.load();
                    break;
                case 'fetch': {
                    const gen = this.gen;
                    const [r0, r1] = msg.rows as [number, number];
                    const [c0, c1] = msg.cols as [number, number];
                    const values = await this.values(r0, r1, c0, c1);
                    if (gen === this.gen) {
                        this.post({ type: 'block', gen, key: msg.key, values });
                    }
                    break;
                }
                case 'fetchLabels': {
                    const gen = this.gen;
                    const [r0, r1] = msg.rows as [number, number];
                    const labels = await this.rowLabels(r0, r1);
                    if (gen === this.gen) {
                        this.post({ type: 'labels', gen, block: msg.block, labels });
                    }
                    break;
                }
                case 'sort':
                    await this.sort(msg.keys);
                    break;
                case 'addFilter':
                    await this.addFilter(msg.spec);
                    break;
                case 'removeFilter':
                    await this.removeFilter(msg.id);
                    break;
                case 'search':
                    await this.setSearch(msg.term);
                    break;
                case 'copy':
                    await this.copy(msg.range, msg.format);
                    break;
                case 'rendered':
                    this.lastRender = msg.render;
                    break;
            }
        } catch (err) {
            if (msg.type === 'fetch' || msg.type === 'fetchLabels') {
                this.post({ type: 'fetchFailed', gen: this.gen, key: msg.key, block: msg.block });
            } else {
                void vscode.window.showErrorMessage(`Data explorer: ${(err as Error).message}`);
            }
        }
    }

    /** `silent`: the session is gone, so there's no comm to close. */
    dispose(silent = false): void {
        if (this.disposed) {
            return;
        }
        this.disposed = true;
        if (!silent && !this.closed) {
            this.host.close(this.commId);
        }
        this.panel.dispose();
        this.onDispose(this);
    }
}

/** The session's open data explorers, keyed by ark's comm id. */
export class DataExplorers implements vscode.Disposable {
    readonly panels = new Set<DataExplorerPanel>();

    constructor(private readonly host: DataExplorerHost) {}

    /** A data explorer ark opened. `View()` of the same title again reuses its tab. */
    open(commId: string, title: string): DataExplorerPanel {
        const existing = this.byTitle(title);
        if (existing) {
            existing.attach(commId);
            return existing;
        }
        const panel = new DataExplorerPanel(this.host, commId, title, (p) => this.panels.delete(p));
        this.panels.add(panel);
        return panel;
    }

    byTitle(title: string): DataExplorerPanel | undefined {
        return [...this.panels].find((p) => p.title === title);
    }

    private byComm(commId: string): DataExplorerPanel | undefined {
        return [...this.panels].find((p) => p.commId === commId);
    }

    onEvent(commId: string, method: string): void {
        this.byComm(commId)?.onEvent(method);
    }

    onClosed(commId: string): void {
        this.byComm(commId)?.onClosed();
    }

    dispose(): void {
        for (const panel of [...this.panels]) {
            panel.dispose(true);
        }
    }
}

function html(): string {
    const nonce = crypto.randomBytes(16).toString('base64');
    return `<!DOCTYPE html>
<html><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  /* Element rules below set display (e.g. the filter form's flex), which would otherwise override the hidden attribute. */
  [hidden] { display: none !important; }
  html, body { height: 100%; margin: 0; overflow: hidden; color: var(--vscode-foreground); font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); background: var(--vscode-editor-background); }
  body { display: flex; flex-direction: column; }
  .bar { display: flex; gap: 6px; align-items: center; padding: 4px 8px; border-bottom: 1px solid var(--vscode-panel-border); }
  .spacer { flex: 1; }
  #shape { opacity: .75; font-variant-numeric: tabular-nums; white-space: nowrap; }
  button { background: none; color: inherit; border: 1px solid transparent; border-radius: 3px; padding: 2px 8px; cursor: pointer; font: inherit; }
  button:hover:not(:disabled) { background: var(--vscode-toolbar-hoverBackground); }
  button:disabled { opacity: .4; cursor: default; }
  input, select { background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent); border-radius: 2px; padding: 2px 6px; font: inherit; }
  input:focus, select:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  #search { width: 180px; }
  #filters { display: flex; flex-wrap: wrap; gap: 4px; padding: 4px 8px; border-bottom: 1px solid var(--vscode-panel-border); }
  #filters:empty { display: none; }
  .chip { display: inline-flex; align-items: center; gap: 4px; padding: 1px 4px 1px 8px; border-radius: 10px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
  .chip.invalid { background: var(--vscode-inputValidation-errorBackground); outline: 1px solid var(--vscode-inputValidation-errorBorder); color: inherit; }
  .chip button { padding: 0 4px; border-radius: 8px; }
  #grid { flex: 1; overflow: auto; position: relative; outline: none; }
  /* Rows near the end of a tall table are placed past the canvas's bottom edge (see rowsTop()); clipping them keeps the scroll range fixed. */
  #canvas { position: relative; overflow-y: clip; }
  .c, .h, .l, #corner { position: absolute; box-sizing: border-box; height: var(--row-h, 22px); line-height: calc(var(--row-h, 22px) - 1px); padding: 0 6px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis;
    border-right: 1px solid var(--vscode-panel-border); border-bottom: 1px solid var(--vscode-panel-border); font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size); }
  .c.n { text-align: right; font-variant-numeric: tabular-nums; }
  .c.s { color: var(--vscode-descriptionForeground); font-style: italic; }
  .c.sel { background: var(--vscode-editor-selectionBackground); }
  .c.focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  .c.pending { color: transparent; }
  #header, #labels { position: absolute; top: 0; left: 0; z-index: 2; }
  #corner { z-index: 3; }
  .h, #corner { height: 40px; line-height: 1.25; padding: 3px 18px 3px 6px; background: var(--vscode-editorGroupHeader-tabsBackground, var(--vscode-sideBar-background)); cursor: pointer; user-select: none; font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); }
  .h .name { font-weight: 600; overflow: hidden; text-overflow: ellipsis; }
  .h .type { opacity: .65; font-size: .9em; overflow: hidden; text-overflow: ellipsis; }
  .h .sort { position: absolute; right: 18px; top: 3px; font-size: .85em; }
  .h .fbtn { position: absolute; right: 2px; bottom: 3px; padding: 0 3px; opacity: 0; }
  .h:hover .fbtn { opacity: .8; }
  .h.sel { background: var(--vscode-list-inactiveSelectionBackground); }
  .h .resize { position: absolute; right: -3px; top: 0; width: 7px; height: 100%; cursor: col-resize; z-index: 1; }
  .l { background: var(--vscode-editorGroupHeader-tabsBackground, var(--vscode-sideBar-background)); color: var(--vscode-descriptionForeground); cursor: pointer; user-select: none; }
  .l.sel { background: var(--vscode-list-inactiveSelectionBackground); }
  #corner { cursor: pointer; }
  #overlay { position: absolute; inset: auto 12px 12px auto; padding: 6px 10px; border-radius: 4px; background: var(--vscode-inputValidation-warningBackground); border: 1px solid var(--vscode-inputValidation-warningBorder); z-index: 5; }
  #empty { padding: 16px; opacity: .7; }
  #popover { position: fixed; z-index: 10; display: flex; flex-direction: column; gap: 6px; padding: 8px; min-width: 220px;
    background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-editorWidget-border, var(--vscode-panel-border)); border-radius: 4px; box-shadow: 0 2px 8px var(--vscode-widget-shadow); }
  #popover .row { display: flex; gap: 6px; justify-content: flex-end; }
  #popover button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  .probe { position: absolute; visibility: hidden; height: auto; line-height: normal; }
</style></head>
<body>
  <div class="bar">
    <span id="shape"></span>
    <span class="spacer"></span>
    <input id="search" type="search" placeholder="Search all cells" title="Keep rows where any cell contains this text">
    <button id="addFilter" title="Filter rows by a column's values">+ Filter</button>
    <button id="clearSort" title="Back to the original row order" disabled>Clear Sort</button>
    <button id="copy" title="Copy the selected cells (Cmd/Ctrl+C), tab-separated" disabled>Copy</button>
    <button id="copyCsv" title="Copy the selected cells as CSV" disabled>Copy as CSV</button>
  </div>
  <div id="filters"></div>
  <div id="grid" tabindex="0"><div id="canvas"><div id="cells"></div><div id="labels"></div><div id="header"></div><div id="corner"></div></div></div>
  <div id="overlay" hidden></div>
  <div id="popover" hidden>
    <select id="fCol"></select>
    <select id="fOp"></select>
    <input id="fV1" placeholder="Value">
    <input id="fV2" placeholder="and">
    <div class="row"><button id="fCancel">Cancel</button><button id="fApply" class="primary">Apply</button></div>
  </div>
  <div class="c probe" id="probe">0</div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const HEAD_H = 40, BR = 100, BC = 20, MAX_SCROLL_HEIGHT = ${MAX_SCROLL_HEIGHT};
  let ROW_H = 22;
  ${rowHeight}
  ${canvasRowsHeight}
  ${rowsTop}
  ${scrollTopFor}
  const $ = (id) => document.getElementById(id);
  const grid = $('grid'), canvas = $('canvas'), cellsEl = $('cells'), headerEl = $('header'), labelsEl = $('labels'), corner = $('corner');
  const SPECIAL = { 0: 'NULL', 1: 'NA', 2: 'NaN', 10: 'Inf', 11: '-Inf' };
  const NUMERIC = new Set(['floating', 'integer', 'decimal']);
  const OP_LABEL = { '=': '=', '!=': '≠', '<': '<', '<=': '≤', '>': '>', '>=': '≥', between: 'between', not_between: 'not between',
    contains: 'contains', not_contains: "doesn't contain", starts_with: 'starts with', ends_with: 'ends with', regex_match: 'matches regex',
    is_null: 'is NA', not_null: 'is not NA', is_empty: 'is empty', not_empty: 'is not empty', is_true: 'is TRUE', is_false: 'is FALSE' };
  const SEARCH_OPS = ['contains', 'not_contains', 'starts_with', 'ends_with', 'regex_match'];
  const COMPARE_OPS = ['=', '!=', '<', '<=', '>', '>='];
  const opsFor = (display) =>
    display === 'boolean' ? ['is_true', 'is_false', 'is_null', 'not_null']
    : NUMERIC.has(display) || ['date', 'datetime', 'time'].includes(display) ? [...COMPARE_OPS, 'between', 'not_between', 'is_null', 'not_null']
    : [...SEARCH_OPS, '=', '!=', 'is_empty', 'not_empty', 'is_null', 'not_null'];
  const arity = (op) => (op === 'between' || op === 'not_between' ? 2 : COMPARE_OPS.includes(op) || SEARCH_OPS.includes(op) ? 1 : 0);
  const esc = (s) => String(s).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]);

  let st = null;
  let widths = [], xs = [0], fitted = [], labelW = 50;
  let cache = new Map(), labels = new Map();
  let anchor = null, focus = null, selKind = 'cells';
  let lastReport = '';
  const measure = document.createElement('canvas').getContext('2d');
  const textWidth = (s, bold) => {
    const font = getComputedStyle($('probe')).font;
    measure.font = bold ? 'bold ' + font : font;
    return measure.measureText(s).width;
  };

  function layout() {
    const h = rowHeight(parseFloat(getComputedStyle($('probe')).fontSize));
    if (h !== ROW_H) {
      ROW_H = h;
      pinned = null;
      document.body.style.setProperty('--row-h', h + 'px');
    }
    xs = [0];
    for (const w of widths) xs.push(xs[xs.length - 1] + w);
    canvas.style.width = labelW + xs[xs.length - 1] + 'px';
    canvas.style.height = HEAD_H + canvasRowsHeight(rowsHeight()) + 'px';
  }

  // Scrolling. A table taller than MAX_SCROLL_HEIGHT scrolls a canvas of that
  // height, so each scroll pixel spans several px of rows: rowsTop() maps the
  // scroll position to rows, and rows are placed relative to the viewport.
  const rowsHeight = () => (st ? st.numRows : 0) * ROW_H;
  const viewHeight = () => Math.max(0, grid.clientHeight - HEAD_H);
  // Where scrollRowsTo() last scrolled, with the exact offset into the rows it
  // asked for: in a tall table the scroll position alone can't say which row
  // is at the top, so a key press would otherwise land a row off.
  let pinned = null;
  // How far down the rows (rowsHeight() px tall) the viewport starts.
  function rowsOffset() {
    const total = rowsHeight(), view = viewHeight();
    if (pinned && pinned.scroll === grid.scrollTop && total > MAX_SCROLL_HEIGHT) return Math.min(pinned.top, Math.max(0, total - view));
    pinned = null;
    return rowsTop(grid.scrollTop, grid.scrollHeight - grid.clientHeight, total, view);
  }
  // Scrolls so the viewport starts top px down the rows.
  function scrollRowsTo(top) {
    const total = rowsHeight(), view = viewHeight();
    top = Math.max(0, Math.min(top, total - view));
    grid.scrollTop = scrollTopFor(top, grid.scrollHeight - grid.clientHeight, total, view);
    pinned = total > MAX_SCROLL_HEIGHT ? { scroll: grid.scrollTop, top } : null;
  }

  function colAt(x) {
    let lo = 0, hi = widths.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (xs[mid] <= x) lo = mid; else hi = mid - 1;
    }
    return Math.max(0, lo);
  }

  function range() {
    if (!anchor || !focus || !st) return null;
    if (selKind === 'all') return { r0: 0, r1: st.numRows - 1, c0: 0, c1: st.numCols - 1 };
    const r = { r0: Math.min(anchor.r, focus.r), r1: Math.max(anchor.r, focus.r), c0: Math.min(anchor.c, focus.c), c1: Math.max(anchor.c, focus.c) };
    if (selKind === 'cols') { r.r0 = 0; r.r1 = st.numRows - 1; }
    if (selKind === 'rows') { r.c0 = 0; r.c1 = st.numCols - 1; }
    return r;
  }

  function value(r, c) {
    const block = cache.get(Math.floor(r / BR) + ':' + Math.floor(c / BC));
    return Array.isArray(block) ? block[c % BC][r % BR] : undefined;
  }

  function rowLabel(r) {
    if (!st.hasRowLabels) return String(r + 1);
    const block = labels.get(Math.floor(r / BR));
    return Array.isArray(block) ? block[r % BR] : '';
  }

  function request(r0, r1, c0, c1) {
    for (let rb = Math.floor(r0 / BR); rb <= Math.floor(r1 / BR); rb++) {
      const rows = [rb * BR, Math.min(st.numRows - 1, rb * BR + BR - 1)];
      for (let cb = Math.floor(c0 / BC); cb <= Math.floor(c1 / BC); cb++) {
        const key = rb + ':' + cb;
        if (!cache.has(key)) {
          cache.set(key, 'pending');
          vscode.postMessage({ type: 'fetch', key, rows, cols: [cb * BC, Math.min(st.numCols - 1, cb * BC + BC - 1)] });
        }
      }
      if (st.hasRowLabels && !labels.has(rb)) {
        labels.set(rb, 'pending');
        vscode.postMessage({ type: 'fetchLabels', block: rb, rows });
      }
    }
  }

  function render() {
    const sl = grid.scrollLeft, stp = grid.scrollTop, offset = rowsOffset();
    headerEl.style.top = stp + 'px';
    labelsEl.style.left = sl + 'px';
    corner.style.left = sl + 'px';
    corner.style.top = stp + 'px';
    corner.style.width = labelW + 'px';
    if (!st || !st.numCols) { cellsEl.innerHTML = headerEl.innerHTML = labelsEl.innerHTML = ''; return; }
    const c0 = colAt(sl), c1 = colAt(sl + grid.clientWidth - labelW);
    const hasRows = st.numRows > 0;
    const r0 = Math.min(Math.max(0, Math.floor(offset / ROW_H)), Math.max(0, st.numRows - 1));
    const r1 = Math.min(st.numRows - 1, Math.floor((offset + grid.clientHeight - HEAD_H) / ROW_H) + 1);
    if (hasRows) request(r0, r1, c0, c1);
    const sel = range();
    const keys = st.sortKeys;
    let h = '';
    for (let c = c0; c <= c1; c++) {
      const col = st.schema[c] || { name: '', type: '' };
      const k = keys.findIndex((s) => s.column_index === c);
      const arrow = k < 0 ? '' : (keys[k].ascending ? '▲' : '▼') + (keys.length > 1 ? k + 1 : '');
      const selected = sel && selKind !== 'rows' && c >= sel.c0 && c <= sel.c1 && (selKind === 'cols' || selKind === 'all');
      h += '<div class="h' + (selected ? ' sel' : '') + '" data-c="' + c + '" style="left:' + (labelW + xs[c]) + 'px;width:' + widths[c] + 'px" title="' + esc(col.name + ' (' + col.type + ')') + '">' +
        '<div class="name">' + esc(col.name) + '</div><div class="type">' + esc(col.type) + '</div>' +
        '<span class="sort">' + arrow + '</span><button class="fbtn" title="Filter by this column">⏷</button><div class="resize"></div></div>';
    }
    headerEl.innerHTML = h;
    let cells = '', ls = '', count = 0;
    // Rows sit relative to the viewport: offset is where it starts in the rows,
    // stp where it is on the canvas (the same, unless the table is tall).
    const dy = HEAD_H + (stp - offset);
    for (let r = hasRows ? r0 : 0; hasRows && r <= r1; r++) {
      const top = dy + r * ROW_H;
      const rowSel = sel && r >= sel.r0 && r <= sel.r1;
      ls += '<div class="l' + (rowSel && (selKind === 'rows' || selKind === 'all') ? ' sel' : '') + '" data-r="' + r + '" style="top:' + top + 'px;width:' + labelW + 'px" title="' + esc(rowLabel(r)) + '">' + esc(rowLabel(r)) + '</div>';
      for (let c = c0; c <= c1; c++) {
        const v = value(r, c);
        const special = typeof v === 'number';
        const text = v === undefined ? '' : special ? SPECIAL[v] ?? '?' : v;
        let cls = 'c';
        if (NUMERIC.has((st.schema[c] || {}).display)) cls += ' n';
        if (special) cls += ' s';
        if (v === undefined) cls += ' pending';
        if (rowSel && c >= sel.c0 && c <= sel.c1) cls += ' sel';
        if (focus && focus.r === r && focus.c === c) cls += ' focus';
        cells += '<div class="' + cls + '" style="left:' + (labelW + xs[c]) + 'px;top:' + top + 'px;width:' + widths[c] + 'px" title="' + esc(text) + '">' + esc(text) + '</div>';
        count++;
      }
    }
    cellsEl.innerHTML = cells;
    labelsEl.innerHTML = ls;
    const v = hasRows ? value(r0, c0) : undefined;
    const report = {
      row: r0, col: c0, text: v === undefined ? '' : typeof v === 'number' ? SPECIAL[v] : v, cells: count,
      filterForm: getComputedStyle($('popover')).display !== 'none',
    };
    const key = JSON.stringify(report);
    if (key !== lastReport && (v !== undefined || !hasRows)) {
      lastReport = key;
      vscode.postMessage({ type: 'rendered', render: report });
    }
  }

  // Redraws happen right away, not on an animation frame: an unfocused window
  // throttles frames (and timers) almost to a stop, which would leave fetched
  // values undrawn. Messages and scroll events still arrive promptly.
  grid.addEventListener('scroll', render);
  new ResizeObserver(render).observe(grid);
  // The probe's height follows the editor font size, which sets ROW_H.
  new ResizeObserver(() => { layout(); render(); }).observe($('probe'));

  // In a tall table one scroll pixel spans several px of rows, so the wheel
  // would race through them: move through the rows directly instead, at the
  // wheel's usual speed. Shift+wheel scrolls sideways, as before.
  grid.addEventListener('wheel', (e) => {
    if (!st || rowsHeight() <= MAX_SCROLL_HEIGHT || e.ctrlKey || e.shiftKey || !e.deltaY) return;
    e.preventDefault();
    const unit = e.deltaMode === 1 ? ROW_H : e.deltaMode === 2 ? viewHeight() : 1;
    const before = grid.scrollTop;
    grid.scrollLeft += e.deltaX * unit;
    scrollRowsTo(rowsOffset() + e.deltaY * unit);
    if (grid.scrollTop === before) render();
  }, { passive: false });

  function autoFit(cb, values) {
    let changed = false;
    values.forEach((col, i) => {
      const c = cb * BC + i;
      if (fitted[c]) return;
      fitted[c] = true;
      let w = widths[c];
      for (const v of col.slice(0, 100)) {
        w = Math.max(w, textWidth(typeof v === 'number' ? SPECIAL[v] ?? '' : v) + 14);
      }
      w = Math.min(400, Math.ceil(w));
      if (w !== widths[c]) { widths[c] = w; changed = true; }
    });
    if (changed) layout();
  }

  function fitLabels(block) {
    const w = Math.min(300, Math.ceil(Math.max(labelW, ...block.slice(0, 100).map((s) => textWidth(s) + 14))));
    if (w !== labelW) { labelW = w; layout(); }
  }

  function setState(next) {
    const sameSchema = st && st.schema.length === next.schema.length && st.schema.every((c, i) => c.name === next.schema[i].name);
    if (!st || next.gen !== st.gen) { cache = new Map(); labels = new Map(); }
    st = next;
    if (!sameSchema) {
      widths = st.schema.map((c) => Math.min(300, Math.ceil(Math.max(textWidth(c.name, true), textWidth(c.type)) + 34)));
      fitted = [];
      anchor = focus = null;
    }
    labelW = st.hasRowLabels ? Math.max(labelW, 50) : Math.ceil(textWidth(String(st.numRows)) + 14);
    if (focus && (focus.r >= st.numRows || focus.c >= st.numCols)) anchor = focus = null;
    const filtered = st.numRows !== st.unfilteredRows;
    $('shape').textContent = st.numRows.toLocaleString() + (filtered ? ' of ' + st.unfilteredRows.toLocaleString() : '') + ' rows × ' + st.numCols.toLocaleString() + ' columns';
    $('clearSort').disabled = !st.sortKeys.length;
    if (document.activeElement !== $('search')) $('search').value = st.search;
    renderFilters();
    updateCopy();
    $('overlay').hidden = !st.closed;
    $('overlay').textContent = st.closed || '';
    layout();
    render();
  }

  function filterLabel(f) {
    const name = f.column_schema ? f.column_schema.column_name : '';
    const p = f.params || {};
    if (f.filter_type === 'compare') return name + ' ' + (OP_LABEL[p.op] || p.op) + ' ' + p.value;
    if (f.filter_type === 'between' || f.filter_type === 'not_between') return name + ' ' + OP_LABEL[f.filter_type] + ' ' + p.left_value + ' and ' + p.right_value;
    if (f.filter_type === 'search') return name + ' ' + (OP_LABEL[p.search_type] || p.search_type) + ' "' + p.term + '"';
    return name + ' ' + (OP_LABEL[f.filter_type] || f.filter_type);
  }

  function renderFilters() {
    $('filters').innerHTML = st.rowFilters.map((f) =>
      '<span class="chip' + (f.is_valid === false ? ' invalid' : '') + '" title="' + esc(f.error_message || filterLabel(f)) + '">' + esc(filterLabel(f)) +
      '<button data-remove="' + esc(f.filter_id) + '" title="Remove filter">✕</button></span>').join('');
  }

  $('filters').addEventListener('click', (e) => {
    const id = e.target.dataset && e.target.dataset.remove;
    if (id) vscode.postMessage({ type: 'removeFilter', id });
  });

  // Filter form
  function openPopover(column, at) {
    if (!st || !st.schema.length) return;
    const pop = $('popover');
    $('fCol').innerHTML = st.schema.map((c, i) => '<option value="' + i + '">' + esc(c.name) + '</option>').join('');
    $('fCol').value = String(column);
    fillOps();
    $('fV1').value = $('fV2').value = '';
    pop.hidden = false;
    const x = Math.min(at.x, window.innerWidth - pop.offsetWidth - 8), y = Math.min(at.y, window.innerHeight - pop.offsetHeight - 8);
    pop.style.left = Math.max(4, x) + 'px';
    pop.style.top = Math.max(4, y) + 'px';
    ($('fV1').hidden ? $('fOp') : $('fV1')).focus();
  }
  function fillOps() {
    const ops = opsFor(st.schema[+$('fCol').value].display);
    $('fOp').innerHTML = ops.map((o) => '<option value="' + o + '">' + esc(OP_LABEL[o]) + '</option>').join('');
    showValues();
  }
  function showValues() {
    const n = arity($('fOp').value);
    $('fV1').hidden = n < 1;
    $('fV2').hidden = n < 2;
  }
  $('fCol').onchange = fillOps;
  $('fOp').onchange = showValues;
  const closePopover = () => { $('popover').hidden = true; grid.focus(); };
  $('fCancel').onclick = closePopover;
  $('fApply').onclick = () => {
    const column_index = +$('fCol').value, op = $('fOp').value, v1 = $('fV1').value, v2 = $('fV2').value;
    let spec;
    if (COMPARE_OPS.includes(op)) spec = { column_index, filter_type: 'compare', params: { op, value: v1 } };
    else if (op === 'between' || op === 'not_between') spec = { column_index, filter_type: op, params: { left_value: v1, right_value: v2 } };
    else if (SEARCH_OPS.includes(op)) spec = { column_index, filter_type: 'search', params: { search_type: op, term: v1, case_sensitive: false } };
    else spec = { column_index, filter_type: op };
    vscode.postMessage({ type: 'addFilter', spec });
    closePopover();
  };
  $('popover').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('fApply').click();
    if (e.key === 'Escape') closePopover();
  });
  $('addFilter').onclick = (e) => {
    const r = e.target.getBoundingClientRect();
    openPopover(focus ? focus.c : 0, { x: r.left, y: r.bottom + 4 });
  };

  let searchTimer;
  $('search').addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => vscode.postMessage({ type: 'search', term: $('search').value }), 300);
  });
  $('clearSort').onclick = () => vscode.postMessage({ type: 'sort', keys: [] });

  function toggleSort(c, multi) {
    let keys = st.sortKeys.map((k) => ({ ...k }));
    const i = keys.findIndex((k) => k.column_index === c);
    const next = i < 0 ? true : keys[i].ascending ? false : null;
    if (!multi) keys = next === null ? [] : [{ column_index: c, ascending: next }];
    else if (i < 0) keys.push({ column_index: c, ascending: true });
    else if (next === null) keys.splice(i, 1);
    else keys[i].ascending = next;
    vscode.postMessage({ type: 'sort', keys });
  }

  // Selection and copy
  function updateCopy() {
    const none = !range();
    $('copy').disabled = $('copyCsv').disabled = none;
  }
  function select(r, c, extend, kind) {
    if (!extend || !anchor) anchor = { r, c };
    focus = { r, c };
    selKind = kind || 'cells';
    updateCopy();
    render();
  }
  function copy(format) {
    const r = range();
    if (r) vscode.postMessage({ type: 'copy', range: r, format });
  }
  $('copy').onclick = () => copy('tsv');
  $('copyCsv').onclick = () => copy('csv');

  function cellAt(e) {
    const rect = grid.getBoundingClientRect();
    const x = e.clientX - rect.left, y = e.clientY - rect.top;
    if (x > grid.clientWidth || y > grid.clientHeight) return null;
    const r = Math.floor((y - HEAD_H + rowsOffset()) / ROW_H), c = colAt(x + grid.scrollLeft - labelW);
    return { r: Math.max(0, Math.min(st.numRows - 1, r)), c: Math.max(0, Math.min(st.numCols - 1, c)), header: y < HEAD_H, label: x < labelW };
  }

  let dragging = null;
  grid.addEventListener('mousedown', (e) => {
    if (!st || e.button !== 0) return;
    const target = e.target;
    if (target.classList.contains('resize')) {
      const c = +target.parentElement.dataset.c;
      dragging = { resize: c, x: e.clientX, w: widths[c] };
      e.preventDefault();
      return;
    }
    if (target.classList.contains('fbtn')) {
      const r = target.getBoundingClientRect();
      openPopover(+target.parentElement.dataset.c, { x: r.left, y: r.bottom + 4 });
      e.preventDefault();
      return;
    }
    const h = target.closest('.h');
    if (h) {
      const c = +h.dataset.c;
      if (e.metaKey || e.ctrlKey) select(0, c, e.shiftKey, 'cols');
      else toggleSort(c, e.shiftKey);
      return;
    }
    if (target === corner || corner.contains(target)) { anchor = { r: 0, c: 0 }; focus = { r: 0, c: 0 }; selKind = 'all'; updateCopy(); render(); return; }
    if (!st.numRows) return;
    const l = target.closest('.l');
    if (l) { select(+l.dataset.r, focus ? focus.c : 0, e.shiftKey, 'rows'); dragging = { kind: 'rows' }; return; }
    const at = cellAt(e);
    if (!at || at.header || at.label) return;
    select(at.r, at.c, e.shiftKey, 'cells');
    dragging = { kind: 'cells' };
    grid.focus();
  });
  window.addEventListener('mousemove', (e) => {
    if (!dragging || !st) return;
    if (dragging.resize !== undefined) {
      widths[dragging.resize] = Math.max(40, dragging.w + e.clientX - dragging.x);
      fitted[dragging.resize] = true;
      layout();
      render();
      return;
    }
    const at = cellAt(e);
    if (at && !at.header) { focus = dragging.kind === 'rows' ? { r: at.r, c: focus.c } : { r: at.r, c: at.c }; render(); }
  });
  window.addEventListener('mouseup', () => { dragging = null; });

  function reveal(r, c) {
    const top = r * ROW_H, offset = rowsOffset(), left = labelW + xs[c];
    if (top < offset) scrollRowsTo(top);
    else if (top + ROW_H > offset + viewHeight()) scrollRowsTo(top + ROW_H - viewHeight());
    if (left - labelW < grid.scrollLeft) grid.scrollLeft = left - labelW;
    else if (left + widths[c] > grid.scrollLeft + grid.clientWidth) grid.scrollLeft = left + widths[c] - grid.clientWidth;
  }

  grid.addEventListener('keydown', (e) => {
    if (!st || !st.numRows || !st.numCols) return;
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key === 'c') { copy('tsv'); e.preventDefault(); return; }
    if (mod && e.key === 'a') { anchor = { r: 0, c: 0 }; focus = { r: 0, c: 0 }; selKind = 'all'; updateCopy(); render(); e.preventDefault(); return; }
    if (e.key === 'Escape') { anchor = focus = null; updateCopy(); render(); return; }
    const page = Math.max(1, Math.floor((grid.clientHeight - HEAD_H) / ROW_H) - 1);
    const f = focus || { r: 0, c: 0 };
    const moves = {
      ArrowUp: [mod ? -f.r : -1, 0], ArrowDown: [mod ? st.numRows : 1, 0],
      ArrowLeft: [0, mod ? -f.c : -1], ArrowRight: [0, mod ? st.numCols : 1],
      PageUp: [-page, 0], PageDown: [page, 0],
      Home: [mod ? -f.r : 0, -f.c], End: [mod ? st.numRows : 0, st.numCols],
    };
    const m = moves[e.key];
    if (!m) return;
    e.preventDefault();
    const r = Math.max(0, Math.min(st.numRows - 1, f.r + m[0])), c = Math.max(0, Math.min(st.numCols - 1, f.c + m[1]));
    reveal(r, c);
    select(r, c, e.shiftKey, e.shiftKey ? selKind : 'cells');
  });

  window.addEventListener('message', ({ data }) => {
    switch (data.type) {
      case 'state':
        setState(data);
        break;
      case 'block':
        if (!st || data.gen !== st.gen) return;
        cache.set(data.key, data.values);
        autoFit(+data.key.split(':')[1], data.values);
        render();
        break;
      case 'labels':
        if (!st || data.gen !== st.gen) return;
        labels.set(data.block, data.labels);
        fitLabels(data.labels);
        render();
        break;
      case 'fetchFailed':
        if (data.key) cache.set(data.key, 'failed');
        if (data.block !== undefined) labels.set(data.block, []);
        break;
      case 'closed':
        if (st) st.closed = data.message;
        $('overlay').hidden = false;
        $('overlay').textContent = data.message;
        break;
      case 'error':
        $('overlay').hidden = false;
        $('overlay').textContent = data.message;
        break;
      case 'simulate':
        if (data.key) grid.dispatchEvent(new KeyboardEvent('keydown', { key: data.key, ctrlKey: !!data.mod }));
        else if (data.wheel !== undefined) grid.dispatchEvent(new WheelEvent('wheel', { deltaY: data.wheel, cancelable: true }));
        else grid.scrollTop = data.scroll * (grid.scrollHeight - grid.clientHeight);
        break;
    }
  });
  vscode.postMessage({ type: 'ready' });
</script>
</body></html>`;
}
