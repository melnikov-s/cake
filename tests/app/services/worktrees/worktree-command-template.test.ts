import { describe, expect, it } from "vitest";
import { renderWorktreeCommand } from "../../../../src/services/worktrees/worktree-command-template";

const variables = {
  projectPath: "/work/Cake's app",
  worktreePath: "/work/.cake-worktrees/fix setup",
  worktreeName: "fix-setup",
  branchName: "agent/fix-setup",
  baseBranch: "main",
  baseCommit: "abc123",
};

describe("worktree command templates", () => {
  it("shell-quotes every substituted variable", () => {
    expect(renderWorktreeCommand("link {projectPath}/node_modules {worktreePath}", variables)).toBe(
      `link '/work/Cake'"'"'s app'/node_modules '/work/.cake-worktrees/fix setup'`,
    );
  });

  it("preserves ordinary shell variables", () => {
    expect(renderWorktreeCommand("echo ${HOME} {worktreeName}", variables)).toBe(
      "echo ${HOME} 'fix-setup'",
    );
  });
});
