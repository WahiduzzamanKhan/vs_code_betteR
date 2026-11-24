import * as cp from 'child_process';
import * as vscode from 'vscode';
import type { Session } from './session';

/**
 * Whether an object named `name` matches the Environment view's filter:
 * case-insensitive, by substring, or by `*` / `?` wildcards when it has any.
 */
export function matchesFilter(name: string, filter: string): boolean {
    const f = filter.trim().toLowerCase();
    if (!f) {
        return true;
    }
    const n = name.toLowerCase();
    if (!/[*?]/.test(f)) {
        return n.includes(f);
    }
    const pattern = f.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
    return new RegExp(`^${pattern}$`).test(n);
}

/** A variable as ark's variables comm describes it. */
export interface RVariable {
    access_key: string;
    display_name: string;
    display_value: string;
    display_type: string;
    type_info: string;
    size: number;
    kind: string;
    length: number;
    has_children: boolean;
    is_truncated: boolean;
}

export type EnvNode =
    /** An object in the environment, or a child of one; `path` is its access-key path. */
    | { type: 'var'; variable: RVariable; path: string[]; hidden: boolean }
    /** An entry on the search path (`search()`). */
    | { type: 'search'; name: string; version: string }
    /** An object in a search path entry. */
    | { type: 'object'; env: string; name: string }
    | { type: 'namespace'; name: string; version: string; attached: boolean }
    | { type: 'info'; label: string; value: string }
    | { type: 'more'; count: number };

interface SessionState {
    search: string[];
    searchVersions: string[];
    namespaces: string[];
    namespaceVersions: string[];
    rVersion: string;
    platform: string;
    wd: string;
}

interface HiddenObject {
    name: string;
    type: string;
    value: string;
    children: boolean;
}

/** R's JSON conversion makes length-1 vectors scalars and empty ones null. */
function arr<T>(v: T | T[] | null | undefined): T[] {
    return v === null || v === undefined ? [] : Array.isArray(v) ? v : [v];
}

const rString = (s: string) => JSON.stringify(s);

const RESERVED = new Set(
    'if else repeat while function for next break TRUE FALSE NULL Inf NaN NA NA_integer_ NA_real_ NA_character_ NA_complex_ in'.split(' '),
);

/** `name` as R code: backticked unless it's a syntactic name. */
export function rName(name: string): string {
    const syntactic = /^((([A-Za-z]|[.][._A-Za-z])[._A-Za-z0-9]*)|[.])$/.test(name) && !RESERVED.has(name);
    return syntactic ? name : '`' + name.replace(/\\/g, '\\\\').replace(/`/g, '\\`') + '`';
}

/** R code that refers to `node`'s object, if it has a simple one. */
export function rExpression(node: EnvNode): string | undefined {
    if (node.type === 'var' && node.path.length === 1) {
        return rName(node.variable.display_name);
    }
    if (node.type === 'object') {
        return node.env.startsWith('package:')
            ? `${node.env.slice('package:'.length)}::${rName(node.name)}`
            : `get(${rString(node.name)}, envir = as.environment(${rString(node.env)}))`;
    }
    return undefined;
}

const STATE_CODE = `local({
  ver <- function(p) tryCatch(as.character(getNamespaceVersion(p)), error = function(e) "")
  s <- search()
  ns <- sort(loadedNamespaces())
  list(
    search = s,
    search_versions = vapply(s, function(x) if (startsWith(x, "package:")) ver(substring(x, 9)) else "", "", USE.NAMES = FALSE),
    namespaces = ns,
    namespace_versions = vapply(ns, ver, "", USE.NAMES = FALSE),
    r_version = R.version.string,
    platform = R.version$platform,
    wd = getwd()
  )
})`;

/** Hidden (dot-named) objects of the global env, which ark's variables comm leaves out. */
const HIDDEN_CODE = `local({
  e <- globalenv()
  n <- ls(e, all.names = TRUE, sorted = TRUE)
  lapply(n[startsWith(n, ".")], function(k) {
    x <- get(k, envir = e)
    v <- tryCatch(paste(trimws(utils::capture.output(utils::str(x, max.level = 0, give.attr = FALSE, give.head = FALSE, vec.len = 3))), collapse = " "), error = function(err) "")
    list(name = k, type = class(x)[[1]], value = substr(v, 1, 200), children = (is.list(x) || is.environment(x) || isS4(x)) && length(x) > 0)
  })
})`;

const KIND_ICONS: Record<string, string> = {
    boolean: 'symbol-boolean',
    bytes: 'file-binary',
    class: 'symbol-class',
    collection: 'symbol-array',
    empty: 'circle-slash',
    function: 'symbol-method',
    map: 'symbol-structure',
    number: 'symbol-number',
    string: 'symbol-string',
    table: 'table',
    lazy: 'clock',
    connection: 'plug',
};

function formatBytes(n: number): string {
    if (n < 1024) {
        return `${n} B`;
    }
    const units = ['KB', 'MB', 'GB', 'TB'];
    let v = n / 1024;
    let i = 0;
    while (v >= 1024 && i < units.length - 1) {
        v /= 1024;
        i++;
    }
    return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}

/**
 * Memory of a process in bytes: resident set size from `ps` on macOS and
 * Linux, working set from `tasklist` on Windows. Undefined if unknown.
 */
function processMemory(pid: number): Promise<number | undefined> {
    const [command, args, parse] =
        process.platform === 'win32'
            ? ['tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], parseTasklistMemory]
            : ['ps', ['-o', 'rss=', '-p', String(pid)], (out: string) => Number(out.trim()) || undefined];
    return new Promise((resolve) =>
        cp.execFile(command, args, { windowsHide: true }, (err, out) => {
            const kb = err ? undefined : parse(out);
            resolve(kb === undefined ? undefined : kb * 1024);
        }),
    );
}

/**
 * The "Mem Usage" column (KB) of `tasklist /FO CSV /NH` output, e.g.
 * `"better.exe","1234","Console","1","123,456 K"`. Its thousands separator
 * and unit depend on the locale (`123.456 K`, `123 456 Ko`), so only digits
 * count. When no process matches, tasklist prints an `INFO:` line instead.
 */
export function parseTasklistMemory(out: string): number | undefined {
    const line = out.split(/\r?\n/).find((l) => l.startsWith('"'));
    const columns = line?.slice(1, -1).split('","');
    const kb = columns && columns.length >= 5 ? Number(columns[columns.length - 1].replace(/\D/g, '')) : NaN;
    return kb > 0 ? kb : undefined;
}

class Provider implements vscode.TreeDataProvider<EnvNode> {
    private readonly changes = new vscode.EventEmitter<EnvNode | undefined>();
    readonly onDidChangeTreeData = this.changes.event;

    constructor(
        private readonly roots: () => EnvNode[] | Promise<EnvNode[]>,
        private readonly children: (node: EnvNode) => Promise<EnvNode[]>,
        private readonly item: (node: EnvNode) => vscode.TreeItem,
    ) {}

    refresh(): void {
        this.changes.fire(undefined);
    }

    getTreeItem(node: EnvNode): vscode.TreeItem {
        return this.item(node);
    }

    getChildren(node?: EnvNode): EnvNode[] | Promise<EnvNode[]> {
        return node ? this.children(node) : this.roots();
    }

    dispose(): void {
        this.changes.dispose();
    }
}

/**
 * The R environment explorer in the secondary side bar: objects in the global
 * env (or the debug frame while R is paused) from ark's variables comm, the
 * search path, loaded namespaces and session info. The last three, and hidden
 * objects, are read with silent `evaluate_code` requests after each prompt.
 */
export class EnvironmentExplorer implements vscode.Disposable {
    /** Objects in the selected environment, sorted by name; undefined until ark first reports. */
    variables: RVariable[] | undefined;
    hidden: HiddenObject[] = [];
    state: SessionState | undefined;
    memory: number | undefined;
    showHidden = false;
    /** Shows only top-level objects whose names match; see `matchesFilter`. */
    filter = '';
    /** R is at a browser prompt, so ark reports the debug frame's objects. */
    browsing = false;
    private session: Session | undefined;
    private sessionListeners: vscode.Disposable[] = [];
    private stateTimer: NodeJS.Timeout | undefined;
    private stale = true;
    private refreshing: Promise<void> | undefined;
    /** Names removed with `delete` that ark hasn't reported gone yet. */
    private readonly deleted = new Set<string>();
    readonly environment: Provider;
    readonly searchPath: Provider;
    readonly namespaces: Provider;
    readonly info: Provider;
    private readonly views: vscode.TreeView<EnvNode>[];
    private readonly disposables: vscode.Disposable[] = [];

    constructor() {
        this.environment = new Provider(
            () => this.environmentRoots(),
            (node) => this.inspect(node),
            (node) => this.treeItem(node),
        );
        this.searchPath = new Provider(
            () =>
                (this.state?.search ?? []).map((name, i) => ({ type: 'search', name, version: this.state!.searchVersions[i] ?? '' })),
            (node) => this.searchChildren(node),
            (node) => this.treeItem(node),
        );
        this.namespaces = new Provider(
            () => {
                const attached = new Set(this.state?.search ?? []);
                return (this.state?.namespaces ?? []).map((name, i) => ({
                    type: 'namespace',
                    name,
                    version: this.state!.namespaceVersions[i] ?? '',
                    attached: attached.has(`package:${name}`),
                }));
            },
            async () => [],
            (node) => this.treeItem(node),
        );
        this.info = new Provider(
            () => this.infoRoots(),
            async () => [],
            (node) => this.treeItem(node),
        );
        this.views = [
            vscode.window.createTreeView('betteR.environment', { treeDataProvider: this.environment, showCollapseAll: true }),
            vscode.window.createTreeView('betteR.searchPath', { treeDataProvider: this.searchPath, showCollapseAll: true }),
            vscode.window.createTreeView('betteR.namespaces', { treeDataProvider: this.namespaces }),
            vscode.window.createTreeView('betteR.sessionInfo', { treeDataProvider: this.info }),
        ];
        for (const view of this.views) {
            this.disposables.push(
                view,
                view.onDidChangeVisibility(({ visible }) => visible && this.stale && this.scheduleStateRefresh(0)),
            );
        }
        this.disposables.push(this.environment, this.searchPath, this.namespaces, this.info);
        void vscode.commands.executeCommand('setContext', 'betteR.showHidden', false);
        void vscode.commands.executeCommand('setContext', 'betteR.envFiltered', false);
        this.updateMessages();
    }

    /** Follows a (new) session: R was started or restarted. */
    attach(session: Session | undefined): void {
        this.sessionListeners.forEach((d) => d.dispose());
        this.session = session;
        this.variables = undefined;
        this.deleted.clear();
        this.hidden = [];
        this.state = undefined;
        this.memory = undefined;
        this.browsing = false;
        this.sessionListeners = session
            ? [
                  session.onVariablesEvent((e) => this.onVariablesEvent(e.method, e.params)),
                  session.onPromptState((p) => {
                      this.browsing = /^Browse\[\d+\]>/.test(p.input_prompt);
                      this.updateMessages();
                      this.scheduleStateRefresh();
                  }),
              ]
            : [];
        this.refreshAll();
        if (session) {
            this.scheduleStateRefresh(0);
        }
    }

    /**
     * `fromArk`: pushed by ark after an execution, rather than our own `list`.
     * Ark doesn't rescan after `delete`, and `list` returns its last scan, so
     * deleted names are hidden here until ark's next update reports them gone.
     */
    private onVariablesEvent(method: string, params: unknown, fromArk = true): void {
        if (fromArk) {
            this.deleted.clear();
        }
        if (method === 'refresh') {
            this.variables = arr((params as { variables: RVariable[] }).variables);
        } else if (method === 'update') {
            const { assigned, removed } = params as { assigned: RVariable[]; removed: string[] };
            const byKey = new Map((this.variables ?? []).map((v) => [v.access_key, v]));
            for (const key of arr(removed)) {
                byKey.delete(key);
            }
            for (const v of arr(assigned)) {
                byKey.set(v.access_key, v);
            }
            this.variables = [...byKey.values()].sort((a, b) => (a.display_name < b.display_name ? -1 : a.display_name > b.display_name ? 1 : 0));
        } else {
            return;
        }
        if (this.deleted.size) {
            this.variables = this.variables.filter((v) => !this.deleted.has(v.access_key));
        }
        this.updateMessages();
        this.environment.refresh();
    }

    private get anyVisible(): boolean {
        return this.views.some((v) => v.visible);
    }

    /** Re-reads the search path, namespaces, session info and hidden objects, once R is back at a prompt. */
    private scheduleStateRefresh(delay = 250): void {
        this.stale = true;
        clearTimeout(this.stateTimer);
        this.stateTimer = setTimeout(() => {
            if (this.anyVisible) {
                void this.refreshState();
            }
        }, delay);
    }

    async refreshState(): Promise<void> {
        // One request at a time; a prompt during it schedules another.
        if (this.refreshing) {
            return this.refreshing;
        }
        const session = this.session;
        if (!session) {
            return;
        }
        this.stale = false;
        this.refreshing = (async () => {
            try {
                const raw = await session.evaluate<Record<string, unknown>>(STATE_CODE);
                const hidden =
                    this.showHidden && !this.browsing ? arr(await session.evaluate<HiddenObject[] | HiddenObject>(HIDDEN_CODE)) : [];
                if (session !== this.session) {
                    return;
                }
                this.state = {
                    search: arr(raw.search as string[]),
                    searchVersions: arr(raw.search_versions as string[]),
                    namespaces: arr(raw.namespaces as string[]),
                    namespaceVersions: arr(raw.namespace_versions as string[]),
                    rVersion: String(raw.r_version ?? ''),
                    platform: String(raw.platform ?? ''),
                    wd: String(raw.wd ?? ''),
                };
                this.hidden = hidden;
                this.memory = session.kernel.pid ? await processMemory(session.kernel.pid) : undefined;
                this.refreshAll();
            } catch {
                // R is busy or the console isn't connected yet; the next prompt retries.
                this.stale = true;
            } finally {
                this.refreshing = undefined;
            }
        })();
        return this.refreshing;
    }

    /** Re-reads everything, including the full variable list. */
    async refresh(): Promise<void> {
        const session = this.session;
        if (!session) {
            return;
        }
        try {
            const list = await session.commRpc<{ variables: RVariable[] }>('variables', 'list');
            if (session === this.session) {
                this.onVariablesEvent('refresh', list, false);
            }
        } catch {
            // Shown as stale; the next prompt updates it.
        }
        await this.refreshState();
    }

    async setShowHidden(show: boolean): Promise<void> {
        this.showHidden = show;
        await vscode.commands.executeCommand('setContext', 'betteR.showHidden', show);
        if (!show) {
            this.hidden = [];
            this.environment.refresh();
        }
        await this.refreshState();
    }

    setFilter(filter: string): void {
        this.filter = filter.trim();
        void vscode.commands.executeCommand('setContext', 'betteR.envFiltered', !!this.filter);
        this.updateMessages();
        this.environment.refresh();
    }

    /**
     * Asks for a filter, applying it as it's typed. Escape restores the one
     * there was before; an empty filter shows everything.
     */
    async promptFilter(): Promise<void> {
        const previous = this.filter;
        const input = vscode.window.createInputBox();
        input.title = 'Filter R Environment';
        input.placeholder = 'Object name, or a pattern such as df_* (case-insensitive)';
        input.value = previous;
        let accepted = false;
        await new Promise<void>((resolve) => {
            input.onDidChangeValue((v) => this.setFilter(v));
            input.onDidAccept(() => {
                accepted = true;
                input.hide();
            });
            input.onDidHide(() => resolve());
            input.show();
        });
        input.dispose();
        if (!accepted) {
            this.setFilter(previous);
        }
    }

    /** Opens a data frame (or other table) in the data explorer. */
    async view(node: EnvNode): Promise<void> {
        if (node.type !== 'var' || !this.session) {
            return;
        }
        await this.session.commRpc('variables', 'view', { path: node.path });
    }

    async remove(nodes: EnvNode[]): Promise<void> {
        const names = nodes.flatMap((n) => (n.type === 'var' && n.path.length === 1 ? [n.variable.access_key] : []));
        if (!names.length || !this.session) {
            return;
        }
        const what = names.length === 1 ? `'${names[0]}'` : `${names.length} objects`;
        const choice = await vscode.window.showWarningMessage(`Remove ${what} from the R environment?`, { modal: true }, 'Remove');
        if (choice !== 'Remove') {
            return;
        }
        await this.session.commRpc('variables', 'delete', { names });
        for (const name of names) {
            this.deleted.add(name);
        }
        await this.refresh();
    }

    async clear(): Promise<void> {
        if (!this.session) {
            return;
        }
        const where = this.browsing ? 'the debug frame' : 'the global environment';
        const hidden = this.showHidden ? ', including hidden objects' : '';
        const choice = await vscode.window.showWarningMessage(
            `Remove all objects from ${where}${hidden}?`,
            { modal: true },
            'Clear',
        );
        if (choice !== 'Clear') {
            return;
        }
        await this.session.commRpc('variables', 'clear', { include_hidden_objects: this.showHidden });
        await this.refresh();
    }

    private environmentRoots(): EnvNode[] {
        return this.allEnvironmentRoots().filter((n) => n.type !== 'var' || matchesFilter(n.variable.display_name, this.filter));
    }

    private allEnvironmentRoots(): EnvNode[] {
        const visible: EnvNode[] = (this.variables ?? []).map((variable) => ({
            type: 'var',
            variable,
            path: [variable.access_key],
            hidden: false,
        }));
        if (!this.showHidden || this.browsing) {
            return visible;
        }
        const hidden: EnvNode[] = this.hidden.map((h) => ({
            type: 'var',
            hidden: true,
            path: [h.name],
            variable: {
                access_key: h.name,
                display_name: h.name,
                display_value: h.value,
                display_type: h.type,
                type_info: h.type,
                size: 0,
                kind: 'other',
                length: 0,
                has_children: h.children,
                is_truncated: false,
            },
        }));
        return [...hidden, ...visible];
    }

    private async inspect(node: EnvNode): Promise<EnvNode[]> {
        if (node.type !== 'var' || !this.session) {
            return [];
        }
        try {
            const reply = await this.session.commRpc<{ children: RVariable[]; length: number }>('variables', 'inspect', {
                path: node.path,
            });
            const children = arr(reply.children);
            const nodes: EnvNode[] = children.map((variable) => ({
                type: 'var',
                variable,
                path: [...node.path, variable.access_key],
                hidden: false,
            }));
            if (reply.length > children.length) {
                nodes.push({ type: 'more', count: reply.length - children.length });
            }
            return nodes;
        } catch (err) {
            return [{ type: 'info', label: 'Could not inspect', value: (err as Error).message }];
        }
    }

    private async searchChildren(node: EnvNode): Promise<EnvNode[]> {
        if (node.type !== 'search' || !this.session) {
            return [];
        }
        try {
            const names = arr(
                await this.session.evaluate<string[] | string>(`ls(as.environment(${rString(node.name)}), sorted = TRUE)`),
            );
            return names.map((name) => ({ type: 'object', env: node.name, name }));
        } catch (err) {
            return [{ type: 'info', label: 'Could not list', value: (err as Error).message }];
        }
    }

    private infoRoots(): EnvNode[] {
        const s = this.state;
        if (!s) {
            return [];
        }
        const nodes: EnvNode[] = [
            { type: 'info', label: 'R version', value: s.rVersion },
            { type: 'info', label: 'Platform', value: s.platform },
            { type: 'info', label: 'Working directory', value: s.wd },
        ];
        if (this.memory !== undefined) {
            nodes.push({ type: 'info', label: 'Memory (R process)', value: formatBytes(this.memory) });
        }
        nodes.push(
            { type: 'info', label: 'Attached packages', value: String(s.search.filter((e) => e.startsWith('package:')).length) },
            { type: 'info', label: 'Loaded namespaces', value: String(s.namespaces.length) },
        );
        if (this.session?.kernel.pid) {
            nodes.push({ type: 'info', label: 'Process ID', value: String(this.session.kernel.pid) });
        }
        return nodes;
    }

    private treeItem(node: EnvNode): vscode.TreeItem {
        switch (node.type) {
            case 'var': {
                const v = node.variable;
                const item = new vscode.TreeItem(
                    v.display_name,
                    v.has_children ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
                );
                item.id = `var:${node.hidden ? 'hidden:' : ''}${JSON.stringify(node.path)}`;
                item.description = v.display_value;
                item.iconPath = new vscode.ThemeIcon(KIND_ICONS[v.kind] ?? 'symbol-variable');
                const tooltip = new vscode.MarkdownString();
                tooltip.appendMarkdown(`**${v.display_name}** · ${v.type_info || v.display_type}`);
                if (v.size) {
                    tooltip.appendMarkdown(`  \nSize: ${formatBytes(v.size)}`);
                }
                if (v.display_value) {
                    tooltip.appendMarkdown('\n\n');
                    tooltip.appendCodeblock(v.display_value + (v.is_truncated ? ' …' : ''), 'r');
                }
                item.tooltip = tooltip;
                item.contextValue = (node.path.length === 1 ? 'rTopVariable' : 'rChildVariable') + (v.kind === 'table' ? 'Table' : '');
                return item;
            }
            case 'search': {
                const item = new vscode.TreeItem(node.name, vscode.TreeItemCollapsibleState.Collapsed);
                item.id = `search:${node.name}`;
                item.description = node.version;
                item.iconPath = new vscode.ThemeIcon(node.name.startsWith('package:') ? 'package' : 'symbol-namespace');
                item.contextValue = 'rSearchEntry';
                return item;
            }
            case 'object': {
                const item = new vscode.TreeItem(node.name);
                item.id = `object:${node.env}:${node.name}`;
                item.iconPath = new vscode.ThemeIcon('symbol-field');
                item.tooltip = rExpression(node);
                item.contextValue = 'rSearchObject';
                return item;
            }
            case 'namespace': {
                const item = new vscode.TreeItem(node.name);
                item.id = `ns:${node.name}`;
                item.description = node.attached ? `${node.version} · attached` : node.version;
                item.iconPath = new vscode.ThemeIcon(node.attached ? 'package' : 'library');
                item.contextValue = 'rNamespace';
                return item;
            }
            case 'info': {
                const item = new vscode.TreeItem(node.label);
                item.description = node.value;
                item.tooltip = `${node.label}: ${node.value}`;
                item.contextValue = 'rInfo';
                return item;
            }
            case 'more': {
                const item = new vscode.TreeItem(`… ${node.count} more`);
                item.tooltip = 'Not shown: too many entries';
                return item;
            }
        }
    }

    private updateMessages(): void {
        const [env, search, ns, info] = this.views;
        const waiting = this.session ? 'Waiting for the R console…' : 'The R session is not running.';
        const any = !!this.variables?.length || (this.showHidden && !this.browsing && this.hidden.length > 0);
        env.message =
            this.variables === undefined
                ? waiting
                : !any
                  ? 'The environment is empty.'
                  : this.filter && !this.environmentRoots().length
                    ? `No objects match '${this.filter}'.`
                    : undefined;
        const where = this.variables === undefined ? undefined : this.browsing ? 'Debug frame' : 'Global';
        env.description = this.filter ? `${where ? `${where} · ` : ''}filter: ${this.filter}` : where;
        for (const view of [search, ns, info]) {
            view.message = this.state ? undefined : waiting;
        }
    }

    private refreshAll(): void {
        this.updateMessages();
        this.environment.refresh();
        this.searchPath.refresh();
        this.namespaces.refresh();
        this.info.refresh();
    }

    /** Text to copy for `node`: an object's name, or an info row's value. */
    static copyText(node: EnvNode): string | undefined {
        switch (node.type) {
            case 'var':
                return node.path.length === 1 ? rName(node.variable.display_name) : node.variable.display_name;
            case 'object':
                return rExpression(node);
            case 'search':
            case 'namespace':
                return node.name;
            case 'info':
                return node.value;
            default:
                return undefined;
        }
    }

    dispose(): void {
        clearTimeout(this.stateTimer);
        this.sessionListeners.forEach((d) => d.dispose());
        this.disposables.forEach((d) => d.dispose());
    }
}
