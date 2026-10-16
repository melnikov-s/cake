import { describe, expect, it } from "vitest";
import type { UiPart } from "../../../src/contracts/conversations/session-contract";
import { linkedMessageTarget } from "../../../src/renderer/lib/message-navigation";

const reasoning: UiPart = {
  id: "entry-answer-reasoning-0",
  kind: "reasoning",
  text: "Thinking",
  status: "complete",
};
const answer: UiPart = {
  id: "entry-answer-text-1",
  kind: "text",
  role: "assistant",
  entryId: "answer",
  text: "Answer",
  status: "complete",
};

describe("linked message targets", () => {
  it("prefers entry text to earlier reasoning but preserves an exact part target", () => {
    expect(linkedMessageTarget([reasoning, answer], "answer")).toBe(answer);
    expect(linkedMessageTarget([reasoning, answer], reasoning.id)).toBe(reasoning);
    expect(linkedMessageTarget([answer, { ...answer, id: "answer" }], "answer")?.id).toBe("answer");
  });
  it("resolves activity-only entries without matching similar entry ids", () => {
    expect(linkedMessageTarget([reasoning], "answer")).toBe(reasoning);
    expect(linkedMessageTarget([reasoning], "ans")).toBeUndefined();
    expect(linkedMessageTarget([], "missing")).toBeUndefined();
  });
});
