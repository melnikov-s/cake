import { describe, expect, it } from "vitest";
import { coordinatorSystemPrompt } from "../../../src/services/pi-durable/coordinator-system-prompt";
import { durableArchiveRecallInstructions } from "../../../src/services/pi-durable/durable-archive-recall";
import { MEMORY_COMPACTOR_PROMPT } from "../../../src/services/pi-durable/durable-memory-policy";
import { worktreeSystemPrompt } from "../../../src/services/pi/runtime/worktree-system-prompt";
import mergeLanding from "../../../src/services/pi/runtime/prompts/worktree-landing-merge.md?raw";
import pullRequestLanding from "../../../src/services/pi/runtime/prompts/worktree-landing-pull-request.md?raw";
const prompt = coordinatorSystemPrompt("", "/cake/docs");

describe("compact Cake Chat guidance", () => {
  it("selects role sections: coordinator stewardship, never for the companion", () => {
    const companion = coordinatorSystemPrompt("", "/cake/docs", true);
    for (const section of ["## Cake Chat", "## Execution stewardship"]) {
      expect(prompt).toContain(section);
      expect(companion).not.toContain(section);
    }
    expect(prompt).not.toContain("## Deliver and revise");
  });

  it("applies global execution policy only to the non-companion Global Cake Chat", () => {
    const global = coordinatorSystemPrompt("", "/docs", false, "", true);
    expect(global).not.toBe(coordinatorSystemPrompt("", "/docs"));
    expect(coordinatorSystemPrompt("", "/docs", true, "", true)).toBe(
      coordinatorSystemPrompt("", "/docs", true),
    );
  });

  it("links the task guide and includes the compaction policy once", () => {
    expect(prompt).toContain("/cake/docs/index.md");
    expect(prompt.split(MEMORY_COMPACTOR_PROMPT)).toHaveLength(2);
  });

  it("scopes recall instructions to the exact conversation reference", () => {
    expect(durableArchiveRecallInstructions("test-chat")).toMatch(
      /^\n<original-conversation reference="cake:\/\/session\/test-chat">\n[\s\S]+\n<\/original-conversation>$/,
    );
  });

  it("preserves user instructions verbatim", () => {
    const custom = "User-owned instructions.\n  Keep spacing. <custom>".repeat(1000);
    expect(coordinatorSystemPrompt(custom, "/cake/docs")).toBe(
      prompt.replace("<cake-chat-instructions>\n\n", `<cake-chat-instructions>\n${custom}\n`),
    );
  });
});

it.each([
  ["merge", mergeLanding, pullRequestLanding],
  ["pull-request", pullRequestLanding, mergeLanding],
] as const)("renders isolated paths with the %s landing template", (mode, selected, other) => {
  const prompt = worktreeSystemPrompt(
    { worktreePath: "/trees/change", mainCheckoutPath: "/project", branch: "agent/change" },
    mode,
  );
  for (const value of ["/trees/change", "/project", "agent/change", selected.trim()])
    expect(prompt).toContain(value);
  expect(prompt).not.toContain(other.trim());
  expect(prompt).not.toContain("{{");
});
