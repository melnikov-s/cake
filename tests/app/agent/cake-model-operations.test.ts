import { describe, expect, it } from "vitest";
import { CakeOperationRegistry } from "../../../src/agent/cake-operation-registry";
import { createCakeModelOperations } from "../../../src/agent/cake-model-operations";

describe("Cake model operations", () => {
  it("lists only preset names and model IDs", async () => {
    const operations = new CakeOperationRegistry(
      createCakeModelOperations(() => [
        { name: "Sol", modelId: "gpt-5.6-sol" },
        { name: "Luna", modelId: "gpt-5.6-luna" },
      ]),
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
          { name: "Sol", modelId: "gpt-5.6-sol" },
          { name: "Luna", modelId: "gpt-5.6-luna" },
        ],
      },
    });
    expect(result.text).not.toContain("provider");
    expect(result.text).not.toContain("thinkingLevel");
    expect(result.text).not.toContain("fastMode");
  });
});
