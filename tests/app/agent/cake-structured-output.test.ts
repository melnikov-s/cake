import { Schema } from "effect";
import { describe, expect, it, vi } from "vitest";
import { createCakeArtifactOperations } from "../../../src/domain/artifacts/cake-artifact-operations";
import {
  CakeOperationRegistry,
  cakeToolOutputSchema,
} from "../../../src/services/pi/runtime/cake-operation-registry";
import {
  cakeOperationImageResult,
  type CakeOperationDefinition,
} from "../../../src/contracts/agent/cake-operation";
import { createCakeToolDefinition } from "../../../src/services/pi/runtime/cake-session-runtime-capabilities";
import { artifactMetadata, artifactOperationOptions } from "../../fixtures/cake-structured-output";

const context = { signal: new AbortController().signal, toolCallId: "fixture", runtime: {} };
const image = { type: "image", data: "aW1hZ2U=", mimeType: "image/png" } as const;
function operations(list = vi.fn(async () => [artifactMetadata()])) {
  return createCakeArtifactOperations({ appendEntry: vi.fn() }, artifactOperationOptions(list));
}
function nonselected(execute: CakeOperationDefinition["execute"]): CakeOperationDefinition {
  return {
    command: "app.fixture",
    topic: "app",
    summary: "Fixture",
    inputSchema: Schema.Struct({}),
    examples: [{}],
    result: "Ordinary result",
    execute,
  };
}

async function invokeTool(definitions: CakeOperationDefinition[], command: string, input = {}) {
  return createCakeToolDefinition(definitions).execute(
    "fixture",
    { command, input },
    context.signal,
    undefined,
    {
      sessionManager: {
        getSessionId: () => "session-1",
        getSessionFile: () => undefined,
        getLeafId: () => null,
        getBranch: () => [],
      },
    } as never,
  );
}

describe("Cake structured output", () => {
  it.each([
    {
      command: "artifacts.list",
      input: {},
      result: { total: 1, truncated: false, artifacts: [artifactMetadata()] },
    },
    {
      command: "artifacts.search",
      input: { query: "DESIGN" },
      result: { total: 1, truncated: false, artifacts: [artifactMetadata()] },
    },
    {
      command: "artifacts.resolve-reference",
      input: { reference: "design-plan@r2" },
      result: artifactMetadata(),
    },
  ])(
    "forwards authoritative $command data through the gateway with readable direct content",
    async ({ command, input, result }) => {
      const definitions = operations();
      const gateway = await invokeTool(definitions, command, input);
      expect(gateway.structuredContent).toEqual({ command, result });
      expect(gateway.content).toEqual([{ type: "text", text: JSON.stringify(result, null, 2) }]);
      expect(gateway.details).toEqual({ protocol: "cake.operation/v1", command, result });
      expect(JSON.stringify(gateway)).not.toContain("Content never returned");
    },
  );

  it("preserves empty, bounded, and filtered list semantics", async () => {
    const list = vi.fn(async () =>
      Array.from({ length: 101 }, (_, i) => artifactMetadata(`item-${i}`)),
    );
    const registry = new CakeOperationRegistry(operations(list));
    expect(
      (await registry.invoke({ command: "artifacts.list" }, context)).structuredContent,
    ).toMatchObject({ result: { total: 101, truncated: true, artifacts: expect.any(Array) } });
    const searched = await registry.invoke(
      { command: "artifacts.search", input: { query: "item-", limit: 2 } },
      context,
    );
    expect(searched.structuredContent).toMatchObject({
      result: {
        total: 101,
        truncated: true,
        artifacts: [artifactMetadata("item-0"), artifactMetadata("item-1")],
      },
    });
    expect(
      (await registry.invoke({ command: "artifacts.search", input: { query: "absent" } }, context))
        .structuredContent,
    ).toEqual({
      command: "artifacts.search",
      result: { total: 0, truncated: false, artifacts: [] },
    });
    list.mockResolvedValueOnce([]);
    expect(
      (await registry.invoke({ command: "artifacts.list" }, context)).structuredContent,
    ).toEqual({ command: "artifacts.list", result: { total: 0, truncated: false, artifacts: [] } });
  });

  it("advertises a small fixed output envelope regardless of registered result schemas", () => {
    const definitions = operations();
    const expanded = Array.from({ length: 50 }, (_, index) =>
      definitions.map((definition) => ({
        ...definition,
        command: `${definition.command}${index}`,
      })),
    ).flat();
    const schema = createCakeToolDefinition([]).outputSchema;
    expect(createCakeToolDefinition(definitions).outputSchema).toEqual(schema);
    expect(createCakeToolDefinition(expanded).outputSchema).toEqual(schema);
    expect(schema).toMatchObject({
      anyOf: [
        { type: "string" },
        {
          type: "object",
          properties: { command: { type: "string" }, result: {} },
          required: ["command", "result"],
        },
      ],
    });
    expect(JSON.stringify(schema).length).toBeLessThan(1_024);
    const decode = Schema.decodeUnknownSync(cakeToolOutputSchema);
    expect(decode("help")).toBe("help");
    for (const result of [null, 42, "value", [], { nested: true }]) {
      const envelope = { command: "artifacts.search", result };
      expect(decode(envelope)).toEqual(envelope);
    }
  });

  it.each([
    { name: "wrong field type", mutate: () => ({ ...artifactMetadata(), selectedRevision: "2" }) },
    {
      name: "missing required field",
      mutate: () =>
        Object.fromEntries(Object.entries(artifactMetadata()).filter(([key]) => key !== "files")),
    },
    {
      name: "unexpected metadata field",
      mutate: () => ({ ...artifactMetadata(), payload: "not metadata" }),
    },
    {
      name: "invalid nested file",
      mutate: () => ({
        ...artifactMetadata(),
        files: [{ ...artifactMetadata().files[0], byteSize: "4" }],
      }),
    },
  ])("rejects $name before returning native structured success", async ({ mutate }) => {
    // Intentional malformed external boundary, despite its static contract.
    const list = vi.fn(async () => [mutate()] as unknown as ReturnType<typeof artifactMetadata>[]);
    await expect(invokeTool(operations(list), "artifacts.list")).rejects.toThrow();
  });

  it("rejects invalid operation input before consulting the authority", async () => {
    const list = vi.fn(async () => [artifactMetadata()]);
    await expect(
      invokeTool(operations(list), "artifacts.search", { query: "design", limit: 51 }),
    ).rejects.toThrow();
    await expect(
      invokeTool(operations(list), "artifacts.search", { query: "design", unexpected: true }),
    ).rejects.toThrow();
    expect(list).not.toHaveBeenCalled();
  });

  it("propagates domain errors without fabricating data", async () => {
    await expect(
      invokeTool(operations(), "artifacts.resolve-reference", { reference: "missing" }),
    ).rejects.toThrow("Artifact is not linked");
  });

  it("retains full valid script data beyond the readable limit but rejects oversized structured results", async () => {
    const large = { ...artifactMetadata(), title: "x".repeat(30_000) };
    const list = vi.fn(async () => [large]);
    const result = await invokeTool(operations(list), "artifacts.list");
    expect(result.content).toEqual([
      { type: "text", text: expect.stringContaining("… (truncated)") },
    ]);
    expect(result.structuredContent).toMatchObject({ result: { artifacts: [large] } });
    list.mockResolvedValueOnce([{ ...large, title: "x".repeat(1_048_576) }]);
    await expect(invokeTool(operations(list), "artifacts.list")).rejects.toThrow(
      /1048576-byte result limit/,
    );
  });

  it.each(["help", "artifacts", "artifacts.search.help", "artifacts.unknown"])(
    "keeps %s discovery readable and executable as a string",
    async (command) => {
      const list = vi.fn(async () => [artifactMetadata()]);
      const result = await invokeTool(operations(list), command);
      expect(result.structuredContent).toEqual(
        result.content[0]?.type === "text" ? result.content[0].text : undefined,
      );
      expect(typeof result.structuredContent).toBe("string");
      expect(list).not.toHaveBeenCalled();
      if (command === "artifacts.search.help") {
        expect(result.structuredContent).toContain("Output schema (result):");
        expect(result.structuredContent).toContain("validated output");
        expect(result.structuredContent).toContain('"selectedRevision"');
      }
    },
  );

  it.each([
    { name: "JSON", value: { status: "ok" } },
    { name: "string", value: "Ordinary readable result" },
    { name: "image", value: cakeOperationImageResult({ width: 1 }, [image]) },
  ])(
    "keeps nonselected $name results as strings without changing content or details",
    async ({ value }) => {
      const result = await invokeTool(
        [...operations(), nonselected(async () => value)],
        "app.fixture",
      );
      const metadata = typeof value === "string" ? value : "_tag" in value ? value.metadata : value;
      const text = typeof metadata === "string" ? metadata : JSON.stringify(metadata, null, 2);
      expect(result.structuredContent).toBe(text);
      expect(result.content).toEqual([
        { type: "text", text },
        ...(typeof value === "object" && "_tag" in value ? [image] : []),
      ]);
      expect(result.details).toEqual({
        protocol: "cake.operation/v1",
        command: "app.fixture",
        result: metadata,
      });
    },
  );
});
