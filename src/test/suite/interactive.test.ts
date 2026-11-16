import * as assert from 'assert';
import * as http from 'http';
import * as path from 'path';
import * as vscode from 'vscode';
import type { BetteRApi } from '../../extension';
import type { Session } from '../../session';

const workspace = () => vscode.workspace.workspaceFolders![0].uri.fsPath;

async function waitFor<T>(what: string, probe: () => T | Promise<T>, ok: (v: T) => boolean, ms = 30_000): Promise<T> {
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

/**
 * R code writing an interactive page to R's tempdir, laid out like an
 * htmlwidget: the page loads a script from its sibling `<name>_files/` folder,
 * and that script fetches `ping-<tag>`, so a request for it proves the page's
 * JavaScript (and its dependency) really ran inside VS Code.
 */
function writeWidget(name: string, tag: string): string {
    return [
        `wdir <- file.path(tempdir(), "${name}"); dir.create(file.path(wdir, "${name}_files"), recursive = TRUE, showWarnings = FALSE)`,
        `writeLines("fetch('ping-' + window.TAG)", file.path(wdir, "${name}_files", "dep.js"))`,
        `writeLines(c("<html><body><div id=chart></div>", "<script>window.TAG = '${tag}'</script>", "<script src='${name}_files/dep.js'></script></body></html>"), file.path(wdir, "index.html"))`,
    ].join('\n');
}

const pinged = (session: Session, tag: string) => () => session.htmlServer.requests.some((r) => r.endsWith(`/ping-${tag}`));

suite('betteR interactive output: htmlwidgets, viewer and web apps', () => {
    let session: Session;

    suiteSetup(async () => {
        const doc = await vscode.workspace.openTextDocument(path.join(workspace(), 'analysis.R'));
        await vscode.window.showTextDocument(doc);
        const ext = vscode.extensions.getExtension<BetteRApi>('better.better-vscode')!;
        session = await (await ext.activate()).ready();
    });

    test('a plot-like htmlwidget (plotly, leaflet, ...) runs live in the R Plots history', async () => {
        const before = session.plots.plots.length;
        session.execute(writeWidget('plotwidget', 'plot'));
        // Exactly what htmlwidgets' print method does under ark for a figure-like widget.
        session.execute(
            'get(".ps.Call", envir = environment(.ps.ui.showUrl))("ps_html_viewer", file.path(wdir, "index.html"), "plotly", 400L, "plot")',
        );
        await waitFor('interactive plot in history', () => session.plots.plots.length, (n) => n === before + 1);
        const entry = session.plots.current!;
        assert.ok(entry.html, 'entry is a live page, not an image');
        assert.strictEqual(entry.html!.title, 'plotly');
        assert.ok(session.plots.isVisible);
        await waitFor('widget JavaScript to run in the pane', pinged(session, 'plot'), (ok) => ok);

        // It sits in the same history as static plots and can be removed.
        session.plots.removeCurrent();
        assert.strictEqual(session.plots.plots.length, before);
    });

    test('viewer output (DT tables, other widgets) runs live in the R Viewer', async () => {
        session.execute(writeWidget('viewerwidget', 'viewer'));
        session.execute('getOption("viewer")(file.path(wdir, "index.html"))');
        await waitFor('R Viewer to show the page', () => session.viewer.url, (u) => !!u && u.endsWith('/index.html'));
        assert.ok(session.viewer.isVisible);
        await waitFor('page JavaScript to run in the Viewer', pinged(session, 'viewer'), (ok) => ok);
    });

    test('a local web app (e.g. Shiny via browseURL) opens in the R Viewer', async () => {
        let hits = 0;
        const app = http.createServer((_, res) => {
            hits++;
            res.writeHead(200, { 'Content-Type': 'text/html' }).end('<h1>app</h1>');
        });
        await new Promise<void>((r) => app.listen(0, '127.0.0.1', r));
        const url = `http://127.0.0.1:${(app.address() as { port: number }).port}/`;
        try {
            session.execute(`browseURL("${url}")`);
            await waitFor('R Viewer to show the app', () => session.viewer.url, (u) => u === url);
            await waitFor('the app to be loaded', () => hits, (n) => n > 0);
        } finally {
            app.close();
        }
    });
});
