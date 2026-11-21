import * as vscode from 'vscode';

/**
 * Helping users install or update the console (`better`), which is installed
 * separately from this extension. Nothing is downloaded or run unless the
 * user clicks a button.
 */

/** betteR's install scripts, attached to every GitHub Release. */
const RELEASE = 'https://github.com/WahiduzzamanKhan/betteR/releases/latest/download';
export const INSTALL_DOCS = 'https://github.com/WahiduzzamanKhan/betteR#installation';

/**
 * The command that installs (or updates) `better` on `platform`. It works in
 * the shells VS Code's terminal opens: on Windows both PowerShell and cmd.
 */
export function installCommand(platform: NodeJS.Platform = process.platform): string {
    return platform === 'win32'
        ? `powershell -ExecutionPolicy Bypass -c "irm ${RELEASE}/better-installer.ps1 | iex"`
        : `curl --proto '=https' --tlsv1.2 -LsSf ${RELEASE}/better-installer.sh | sh`;
}

/**
 * Shows `message` with buttons to install (or update) the console: run the
 * install command in a terminal the user can watch, copy it, or open the
 * instructions. After installing, "Start R" starts a session without
 * restarting VS Code (the console is then found in its install directory).
 */
export async function offerInstall(message: string, kind: 'install' | 'update'): Promise<void> {
    const run = kind === 'install' ? 'Install' : 'Update';
    const choice = await vscode.window.showErrorMessage(`betteR: ${message}`, run, 'Copy Command', 'Instructions');
    const command = installCommand();
    let next: string;
    if (choice === run) {
        const terminal = vscode.window.createTerminal({ name: `${run} betteR console` });
        terminal.show();
        terminal.sendText(command);
        next = 'When the install in the terminal has finished, start R.';
    } else if (choice === 'Copy Command') {
        await vscode.env.clipboard.writeText(command);
        next = 'Install command copied. Run it in a terminal, then start R.';
    } else {
        if (choice === 'Instructions') {
            void vscode.env.openExternal(vscode.Uri.parse(INSTALL_DOCS));
        }
        return;
    }
    if ((await vscode.window.showInformationMessage(next, 'Start R')) === 'Start R') {
        await vscode.commands.executeCommand('betteR.restart');
    }
}
