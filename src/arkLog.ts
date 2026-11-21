import * as fs from 'fs';

/**
 * Finding why the kernel stopped, in ark's log, so the extension can say so
 * instead of only "The R session ended" (for example "Unsupported R version
 * 4.1.2. Ark requires R >= 4.2.0").
 *
 * The console does the same in `../betteR/src/arklog.rs`; keep the two alike.
 */

/** Longest reason shown; longer ones are cut with an ellipsis. */
const MAX_CHARS = 400;

/**
 * The reason in ark's log `log`: the message of its first panic, else of its
 * last `ERROR` line, on one line.
 *
 * A panic looks like `<time> ERROR  Panic! In file '…' at line N: <message>`,
 * and the message can go on over the following lines until a blank line or a
 * backtrace. When R code failed, the message quotes all of that code
 * (`Error evaluating '<code>': <R error>`); the code is left out.
 */
export function failureReason(log: string): string | undefined {
    const lines = log.split(/\r?\n/);
    const start = lines.findIndex((l) => l.includes("Panic! In file '"));
    let reason: string;
    if (start >= 0) {
        const first = lines[start];
        const at = first.indexOf("' at line ");
        const colon = at >= 0 ? first.indexOf(': ', at) : -1;
        const parts = [colon >= 0 ? first.slice(colon + 2) : first];
        for (const line of lines.slice(start + 1)) {
            const t = line.trim();
            if (t === '' || t === 'Backtrace:' || t === 'R backtrace:') {
                break;
            }
            parts.push(line);
        }
        reason = parts.join('\n');
    } else {
        const line = [...lines].reverse().find((l) => l.includes(' ERROR '));
        if (line === undefined) {
            return undefined;
        }
        reason = line.slice(line.indexOf(' ERROR ') + ' ERROR '.length);
    }
    const evaluating = reason.indexOf("Error evaluating '");
    const end = reason.lastIndexOf("': ");
    if (evaluating >= 0 && end > evaluating) {
        reason = reason.slice(0, evaluating) + reason.slice(end + 3);
    }
    reason = reason.split(/\s+/).filter(Boolean).join(' ');
    if (!reason) {
        return undefined;
    }
    const chars = [...reason];
    return chars.length > MAX_CHARS ? chars.slice(0, MAX_CHARS).join('') + '…' : reason;
}

/** `failureReason` of the log file at `file`, if it can be read. */
export function failureReasonIn(file: string): string | undefined {
    try {
        return failureReason(fs.readFileSync(file, 'utf8'));
    } catch {
        return undefined;
    }
}
