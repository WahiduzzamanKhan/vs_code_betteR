import * as vscode from 'vscode';

/**
 * The console's own settings (`config.toml`, see the console's README), as
 * `betteR.console.<key>` VS Code settings. The extension passes only the ones
 * the user has set (user, workspace or folder scope) to the console as
 * `--set key=value`; the rest fall through to the console's `config.toml`.
 *
 * `startup.ark` is left out: in VS Code, `betteR.arkPath` decides the kernel.
 */
export const CONSOLE_SETTING_KEYS = [
    'startup.r_home',
    'startup.banner',
    'startup.inline_plots',
    'completion.lsp',
    'completion.popup',
    'completion.min_chars',
    'completion.delay_ms',
    'completion.accept',
    'completion.max_suggestions',
    'editing.newline',
    'history.size',
    'history.suggestions',
] as const;

export type ConsoleSettingKey = (typeof CONSOLE_SETTING_KEYS)[number];

/** The settings the user has set, by key. Unset keys are absent. */
export type ConsoleSettingValues = Partial<Record<ConsoleSettingKey, unknown>>;

/** The parts of `WorkspaceConfiguration.inspect()` that say where a value was set. */
export interface InspectedValue {
    globalValue?: unknown;
    workspaceValue?: unknown;
    workspaceFolderValue?: unknown;
}

/**
 * The value the user set, most specific scope first, or `undefined` if only
 * the default applies. A default doesn't count: it would hide `config.toml`.
 */
export function userSetValue(inspected: InspectedValue | undefined): unknown {
    if (!inspected) {
        return undefined;
    }
    return inspected.workspaceFolderValue ?? inspected.workspaceValue ?? inspected.globalValue;
}

/** `key=value` for `--set`, or `undefined` for a value the console can't be given (an object, say). */
function assignment(key: string, value: unknown): string | undefined {
    if (typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) {
        return `${key}=${value}`;
    }
    return undefined;
}

function setArgs(values: ConsoleSettingValues, keys: readonly ConsoleSettingKey[]): string[] {
    const args: string[] = [];
    for (const key of keys) {
        const a = assignment(key, values[key]);
        if (a !== undefined) {
            args.push('--set', a);
        }
    }
    return args;
}

/** Arguments for the console terminal: every setting the user set, in a fixed order. */
export function consoleArgs(values: ConsoleSettingValues): string[] {
    return setArgs(values, CONSOLE_SETTING_KEYS);
}

/**
 * Arguments for the kernel (`better --kernel`): only `startup.r_home`, and
 * nothing when a separate ark (`betteR.arkPath`) runs instead.
 */
export function kernelArgs(values: ConsoleSettingValues, arkOverride: boolean): string[] {
    return arkOverride ? [] : setArgs(values, ['startup.r_home']);
}

/** The `betteR.console.*` settings the user has set in VS Code. */
export function userConsoleSettings(): ConsoleSettingValues {
    const config = vscode.workspace.getConfiguration('betteR.console');
    const values: ConsoleSettingValues = {};
    for (const key of CONSOLE_SETTING_KEYS) {
        const value = userSetValue(config.inspect(key));
        if (value !== undefined) {
            values[key] = value;
        }
    }
    return values;
}
