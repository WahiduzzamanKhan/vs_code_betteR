import * as assert from 'assert';
import { MIN_CONSOLE_VERSION, PROTOCOL, consoleVersionProblem, parseVersion, protocolProblem } from '../../compat';

suite('Compatibility with the console', () => {
    test('versions are read from `better --version` output', () => {
        assert.deepStrictEqual(parseVersion('better 0.1.0\n'), [0, 1, 0]);
        assert.deepStrictEqual(parseVersion('better 12.3.45'), [12, 3, 45]);
        assert.deepStrictEqual(parseVersion('better 0.2.0-rc.1'), [0, 2, 0]);
        assert.strictEqual(parseVersion('better'), undefined);
    });

    test('a console older than the minimum is refused, others are not', () => {
        const [major, minor, patch] = parseVersion(MIN_CONSOLE_VERSION)!;
        const older = patch > 0 ? `${major}.${minor}.${patch - 1}` : minor > 0 ? `${major}.${minor - 1}.99` : `${major - 1}.99.99`;
        const problem = consoleVersionProblem(`better ${older}\n`, '/x/better');
        assert.ok(problem, `better ${older} accepted`);
        assert.match(problem, /\/x\/better/);
        assert.ok(problem.includes(older) && problem.includes(MIN_CONSOLE_VERSION), problem);

        for (const ok of [
            MIN_CONSOLE_VERSION,
            `${MIN_CONSOLE_VERSION}-rc.1`,
            `${major}.${minor}.${patch + 1}`,
            `${major}.${minor + 1}.0`,
            `${major + 1}.0.0`,
        ]) {
            assert.strictEqual(consoleVersionProblem(`better ${ok}\n`, 'b'), undefined, ok);
        }
        // Unreadable output isn't a reason to refuse.
        for (const unknown of ['', 'something else', 'better', 'better dev']) {
            assert.strictEqual(consoleVersionProblem(unknown, 'b'), undefined, unknown);
        }
    });

    test('a different protocol says which side to update', () => {
        assert.strictEqual(protocolProblem(PROTOCOL), undefined);
        assert.match(protocolProblem(undefined)!, /Update the betteR console/);
        assert.match(protocolProblem(PROTOCOL - 1)!, /Update the betteR console/);
        assert.match(protocolProblem(PROTOCOL + 1)!, /Update the betteR VS Code extension/);
        assert.match(protocolProblem('1')!, /Update the betteR console/);
    });
});
