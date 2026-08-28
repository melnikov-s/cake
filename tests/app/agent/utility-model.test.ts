import { describe, expect, it, vi } from "vitest";
import { generateSessionTitle, normalizeSessionTitle } from "../../../src/agent/utility-model";

describe("utility model", () => {
  it("runs the exact configured model and reasoning level for a bounded title request", async () => {
    const model = { provider: "openai", id: "gpt-5-mini" };
    const completeSimple = vi.fn(async () => ({
      content: [{ type: "text", text: '"Implement utility model settings."' }],
    }));
    const title = await generateSessionTitle({
      modelRuntime: {
        getModel: vi.fn(() => model),
        completeSimple,
      } as never,
      utilityModel: { provider: "openai", modelId: "gpt-5-mini", thinkingLevel: "low" },
      firstUserMessage: "Add a user-configured utility model.",
    });

    expect(title).toBe("Implement utility model settings");
    expect(completeSimple).toHaveBeenCalledWith(
      model,
      expect.objectContaining({
        systemPrompt: expect.stringContaining("user's initial request"),
        messages: [
          expect.objectContaining({
            role: "user",
            content: expect.stringMatching(
              /^<first_user_message>[\s\S]*Add a user-configured utility model[\s\S]*<\/first_user_message>$/,
            ),
          }),
        ],
      }),
      expect.objectContaining({ reasoning: "low", maxTokens: 40 }),
    );
  });

  it("keeps useful title detail and marks titles that exceed the display limit", () => {
    const title = normalizeSessionTitle(`## “${"Long generated title ".repeat(8)}”\nExplanation`);

    expect(title).toHaveLength(80);
    expect(title).toMatch(/…$/u);
    expect(normalizeSessionTitle("\n\n")).toBe("");
  });
});
