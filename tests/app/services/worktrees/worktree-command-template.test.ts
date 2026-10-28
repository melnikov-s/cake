import { describe, expect, it } from "vitest";
import { renderWorktreeCommand } from "../../../../src/services/worktrees/worktree-command-template";

const variables = {
  projectPath: "/work/Cake's app",
  worktreePath: "/work/.cake-worktrees/fix setup/app",
  checkoutPath: "/work/.cake-worktrees/fix setup",
  worktreeName: "fix-setup",
  branchName: "agent/fix-setup",
  baseBranch: "main",
  baseCommit: "abc123",
  removeReason: "",
};

describe("worktree command templates", () => {
  it("shell-quotes every substituted variable", () => {
    expect(renderWorktreeCommand("link {projectPath}/node_modules {worktreePath}", variables)).toBe(
      `link '/work/Cake'"'"'s app'/node_modules '/work/.cake-worktrees/fix setup/app'`,
    );
    expect(renderWorktreeCommand("git worktree add {checkoutPath} {branchName}", variables)).toBe(
      `git worktree add '/work/.cake-worktrees/fix setup' 'agent/fix-setup'`,
    );
  });

  it("renders an empty remove reason as one empty argument", () => {
    expect(renderWorktreeCommand("[ {removeReason} = resolve ]", variables)).toBe(
      "[ '' = resolve ]",
    );
  });

  it("preserves ordinary shell variables and unknown braces", () => {
    expect(renderWorktreeCommand("echo ${HOME} {worktreeName} {other}", variables)).toBe(
      "echo ${HOME} 'fix-setup' {other}",
    );
  });
});
