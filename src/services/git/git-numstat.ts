import type { ChangedFile } from "../../contracts/worktrees/worktree-changes";

/** Decode --raw --numstat -z --no-renames without unquoting or trimming paths. */
export function parseNumstat(output: string): Omit<ChangedFile, "workingTreeExists">[] {
  const records = output.split("\0");
  const deletedPaths = new Set<string>();
  const files: Omit<ChangedFile, "workingTreeExists">[] = [];
  for (let index = 0; index < records.length; index++) {
    const row = (records[index] ?? "").replace(/^\n+/, "");
    if (!row) continue;
    if (row.startsWith(":")) {
      const path = records[++index];
      if (row.endsWith(" D") && path) deletedPaths.add(path);
      continue;
    }
    const first = row.indexOf("\t");
    const second = row.indexOf("\t", first + 1);
    if (first < 0 || second < 0) throw new Error("Invalid Git numstat record");
    const added = row.slice(0, first);
    const removed = row.slice(first + 1, second);
    const path = row.slice(second + 1);
    files.push({
      path,
      deleted: deletedPaths.has(path),
      additions: added === "-" ? null : Number(added),
      deletions: removed === "-" ? null : Number(removed),
    });
  }
  return files;
}
