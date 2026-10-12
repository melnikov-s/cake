import { SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { projectCakeOperationRuntime } from "../../../src/services/pi/runtime/cake-operation-context";

const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

describe("Cake operation caller projection", () => {
  it("binds interview origin to its assistant tool call, not later metadata", () => {
    const sessionManager = SessionManager.inMemory("/workspace");
    const assistantEntryId = sessionManager.appendMessage({
      role: "assistant",
      api: "openai-completions",
      provider: "fixture",
      model: "fixture",
      content: [{ type: "toolCall", id: "call-1", name: "cake", arguments: {} }],
      usage,
      stopReason: "toolUse",
      timestamp: 0,
    });
    const metadataEntryId = sessionManager.appendCustomEntry("fixture", {});
    const context = projectCakeOperationRuntime({ sessionManager, model: undefined }, "call-1");
    expect(context).toEqual({
      sessionId: sessionManager.getSessionId(),
      sessionFile: undefined,
      entryId: metadataEntryId,
      assistantEntryId,
      model: undefined,
    });
    expect(
      projectCakeOperationRuntime({ sessionManager, model: undefined }, "missing").assistantEntryId,
    ).toBeUndefined();
  });
});
