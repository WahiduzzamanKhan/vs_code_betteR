# betteR VS Code extension

Runs **one** ark R session per window and connects every view to it:

```
VS Code extension ── spawns `better --kernel` (ark built in), owns kernel.json, listens on ide.sock
   ├─ language client ── better --lsp-stdio -f kernel.json ──► ark LSP   (completion, hover, statement ranges, virtual docs)
   ├─ debugger        ── in-process bridge ─────────────────► ark DAP   (port reported by the console)
   ├─ R Plots pane    ── render requests ── ide.sock ── console ──► ark graphics device (positron.plot comms)
   ├─ R Viewer        ── localhost file server ◄── show_html_file / show_url ── console ◄── ark UI comm
   ├─ R Help          ── localhost relay ──► ark help proxy ◄── show_help ── console ◄── ark help comm
   └─ terminal "R"    ── better -f kernel.json --ide-socket ide.sock ──► ark Jupyter (the console; holds ark's debugger comm)
```

- **Shared session.** Run `y <- mtcars` in the console, type `y$` in an `.R` file, and the editor completes the live columns.
- **Debugging.** `browser()` and gutter breakpoints stop VS Code's debugger on the real file line, with the variables pane filled in. Step and Continue work from the toolbar or by typing `n` and `c` in the console.
- **Plots without `httpgd`.** Plots appear in an *R Plots* pane, re-rendered by ark at the pane's exact size and pixel ratio. The pane keeps a history and saves to PNG or SVG.
- **Interactive output.** Plot-like htmlwidgets (plotly, leaflet, …) run live in the *R Plots* history. Other widgets (DT tables, …), `viewer` output and local web apps (Shiny, plumber) run live in an *R Viewer* panel. External URLs open in your browser.
- **Help pages.** `?topic`, `help()`, `??search` and package indexes open in an *R Help* panel with Back/Forward. **F1** in an `.R` file shows help for the symbol at the cursor, as in RStudio.
- **Nothing is installed** into the R library, and no project files change.

## Try it

Prerequisites: R, and the `better` binary from the sibling repo [betteR](../betteR) (`better` on `PATH`, or `../betteR/target/debug/better`). `better` includes the R kernel (ark), so nothing else is needed; rebuild it after pulling.

```sh
npm install && npm run compile
code --extensionDevelopmentPath="$PWD" --disable-extension reditorsupport.r /path/to/an/R/project
```

You can also open this folder in VS Code and press **F5**, which opens the bundled `test-fixtures/workspace` with `analysis.R` and `debug.R`.

In the new window, open any `.R` file. The R session starts and an **R** terminal opens with the console.

| Action | How |
|---|---|
| Run the statement at the cursor (a whole function definition, a pipe chain, …) or the selection | **Cmd+Enter** (Ctrl+Enter); the cursor moves past it |
| Debug with `browser()` | Put `browser()` in a function, run the function with Cmd+Enter, and call it. VS Code stops on that line. |
| Debug with breakpoints | Click the gutter, re-run the function definition with Cmd+Enter, and call it |
| Step / continue / stop | Debug toolbar (F10, F11, F5, Shift+F5), or `n`, `s`, `c`, `Q` in the console; both stay in sync. Stepping from the console keeps keyboard focus in the console while the editor follows the current line. |
| Plots | Shown automatically in *R Plots*. Use ◀ ▶ for history, *Save…* for PNG or SVG, *Remove* to drop a plot and *Clear* to remove them all (asks first; also *betteR: Clear All Plots*). Reopen with *betteR: Show Plots*. |
| Help | `?mean`, `help("lm")`, `??regression` in the console, or **F1** on a symbol in the editor (*betteR: Help for Symbol at Cursor*). Links work inside the panel; ◀ ▶ go back and forward. |
| Interactive charts and apps | Just print the widget or run the app. Plot-like widgets join the *R Plots* history (*Open in Browser* instead of *Save…*); the rest appear in *R Viewer* (*Reload*, *Open in Browser*). Reopen with *betteR: Show Viewer*. |
| Open or reopen the console | Status bar **R** item, or *betteR: Open R Console* |
| Restart R | *betteR: Restart R Session* |
| Detach the console without killing R | Ctrl-D in the terminal, then reopen it from the status bar |

Breakpoints apply to code R learns about with a file location, which means code run with Cmd+Enter. Code run with `source()` uses R's own srcrefs. Functions you type directly in the console have no file, so they are shown from a read-only `ark:` virtual document.

Disable **REditorSupport (`reditorsupport.r`)** in windows where you use betteR, because it registers a competing R language server.

### Settings

- `betteR.arkPath`: optional separate ark binary to run R instead of the kernel built into `better`. Leave empty normally.
- `betteR.consolePath`: better binary. If empty: `better` on `PATH`, then the repo's dev build.
- `betteR.openConsoleOnStart` (default `true`).

## Test

```sh
npm test    # downloads a VS Code build into .vscode-test/ on first run
```

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
2. Back and Forward move between `?mean` and `help("lm")`.
3. `??regression` shows search results, and `help(package = "stats")` shows the package index.
4. F1 on `mean(` in the editor shows `mean`'s page; an unknown symbol reports that no help was found.

**Interactive output:**
1. A plot-like htmlwidget joins the *R Plots* history as a live page, and its JavaScript, including a dependency loaded from its `*_files/` folder, runs inside the pane.
2. `viewer` output runs live in *R Viewer*.
3. `browseURL()` on a local app (how Shiny launches) shows the app in *R Viewer* and loads it.

These tests use a hand-built page laid out like an htmlwidget, so no R packages are needed. Real plotly and DT were checked by hand from a throwaway library: plotly arrives with destination `plot` and DT with `viewer`, each as `index.html` plus a `lib/` folder.

## Design notes

- **No ZeroMQ in Node.** The extension never speaks Jupyter itself. `better --lsp-stdio` bridges ark's LSP to stdio for `vscode-languageclient`. The console talks to the extension over a Unix socket of JSON lines (`ide.sock`), and the debugger uses a small in-process DAP bridge to ark's TCP port. There are no native modules.
- **One LSP client per kernel.** Ark sends live-state updates (console scopes, virtual documents) only to its newest LSP connection. When hosted, the console therefore asks the extension for completions instead of opening its own LSP, so the editor's connection receives everything. This is what makes `ark:` documents openable.
- **The console owns ark's debugger comm**, because ark runs Step and Continue as console input ("as if typed"). When you click Step, ark sends the console `execute n`; the console wakes from line editing, echoes `Browse[1]> n` and runs it. Run Selection works the same way: the code is echoed one expression per prompt, with your half-typed input preserved.
- **Run Selection carries a file location** (`positron.code_location`, UTF-8 columns). Ark attaches srcrefs into that file and injects breakpoints, so the debugger shows the real line.
- **Debug session lifecycle.** VS Code is attached while R is paused or while any R breakpoints exist, which ark needs in order to receive them. Otherwise it is detached, so the debug toolbar only appears when it means something. Detaching is debounced because every step briefly leaves the browser. Ark doesn't replay `stopped` to a client that attaches while R is already paused, so the bridge sends it.
- **Plots come from ark's own graphics device.** The console opens ark's UI comm, so ark announces each plot as a `positron.plot` comm with a PNG pre-render and serves `render` requests at any size and format. The console relays plot events and render requests over `ide.sock` from its background thread, without disturbing the prompt. The pane tells ark its size (`did_change_plots_render_settings`), so later pre-renders already fit.
- **Interactive output comes from ark's UI comm.** Ark overrides `print.htmlwidget`, `options(viewer)`, `options(browser)` and `shiny.launch.browser`. It writes widgets to R's tempdir and sends `show_html_file {path, title, destination}`, or sends `show_url {url}` for web apps. The console forwards these over `ide.sock`, also while you're typing. The extension serves each widget's folder from a localhost server under a random token (only registered folders are reachable) and shows it in an iframe. `asExternalUri` keeps this working over remote connections.
- **Help comes from ark's help comm.** Opening it starts R's help server and ark's help proxy; each request becomes `show_help {url}`. F1 asks ark's LSP for the topic at the cursor (`positron/textDocument/helpTopic`), then asks the help comm to show it (`show_help_topic`). The help page is a cross-origin iframe, so the panel loads it through a small localhost relay. The relay keeps paths unchanged, so R's absolute links work, and appends one script that reports each page's URL and title. That's what makes Back/Forward include links you followed.
- **Lifecycle.** The extension owns ark. Closing the console only detaches it. `q()` in the console ends the session, and the extension offers *Restart R*. On window close, ark is stopped and its temp dir removed. If ark crashes, its log is kept and its path is written to the *betteR* output channel.
