# betteR for VS Code: design notes

How the extension is put together. For installation and usage, see the [README](../README.md).

## Architecture

One R session (ark, built into `better`) per window; every view connects to it:

```
VS Code extension ── spawns `better --kernel` (ark built in), owns kernel.json, listens on 127.0.0.1:<ide port>
   ├─ language client ── better --lsp-stdio -f kernel.json ──► ark LSP   (completion, hover, statement ranges, virtual docs)
   ├─ debugger        ── in-process bridge ─────────────────► ark DAP   (port reported by the console)
   ├─ R Plots pane    ── render requests ── IDE channel ── console ──► ark graphics device (positron.plot comms)
   ├─ R Viewer        ── localhost file server ◄── show_html_file / show_url ── console ◄── ark UI comm
   ├─ R Help          ── localhost relay ──► ark help proxy ◄── show_help ── console ◄── ark help comm
   ├─ R Session views ◄── variables_event / comm_rpc ── IDE channel ── console ──► ark variables + UI comms
   ├─ Data explorer   ◄── comm_open / comm_event / comm_rpc ── IDE channel ── console ──► ark data explorer comms
   └─ terminal "R"    ── better -f kernel.json --ide <port> (token in env) ──► ark Jupyter (the console; holds ark's debugger comm)
```

## Design notes

- **No ZeroMQ in Node.** The extension never speaks Jupyter itself. `better --lsp-stdio` bridges ark's LSP to stdio for `vscode-languageclient`. The console talks to the extension over JSON lines on loopback TCP (the IDE channel), and the debugger uses a small in-process DAP bridge to ark's TCP port. There are no native modules.
- **The IDE channel is loopback TCP with a token.** The extension listens on `127.0.0.1`, on a port the OS picks, and starts the console with `--ide <port>`. It passes a random token (16 bytes, hex) in the terminal's environment as `BETTER_IDE_TOKEN`, not in argv, where other users could see it. Any local user can connect to a loopback port, so the console's first line must be `{"type":"hello","token":"…"}`. The extension compares tokens with `crypto.timingSafeEqual`, and closes a connection whose first line isn't a matching hello, that sends more than 4 KB without a newline, or that sends nothing for 10 s. Only an authenticated connection replaces the current console and receives queued messages. Both ends set `TCP_NODELAY`, because completion requests are small and latency-sensitive. TCP rather than a Unix socket because Node on Windows can only listen on named pipes, not file paths.
- **One LSP client per kernel.** Ark sends live-state updates (console scopes, virtual documents) only to its newest LSP connection. When hosted, the console therefore asks the extension for completions instead of opening its own LSP, so the editor's connection receives everything. This is what makes `ark:` documents openable.
- **The console owns ark's debugger comm**, because ark runs Step and Continue as console input ("as if typed"). When you click Step, ark sends the console `execute n`; the console wakes from line editing, echoes `Browse[1]> n` and runs it. Run Selection works the same way: the code is echoed one expression per prompt, with your half-typed input preserved.
- **Run Selection carries a file location** (`positron.code_location`, UTF-8 columns). Ark attaches srcrefs into that file and injects breakpoints, so the debugger shows the real line.
- **Debug session lifecycle.** VS Code is attached while R is paused or while any R breakpoints exist, which ark needs in order to receive them. Otherwise it is detached, so the debug toolbar only appears when it means something. Detaching is debounced because every step briefly leaves the browser. Ark doesn't replay `stopped` to a client that attaches while R is already paused, so the bridge sends it.
- **Plots come from ark's own graphics device.** The console opens ark's UI comm, so ark announces each plot as a `positron.plot` comm with a PNG pre-render and serves `render` requests at any size and format. The console relays plot events and render requests over the IDE channel from its background thread, without disturbing the prompt. The pane tells ark its size (`did_change_plots_render_settings`), so later pre-renders already fit. The pane's webview reports its size on load, on resize, and whenever the extension sends it a message (also when it becomes visible again), because in an unfocused window its resize timers can be throttled for a minute. Before an SVG render, a silent `evaluate_code` opens and closes the SVG device ark would use. Without Cairo (CRAN's macOS R without XQuartz), `svg()` only warns and opens no device, and ark would then replay the plot onto its own device and close it, which breaks later plot updates. So the render is refused with a message saying SVG needs XQuartz, and PNG keeps working.
- **Interactive output comes from ark's UI comm.** Ark overrides `print.htmlwidget`, `options(viewer)`, `options(browser)` and `shiny.launch.browser`. It writes widgets to R's tempdir and sends `show_html_file {path, title, destination}`, or sends `show_url {url}` for web apps. The console forwards these over the IDE channel, also while you're typing. The extension serves each widget's folder from a localhost server under a random token (only registered folders are reachable) and shows it in an iframe. `asExternalUri` keeps this working over remote connections.
- **Help comes from ark's help comm.** Opening it starts R's help server and ark's help proxy; each request becomes `show_help {url}`. F1 asks ark's LSP for the topic at the cursor (`positron/textDocument/helpTopic`), then asks the help comm to show it (`show_help_topic`). The help page is a cross-origin iframe, so the panel loads it through a small localhost relay. The relay keeps paths unchanged, so R's absolute links work, and appends one script that reports each page's URL and title. That's what makes Back/Forward include links you followed. The relay also themes the pages: the panel reads its `--vscode-*` theme values (the iframe is cross-origin and can't), and the relay puts them, with a stylesheet overriding R.css, at the top of each page's `<head>`, so pages load already themed. When the theme changes, the panel sends the new values to the page's injected listener.
- **The environment explorer uses ark's variables comm and UI comm.** In hosted mode the console opens `positron.variables`. After each execution ark sends a `refresh` (full list) or `update` (diff) for the global env, or for the debug frame while paused, and serves `inspect` (children of a path of access keys), `delete` and `clear`. The console relays these as `variables_event`, and the extension sends `comm_rpc` requests and gets `comm_rpc_reply` back. Ark's list leaves out hidden objects, the search path and loaded namespaces, so those come from silent `evaluate_code` requests on the UI comm: R code runs in the global env with no console echo, and the value returns as JSON. Those requests run after each `prompt_state` (which the console forwards), and only while one of the views is visible. Ark answers comm requests only when R is idle, so a long computation just delays the refresh. Removing an object doesn't make ark send an update, so the extension re-lists afterwards. The views live in a `viewsContainers.secondarySidebar` container, which needs VS Code 1.106.
- **The data explorer uses ark's data explorer comm**, the backend of Positron's Data Explorer. `View(df)` (ark replaces `utils::View`) and the variables comm's `view` request make ark open a `positron.dataExplorer` comm. The console forwards it as `comm_open`, forwards its `schema_update` / `data_update` events as `comm_event`, and reports its closing (the variable was removed) as `comm_closed`. The extension sends its requests by comm id over `comm_rpc` and closes the comm when the tab closes. Ark keeps the table and applies sorting and filters itself, so the webview's grid stays virtual: it requests values in blocks of 100 rows × 20 columns for what's on screen (`get_data_values`, plus `get_row_labels` for row names), and drops its cache whenever the view changes. Values arrive formatted; NA, NaN and Inf arrive as special codes. Search across all cells is a `global_search` row filter, and copying uses `export_data_selection`. The grid redraws as soon as data arrives rather than on an animation frame, because an unfocused window throttles frames almost to a stop.
- **Shift-Enter in the console.** VS Code's terminal (xterm.js) supports the kitty keyboard protocol, on by default since VS Code 1.110 (`terminal.integrated.enableKittyKeyboardProtocol`). The console asks for it, and xterm.js then sends Shift-Enter as `CSI 13;2u`, which the console reads as a newline. Where the protocol is off (the setting, or VS Code 1.106–1.109) xterm.js sends Shift-Enter as plain Enter, so the extension binds Shift-Enter to `workbench.action.terminal.sendSequence` with Alt-Enter's `ESC CR`, which the console also reads as a newline. The binding applies only then (`!config.terminal.integrated.enableKittyKeyboardProtocol`), only in the R terminal and not where the console runs on Windows (`betteR.consoleShiftEnter`, a context key the extension sets from the active terminal and its own platform; VS Code's `isWindows` is the UI's OS, which differs from the console's in remote windows), where the console reads keys through the console API. The extension then starts the console with `BETTER_SHIFT_ENTER=1` so its banner offers Shift-Enter rather than Alt-Enter.
- **Lifecycle.** The extension owns ark. Closing the console only detaches it. `q()` in the console ends the session, and the extension offers *Restart R*. On window close or *Restart R*, the extension runs `better --shutdown -f kernel.json`, which sends a Jupyter `shutdown_request`: ark interrupts any running code, then R quits as at `q()`, running `.Last` and finalizers and removing its own temp directory. Only if the kernel hasn't exited within 3 s is it killed. Killing R skips all of that, and `SIGTERM` was no better: R ignored it on macOS, and on Windows Node's `kill()` always kills outright. Then the extension removes its own temp dir. A backstop kills the kernel if the extension host exits without deactivating. If ark crashes, its log is kept and its path is written to the *betteR* output channel.

## What the tests cover

The tests open a copy of `test-fixtures/workspace` in a real VS Code with other extensions disabled.

**Shared session (Phase 2):**
1. The console terminal opens attached to the session.
2. `y <- mtcars` typed into the console makes `y$` complete `mpg, cyl, hp, carb` in the editor.
3. Hover on `mean` shows the R help page.
4. *Run Selection* runs code in the console that creates a name only the live session can know, and the editor then completes it.
5. The console's signature help request (`signature`) is answered through the editor's language client: `mean(1:10, )` gives `mean(x, ...)` with the second parameter active.
6. The console's request for a completion's help (`resolve`) is answered the same way: `mean` comes back with its help page.
7. The console channel closes connections that send a wrong or partial token, another message first, garbage or an over-long line, without sending them anything; the real console keeps working (the next test runs code through it).
8. The installed R package set and all project files, including `renv.lock`, are unchanged.

**Console keys (Unix):**
1. The console's banner offers Shift-Enter: VS Code's terminal answers its kitty keyboard protocol query (the extension doesn't tell it here, since the protocol is on).
2. The Shift-Enter keybinding's command and arguments, run in the R terminal after `40000 + 1`, insert a newline: nothing runs until the next Enter, which runs both lines.

**Debugger (Phase 3):**
1. Cmd+Enter on line 1 of `add_one` runs the whole function. Calling it stops VS Code at `browser()` on `debug.R:3`, the real file and not a copy. VS Code focuses that frame, the variables pane shows `x = 1, y = 2`, Step Over moves to line 4, and Continue finishes with the right result (`4`).
2. A gutter breakpoint on `debug.R:8` stops `times_two(5)` there, with `v = 5`, and Continue returns `10`.
3. A function typed straight into the console stops in an `ark:` virtual document whose text VS Code can open.

**Plots (Phase 4):**
1. `plot()` opens the *R Plots* pane. The pane reports its size, and the plot is re-rendered to exactly that size × pixel ratio, replacing the 640×400 pre-render.
2. Plots render on demand at any size as PNG (checked pixel-exact) or SVG.
   When R can't make SVGs (simulated by replacing `grDevices::svg` in the session), the SVG render fails with a clear message, PNG still renders, and later `lines()` and Clear still work.
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


**Finding `better`:**
1. On Windows, `better.exe` is found on `PATH` after empty and quoted entries; `better.cmd`, `better.bat` and an extensionless `better` are not used, nor is a directory named `better.exe`. A configured path may leave out `.exe`. Elsewhere the plain name is used. (These run the Windows logic on any OS by setting `process.platform`.)

**Shutting R down** (runs last, since it restarts R):
1. *Restart R* lets R quit cleanly: a `.Last` defined in the session runs and R's `tempdir()` is removed, and the new session evaluates code.
2. Windows process memory is parsed from `tasklist` output in English, German and French number formats; "no tasks" gives none.

**After VS Code exits** (`runTest.ts`, on every OS): no betteR kernel started during the run is still running (kernels of other betteR windows, listed before the run, are ignored), and no new `Rtmp*` directory is left in the temp directory, which would mean an R was killed rather than shut down. Processes are listed with `ps`, or on Windows with `Get-CimInstance Win32_Process`.
