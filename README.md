# betterR VS Code extension (Phases 2–3)

Runs **one** ark R session per window and connects every view to it:

```
VS Code extension ── spawns ark, owns kernel.json, listens on ide.sock
   ├─ language client ── betterr --lsp-stdio -f kernel.json ──► ark LSP   (completion, hover, statement ranges, virtual docs)
   ├─ debugger        ── in-process bridge ─────────────────► ark DAP   (port reported by the console)
   └─ terminal "R"    ── betterr -f kernel.json --ide-socket ide.sock ──► ark Jupyter (the console; holds ark's debugger comm)
```

- **Shared session.** Run `y <- mtcars` in the console, type `y$` in an `.R` file, and the editor completes the live columns.
- **Debugging.** `browser()` and gutter breakpoints stop VS Code's debugger on the real file line, with the variables pane filled in. Step and Continue work from the toolbar or by typing `n` and `c` in the console.
- **Nothing is installed** into the R library, and no project files change.

## Try it

Prerequisites are the dev builds from Phases 0 and 1 (`vendor/ark/target/debug/ark` and `console/target/debug/betterr`; rebuild the console after pulling).

```sh
cd extension && npm install && npm run compile
code --extensionDevelopmentPath="$PWD" --disable-extension reditorsupport.r /path/to/an/R/project
```

You can also open the `extension/` folder in VS Code and press **F5**, which opens the bundled `test-fixtures/workspace` with `analysis.R` and `debug.R`.

In the new window, open any `.R` file. The R session starts and an **R** terminal opens with the console.

| Action | How |
|---|---|
| Run the statement at the cursor (a whole function definition, a pipe chain, …) or the selection | **Cmd+Enter** (Ctrl+Enter); the cursor moves past it |
| Debug with `browser()` | Put `browser()` in a function, run the function with Cmd+Enter, and call it. VS Code stops on that line. |
| Debug with breakpoints | Click the gutter, re-run the function definition with Cmd+Enter, and call it |
| Step / continue / stop | Debug toolbar (F10, F11, F5, Shift+F5), or `n`, `s`, `c`, `Q` in the console; both stay in sync |
| Open or reopen the console | Status bar **R** item, or *betterR: Open R Console* |
| Restart R | *betterR: Restart R Session* |
| Detach the console without killing R | Ctrl-D in the terminal, then reopen it from the status bar |

Breakpoints apply to code R learns about with a file location, which means code run with Cmd+Enter. Code run with `source()` uses R's own srcrefs. Functions you type directly in the console have no file, so they are shown from a read-only `ark:` virtual document.

Disable **REditorSupport (`reditorsupport.r`)** in windows where you use betterR, because it registers a competing R language server.

### Settings

- `betterR.arkPath`: ark binary. If empty: `$ARK_PATH`, then `ark` on `PATH`, then the repo's dev build.
- `betterR.consolePath`: betterr binary. If empty: `betterr` on `PATH`, then the repo's dev build.
- `betterR.openConsoleOnStart` (default `true`).

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

## Design notes

- **No ZeroMQ in Node.** The extension never speaks Jupyter itself. `betterr --lsp-stdio` bridges ark's LSP to stdio for `vscode-languageclient`. The console talks to the extension over a Unix socket of JSON lines (`ide.sock`), and the debugger uses a small in-process DAP bridge to ark's TCP port. There are no native modules.
- **One LSP client per kernel.** Ark sends live-state updates (console scopes, virtual documents) only to its newest LSP connection. When hosted, the console therefore asks the extension for completions instead of opening its own LSP, so the editor's connection receives everything. This is what makes `ark:` documents openable.
- **The console owns ark's debugger comm**, because ark runs Step and Continue as console input ("as if typed"). When you click Step, ark sends the console `execute n`; the console wakes from line editing, echoes `Browse[1]> n` and runs it. Run Selection works the same way: the code is echoed one expression per prompt, with your half-typed input preserved.
- **Run Selection carries a file location** (`positron.code_location`, UTF-8 columns). Ark attaches srcrefs into that file and injects breakpoints, so the debugger shows the real line.
- **Debug session lifecycle.** VS Code is attached while R is paused or while any R breakpoints exist, which ark needs in order to receive them. Otherwise it is detached, so the debug toolbar only appears when it means something. Detaching is debounced because every step briefly leaves the browser. Ark doesn't replay `stopped` to a client that attaches while R is already paused, so the bridge sends it.
- **Lifecycle.** The extension owns ark. Closing the console only detaches it. `q()` in the console ends the session, and the extension offers *Restart R*. On window close, ark is stopped and its temp dir removed. If ark crashes, its log is kept and its path is written to the *betterR* output channel.
