/** Node 24 emits this warning when the production Durable SQLite adapter is imported.
 * Strip only its exact two-line diagnostic, preserving all unexpected stderr.
 */
export const unexpectedNodeStderr = (stderr: string) =>
  stderr.replace(
    /\(node:\d+\) ExperimentalWarning: SQLite is an experimental feature and might change at any time\r?\n\(Use `node --trace-warnings \.\.\.` to show where the warning was created\)\r?\n/g,
    "",
  );
