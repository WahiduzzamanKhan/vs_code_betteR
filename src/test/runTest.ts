import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runTests } from '@vscode/test-electron';

async function main(): Promise<void> {
    const extensionDevelopmentPath = path.resolve(__dirname, '../../');
    const extensionTestsPath = path.resolve(__dirname, './suite/index');

    // Work on a copy so anything R writes can't touch the repo fixture.
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'better-ws-'));
    fs.cpSync(path.join(extensionDevelopmentPath, 'test-fixtures/workspace'), workspace, { recursive: true });

    try {
        await runTests({
            extensionDevelopmentPath,
            extensionTestsPath,
            // Other R extensions (e.g. REditorSupport) would register competing language servers.
            launchArgs: [workspace, '--disable-extensions', '--disable-workspace-trust'],
        });
    } finally {
        fs.rmSync(workspace, { recursive: true, force: true });
    }

    // Closing VS Code must not leave an R session behind.
    await new Promise((r) => setTimeout(r, 1000));
    const orphans = cp
        .execFileSync('ps', ['-ax', '-o', 'pid=,command='], { encoding: 'utf8' })
        .split('\n')
        // `<pid> <executable> <args>`: match the executable itself, not any command mentioning it.
        .filter((line) => /^\s*\d+\s+\S*\/(ark|better --kernel) --connection_file \S*better-vscode-/.test(line));
    if (orphans.length) {
        throw new Error(`ark still running after VS Code exited:\n${orphans.join('\n')}`);
    }
    console.log('No orphaned ark processes.');
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
