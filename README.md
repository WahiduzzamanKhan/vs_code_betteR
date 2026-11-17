# betteR for VS Code

**RStudio-class R development in plain VS Code. No fork, and no R packages in your project.**

betteR runs **one live R session** per VS Code window and connects every part of VS Code to it. The console in the terminal, completion in the editor, the debugger, plots and help all see the same objects. Create `y <- mtcars` in the console, type `y$` in a script, and the editor completes the columns.

It works in standard VS Code and needs nothing installed into your R library: no `languageserver`, `httpgd` or other helper packages, so your `renv.lock` stays clean.

## Features

- **A modern R console** in VS Code's terminal: syntax highlighting, Tab completion from the live session, multi-line editing, history search, `readline()` prompts and Ctrl-C interrupts.
- **Live-session editor intelligence:** completion (including data frame columns and functions you've defined), signature help and hover help, from the same session as the console.
- **Run code RStudio-style:** **Cmd+Enter** (Ctrl+Enter on Linux) runs the whole statement at the cursor (a function definition, a pipe chain) or the selection, then moves to the next statement.
- **Real debugging:** `browser()`, `debug()` and gutter breakpoints stop in VS Code's debugger on the actual line of your file, with the variables pane, call stack and step buttons. You can also step by typing `n` or `c` in the console.
- **Plots without httpgd:** an *R Plots* panel shows every plot sharp at its exact size, re-rendered when you resize the panel. It has history, Save as PNG/SVG, Remove and Clear.
- **Interactive charts and apps:** plotly, leaflet and other htmlwidgets run live in the plots panel; DT tables, other widgets and Shiny apps run in an *R Viewer* panel.
- **Help pages:** `?mean`, `help()` and `??search` open in an *R Help* panel with Back/Forward. **F1** on a function in your script shows its help.
- **Environment explorer:** an *R Session* side bar on the right lists the objects in your session (or in the debug frame while paused), expandable into columns, list elements and slots. It also shows the attached packages, loaded namespaces and session info, all updated after every command.

## Requirements

- **VS Code 1.106** or newer.
- **R**, installed normally. Tested with R 4.3 and 4.6.
- **The `better` console**, from [betteR](https://github.com/WahiduzzamanKhan/betteR). It contains the R engine ([ark](https://github.com/posit-dev/ark)) that the extension uses. It must be on your `PATH`, or set in `betteR.consolePath`.
- **macOS or Linux.** Windows is not supported yet. betteR has been tested on macOS.
- **To build from source:** Node.js 20 or newer with npm.

## Installation

1. **Install the `better` console** by following the [betteR README](https://github.com/WahiduzzamanKhan/betteR#installation) (`cargo install --path .`). Check it with:

   ```sh
   better --version
   ```

2. **Build and install the extension:**

   ```sh
   git clone https://github.com/WahiduzzamanKhan/vs_code_betteR.git
   cd vs_code_betteR
   npm install
   npm run package
   code --install-extension better-vscode.vsix
   ```

3. **Disable REditorSupport** (`reditorsupport.r`, the "R" extension) if you have it. It runs its own R language server that would compete with betteR's. In the Extensions view, choose *Disable (Workspace)* for projects where you use betteR, or disable it entirely.

4. **Reload VS Code.**

To update, pull the latest changes, run `npm run package` again and reinstall the `.vsix`. To uninstall, run `code --uninstall-extension better.better-vscode`.

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

Type `?mean`, `help("lm")`, `??regression` or `help(package = "stats")` in the console, or press **F1** on a function name in a script. Help opens in the *R Help* panel, in your VS Code theme's colors and fonts; links work, and **◀ ▶** go back and forward.

### Environment explorer

The **R Session** container in the secondary side bar (on the right, next to Chat) has four views. If it's hidden, use *View › Appearance › Secondary Side Bar*.

- **Environment:** the objects in the global environment, with their type and a preview. Expand data frames, lists, environments and S4/R6 objects to see what's inside. While R is paused in the debugger it shows the current frame instead, marked *Debug frame*. Hover an object for its type and size. Title-bar buttons show or hide hidden (`.name`) objects, clear the environment and refresh.
- **Attached:** the search path (`search()`), with package versions. Expand an entry to list its objects.
- **Loaded Namespaces:** every loaded namespace and its version; attached ones are marked.
- **Session:** R version, platform, working directory, memory used by the R process, and counts.

Right-click an object to **Print in Console**, **Show Structure (str)** or **Copy** its name, or to **Remove** it (with confirmation). Print and str run in the console as if typed, so they go into history. Hidden objects are read from the global environment only.

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
| `betteR.consolePath` | *(empty)* | Path to the `better` binary. If empty, `better` on your `PATH` is used. |
| `betteR.openConsoleOnStart` | `true` | Open the R terminal when the session starts. |
| `betteR.arkPath` | *(empty)* | Advanced: use a separate ark build instead of the one inside `better`. |

## Troubleshooting

- **"Could not find `better`"**: install the console and make sure `better --version` works in a terminal. If VS Code was started from the Dock and doesn't see your shell's `PATH`, set `betteR.consolePath` to the full path, for example `~/.cargo/bin/better`.
- **Duplicate completions or errors from another R language server**: disable REditorSupport (see Installation).
- **"The R session ended"**: R crashed or you ran `q()`. Choose *Restart R* in the notification. Session logs are listed in the *betteR* output channel (*View › Output*, then pick *betteR*).
- **A breakpoint doesn't stop**: re-run the function definition with Cmd+Enter after setting the breakpoint, so R picks it up.

## Development

```sh
npm install
npm run compile
npm test            # integration tests in a real VS Code (downloaded on first run)
```

Open this folder in VS Code and press **F5** to start a development window with a sample workspace (`test-fixtures/workspace`). The development build looks for `better` on your `PATH`, then in `../betteR/target/debug/better`.

Commits follow [Conventional Commits](https://www.conventionalcommits.org). Architecture and design notes are in [docs/design.md](docs/design.md).

## License and credits

betteR for VS Code is released under the [MIT License](LICENSE).


betteR is built on [ark](https://github.com/posit-dev/ark) by Posit Software, PBC (MIT licence).
