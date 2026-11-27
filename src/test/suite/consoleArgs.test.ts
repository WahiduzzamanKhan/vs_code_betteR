import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { CONSOLE_SETTING_KEYS, consoleArgs, kernelArgs, userSetValue } from '../../consoleSettings';

const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../package.json'), 'utf8'));
const properties: Record<string, { type: string; default: unknown; enum?: string[]; minimum?: number; maximum?: number }> =
    pkg.contributes.configuration.properties;

suite('Console settings: arguments', () => {
    test('nothing set: no arguments for the console or the kernel', () => {
        assert.deepStrictEqual(consoleArgs({}), []);
        assert.deepStrictEqual(kernelArgs({}, false), []);
    });

    test('each set value becomes one --set key=value, in a fixed order', () => {
        assert.deepStrictEqual(
            consoleArgs(
                {
                    'history.size': 0,
                    'completion.accept': 'enter',
                    'startup.banner': false,
                    'completion.min_chars': 3,
                    'completion.delay_ms': 300,
                    'startup.r_home': '/opt/R 4.5/lib/R',
                },
            ),
            [
                '--set', 'startup.r_home=/opt/R 4.5/lib/R',
                '--set', 'startup.banner=false',
                '--set', 'completion.min_chars=3',
                '--set', 'completion.delay_ms=300',
                '--set', 'completion.accept=enter',
                '--set', 'history.size=0',
            ],
        );
    });

    test('every key is passed, with values as the console reads them', () => {
        const values = {
            'startup.r_home': '/r',
            'startup.banner': true,
            'startup.inline_plots': 'sixel',
            'completion.lsp': false,
            'completion.popup': 'tab',
            'completion.min_chars': 0,
            'completion.delay_ms': 2000,
            'completion.accept': 'tab',
            'completion.max_suggestions': 50,
            'editing.newline': 'opt_enter',
            'history.size': 10000,
            'history.suggestions': false,
        } as const;
        assert.deepStrictEqual(Object.keys(values), [...CONSOLE_SETTING_KEYS]);
        const args = consoleArgs(values);
        assert.deepStrictEqual(
            args.filter((_, i) => i % 2 === 1),
            Object.entries(values).map(([k, v]) => `${k}=${v}`),
        );
        assert.ok(args.filter((_, i) => i % 2 === 0).every((a) => a === '--set'));
    });

    test('a value equal to the default is still passed when the user set it (it overrides config.toml)', () => {
        assert.deepStrictEqual(consoleArgs({ 'completion.max_suggestions': 5, 'startup.r_home': '' }), [
            '--set', 'startup.r_home=',
            '--set', 'completion.max_suggestions=5',
        ]);
    });

    test('values the console has no syntax for are left out', () => {
        assert.deepStrictEqual(
            consoleArgs(
                {
                    'completion.max_suggestions': { rows: 3 },
                    'history.size': null,
                    'completion.min_chars': Number.NaN,
                    'completion.delay_ms': [1],
                    'startup.banner': false,
                },
            ),
            ['--set', 'startup.banner=false'],
        );
    });

    test('an out-of-range value is passed as is, for the console to warn about', () => {
        assert.deepStrictEqual(consoleArgs({ 'completion.max_suggestions': 99 }), ['--set', 'completion.max_suggestions=99']);
    });

    test('editing.newline is passed only when the user set it', () => {
        assert.deepStrictEqual(consoleArgs({}), []);
        for (const v of ['auto', 'shift_enter', 'alt_enter', 'opt_enter']) {
            assert.deepStrictEqual(consoleArgs({ 'editing.newline': v }), ['--set', `editing.newline=${v}`]);
        }
    });

    test('the kernel gets only startup.r_home, and nothing with a separate ark', () => {
        const values = { 'startup.r_home': '/opt/R', 'startup.banner': false, 'completion.lsp': false };
        assert.deepStrictEqual(kernelArgs(values, false), ['--set', 'startup.r_home=/opt/R']);
        assert.deepStrictEqual(kernelArgs(values, true), []);
        assert.deepStrictEqual(kernelArgs({ 'startup.banner': false }, false), []);
    });

    test('the most specific scope the user set wins; defaults alone count as unset', () => {
        assert.strictEqual(userSetValue(undefined), undefined);
        assert.strictEqual(userSetValue({}), undefined);
        assert.strictEqual(userSetValue({ globalValue: 3 }), 3);
        assert.strictEqual(userSetValue({ globalValue: 3, workspaceValue: 4 }), 4);
        assert.strictEqual(userSetValue({ globalValue: 3, workspaceValue: 4, workspaceFolderValue: 5 }), 5);
        assert.strictEqual(userSetValue({ workspaceValue: false }), false);
        assert.strictEqual(userSetValue({ globalValue: 0 }), 0);
        assert.strictEqual(userSetValue({ globalValue: '' }), '');
        // `inspect()` also reports the default, which mustn't be passed.
        assert.strictEqual(userSetValue({ defaultValue: 5 } as never), undefined);
    });
});

suite('Console settings: package.json', () => {
    // The console's settings (betteR issue #6), less startup.ark: betteR.arkPath decides that in VS Code.
    const spec: Record<string, { type: string; default: unknown; enum?: string[]; minimum?: number; maximum?: number }> = {
        'startup.r_home': { type: 'string', default: '' },
        'startup.banner': { type: 'boolean', default: true },
        'startup.inline_plots': { type: 'string', default: 'auto', enum: ['auto', 'iterm', 'kitty', 'sixel', 'none'] },
        'completion.lsp': { type: 'boolean', default: true },
        'completion.popup': { type: 'string', default: 'typing', enum: ['typing', 'tab'] },
        'completion.min_chars': { type: 'integer', default: 3, minimum: 0, maximum: 10 },
        'completion.delay_ms': { type: 'integer', default: 0, minimum: 0, maximum: 2000 },
        'completion.accept': { type: 'string', default: 'tab', enum: ['tab', 'enter'] },
        'completion.max_suggestions': { type: 'integer', default: 5, minimum: 1, maximum: 50 },
        'editing.newline': { type: 'string', default: 'auto', enum: ['auto', 'shift_enter', 'alt_enter', 'opt_enter'] },
        'history.size': { type: 'integer', default: 10000, minimum: 0 },
        'history.suggestions': { type: 'boolean', default: true },
    };

    test('every console setting is contributed with its type, values, range and default', () => {
        assert.deepStrictEqual([...CONSOLE_SETTING_KEYS], Object.keys(spec));
        for (const [key, want] of Object.entries(spec)) {
            const got = properties[`betteR.console.${key}`];
            assert.ok(got, `betteR.console.${key} is not contributed`);
            assert.strictEqual(got.type, want.type, key);
            assert.deepStrictEqual(got.default, want.default, key);
            assert.deepStrictEqual(got.enum, want.enum, key);
            assert.strictEqual(got.minimum, want.minimum, key);
            assert.strictEqual(got.maximum, want.maximum, key);
        }
    });

    test('no other betteR.console settings, and no startup.ark', () => {
        const contributed = Object.keys(properties).filter((k) => k.startsWith('betteR.console.'));
        assert.deepStrictEqual(contributed.sort(), Object.keys(spec).map((k) => `betteR.console.${k}`).sort());
        assert.ok(properties['betteR.arkPath'], 'betteR.arkPath decides the kernel in VS Code');
    });
});

/**
 * Evaluates the `when` clauses the newline keybindings use: `&&` of `key`,
 * `key == value`, `key != value` and `key =~ /regex/`.
 */
function when(clause: string, context: Record<string, unknown>): boolean {
    return clause.split('&&').every((part) => {
        const term = part.trim();
        let m = /^(\S+) =~ \/(.*)\/$/.exec(term);
        if (m) {
            return new RegExp(m[2]).test(String(context[m[1]] ?? ''));
        }
        m = /^(\S+) (==|!=) (\S+)$/.exec(term);
        if (m) {
            return (String(context[m[1]]) === m[3]) === (m[2] === '==');
        }
        assert.match(term, /^[\w.]+$/, `unexpected when clause: ${term}`);
        return Boolean(context[term]);
    });
}

suite('Console settings: newline keybindings', () => {
    const NEWLINE = '\u001b\r';
    const bindings = (pkg.contributes.keybindings as { command: string; key: string; mac?: string; args?: { text: string }; when: string }[])
        .filter((b) => b.key === 'shift+enter' || b.key === 'alt+enter');

    /** What each key sends to the focused console, by key. */
    function sent(newline: string | undefined, consoleFocused = true): Record<string, string | undefined> {
        const context = {
            terminalFocus: true,
            'betteR.consoleFocused': consoleFocused,
            // VS Code's config context keys include the default.
            'config.betteR.console.editing.newline': newline ?? 'auto',
        };
        const result: Record<string, string | undefined> = {};
        for (const key of ['shift+enter', 'alt+enter']) {
            const matching = bindings.filter((b) => b.key === key && when(b.when, context));
            assert.ok(matching.length <= 1, `${key}: ${matching.length} bindings apply`);
            for (const b of matching) {
                assert.strictEqual(b.command, 'workbench.action.terminal.sendSequence');
                assert.strictEqual(b.mac, undefined, 'alt+enter is Option+Enter on macOS');
            }
            result[key] = matching[0]?.args?.text;
        }
        return result;
    }

    test('only the chosen key sends the newline (ESC CR); the other runs the line (CR)', () => {
        const shift = { 'shift+enter': NEWLINE, 'alt+enter': '\r' };
        const alt = { 'shift+enter': '\r', 'alt+enter': NEWLINE };
        assert.deepStrictEqual(sent(undefined), shift, 'unset: auto');
        assert.deepStrictEqual(sent('auto'), shift, 'auto: Shift+Enter in VS Code');
        assert.deepStrictEqual(sent('shift_enter'), shift);
        assert.deepStrictEqual(sent('alt_enter'), alt);
        assert.deepStrictEqual(sent('opt_enter'), alt, 'Option+Enter on macOS, Alt+Enter elsewhere');
        assert.deepStrictEqual(sent('nonsense'), shift, 'an invalid value acts as auto');
    });

    test('the keys are left alone outside the console', () => {
        for (const v of ['auto', 'alt_enter']) {
            assert.deepStrictEqual(sent(v, false), { 'shift+enter': undefined, 'alt+enter': undefined });
        }
    });
});
