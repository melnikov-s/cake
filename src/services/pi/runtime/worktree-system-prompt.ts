import { execFile } from "node:child_process";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import worktreePromptTemplate from "./prompts/worktree.md?raw";
import { renderPromptTemplate } from "./prompt-template";

const execFileAsync = promisify(execFile);

export interface GitWorktreeContext {
  worktreePath: string;
  mainCheckoutPath: string;
  branch: string;
}

export function worktreeSystemPrompt(context: GitWorktreeContext): string {
  return renderPromptTemplate(worktreePromptTemplate, {
    worktreePath: context.worktreePath,
    mainCheckoutPath: context.mainCheckoutPath,
    branch: context.branch,
  });
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
