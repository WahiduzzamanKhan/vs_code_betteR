import * as assert from 'assert';
import { failureReason } from '../../arkLog';

// Trimmed from real logs of `better` 0.2.0-rc.1 (2026-11-21); the console's
// `src/arklog.rs` tests use the same ones.
const OLD_R = `  2026-11-21T09:49:01.416332Z  INFO  Loaded connection information from frontend in /tmp/better-6269/kernel.json
    at /github/home/.cargo/git/checkouts/ark/crates/amalthea/src/kernel.rs:358

  2026-11-21T09:49:01.429974Z ERROR  Panic! In file '/github/home/.cargo/git/checkouts/ark/crates/ark/src/start.rs' at line 55: Unsupported R version 4.1.2. Ark requires R >= 4.2.0
Backtrace:
   0: <std::backtrace::Backtrace>::create
   7: ark::start::start_kernel

    at /github/home/.cargo/git/checkouts/ark/crates/ark/src/panic.rs:52
`;

const NO_WHICH = `  2026-11-21T09:51:39.635833Z ERROR  Panic! In file '/github/home/.cargo/git/checkouts/ark/crates/ark/src/console/console_repl.rs' at line 499: Failed to load R modules: Error evaluating 'import_positron(exprs = structure(expression(env_bind_force <- function(env,
    name, value) {
    invisible(original)
}), srcfile = <environment>, wholeSrcref = structure(c(1L, 0L,
25L, 0L, 0L, 0L, 1L, 25L), srcfile = <environment>, class = "srcref")))': .onLoad failed in loadNamespace() for 'utils', details:
  call: system(paste(which, shQuote(names[i])), intern = TRUE, ignore.stderr = TRUE)
  error: error in running command: 'Function not implemented'

R backtrace:
0. runHook(".onLoad", env, package.lib, package)
`;

suite('Why the kernel stopped (ark log)', () => {
    test('a panic gives its message', () => {
        assert.strictEqual(failureReason(OLD_R), 'Unsupported R version 4.1.2. Ark requires R >= 4.2.0');
        assert.strictEqual(
            failureReason(OLD_R.replace(/\n/g, '\r\n')),
            'Unsupported R version 4.1.2. Ark requires R >= 4.2.0',
            'Windows line endings',
        );
        const noR =
            "  2026-11-21T09:49:09.496557Z ERROR  Panic! In file '/x/crates/ark/src/start.rs' at line 46: Can't set up `R_HOME`: Can't find R or `R_HOME`: No such file or directory (os error 2)\nBacktrace:\n";
        assert.strictEqual(
            failureReason(noR),
            "Can't set up `R_HOME`: Can't find R or `R_HOME`: No such file or directory (os error 2)",
        );
    });

    test('quoted R code is left out of a multi-line message', () => {
        assert.strictEqual(
            failureReason(NO_WHICH),
            "Failed to load R modules: .onLoad failed in loadNamespace() for 'utils', details: " +
                'call: system(paste(which, shQuote(names[i])), intern = TRUE, ignore.stderr = TRUE) ' +
                "error: error in running command: 'Function not implemented'",
        );
    });

    test('without a panic the last ERROR line is used', () => {
        const log = '  t  INFO  starting\n  t ERROR  first problem\n  t ERROR  Can\'t connect\n  t  INFO  bye\n';
        assert.strictEqual(failureReason(log), "Can't connect");
        assert.strictEqual(failureReason('  t  INFO  all good\n'), undefined);
        assert.strictEqual(failureReason(''), undefined);
    });

    test('long reasons are cut', () => {
        const reason = failureReason(`t ERROR  Panic! In file 'x' at line 1: ${'é'.repeat(1000)}\n`)!;
        assert.strictEqual([...reason].length, 401);
        assert.ok(reason.endsWith('…'));
    });
});
