# betteR for VS Code: design notes

How the extension is put together. For installation and usage, see the [README](../README.md).

## Architecture

One R session (ark, built into `better`) per window; every view connects to it:

```
VS Code extension ── spawns `better --kernel` (ark built in), owns kernel.json, listens on ide.sock
   ├─ language client ── better --lsp-stdio -f kernel.json ──► ark LSP   (completion, hover, statement ranges, virtual docs)
   ├─ debugger        ── in-process bridge ─────────────────► ark DAP   (port reported by the console)
   ├─ R Plots pane    ── render requests ── ide.sock ── console ──► ark graphics device (positron.plot comms)
   ├─ R Viewer        ── localhost file server ◄── show_html_file / show_url ── console ◄── ark UI comm
   ├─ R Help          ── localhost relay ──► ark help proxy ◄── show_help ── console ◄── ark help comm
   ├─ R Session views ◄── variables_event / comm_rpc ── ide.sock ── console ──► ark variables + UI comms
   ├─ Data explorer   ◄── comm_open / comm_event / comm_rpc ── ide.sock ── console ──► ark data explorer comms
   └─ terminal "R"    ── better -f kernel.json --ide-socket ide.sock ──► ark Jupyter (the console; holds ark's debugger comm)
```

## Design notes

- **No ZeroMQ in Node.** The extension never speaks Jupyter itself. `better --lsp-stdio` bridges ark's LSP to stdio for `vscode-languageclient`. The console talks to the extension over a Unix socket of JSON lines (`ide.sock`), and the debugger uses a small in-process DAP bridge to ark's TCP port. There are no native modules.
- **One LSP client per kernel.** Ark sends live-state updates (console scopes, virtual documents) only to its newest LSP connection. When hosted, the console therefore asks the extension for completions instead of opening its own LSP, so the editor's connection receives everything. This is what makes `ark:` documents openable.
- **The console owns ark's debugger comm**, because ark runs Step and Continue as console input ("as if typed"). When you click Step, ark sends the console `execute n`; the console wakes from line editing, echoes `Browse[1]> n` and runs it. Run Selection works the same way: the code is echoed one expression per prompt, with your half-typed input preserved.
- **Run Selection carries a file location** (`positron.code_location`, UTF-8 columns). Ark attaches srcrefs into that file and injects breakpoints, so the debugger shows the real line.
- **Debug session lifecycle.** VS Code is attached while R is paused or while any R breakpoints exist, which ark needs in order to receive them. Otherwise it is detached, so the debug toolbar only appears when it means something. Detaching is debounced because every step briefly leaves the browser. Ark doesn't replay `stopped` to a client that attaches while R is already paused, so the bridge sends it.
- **Plots come from ark's own graphics device.** The console opens ark's UI comm, so ark announces each plot as a `positron.plot` comm with a PNG pre-render and serves `render` requests at any size and format. The console relays plot events and render requests over `ide.sock` from its background thread, without disturbing the prompt. The pane tells ark its size (`did_change_plots_render_settings`), so later pre-renders already fit.
- **Interactive output comes from ark's UI comm.** Ark overrides `print.htmlwidget`, `options(viewer)`, `options(browser)` and `shiny.launch.browser`. It writes widgets to R's tempdir and sends `show_html_file {path, title, destination}`, or sends `show_url {url}` for web apps. The console forwards these over `ide.sock`, also while you're typing. The extension serves each widget's folder from a localhost server under a random token (only registered folders are reachable) and shows it in an iframe. `asExternalUri` keeps this working over remote connections.
- **Help comes from ark's help comm.** Opening it starts R's help server and ark's help proxy; each request becomes `show_help {url}`. F1 asks ark's LSP for the topic at the cursor (`positron/textDocument/helpTopic`), then asks the help comm to show it (`show_help_topic`). The help page is a cross-origin iframe, so the panel loads it through a small localhost relay. The relay keeps paths unchanged, so R's absolute links work, and appends one script that reports each page's URL and title. That's what makes Back/Forward include links you followed. The relay also themes the pages: the panel reads its `--vscode-*` theme values (the iframe is cross-origin and can't), and the relay puts them, with a stylesheet overriding R.css, at the top of each page's `<head>`, so pages load already themed. When the theme changes, the panel sends the new values to the page's injected listener.
- **The environment explorer uses ark's variables comm and UI comm.** In hosted mode the console opens `positron.variables`. After each execution ark sends a `refresh` (full list) or `update` (diff) for the global env, or for the debug frame while paused, and serves `inspect` (children of a path of access keys), `delete` and `clear`. The console relays these as `variables_event`, and the extension sends `comm_rpc` requests and gets `comm_rpc_reply` back. Ark's list leaves out hidden objects, the search path and loaded namespaces, so those come from silent `evaluate_code` requests on the UI comm: R code runs in the global env with no console echo, and the value returns as JSON. Those requests run after each `prompt_state` (which the console forwards), and only while one of the views is visible. Ark answers comm requests only when R is idle, so a long computation just delays the refresh. Removing an object doesn't make ark send an update, so the extension re-lists afterwards. The views live in a `viewsContainers.secondarySidebar` container, which needs VS Code 1.106.
- **The data explorer uses ark's data explorer comm**, the backend of Positron's Data Explorer. `View(df)` (ark replaces `utils::View`) and the variables comm's `view` request make ark open a `positron.dataExplorer` comm. The console forwards it as `comm_open`, forwards its `schema_update` / `data_update` events as `comm_event`, and reports its closing (the variable was removed) as `comm_closed`. The extension sends its requests by comm id over `comm_rpc` and closes the comm when the tab closes. Ark keeps the table and applies sorting and filters itself, so the webview's grid stays virtual: it requests values in blocks of 100 rows × 20 columns for what's on screen (`get_data_values`, plus `get_row_labels` for row names), and drops its cache whenever the view changes. Values arrive formatted; NA, NaN and Inf arrive as special codes. Search across all cells is a `global_search` row filter, and copying uses `export_data_selection`. The grid redraws as soon as data arrives rather than on an animation frame, because an unfocused window throttles frames almost to a stop.
- **Lifecycle.** The extension owns ark. Closing the console only detaches it. `q()` in the console ends the session, and the extension offers *Restart R*. On window close, ark is stopped and its temp dir removed. If ark crashes, its log is kept and its path is written to the *betteR* output channel.

## What the tests cover

The tests open a copy of `test-fixtures/workspace` in a real VS Code with other extensions disabled.

**Shared session (Phase 2):**
1. The console terminal opens attached to the session.
2. `y <- mtcars` typed into the console makes `y$` complete `mpg, cyl, hp, carb` in the editor.
3. Hover on `mean` shows the R help page.
4. *Run Selection* runs code in the console that creates a name only the live session can know, and the editor then completes it.
5. The installed R package set and all project files, including `renv.lock`, are unchanged.

**Debugger (Phase 3):**
1. Cmd+Enter on line 1 of `add_one` runs the whole function. Calling it stops VS Code at `browser()` on `debug.R:3`, the real file and not a copy. VS Code focuses that frame, the variables pane shows `x = 1, y = 2`, Step Over moves to line 4, and Continue finishes with the right result (`4`).
2. A gutter breakpoint on `debug.R:8` stops `times_two(5)` there, with `v = 5`, and Continue returns `10`.
3. A function typed straight into the console stops in an `ark:` virtual document whose text VS Code can open.

**Plots (Phase 4):**
1. `plot()` opens the *R Plots* pane. The pane reports its size, and the plot is re-rendered to exactly that size × pixel ratio, replacing the 640×400 pre-render.
2. Plots render on demand at any size as PNG (checked pixel-exact) or SVG.
3. `lines()` updates the current plot in place instead of adding a history entry.
4. A new plot is added to the history, earlier plots can be shown again, and removing a plot makes ark free it.

**Help:**
1. `?mean` typed into the console opens *R Help*, and the page itself loads in the panel.
2. Help pages arrive themed: the panel reports the VS Code theme, and each page's `<head>` carries its colors and the R.css overrides.
3. Back and Forward move between `?mean` and `help("lm")`.
4. `??regression` shows search results, and `help(package = "stats")` shows the package index.
5. F1 on `mean(` in the editor shows `mean`'s page; an unknown symbol reports that no help was found.

**Interactive output:**
1. A plot-like htmlwidget joins the *R Plots* history as a live page, and its JavaScript, including a dependency loaded from its `*_files/` folder, runs inside the pane.
2. `viewer` output runs live in *R Viewer*.
3. `browseURL()` on a local app (how Shiny launches) shows the app in *R Viewer* and loads it.

These tests use a hand-built page laid out like an htmlwidget, so no R packages are needed. Real plotly and DT were checked by hand from a throwaway library: plotly arrives with destination `plot` and DT with `viewer`, each as `index.html` plus a `lib/` folder.

**Environment explorer:**
1. A data frame created in the console appears in *Environment* as a table that expands into its columns, and disappears after `rm()`.
2. While R is paused at `browser()`, *Environment* shows the frame's local variables; after `Q` it's back to the global env.
3. *Attached* lists `library()`-attached packages with versions and expands `package:stats` to its objects. *Loaded Namespaces* marks `base` as attached with its version, and *Session* shows the R version.
4. A hidden `.name` object shows only with *Show Hidden Objects*, expands into its elements, and *Remove* deletes it.

**Data explorer:**
1. `View(df)` opens an editor tab named after the data frame, and the webview's grid fetches and draws its first cells.
2. Values arrive a block at a time, including across the 100-row block boundary, with NA as a special value.
3. Sorting reorders rows (and the grid redraws), a column filter and a global search narrow them, and clearing restores all 250.
4. Selected cells export as TSV (with column names) or CSV, and Copy puts them on the clipboard.
5. Changing the data frame updates the tab, and `View()` again reuses it on a new comm.
6. *View Data* in the Environment view opens `head(mtcars)` with its row names.
7. `rm()` of the variable marks the tab as closed.

