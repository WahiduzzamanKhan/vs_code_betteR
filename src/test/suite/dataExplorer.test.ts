import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';
import type { BetteRApi } from '../../extension';
import type { DataExplorerPanel } from '../../dataExplorer';
import type { EnvironmentExplorer, EnvNode } from '../../environment';
import type { Session } from '../../session';

const workspace = () => vscode.workspace.workspaceFolders![0].uri.fsPath;

async function waitFor<T>(what: string, probe: () => T | Promise<T>, ok: (v: T) => boolean, ms = 30_000): Promise<T> {
    const deadline = Date.now() + ms;
    let last: T | undefined;
    while (Date.now() < deadline) {
        try {
            last = await probe();
            if (ok(last)) {
                return last;
            }
        } catch {
            // Not ready yet.
        }
        await new Promise((r) => setTimeout(r, 200));
    }
    assert.fail(`timed out waiting for ${what}; last value: ${JSON.stringify(last)?.slice(0, 500)}`);
}

/** NA as ark encodes it in data explorer values. */
const NA = 1;

suite('betteR data explorer: data frames in an editor tab', () => {
    let session: Session;
    let explorer: EnvironmentExplorer;
    let panel: DataExplorerPanel;

    suiteSetup(async () => {
        const doc = await vscode.workspace.openTextDocument(path.join(workspace(), 'analysis.R'));
        await vscode.window.showTextDocument(doc);
        const api = await vscode.extensions.getExtension<BetteRApi>('better.better-vscode')!.activate();
        session = await api.ready();
        explorer = api.environment;
        session.execute(
            'de_df <- data.frame(id = 1:250, name = paste0("item", 1:250), score = c(NA, seq(0.5, by = 0.5, length.out = 249)))',
        );
    });

    suiteTeardown(() => {
        for (const p of [...session.dataExplorers.panels]) {
            p.dispose();
        }
    });

    test('View(df) opens the table in an editor tab, drawn by the grid', async () => {
        session.execute('View(de_df)');
        panel = (await waitFor('a de_df tab', () => session.dataExplorers.byTitle('de_df'), (p) => !!p?.state))!;
        assert.strictEqual(panel.state!.table_shape.num_rows, 250);
        assert.deepStrictEqual(
            panel.schema.map((c) => c.column_name),
            ['id', 'name', 'score'],
        );
        assert.strictEqual(panel.panel.title, 'de_df');
        // The webview fetched the first block and drew real cells.
        const drawn = await waitFor('grid to draw', () => panel.lastRender, (r) => !!r && r.text === '1');
        assert.ok(drawn!.cells >= 3, `drew ${drawn!.cells} cells`);
        assert.strictEqual(drawn!.filterForm, false, 'the filter form starts closed');
    });

    test('values come a block at a time, with NA as a special value', async () => {
        const [ids, names, scores] = await panel.values(0, 2, 0, 2);
        assert.deepStrictEqual(ids, ['1', '2', '3']);
        assert.deepStrictEqual(names, ['item1', 'item2', 'item3']);
        assert.strictEqual(scores[0], NA);
        // Across the grid's 100-row block boundary.
        assert.deepStrictEqual((await panel.values(199, 201, 0, 0))[0], ['200', '201', '202']);
    });

    test('sorting, column filters and global search narrow the rows', async () => {
        await panel.sort([{ column_index: 0, ascending: false }]);
        assert.deepStrictEqual((await panel.values(0, 0, 0, 0))[0], ['250']);
        await waitFor('grid to redraw sorted', () => panel.lastRender?.text, (t) => t === '250');

        await panel.addFilter({ column_index: 0, filter_type: 'compare', params: { op: '>', value: '245' } });
        assert.strictEqual(panel.state!.table_shape.num_rows, 5);
        assert.deepStrictEqual((await panel.values(0, 4, 0, 0))[0], ['250', '249', '248', '247', '246']);

        await panel.setSearch('item249');
        assert.strictEqual(panel.state!.table_shape.num_rows, 1);
        assert.strictEqual(panel.columnFilters().length, 1, 'the search is not shown as a column filter');

        await panel.setSearch('');
        await panel.removeFilter(panel.columnFilters()[0].filter_id);
        await panel.sort([]);
        assert.strictEqual(panel.state!.table_shape.num_rows, 250);
        assert.deepStrictEqual((await panel.values(0, 0, 0, 0))[0], ['1']);
    });

    test('selected cells copy as TSV or CSV', async () => {
        assert.strictEqual(await panel.export({ r0: 1, r1: 2, c0: 0, c1: 1 }, 'tsv'), 'id\tname\n2\titem2\n3\titem3');
        assert.strictEqual(await panel.export({ r0: 1, r1: 1, c0: 1, c1: 1 }, 'csv'), 'item2');
        await panel.copy({ r0: 0, r1: 1, c0: 0, c1: 0 }, 'csv');
        assert.strictEqual(await vscode.env.clipboard.readText(), 'id\n1\n2');
    });

    test('the tab follows changes to the variable, and View() again reuses it', async () => {
        session.execute('de_df$id[1] <- 999L');
        await waitFor('updated value', async () => (await panel.values(0, 0, 0, 0))[0][0], (v) => v === '999');
        await waitFor('grid to redraw', () => panel.lastRender?.text, (t) => t === '999');

        const before = panel.commId;
        const count = session.dataExplorers.panels.size;
        session.execute('View(de_df)');
        await waitFor('the same tab on a new comm', () => panel.commId, (id) => id !== before);
        assert.strictEqual(session.dataExplorers.panels.size, count);
    });

    test('View Data in the Environment view opens a data frame', async () => {
        session.execute('de_env <- head(mtcars, 3)');
        const node = await waitFor(
            'de_env listed',
            () => (explorer.environment.getChildren() as EnvNode[]).find((n) => n.type === 'var' && n.variable.display_name === 'de_env'),
            (n) => !!n,
        );
        await vscode.commands.executeCommand('betteR.env.viewData', node);
        const env = await waitFor('a de_env tab', () => session.dataExplorers.byTitle('de_env'), (p) => !!p?.state);
        assert.strictEqual(env!.state!.table_shape.num_rows, 3);
        assert.ok(env!.state!.has_row_labels);
        assert.deepStrictEqual(await env!.rowLabels(0, 0), ['Mazda RX4']);
    });

    test('removing the variable marks the tab as closed', async () => {
        session.execute('rm(de_df)');
        await waitFor('de_df explorer closed', () => panel.closed, (c) => !!c);
        await assert.rejects(panel.values(0, 0, 0, 0), /no longer available/);
    });
});
