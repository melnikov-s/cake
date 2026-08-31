import { execFile } from "node:child_process";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface GitWorktreeContext {
  worktreePath: string;
  mainCheckoutPath: string;
  branch: string;
}

export function worktreeSystemPrompt(context: GitWorktreeContext): string {
  return `## Worktree isolation

This session is running in a Git worktree:
- Worktree checkout: ${context.worktreePath}
- Main checkout: ${context.mainCheckoutPath}
- Worktree branch: ${context.branch}

Default all repository reads, searches, edits, tests, and commits to the worktree checkout. Resolve repository-relative paths inside the worktree, and when logs or stack traces mention equivalent absolute paths under the main checkout, use the corresponding path in the worktree instead. Never modify files in the main checkout directly. Landing changes onto the main checkout goes through Cake's worktree landing flow.

If the user deliberately asks you to operate on files outside the worktree, you may comply. When instructions or path signals conflict—for example, a pasted stack trace names files in the main checkout—surface the conflict and confirm before writing outside the worktree rather than silently choosing the external path.`;
}

export async function detectGitWorktree(cwd: string): Promise<GitWorktreeContext | undefined> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      [
        "-C",
        cwd,
        "rev-parse",
        "--path-format=absolute",
        "--show-toplevel",
        "--git-dir",
        "--git-common-dir",
        "--abbrev-ref",
        "HEAD",
      ],
      { maxBuffer: 1_000_000 },
    );
    const [worktreePath, gitDirectory, commonDirectory, branch] = stdout.trimEnd().split("\n");
    if (!worktreePath || !gitDirectory || !commonDirectory || !branch) return undefined;
    if (resolve(gitDirectory) === resolve(commonDirectory)) return undefined;

    return {
      worktreePath: resolve(worktreePath),
      mainCheckoutPath: dirname(resolve(commonDirectory)),
      branch,
    };
  } catch {
    return undefined;
  }
}
