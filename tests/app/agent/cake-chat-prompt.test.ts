import { expect, it } from "vitest";
import { coordinatorSystemPrompt } from "../../../src/services/pi-durable/coordinator-system-prompt";

const prompt = coordinatorSystemPrompt("");

it("describes Cake Chat's direct tools and delegates project work by policy", () => {
  expect(prompt).not.toContain("You cannot read arbitrary local files");
  expect(prompt).toContain("You have read, bash and mcp tools for quick checks");
  expect(prompt).toContain("There is no edit or write tool.");
  // Delegation is framed around context hygiene, not permissions.
  expect(prompt).toContain("This keeps the permanent conversation's context clean");
  expect(prompt).toContain("go to an independent Project Session in its own Cake-managed worktree");
  expect(prompt).toContain("Never mutate a project root checkout from bash");
  expect(prompt).toContain("quick read-only checks may be done directly");
  expect(prompt).not.toContain("you MUST delegate to a project investigator");
});

it("names each delegation operation's assignment field", () => {
  expect(prompt).toContain(
    "subagents.start takes task, sessions.create takes initialPrompt, sessions.send takes text, and session.fork takes prompt",
  );
});
