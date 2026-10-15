import { expect, it } from "vitest";
import { coordinatorSystemPrompt } from "../../../src/services/pi-durable/coordinator-system-prompt";
import { worktreeSystemPrompt } from "../../../src/services/pi/runtime/worktree-system-prompt";

const prompt = coordinatorSystemPrompt("");

it("describes Cake Chat's direct tools and delegates project work by policy", () => {
  expect(prompt).not.toContain("You cannot read arbitrary local files");
  expect(prompt).toContain("You have read, bash and mcp tools plus the cake gateway");
  expect(prompt).toContain("There is no edit or write tool.");
  // Delegation is framed around context hygiene, not permissions.
  expect(prompt).toContain("Delegation keeps the permanent conversation's context clean");
  expect(prompt).toContain("an independent Project Session in its own Cake-managed worktree");
  expect(prompt).toContain("Never mutate a project root checkout from bash");
  expect(prompt).not.toContain("you MUST delegate to a project investigator");
});

it("names each delegation operation's assignment field", () => {
  expect(prompt).toContain(
    "subagents.start takes task, sessions.create takes initialPrompt, sessions.send takes text, and session.fork takes prompt",
  );
});

it("routes requests by the four-tier delegation rule without a source-reading loophole", () => {
  expect(prompt).toContain("Prefer to delegate. Route every request with this four-tier rule:");
  expect(prompt).toContain(
    "1. **Understanding how something works in a project** (code, architecture, configuration, behavior, including how Cake itself works): start a project investigator subagent with subagents.start and the exact registered projectPath. Never grep, sed, cat or read project source yourself",
  );
  expect(prompt).toContain(
    "2. **Doing work in a project** (code changes, commits, merges, rebases, branch or dependency changes): an independent Project Session in its own Cake-managed worktree",
  );
  expect(prompt).toContain(
    "3. **Other investigation or research not about a project's code** (several searches, Slack/Vault digging, web research): a general subagent",
  );
  expect(prompt).toContain(
    "4. **Quick one-off tool calls**: do these directly—copying text with pbcopy, opening a URL with open, gh pr view, git log to check whether a commit landed, reading a file the user explicitly points at, or a single Slack/Vault/Tool Gateway lookup through mcp.",
  );
  expect(prompt).toContain("When unsure which tier applies, delegate.");
  expect(prompt).not.toContain("quick read-only checks may be done directly");
  expect(prompt).not.toContain(
    "a quick read-only check (one file, git log, gh pr view) may be done directly",
  );
  expect(prompt).not.toContain("Read-only inspection is fine.");
});

it("lands session work through the native worktree merge, never by hand", () => {
  expect(prompt).toContain(
    "When the user asks to land, merge or ship a session's work, call worktrees.merge with that session's sessionId.",
  );
  expect(prompt).toContain(
    "Never tell a session to hand-merge, cherry-pick or commit into the project root, and never land work with git yourself.",
  );
});

it("tells worktree sessions to land through worktrees.merge instead of the main checkout", () => {
  const worktree = worktreeSystemPrompt({
    worktreePath: "/worktrees/change",
    mainCheckoutPath: "/project",
    branch: "agent/change",
  });
  expect(worktree).toContain(
    'When the user asks you to land, merge, or commit this work to the main checkout, commit your intended changes in this worktree and call `{"command":"worktrees.merge"}`.',
  );
  expect(worktree).toContain(
    "Never land work yourself with git merge, cherry-pick, rebase, stash, or commit in the main checkout.",
  );
  expect(worktree).not.toContain("Landing changes onto the main checkout goes through");
});
