# betteR for VS Code

**RStudio-class R development in plain VS Code. No fork, and no R packages in your project.**

betteR runs **one live R session** per VS Code window and connects every part of VS Code to it. The console in the terminal, completion in the editor, the debugger, plots and help all see the same objects. Create `y <- mtcars` in the console, type `y$` in a script, and the editor completes the columns.

It works in standard VS Code and needs nothing installed into your R library: no `languageserver`, `httpgd` or other helper packages, so your `renv.lock` stays clean.

![betteR for VS Code: completion from the live session in the editor, View(df) in the data explorer, the R Session side bar, stepping through browser(), help for mean in the R Help panel, signature help while typing, and a histogram in the R Plots panel](docs/media/vs_code_betteR_demo.gif)

## Features

- **A modern R console** in VS Code's terminal: syntax highlighting, completion that pops up as you type (from the live session, like the editor's) with each suggestion's help beside it, function signatures under the line, multi-line editing (Shift+Enter for a newline, or the key you choose), history search, `readline()` prompts and Ctrl-C interrupts.
- **Live-session editor intelligence:** completion (including data frame columns and functions you've defined), signature help and hover help, from the same session as the console.
- **Run code RStudio-style:** **Cmd+Enter** (Ctrl+Enter on Linux and Windows) runs the whole statement at the cursor (a function definition, a pipe chain) or the selection, then moves to the next statement.
- **Real debugging:** `browser()`, `debug()` and gutter breakpoints stop in VS Code's debugger on the actual line of your file, with the variables pane, call stack and step buttons. You can also step by typing `n` or `c` in the console.
- **Plots without httpgd:** an *R Plots* panel shows every plot sharp at its exact size, re-rendered when you resize the panel. It has history, Save as PNG/SVG, Remove and Clear.
- **Interactive charts and apps:** plotly, leaflet and other htmlwidgets run live in the plots panel; DT tables, other widgets and Shiny apps run in an *R Viewer* panel.
- **Help pages:** `?mean`, `help()` and `??search` open in an *R Help* panel with Back/Forward, find in page, copy and paste. **F1** on a function in your script shows its help.
- **Environment explorer:** an *R Session* side bar on the right lists the objects in your session (or in the debug frame while paused), expandable into columns, list elements and slots. It also shows the attached packages, loaded namespaces and session info, all updated after every command.
- **Data explorer:** `View(df)` opens a data frame in an editor tab: a fast grid for tables of any size, with sorting, filters, search across all cells and copying to the clipboard. It stays in sync as the data frame changes.

## Requirements

- **VS Code 1.106** or newer.
- **R 4.2** or newer, installed normally. Tested with R 4.3, 4.5 and 4.6.
- **The `better` console**, from [betteR](https://github.com/WahiduzzamanKhan/betteR). It contains the R engine ([ark](https://github.com/posit-dev/ark)) that the extension uses. Installing it takes one command (step 1 below).
- **macOS, Linux or Windows**, on x86-64 or ARM64. Tested on macOS (Apple silicon), Linux (Ubuntu, Fedora) and Windows 11 (x86-64 and ARM64).

## Installation

1. **Install the `better` console.** On macOS and Linux:

   ```sh
   curl --proto '=https' --tlsv1.2 -LsSf https://github.com/WahiduzzamanKhan/betteR/releases/latest/download/better-installer.sh | sh
   ```

   On Windows, in PowerShell:

   ```powershell
   powershell -ExecutionPolicy Bypass -c "irm https://github.com/WahiduzzamanKhan/betteR/releases/latest/download/better-installer.ps1 | iex"
   ```

   This installs `better` into `~/.cargo/bin` (`%USERPROFILE%\.cargo\bin` on Windows). Open a new terminal and check it with `better --version`. On Windows, R also needs to be findable: see [betteR's Windows notes](https://github.com/WahiduzzamanKhan/betteR#windows). The [betteR README](https://github.com/WahiduzzamanKhan/betteR#installation) lists the supported platforms and other ways to install. If you skip this step, the extension offers to run the command for you when it can't find `better`.

2. **Install the extension.** Download `better-vscode.vsix` from the [latest release](https://github.com/WahiduzzamanKhan/vs_code_betteR/releases/latest), then either run:

   ```sh
   code --install-extension better-vscode.vsix
   ```

   or, in the Extensions view, open the **…** menu and choose *Install from VSIX…*.

3. **Disable REditorSupport** (`reditorsupport.r`, the "R" extension) if you have it. It runs its own R language server that would compete with betteR's. In the Extensions view, choose *Disable (Workspace)* for projects where you use betteR, or disable it entirely.

4. **Reload VS Code.** If you've just installed `better` or changed your `PATH`, quit VS Code completely and start it again instead, so it sees the new `PATH`.

The `better` console isn't signed yet. On macOS the install script isn't affected; on Windows, SmartScreen may warn. See [betteR's notes on unsigned binaries](https://github.com/WahiduzzamanKhan/betteR#unsigned-binaries).

### Updating and uninstalling

To update, download the new `better-vscode.vsix` and install it the same way.

Keep the extension and the console on the same minor version: extension 0.2.x works with console 0.2.x. While betteR is at 0.x, a new minor version (0.2 → 0.3) can change how the two talk to each other, and patch versions (0.2.0 → 0.2.1) don't. If the console is too old, the extension says so and offers to update it; if the extension is too old, it says to update the extension.

To uninstall, run `code --uninstall-extension better.better-vscode`.

## Build from source

You need Node.js 20 or newer with npm.

```sh
git clone https://github.com/WahiduzzamanKhan/vs_code_betteR.git
cd vs_code_betteR
npm install
npm run package
code --install-extension better-vscode.vsix
```

To update, pull the latest changes, run `npm run package` again and reinstall the `.vsix`. To build the console from source too, see [betteR's *Build from source*](https://github.com/WahiduzzamanKhan/betteR#build-from-source).

## Usage

Open a folder and then any `.R` file. betteR starts an R session in the folder and opens an **R** terminal with the console. The **R** item in the status bar shows the session's state and reopens the console.

### Running code

| Action | How |
|---|---|
| Run the statement at the cursor, or the selection | **Cmd+Enter** (macOS) / **Ctrl+Enter** |
| Type directly into R | The **R** terminal |
| Open or reopen the console | Click **R** in the status bar, or *betteR: Open R Console* |
| Restart R | *betteR: Restart R Session* |
| Detach the console but keep R running | Ctrl-D in the terminal; reopen it from the status bar |

Code you run appears in the console exactly as if you'd typed it, and goes into its history.

### Debugging

1. Put `browser()` in a function, or click in the gutter to set a breakpoint.
2. Run the function definition with **Cmd+Enter**, so R knows which file and line it came from.
3. Call the function. VS Code stops on the line, with variables and the call stack in the Run and Debug view.

Step with the debug toolbar (**F10** step over, **F11** step into, **F5** continue, **Shift+F5** stop), or type `n`, `s`, `c` or `Q` in the console. Stepping from the console keeps your cursor in the console while the editor follows along. Functions you typed straight into the console have no file, so VS Code shows them in a read-only copy.

### Plots, widgets and apps

- **Plots** open in the *R Plots* panel beside the editor. Use **◀ ▶** to move through history, **Save…** for PNG or SVG, **Remove** for the current plot and **Clear** for all of them. Resize the panel and the plot is redrawn to fit.
- **htmlwidgets that are charts** (plotly, leaflet, …) appear live in the same history.
- **Other widgets** (DT tables, …), `viewer` output and **local apps** such as Shiny open in the *R Viewer* panel, with **Reload** and **Open in Browser**.
- **External links** from R (`browseURL("https://…")`) open in your browser.

### Help

Type `?mean`, `help("lm")`, `??regression` or `help(package = "stats")` in the console, or press **F1** on a function name in a script. Help opens in the *R Help* panel, in your VS Code theme's colors and fonts; links work, and **◀ ▶** go back and forward. Select text and copy it with **Cmd+C** (**Ctrl+C**) or the right-click menu (which also has *Copy Link Address* on links), paste into the search page's fields with **Cmd+V** (**Ctrl+V**), and press **Cmd+F** (**Ctrl+F**) or click **Find** to search the page (**Enter** / **Shift+Enter** for the next and previous match, **Escape** to close).

### Environment explorer

The **R Session** container in the secondary side bar (on the right, next to Chat) has four views. If it's hidden, use *View › Appearance › Secondary Side Bar*.

- **Environment:** the objects in the global environment, with their type and a preview. Expand data frames, lists, environments and S4/R6 objects to see what's inside. While R is paused in the debugger it shows the current frame instead, marked *Debug frame*. Hover an object for its type and size. Title-bar buttons filter the list by name, show or hide hidden (`.name`) objects, clear the environment and refresh. The filter (🔍, or Cmd+Alt+F / Ctrl+Alt+F in the view) narrows the list as you type: a plain word matches anywhere in the name, and `*` / `?` wildcards match the whole name (`df_*`), ignoring case. The view's title shows the active filter, it applies to objects created later too, and the ✕ button clears it.
- **Attached:** the search path (`search()`), with package versions. Expand an entry to list its objects.
- **Loaded Namespaces:** every loaded namespace and its version; attached ones are marked.
- **Session:** R version, platform, working directory, memory used by the R process, and counts.

Right-click an object to **Print in Console**, **Show Structure (str)** or **Copy** its name, or to **Remove** it (with confirmation). Print and str run in the console as if typed, so they go into history. Hidden objects are read from the global environment only.

### Data explorer

`View(df)` in the console or a script opens the data frame in an editor tab named after it. So does the **View Data** button (table icon) next to a data frame in the *Environment* view, which also works for data frames inside lists. Running `View(df)` again reuses the tab.

- **Scroll** through any number of rows and columns; values are loaded as you scroll. Row names appear on the left, and missing values show as *NA*.
- **Sort:** click a column header to sort ascending, again for descending, and a third time to clear. Shift-click adds more sort columns. **Clear Sort** restores the original order.
- **Filter:** **+ Filter**, or the ⏷ button on a column header, adds a row filter. Number and date columns offer comparisons, *between* and *is NA*. Text columns offer *contains*, *starts with*, regex and more. Filters appear as chips above the grid; click ✕ to remove one. Invalid filters, such as text compared with a number column, are shown in red.
- **Search:** the search box keeps rows where any cell contains the text.
- **Copy:** select cells by clicking and dragging or with Shift+arrow keys. Click a row name to select whole rows, Cmd/Ctrl-click a header to select a column, or press Cmd/Ctrl+A for everything. Then press **Cmd/Ctrl+C** or **Copy** for tab-separated text (pastes into spreadsheets), or **Copy as CSV**. Multi-cell copies include the column names.

The tab updates when the data frame changes, and says so if it's removed. Sorting and filtering only affect the view, never your data.

### Commands

All commands are in the Command Palette under **betteR**:

| Command | Default key |
|---|---|
| Open R Console | |
| Run Selection or Line in R Console | Cmd+Enter / Ctrl+Enter (in `.R` files) |
| Help for Symbol at Cursor | F1 (in `.R` files) |
| Show Plots | |
| Clear All Plots | |
| Show Viewer | |
| Restart R Session | |
| Refresh R Environment | |
| Clear R Environment | |

### Settings

| Setting | Default | Description |
|---|---|---|
| `betteR.consolePath` | *(empty)* | Path to the `better` binary (`better.exe` on Windows). If empty, `better` on your `PATH` is used. |
| `betteR.openConsoleOnStart` | `true` | Open the R terminal when the session starts. |
| `betteR.arkPath` | *(empty)* | Advanced: use a separate ark build instead of the one inside `better`. |

#### Console settings

The `betteR.console.*` settings change how the R console behaves. They are the console's own settings from its `config.toml` (see the [betteR README](https://github.com/WahiduzzamanKhan/betteR#readme)), so one file can serve both a terminal outside VS Code and VS Code:

- A setting you set in VS Code (user or workspace settings) is passed to the console as `--set key=value` and wins over `config.toml`.
- A setting you leave unset in VS Code isn't passed, so `config.toml` (or the console's default) decides.
- The console reads its settings when it starts. Changing one while the console runs shows *Restart the R console to apply.* with a **Restart** button, which restarts the R session and its console.

| Setting | Values | Default | Description |
|---|---|---|---|
| `betteR.console.startup.r_home` | path | *(empty)* | R installation to use. Empty: `$R_HOME`, else `R RHOME`. Passed to the R kernel; ignored when `betteR.arkPath` is set. |
| `betteR.console.startup.banner` | `true`, `false` | `true` | The R version / ark / key-hint lines at startup. |
| `betteR.console.startup.inline_plots` | `auto`, `iterm`, `kitty`, `sixel`, `none` | `auto` | How plots are drawn in the terminal. `auto` detects the terminal. |
| `betteR.console.completion.lsp` | `true`, `false` | `true` | Completions from ark's language server. |
| `betteR.console.completion.popup` | `typing`, `tab` | `typing` | Show suggestions as you type, or only when Tab is pressed. |
| `betteR.console.completion.min_chars` | 0–10 | `3` | Only with `popup` = `typing`: name characters typed before suggestions show. After `$`, `@` or `::` they always show. |
| `betteR.console.completion.delay_ms` | 0–2000 | `0` | Only with `popup` = `typing`: how long typing must pause before suggestions show. Each key press restarts the wait. |
| `betteR.console.completion.accept` | `tab`, `enter` | `tab` | Key that takes the highlighted suggestion. With `enter`, Enter takes it when the menu is open and runs the line when it isn't; Tab still opens the menu and moves to the next item. |
| `betteR.console.completion.max_suggestions` | 1–50 | `5` | Most suggestions shown at once in the completion menu (the border isn't counted). With more matches, the menu scrolls. |
| `betteR.console.editing.newline` | `auto`, `shift_enter`, `alt_enter`, `opt_enter` | `auto` | The one key that inserts a newline; the others run the line like Enter. `auto` is Shift+Enter in VS Code. `opt_enter` is Option+Enter on macOS and the same as `alt_enter` on Windows and Linux. |
| `betteR.console.history.size` | 0 or more | `10000` | Lines kept in the history file. `0` keeps no history. |
| `betteR.console.history.suggestions` | `true`, `false` | `true` | The rest of a matching history line in grey after the cursor; Right arrow takes it. |

The console's `startup.ark` setting has no VS Code setting: in VS Code, `betteR.arkPath` decides which kernel runs.

VS Code's terminal can't always pass Shift+Enter or Option+Enter through to the console as keys of their own, so the extension binds the newline key itself: the key `betteR.console.editing.newline` picks inserts a newline, and the other one (Shift+Enter or Alt/Option+Enter) runs the line like Enter. This works whatever `terminal.integrated.macOptionIsMeta` and the kitty keyboard protocol are set to, and a new choice takes effect at once. The keybindings read only the VS Code setting, so if you choose the key in `config.toml` instead, VS Code still uses Shift+Enter.

## Troubleshooting

- **"Could not find `better`"**: install the console and make sure `better --version` works in a terminal. VS Code reads `PATH` when it starts, so after installing `better` or changing `PATH`, quit VS Code completely (all windows) and start it again. If VS Code was started from the Dock and doesn't see your shell's `PATH`, set `betteR.consolePath` to the full path, for example `~/.cargo/bin/better`. On Windows, the install script and `cargo install` both put it in `%USERPROFILE%\.cargo\bin\better.exe`; only `better.exe` is used, not a `better.cmd` or `.bat` wrapper.
- **The R session doesn't start on Windows** (the *betteR* output channel lists the session log): R must be on your `PATH`, or `R_HOME` set, before VS Code starts, because the R installer sets up neither. See the [betteR Windows notes](https://github.com/WahiduzzamanKhan/betteR#windows) for setting `R_HOME`. For conda's R, also set the user environment variable `BETTER_STANDARD_DLL_SEARCH=1`.
- **Duplicate completions or errors from another R language server**: disable REditorSupport (see [Installation](#installation)).
- **"The R session ended"**: R crashed or you ran `q()`. Choose *Restart R* in the notification. Session logs are listed in the *betteR* output channel (*View › Output*, then pick *betteR*).
- **A breakpoint doesn't stop**: re-run the function definition with Cmd+Enter after setting the breakpoint, so R picks it up.

## Development

```sh
npm install
npm run compile
npm test            # integration tests in a real VS Code (downloaded on first run)
```

Open this folder in VS Code and press **F5** to start a development window with a sample workspace (`test-fixtures/workspace`). The development build looks for `better` on your `PATH`, then in `../betteR/target/debug/better` (`better.exe` on Windows). On Linux without a display, run the tests as `xvfb-run -a npm test`. On macOS, the plot tests need [XQuartz](https://www.xquartz.org) (`brew install --cask xquartz`), because CRAN's R uses it for `svg()`.

Commits follow [Conventional Commits](https://www.conventionalcommits.org). For branches and releases, see [CONTRIBUTING.md](CONTRIBUTING.md). Architecture and design notes are in [docs/design.md](docs/design.md).

## License and credits

betteR for VS Code is released under the [MIT License](LICENSE).


betteR is built on [ark](https://github.com/posit-dev/ark) by Posit Software, PBC (MIT licence).
