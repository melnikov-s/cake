import { describe, expect, it, vi } from "vitest";
import { generateSessionTitle, normalizeSessionTitle } from "../../../src/agent/utility-model";

describe("utility model", () => {
  it("runs the exact configured model and reasoning level for a bounded title request", async () => {
    const model = { provider: "openai", id: "gpt-5-mini" };
    const completeSimple = vi.fn(async () => ({ content: [{ type: "text", text: '"Implement utility model settings."' }] }));
    const title = await generateSessionTitle({
      modelRuntime: {
        getModel: vi.fn(() => model),
        completeSimple
      } as never,
      utilityModel: { provider: "openai", modelId: "gpt-5-mini", thinkingLevel: "low" },
      firstUserMessage: "Add a user-configured utility model.",
      firstAssistantMessage: "I will add application preferences and session naming."
    });

    expect(title).toBe("Implement utility model settings");
    expect(completeSimple).toHaveBeenCalledWith(model, expect.objectContaining({
      messages: [expect.objectContaining({ role: "user", content: expect.stringContaining("Add a user-configured utility model") })]
    }), expect.objectContaining({ reasoning: "low", maxTokens: 40 }));
  });

  it("normalizes provider output to the session display limit", () => {
    expect(normalizeSessionTitle(`## “${"Long generated title ".repeat(4)}”\nExplanation`)).toHaveLength(40);
    expect(normalizeSessionTitle("\n\n")).toBe("");
  });
});
