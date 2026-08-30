import { describe, expect, it } from "vitest";
import { CakeOperationRegistry } from "../../../src/agent/cake-operation-registry";
import { createCakeModelOperations } from "../../../src/agent/cake-model-operations";

describe("Cake model operations", () => {
  it("lists only preset names, model IDs, and the current default", async () => {
    const operations = new CakeOperationRegistry(
      createCakeModelOperations(() => ({
        presets: [
          {
            id: "00000000-0000-4000-8000-000000000001",
            name: "Sol",
            modelId: "gpt-5.6-sol",
          },
          {
            id: "00000000-0000-4000-8000-000000000002",
            name: "Luna",
            modelId: "gpt-5.6-luna",
          },
        ],
        defaultPresetId: "00000000-0000-4000-8000-000000000001",
      })),
    );

    const result = await operations.invoke(
      { command: "models.list" },
      {
        signal: new AbortController().signal,
        toolCallId: "call-1",
        runtime: {},
      },
    );

    expect(result.details).toMatchObject({
      result: {
        presets: [
          { name: "Sol", modelId: "gpt-5.6-sol", default: true },
          { name: "Luna", modelId: "gpt-5.6-luna", default: false },
        ],
      },
    });
    expect(result.text).not.toContain("provider");
    expect(result.text).not.toContain("thinkingLevel");
    expect(result.text).not.toContain("fastMode");
  });
});
