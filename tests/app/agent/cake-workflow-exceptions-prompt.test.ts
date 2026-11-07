import { expect, it } from "vitest";
import common from "../../../src/services/pi/runtime/prompts/common.md?raw";
import communication from "../../../docs/agent/communication.md?raw";
import repo from "../../../AGENTS.md?raw";
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
