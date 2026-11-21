import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { existingFile, findInstalled, findOnPath, installDir } from '../../binary';

/** Runs `fn` as if on `platform`; only `process.platform` changes. */
function as<T>(platform: NodeJS.Platform, fn: () => T): T {
    const real = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { value: platform });
    try {
        return fn();
    } finally {
        Object.defineProperty(process, 'platform', real);
    }
}

suite('betteR: finding the better binary', () => {
    let root: string;
    const dir = (name: string, files: string[] = []) => {
        const d = path.join(root, name);
        fs.mkdirSync(d, { recursive: true });
        for (const f of files) {
            fs.writeFileSync(path.join(d, f), '');
        }
        return d;
    };
    const pathVar = (...dirs: string[]) => dirs.join(path.delimiter);

    suiteSetup(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'better-binary-'));
    });
    suiteTeardown(() => fs.rmSync(root, { recursive: true, force: true }));

    test('on Windows, better.exe is found after other PATH entries, including quoted ones', () => {
        const empty = dir('empty');
        const bin = dir('with space', ['better.exe']);
        assert.strictEqual(
            as('win32', () => findOnPath('better', pathVar('', empty, `"${bin}"`))),
            path.join(bin, 'better.exe'),
        );
    });

    test('on Windows, better.cmd and an extensionless better are not used', () => {
        // Node can't spawn a .cmd without a shell, so it must not be chosen.
        const shims = dir('shims', ['better.cmd', 'better.bat', 'better']);
        assert.strictEqual(as('win32', () => findOnPath('better', pathVar(shims))), undefined);
    });

    test('a directory named better.exe is not an executable', () => {
        const parent = dir('parent');
        fs.mkdirSync(path.join(parent, 'better.exe'));
        assert.strictEqual(as('win32', () => findOnPath('better', pathVar(parent))), undefined);
    });

    test('on Windows, a configured path may leave out .exe', () => {
        const bin = dir('configured', ['better.exe']);
        const withExe = path.join(bin, 'better.exe');
        assert.strictEqual(as('win32', () => existingFile(path.join(bin, 'better'))), withExe);
        assert.strictEqual(as('win32', () => existingFile(withExe)), withExe);
        assert.strictEqual(as('win32', () => existingFile(path.join(bin, 'missing'))), undefined);
    });

    test('elsewhere, the plain name is found and .exe is not added', () => {
        const bin = dir('unix', ['better']);
        const exeOnly = dir('exe-only', ['better.exe']);
        assert.strictEqual(as('darwin', () => findOnPath('better', pathVar(exeOnly, bin))), path.join(bin, 'better'));
        assert.strictEqual(as('linux', () => existingFile(path.join(exeOnly, 'better'))), undefined);
    });

    test('a console the install script put in $CARGO_HOME/bin or ~/.cargo/bin is found without PATH', () => {
        const home = dir('home');
        dir(path.join('home', '.cargo', 'bin'), ['better', 'better.exe']);
        const cargoHome = dir('cargo-home');
        dir(path.join('cargo-home', 'bin'), ['better']);
        assert.strictEqual(installDir({}, home), path.join(home, '.cargo', 'bin'));
        assert.strictEqual(installDir({ CARGO_HOME: cargoHome }, home), path.join(cargoHome, 'bin'));
        assert.strictEqual(
            as('linux', () => findInstalled('better', {}, home)),
            path.join(home, '.cargo', 'bin', 'better'),
        );
        assert.strictEqual(
            as('win32', () => findInstalled('better', {}, home)),
            path.join(home, '.cargo', 'bin', 'better.exe'),
        );
        assert.strictEqual(
            as('linux', () => findInstalled('better', { CARGO_HOME: cargoHome }, home)),
            path.join(cargoHome, 'bin', 'better'),
        );
        assert.strictEqual(as('win32', () => findInstalled('better', { CARGO_HOME: cargoHome }, home)), undefined);
        assert.strictEqual(findInstalled('better', {}, dir('empty-home')), undefined);
    });
});
