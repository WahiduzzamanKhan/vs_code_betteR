import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';
import type { BetteRApi } from '../../extension';
import { canvasRowsHeight, rowHeight, rowsTop, scrollTopFor, type DataExplorerPanel } from '../../dataExplorer';
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

    test('a table taller than the browser can lay out scrolls to its last row', async () => {
        // 2M rows of 22px is past Chromium's ~33.5M px layout limit, which
        // stopped a canvas of rows × row height near row 1.5M.
        const rows = 2_000_000;
        session.execute(`de_big <- data.frame(i = seq_len(${rows}))`);
        session.execute('View(de_big)');
        const big = (await waitFor('a de_big tab', () => session.dataExplorers.byTitle('de_big'), (p) => !!p?.state))!;
        assert.strictEqual(big.state!.table_shape.num_rows, rows);
        // One column, so the grid draws one cell per row: rows `row` to
        // `row + cells - 1`, with the value of the top one.
        const drawn = (what: string, ok: (top: number, bottom: number) => boolean) =>
            waitFor(what, () => big.lastRender, (r) => !!r && r.text === String(r.row + 1) && ok(r.row, r.row + r.cells - 1), 10_000);
        await drawn('the first rows', (top) => top === 0);

        // The scrollbar dragged to the end, and Ctrl+End, show the last row.
        big.simulate({ scroll: 1 });
        await drawn('the last row, scrolled to', (_, bottom) => bottom === rows - 1);
        big.simulate({ key: 'Home', mod: true });
        await drawn('the first row again', (top) => top === 0);
        big.simulate({ key: 'End', mod: true });
        const end = (await drawn('the last row, from Ctrl+End', (_, bottom) => bottom === rows - 1))!;

        // The arrow keys move up one row at a time even here, where each
        // scroll pixel spans several rows: up past the top row scrolls by one.
        for (let i = 0; i < end.cells; i++) {
            big.simulate({ key: 'ArrowUp' });
        }
        await drawn('one row above the top row', (top) => top === end.row - 1);
        big.simulate({ key: 'ArrowUp' });
        await drawn('another row up', (top) => top === end.row - 2);

        // The wheel scrolls at its usual speed, not one scroll pixel's worth of rows per pixel.
        big.simulate({ key: 'Home', mod: true });
        await drawn('the first row again', (top) => top === 0);
        big.simulate({ wheel: 220 });
        await drawn('a few rows down', (top) => top > 0 && top <= 10);

        big.dispose();
        session.execute('rm(de_big)');
    });

    test('removing the variable marks the tab as closed', async () => {
        session.execute('rm(de_df)');
        await waitFor('de_df explorer closed', () => panel.closed, (c) => !!c);
        await assert.rejects(panel.values(0, 0, 0, 0), /no longer available/);
    });
});

suite('Data explorer: grid geometry', () => {
    /** Height of the rows' viewport, below the header. */
    const view = 600;

    test('a table that fits the canvas scrolls one pixel per pixel, as before', () => {
        for (const height of [250 * 22, 10_000_000]) {
            const maxScroll = height - view;
            assert.strictEqual(canvasRowsHeight(height), height);
            for (const y of [0, 1, 1234.5, maxScroll]) {
                assert.strictEqual(rowsTop(y, maxScroll, height, view), y);
                assert.strictEqual(scrollTopFor(y, maxScroll, height, view), y);
            }
        }
    });

    test('a taller table scrolls a canvas Chromium can lay out, whose ends reach the first and last rows', () => {
        for (const rows of [2e6, 1e9]) {
            const height = rows * 22;
            const canvas = canvasRowsHeight(height);
            // Chromium clamps layout sizes at 2^31 / 64 px (its LayoutUnit is a fixed-point int).
            assert.ok(canvas + 40 < 2 ** 31 / 64, `canvas of ${canvas}px for ${rows} rows`);
            const maxScroll = canvas - view;
            assert.strictEqual(rowsTop(0, maxScroll, height, view), 0);
            assert.strictEqual(rowsTop(maxScroll, maxScroll, height, view), height - view, 'the last row at the bottom');
            assert.strictEqual(rowsTop(maxScroll - 0.5, maxScroll, height, view), height - view, 'the end, a fraction of a pixel short');
            assert.strictEqual(rowsTop(maxScroll + 50, maxScroll, height, view), height - view);
            assert.strictEqual(scrollTopFor(0, maxScroll, height, view), 0);
            assert.strictEqual(scrollTopFor(height - view, maxScroll, height, view), maxScroll);
            assert.strictEqual(scrollTopFor(height, maxScroll, height, view), maxScroll);
            let last = 0;
            for (const y of [1, maxScroll / 3, maxScroll / 2, maxScroll - 2]) {
                const top = rowsTop(y, maxScroll, height, view);
                assert.ok(top > last, 'further down the scroll range is further down the table');
                assert.ok(Math.abs(scrollTopFor(top, maxScroll, height, view) - y) < 1e-6);
                last = top;
            }
        }
    });

    test('rows are 22px at the usual font sizes and grow with larger ones', () => {
        assert.deepStrictEqual([8, 12, 13, 14].map(rowHeight), [22, 22, 22, 22]);
        assert.strictEqual(rowHeight(20), 32);
        assert.ok(rowHeight(30) >= 30 * 1.5);
    });
});
