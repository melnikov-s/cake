import { describe, expect, it } from "vitest";
import { windowControlDefinitions } from "../../../src/contracts/application/window-control-definitions";
import orchestration from "../../../.agents/skills/sol-luna-orchestration/SKILL.md?raw";

describe("permanent-chat delegation tool guidance", () => {
  it.each(["sessions.create", "sessions.fork"] as const)(
    "keeps %s discovery consistent with all four selection cases",
    (command) => {
      const guidance = windowControlDefinitions[command].discovery.guidance.join("\n");
      for (const rule of [
        "implementation/code changes",
        "sessions.create",
        "fresh independent Project Session",
        "useful existing context",
        "implementation is not yet clear",
        "sessions.fork",
        "read-only",
        "explicitly requested different model",
        "private subagent directly with that model",
        "Fresh-context subagents require an explicit request",
        "only when explicitly authorized",
        "research workaround",
        "existing context",
        "private subagent",
        "Otherwise use the contextual fork for investigation",
        "silently expand research into coding",
        "registered Project root",
        "worktreeName",
        "initialPrompt",
        "asynchronously/non-blocking",
        "notification",
        "Omit model",
        "unless requested",
        "cross-session chatter",
      ])
        expect(guidance.toLowerCase(), rule).toContain(rule.toLowerCase());
      expect(guidance).not.toContain("Preferred task delegation");
      expect(guidance).not.toContain("coding tools bound");
    },
  );

  it("never advertises an agent fork as a human Side Chat lifecycle", () => {
    const definition = windowControlDefinitions["sessions.fork"];
    const text = [definition.discovery.summary, ...definition.discovery.guidance].join("\n");
    for (const rule of [
      "agent-owned",
      "parent-owned Subagent Session",
      "handleId/ref",
      "survive restart",
      "fails visibly",
      "Side Chats are exclusively human-created",
    ])
      expect(text).toContain(rule);
    expect(text).not.toContain("context-forked Side Session");
    expect(text).not.toContain("inline/side context fork");
  });

  it("makes fresh implementation examples isolated, asynchronous tasks even with a requested model", () => {
    for (const example of windowControlDefinitions["sessions.create"].discovery.examples) {
      expect(example.input.initialPrompt).toContain("Implement");
      expect(example.input.worktreeName).toBeTruthy();
      expect(example.input.resultDelivery).toBe("notification");
    }
  });

  it("keeps the model-specific orchestration skill under the same routing rules", () => {
    for (const rule of [
      "implementation/code changes use sessions.create",
      "never sessions.fork or family children",
      "sessions.fork as a read-only agent-owned context-forked subagent",
      "explicitly requested different model uses a private subagent directly with that model",
      "Fresh-context subagents require an explicit request",
      "Unhelpful existing context permits a private investigator only when explicitly authorized",
      "otherwise use the contextual fork",
      "handoff to a fresh Project Session",
      "never silently turn research into implementation",
      "notification by default",
      "continuation: none",
      "Omit model overrides unless requested",
      "never direct permanent-chat checkout edits",
    ])
      expect(orchestration).toContain(rule);
  });
});
