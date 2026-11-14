import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runTests } from '@vscode/test-electron';

async function main(): Promise<void> {
    const extensionDevelopmentPath = path.resolve(__dirname, '../../');
    const extensionTestsPath = path.resolve(__dirname, './suite/index');

    // Work on a copy so anything R writes can't touch the repo fixture.
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'betterr-ws-'));
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
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
