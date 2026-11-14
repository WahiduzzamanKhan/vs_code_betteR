# betterR VS Code extension (Phase 2)

Runs **one** ark R session per window and connects every view to it:

```
VS Code extension ── spawns ark, owns kernel.json
   ├─ language client ── betterr --lsp-stdio -f kernel.json ──► ark LSP   (completion, hover, signatures…)
   └─ terminal "R"    ── betterr -f kernel.json            ──► ark Jupyter (the console)
```

Run `y <- mtcars` in the console, type `y$` in an `.R` file, and the editor completes the live columns. Nothing is installed into the R library and no project files change.

## Try it

Prerequisites are the dev builds from Phases 0 and 1 (`vendor/ark/target/debug/ark` and `console/target/debug/betterr`).

```sh
cd extension && npm install && npm run compile
code --extensionDevelopmentPath="$PWD" --disable-extension reditorsupport.r /path/to/an/R/project
```

You can also open the `extension/` folder in VS Code and press **F5**, which opens the bundled `test-fixtures/workspace`.

In the new window, open any `.R` file. The R session starts and an **R** terminal opens with the console.

| Action | How |
|---|---|
| Run the current line or selection in the console | **Cmd+Enter** (Ctrl+Enter); the cursor moves to the next line |
| Open or reopen the console | Status bar **R** item, or *betterR: Open R Console* |
| Restart R | *betterR: Restart R Session* |
| Detach the console without killing R | Ctrl-D in the terminal, then reopen it from the status bar |

Disable **REditorSupport (`reditorsupport.r`)** in windows where you use betterR, because it registers a competing R language server.

### Settings

- `betterR.arkPath`: ark binary. If empty: `$ARK_PATH`, then `ark` on `PATH`, then the repo's dev build.
- `betterR.consolePath`: betterr binary. If empty: `betterr` on `PATH`, then the repo's dev build.
- `betterR.openConsoleOnStart` (default `true`).

## Test

```sh
npm test    # downloads a VS Code build into .vscode-test/ on first run
```

The test opens a copy of `test-fixtures/workspace` in a real VS Code with other extensions disabled. It checks five things:
1. The console terminal opens attached to the session.
2. `y <- mtcars` typed into the console makes `y$` complete `mpg, cyl, hp, carb` in the editor.
3. Hover on `mean` shows the R help page.
4. *Run Selection* sends `assign(paste0("dyn", "_from_editor"), 42)` to the console, and the editor then completes `dyn_from_editor`, a name only the live session can know.
5. The installed R package set and all project files, including `renv.lock`, are unchanged afterwards.

## Design notes

- **No ZeroMQ in Node.** The extension never speaks Jupyter itself. `betterr --lsp-stdio` opens ark's `lsp` comm and bridges the TCP LSP to stdio, so `vscode-languageclient` uses a plain stdio server, with no native modules or Electron ABI issues.
- **Two LSP clients, one kernel.** The console and the editor each open their own ark LSP. Phase 1 showed this is safe, because completion reads the live session directly.
- **Lifecycle.** The extension owns ark. Closing the console only detaches it. `q()` in the console ends the session, and the extension offers *Restart R*. On window close, ark is stopped and its temp dir removed. If ark crashes, its log is kept and its path is written to the *betterR* output channel.
- **Run Selection** types into the console as a bracketed paste, so the code appears in console history exactly as if typed.
