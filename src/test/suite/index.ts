import * as fs from 'fs';
import * as path from 'path';
import Mocha from 'mocha';

export function run(): Promise<void> {
    const mocha = new Mocha({ ui: 'tdd', color: true, timeout: 180_000 });
    // Sorted, since readdir order differs between file systems, with the
    // shutdown suite last: it restarts R, which would disturb later suites.
    const last = 'shutdown.test.js';
    const files = fs
        .readdirSync(__dirname)
        .filter((file) => file.endsWith('.test.js'))
        .sort((a, b) => Number(a === last) - Number(b === last) || a.localeCompare(b));
    for (const file of files) {
        mocha.addFile(path.join(__dirname, file));
    }
    return new Promise((resolve, reject) => {
        mocha.run((failures) => (failures ? reject(new Error(`${failures} test(s) failed`)) : resolve()));
    });
}
