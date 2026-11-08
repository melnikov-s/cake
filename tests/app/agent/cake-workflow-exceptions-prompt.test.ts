import { expect, it } from "vitest";
import common from "../../../src/services/pi/runtime/prompts/common.md?raw";
import communication from "../../../docs/agent/communication.md?raw";
import reports from "../../../docs/agent/reports.md?raw";
import repo from "../../../AGENTS.md?raw";
import verification from "../../../docs/development/agent-verification.md?raw";
import { worktreeSystemPrompt } from "../../../src/services/pi/runtime/worktree-system-prompt";
it("honors task-scoped user overrides without weakening security", () => {
  expect(common).toContain("Current explicit user direction overrides Cake workflow defaults");
  expect(common).toContain(
    "including family/channel rules, not security boundaries or tool limits",
  );
  expect(repo).toContain("No instruction-file edit or repeated approval needed");
});
it("separates verified completion from permission and lifecycle actions", () => {
  expect(common).toContain("Reports/completion grant no merge/resolve approval");
  expect(common).toContain("Merging does not resolve");
  expect(common).toContain("Verify results before claiming success");
});
it("keeps detailed readiness gates in the focused guide, not every role's entry prompt", () => {
  expect(common).toContain("worktrees.reportReadiness");
  expect(common).toContain("reports.md: readiness/auto-merge");
  for (const rule of [
    "currently valid explicit readiness from this app run",
    "Scope complete + relevant checks passed = ready",
    "known relevant failures and uncommitted/unvalidated task changes block readiness",
    "commit the validated work",
    "readyToMerge: true, taskCompleted: true, validationPassed: true",
    "ordinary completion delivery or the final answer",
    "Cake waits for successful substantive turn completion",
  ])
    expect(reports).toContain(rule);
});
it("makes scoped readiness visible without a globally-green repository gate", () => {
  expect(common).toContain("task done + scoped checks passed = ready, not repo-wide green");
  for (const policy of [repo, verification, reports]) {
    expect(policy).toContain("Scope complete + relevant checks passed = ready");
    expect(policy).toContain("validationPassed");
    expect(policy).toContain("task-scoped");
    expect(policy).toContain("Unfinished acceptance criteria, known relevant failures");
    expect(policy).toMatch(/uncommitted\/unvalidated\s+task changes/);
    expect(policy).toContain("exact HEAD");
    expect(policy).not.toMatch(/requires all required checks|require final full/);
  }
  expect(repo).toContain("not as unconditional merge gates");
  expect(verification).toContain(
    "An incomplete broad run alone does not require another full-suite run",
  );
  expect(reports).toContain(
    "Unrelated baseline failures or broad-suite timeouts alone do not block readiness",
  );
  expect(reports).toContain("Never weaken tests or relabel a failed task check as passed");
});
it.each(["merge", "pull-request"] as const)(
  "requires landing authorization before the %s workflow",
  (landing) => {
    const prompt = worktreeSystemPrompt(
      { worktreePath: "/task", mainCheckoutPath: "/project", branch: "agent/task" },
      landing,
    );
    expect(prompt).toContain("When authorized to land:");
    expect(prompt).toContain("Never");
    expect(prompt).toContain("main");
    if (landing === "merge") {
      expect(prompt).toContain("worktrees.merge without sessionId");
      expect(prompt).toContain("no fallback");
    } else {
      expect(prompt).toContain("worktrees.merge is unavailable");
      expect(prompt).toContain("worktrees.reportReadiness");
      expect(prompt).toContain("use PRs");
    }
  },
);
it("allows only requested check-ins, with durable cancellation and evidence", () => {
  expect(common).toContain("Poll/check in only if requested");
  for (const rule of [
    "sessions.schedule",
    "durable repeats",
    "one check-in per task",
    "cancel on completion/pause/stop",
    "successful result",
  ])
    expect(communication).toContain(rule);
});
