import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';
import type { BetteRApi } from '../../extension';
import type { Session } from '../../session';

const workspace = () => vscode.workspace.workspaceFolders![0].uri.fsPath;

async function waitFor<T>(what: string, probe: () => T | Promise<T>, ok: (v: T) => boolean, ms = 60_000): Promise<T> {
    const deadline = Date.now() + ms;
    let last: T | undefined;
    while (Date.now() < deadline) {
        last = await probe();
        if (ok(last)) {
            return last;
        }
        await new Promise((r) => setTimeout(r, 200));
    }
    assert.fail(`timed out waiting for ${what}; last value: ${JSON.stringify(last)?.slice(0, 300)}`);
}

/** Pixel size of a base64 PNG, from its IHDR chunk. */
function pngSize(base64: string): { width: number; height: number } {
    const png = Buffer.from(base64, 'base64');
    assert.strictEqual(png.subarray(1, 4).toString('ascii'), 'PNG');
    return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

suite('betteR plots: R graphics in a VS Code pane, no httpgd', () => {
    let session: Session;

    suiteSetup(async () => {
        const doc = await vscode.workspace.openTextDocument(path.join(workspace(), 'analysis.R'));
        await vscode.window.showTextDocument(doc);
        const ext = vscode.extensions.getExtension<BetteRApi>('better.better-vscode')!;
        session = await (await ext.activate()).ready();
    });

    test('a plot opens the R Plots pane, rendered at the pane size', async () => {
        const before = session.plots.plots.length;
        session.execute('plot(1:10, main = "betteR")');
        await waitFor('plot to arrive', () => session.plots.plots.length, (n) => n === before + 1);
        assert.ok(session.plots.isVisible, 'R Plots pane is shown');
        assert.ok(
            vscode.window.tabGroups.all.some((g) => g.tabs.some((t) => t.label === 'R Plots')),
            'R Plots tab exists',
        );

        // The pane reports its size and the plot is re-rendered to fit it exactly
        // (instead of the 640x400 pre-render).
        const plot = session.plots.current!;
        const settings = await waitFor(
            'render at pane size',
            () => plot.image?.settings,
            (s) => !!s && (s.size.width !== 640 || s.size.height !== 400),
        );
        const px = pngSize(plot.image!.data);
        assert.strictEqual(px.width, Math.round(settings!.size.width * settings!.pixel_ratio));
        assert.strictEqual(px.height, Math.round(settings!.size.height * settings!.pixel_ratio));
    });

    test('plots render on demand at any size, as PNG or SVG', async () => {
        const commId = session.plots.current!.commId;
        const png = await session.renderPlot(commId, { width: 300, height: 200 }, 2, 'png');
        assert.deepStrictEqual(pngSize(png.data), { width: 600, height: 400 });
        const svg = await session.renderPlot(commId, { width: 300, height: 200 }, 1, 'svg');
        assert.strictEqual(svg.mime_type, 'image/svg+xml');
        assert.match(Buffer.from(svg.data, 'base64').toString('utf8'), /<svg/);
    });

    test('adding to a plot updates it in place', async () => {
        const plot = session.plots.current!;
        const count = session.plots.plots.length;
        const before = plot.image!.data;
        session.execute('lines(1:10, (1:10)^0.5 * 3, col = "red")');
        await waitFor('plot update', () => plot.image?.data, (d) => !!d && d !== before);
        assert.strictEqual(session.plots.plots.length, count, 'no new history entry');
    });

    test('SVG fails cleanly when R cannot make SVGs, and plots keep working', async () => {
        // CRAN's macOS R without XQuartz: svg() can't load Cairo, so it only
        // warns and opens no device. Simulated in this session only.
        await session.evaluate(`local({
            ns <- asNamespace("grDevices")
            options(better.test.svg = ns$svg)
            unlockBinding("svg", ns)
            assign("svg", function(...) {
                warning("failed to load cairo DLL")
                invisible(NULL)
            }, envir = ns)
            lockBinding("svg", ns)
        })`);
        const plot = session.plots.current!;
        const count = session.plots.plots.length;
        try {
            await assert.rejects(
                session.renderPlot(plot.commId, { width: 300, height: 200 }, 1, 'svg'),
                process.platform === 'darwin' ? /SVG export needs XQuartz on macOS/ : /can't make SVG/,
            );
        } finally {
            await session.evaluate(`local({
                ns <- asNamespace("grDevices")
                unlockBinding("svg", ns)
                assign("svg", getOption("better.test.svg"), envir = ns)
                lockBinding("svg", ns)
                options(better.test.svg = NULL)
            })`);
        }
        // PNG still renders, and the session's plots are as they were.
        const png = await session.renderPlot(plot.commId, { width: 300, height: 200 }, 1, 'png');
        assert.deepStrictEqual(pngSize(png.data), { width: 300, height: 200 });
        const before = plot.image!.data;
        session.execute('lines(1:10, rep(5, 10), col = "blue")');
        await waitFor('plot update', () => plot.image?.data, (d) => !!d && d !== before);
        assert.strictEqual(session.plots.plots.length, count, 'no new history entry');
        assert.strictEqual(session.plots.current, plot);
    });

    test('history keeps earlier plots; removing one frees it', async () => {
        const count = session.plots.plots.length;
        session.execute('hist(rnorm(100))');
        await waitFor('second plot', () => session.plots.plots.length, (n) => n === count + 1);
        assert.strictEqual(session.plots.index, count);

        session.plots.showIndex(count - 1);
        assert.strictEqual(session.plots.current!.commId, session.plots.plots[count - 1].commId);

        const removed = session.plots.current!.commId;
        session.plots.removeCurrent();
        assert.strictEqual(session.plots.plots.length, count);
        // ark dropped the recording, so it can no longer be rendered.
        await assert.rejects(session.renderPlot(removed, { width: 100, height: 100 }, 1, 'png'));
    });

    test('Clear removes every plot and frees them all', async () => {
        session.execute('plot(1:5)');
        session.execute('barplot(1:3)');
        await waitFor('plots to clear', () => session.plots.plots.length, (n) => n >= 2);
        const ids = session.plots.plots.map((p) => p.commId);
        session.plots.clear();
        assert.strictEqual(session.plots.plots.length, 0);
        assert.strictEqual(session.plots.current, undefined);
        for (const id of ids) {
            await assert.rejects(session.renderPlot(id, { width: 100, height: 100 }, 1, 'png'));
        }
        // New plots still arrive after a clear.
        session.execute('plot(1:2)');
        await waitFor('plot after clear', () => session.plots.plots.length, (n) => n === 1);
    });
});
