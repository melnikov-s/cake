import { describe, expect, it } from "vitest";
import { CakeOperationRegistry } from "../../../src/services/pi/runtime/cake-operation-registry";
import { createCakeModelOperations } from "../../../src/services/pi/runtime/cake-model-operations";

const context = {
  signal: new AbortController().signal,
  toolCallId: "call-1",
  runtime: {},
};

describe("Cake model operations", () => {
  it("lists complete non-credential preset configurations and the current default", async () => {
    const operations = new CakeOperationRegistry(
      createCakeModelOperations(() => ({
        presets: [
          {
            id: "00000000-0000-4000-8000-000000000001",
            name: "Sol",
            provider: "openai-codex",
            modelId: "gpt-5.6-sol",
            thinkingLevel: "high",
            fastMode: false,
          },
          {
            id: "00000000-0000-4000-8000-000000000002",
            name: "Sol-Fast",
            provider: "openai-codex",
            modelId: "gpt-5.6-sol",
            thinkingLevel: "high",
            fastMode: true,
          },
        ],
        defaultPresetId: "00000000-0000-4000-8000-000000000001",
      })),
    );

    const result = await operations.invoke({ command: "models.list" }, context);

    expect(result.details).toMatchObject({
      result: {
        presets: [
          {
            name: "Sol",
            provider: "openai-codex",
            modelId: "gpt-5.6-sol",
            thinkingLevel: "high",
            fastMode: false,
            default: true,
          },
          {
            name: "Sol-Fast",
            provider: "openai-codex",
            modelId: "gpt-5.6-sol",
            thinkingLevel: "high",
            fastMode: true,
            default: false,
          },
        ],
      },
    });
    expect(result.text).not.toContain("credential");
    expect(result.text).not.toContain("apiKey");
  });
});
