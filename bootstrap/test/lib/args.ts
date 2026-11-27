// Entry arguments of the item 4 and item 6 tests. No test hooks here.

/** Arguments that begin with a dash (release 0.2.0 item 4), in the order they are passed. */
export const DASH_ARGS = ["-x", "-x:foo", "--", "-", "--%", "-File", "-Command", "x", "-Command x", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Verbose", "-ErrorAction:Stop", "-Debug"];

/**
 * More arguments the starter itself must pass byte for byte (empty, a trailing colon, an embedded
 * quote, a trailing backslash). Not for the polyglot under PowerShell: PowerShell drops an empty
 * argument for a `.cmd`, and the contract says so.
 */
export const EXTRA_ARGS = ["", "-x:", 'c"d', "e\\"];

/** The direct starter calls and the Git Bash forwarding take both lists. */
export const ENTRY_ARGS = [...DASH_ARGS, ...EXTRA_ARGS];
