import { describe, expect, it, vi } from "vitest";
import {
  generateSessionTitle,
  normalizeSessionTitle,
  rewordSelection,
} from "../../../src/agent/utility-model";

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

  it("rewrites selected text with optional user guidance", async () => {
    const model = { provider: "openai", id: "gpt-5-mini" };
    const completeSimple = vi.fn(async () => ({
      content: [{ type: "text", text: "A concise, clear request." }],
    }));

    const text = await rewordSelection({
      modelRuntime: {
        getModel: vi.fn(() => model),
        completeSimple,
      } as never,
      utilityModel: { provider: "openai", modelId: "gpt-5-mini", thinkingLevel: "off" },
      selection: "This is the thing I was rambling about.",
      prompt: "Make it concise.",
    });

    expect(text).toBe("A concise, clear request.");
    expect(completeSimple).toHaveBeenCalledWith(
      model,
      expect.objectContaining({
        systemPrompt: expect.stringContaining("Return only the rewritten text"),
        messages: [
          expect.objectContaining({
            content: JSON.stringify({
              selection: "This is the thing I was rambling about.",
              guidance: "Make it concise.",
            }),
          }),
        ],
      }),
      expect.objectContaining({ reasoning: undefined, maxTokens: 8_192 }),
    );
  });

  it("keeps useful title detail and marks titles that exceed the display limit", () => {
    const title = normalizeSessionTitle(`## “${"Long generated title ".repeat(8)}”\nExplanation`);

    expect(title).toHaveLength(80);
    expect(title).toMatch(/…$/u);
    expect(normalizeSessionTitle("\n\n")).toBe("");
  });
});
