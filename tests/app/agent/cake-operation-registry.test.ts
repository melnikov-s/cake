import { Schema } from "effect";
import { describe, expect, it, vi } from "vitest";
import {
  CakeOperationRegistry,
  cakeToolDescription,
  cakeToolEnvelopeSchema,
} from "../../../src/services/pi/runtime/cake-operation-registry";
import {
  MAX_CAKE_OPERATION_IMAGE_BYTES,
  cakeOperationImageResult,
  type CakeOperationDefinition,
  type CakeOperationImageContent,
  type CakeOperationImageResult,
} from "../../../src/contracts/agent/cake-operation";
import { createCakeToolDefinition } from "../../../src/services/pi/runtime/cake-session-runtime-capabilities";
import { backendAgentTools } from "../../../src/contracts/application/backend-agent-tools";
import { backendAgentSettingsTools } from "../../../src/contracts/application/agent-settings-tools";

function context() {
  return {
    signal: new AbortController().signal,
    toolCallId: "call-1",
    runtime: {},
  };
}

function registry(execute = vi.fn(async () => ({ status: "ok" }))) {
  return new CakeOperationRegistry([
    {
      command: "context.compact",
      topic: "context",
      summary: "Compact context.",
      inputSchema: Schema.Struct({ instructions: Schema.optionalKey(Schema.String) }),
      examples: [{ input: { instructions: "Keep decisions" } }],
      result: "A completion status.",
      execute,
    },
    {
      command: "session.info",
      topic: "sessions",
      summary: "Inspect this session.",
      inputSchema: Schema.Struct({}),
      examples: [{}],
      result: "Minimal session information.",
      execute: async () => ({ sessionId: "one" }),
    },
  ]);
}

function imageOperation(
  execute: CakeOperationDefinition<unknown, CakeOperationImageResult>["execute"],
): CakeOperationDefinition<unknown, CakeOperationImageResult> {
  return {
    command: "context.image",
    topic: "context",
    summary: "Return an image.",
    inputSchema: Schema.Struct({}),
    examples: [{}],
    result: "Image metadata and native content.",
    execute,
  };
}

const tinyPng: CakeOperationImageContent = {
  type: "image",
  data: "aW1hZ2U=",
  mimeType: "image/png",
};

describe("Cake operation registry", () => {
  it("keeps the model-visible envelope and description compact", () => {
    const schema = Schema.toStandardJSONSchemaV1(cakeToolEnvelopeSchema)[
      "~standard"
    ].jsonSchema.input({ target: "draft-07" });
    const encoded = JSON.stringify(schema);
    expect(encoded).toContain('"command"');
    expect(encoded).toContain('"input"');
    expect(encoded).not.toContain("context.compact");
    expect(encoded).toContain("Exact topic or operation command. Omit for the help index.");
    expect(encoded).toContain(
      "Operation arguments only. Omit for help and topic protocol discovery.",
    );
  });

  it("describes progressive discovery and return conventions once in a bounded envelope", () => {
    expect(cakeToolDescription.length).toBeLessThan(700);
    expect(cakeToolDescription).toContain("{} lists enabled topics");
    expect(cakeToolDescription).toContain("<operation>.help");
    expect(cakeToolDescription).toContain("Known operations need no prior discovery");
    expect(cakeToolDescription).toContain("<operation>.output-schema");
    expect(cakeToolDescription).toContain("typed operations resolve to {command,result}");
    expect(cakeToolDescription).toContain("Artifact content is not preloaded");
    expect(cakeToolDescription).toContain("artifacts.present");
  });

  it("budgets real backend catalogs independently of their full schemas", () => {
    const available = new CakeOperationRegistry(
      [...backendAgentTools(), ...backendAgentSettingsTools()].map((tool) => ({
        command: tool.command,
        topic: tool.topic,
        summary: tool.summary,
        guidance: tool.guidance,
        inputSchema: Schema.Struct({}),
        inputJsonSchema: tool.parameters,
        result: tool.result ?? "Result",
        examples: tool.examples ?? [],
        execute: async () => null,
      })),
    );
    expect(available.help().length).toBeLessThan(2_000);
    for (const topic of available.availableTopics())
      expect(available.topicHelp(topic)?.length, topic).toBeLessThan(8_000);
  });

  it("treats a missing command and help with incidental input as equivalent", async () => {
    const available = registry();
    const missing = await available.invoke({}, context());
    const explicit = await available.invoke({ command: "help" }, context());
    const missingWithInput = await available.invoke({ input: {} }, context());
    const explicitWithInput = await available.invoke(
      { command: "help", input: { topic: "vscode guide selection" } },
      context(),
    );
    expect(missing).toEqual(explicit);
    expect(missing).toEqual(missingWithInput);
    expect(missing).toEqual(explicitWithInput);
    expect(missing.text).toContain("sessions —");
    expect(missing.text).not.toContain("widgets —");
  });

  it("discloses a deterministic selection catalog before the exact contract", async () => {
    const available = registry();
    const first = await available.invoke({ command: "context" }, context());
    expect(await available.invoke({ command: "context" }, context())).toEqual(first);
    expect(first.text).toBe(
      [
        "context — Inspect context use or compact the current session.",
        "context.compact — Compact context.",
        "Request <operation>.help for its exact contract before invoking an unfamiliar operation.",
      ].join("\n"),
    );
    const exact = await available.invoke({ command: "context.compact.help" }, context());
    expect(exact.text).toContain('"instructions"');
    expect(exact.text).toContain("Keep decisions");
  });

  it("keeps operation-specific guidance at the selected contract, with direct exact help", async () => {
    const execute = vi.fn(async () => ({ status: "ok" }));
    const available = new CakeOperationRegistry([
      {
        command: "context.compact",
        topic: "context",
        summary: "Compact context.",
        guidance: ["Retain unresolved decisions."],
        limitations: ["Cannot undo compaction."],
        inputSchema: Schema.Struct({}),
        examples: [{}],
        result: "Status",
        execute,
      },
    ]);
    const exact = await available.invoke({ command: "context.compact.help" }, context());
    expect(exact.text).toContain("Guidance: Retain unresolved decisions.");
    expect(exact.text).toContain("Limitation: Cannot undo compaction.");
    expect(available.topicHelp("context")).not.toContain("Retain unresolved decisions.");
    expect(execute).not.toHaveBeenCalled();
  });

  it("gates every discovery layer on current operation availability", async () => {
    let enabled = false;
    const available = new CakeOperationRegistry([
      {
        command: "widgets.fixture",
        topic: "widgets",
        summary: "A fixture.",
        inputSchema: Schema.Struct({}),
        outputSchema: Schema.Struct({ status: Schema.String }),
        examples: [],
        result: "Status",
        available: () => enabled,
        execute: async () => ({ status: "ok" }),
      },
    ]);
    expect(available.help()).toBe("");
    expect(available.topicHelp("widgets")).toBeUndefined();
    expect(available.operationHelp("widgets.fixture")).toBeUndefined();
    expect(available.operationOutputSchema("widgets.fixture")).toBeUndefined();
    for (const command of [
      "widgets.fixture",
      "widgets.fixture.help",
      "widgets.fixture.output-schema",
    ]) {
      expect((await available.invoke({ command }, context())).text).toContain(
        "Unknown Cake command",
      );
    }
    enabled = true;
    expect(available.help()).toContain("widgets —");
    expect(available.topicHelp("widgets")).toContain("widgets.fixture — A fixture.");
    expect(available.operationHelp("widgets.fixture")).toContain(
      "Result schema: widgets.fixture.output-schema",
    );
    expect(available.operationOutputSchema("widgets.fixture")).toContain('"status"');
  });

  it("discloses complete validated output constraints only on explicit schema discovery", async () => {
    const execute = vi.fn(async () => ({ count: 2 }));
    const outputSchema = Schema.Struct({
      count: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 3 })),
    });
    const available = new CakeOperationRegistry([
      {
        command: "context.fixture",
        topic: "context",
        summary: "Fixture.",
        inputSchema: Schema.Struct({}),
        outputSchema,
        examples: [],
        result: "A count.",
        execute,
      },
    ]);
    expect(available.operationHelp("context.fixture")).not.toContain('"maximum"');
    const explicit = await available.invoke(
      { command: "context.fixture.output-schema" },
      context(),
    );
    const schema = JSON.parse(explicit.text.split("\n").slice(1).join("\n"));
    expect(schema).toMatchObject({
      additionalProperties: false,
      required: ["count"],
      properties: { count: { type: "integer", minimum: 1, maximum: 3 } },
    });
    expect(explicit.structuredContent).toBe(explicit.text);
    expect(execute).not.toHaveBeenCalled();
    execute.mockResolvedValueOnce({ count: 4 });
    await expect(available.invoke({ command: "context.fixture" }, context())).rejects.toThrow();
    expect(
      (await registry().invoke({ command: "session.info.output-schema" }, context())).text,
    ).toContain("no structured output schema");
  });

  it("returns deterministic nearest matches without executing", async () => {
    const execute = vi.fn(async () => ({ status: "ok" }));
    const result = await registry(execute).invoke({ command: "context.comact" }, context());
    expect(result.text).toContain("Unknown Cake command: context.comact");
    expect(result.text).toContain("context.compact");
    expect(execute).not.toHaveBeenCalled();
  });

  it("returns topic help even when a caller supplies operation-shaped input", async () => {
    const available = registry();
    const result = await available.invoke(
      { command: "context", input: { instructions: "Keep decisions" } },
      context(),
    );
    expect(result.text).toContain("context.compact — Compact context.");
    expect(result.text).toContain("<operation>.help");
  });

  it("rejects invalid operation input before execution", async () => {
    const execute = vi.fn(async () => ({ status: "ok" }));
    await expect(
      registry(execute).invoke({ command: "context.compact", input: { extra: true } }, context()),
    ).rejects.toThrow();
    expect(execute).not.toHaveBeenCalled();
  });

  it("returns bounded native image content without copying bytes into details", async () => {
    const available = new CakeOperationRegistry([
      imageOperation(async () =>
        cakeOperationImageResult({ boardId: "board-1", width: 640, height: 480 }, [tinyPng]),
      ),
    ]);

    const result = await available.invoke({ command: "context.image" }, context());

    expect(result.content).toEqual([
      {
        type: "text",
        text: JSON.stringify({ boardId: "board-1", width: 640, height: 480 }, null, 2),
      },
      tinyPng,
    ]);
    expect(result.details).toEqual({
      protocol: "cake.operation/v1",
      command: "context.image",
      result: { boardId: "board-1", width: 640, height: 480 },
    });
    expect(JSON.stringify(result.details)).not.toContain(tinyPng.data);
    expect(result.structuredContent).toContain("native image pixels were NOT forwarded");
    expect(result.structuredContent).toContain("Descriptions and source are not image inspection");
    expect(result.structuredContent).toContain("Call cake directly");
    expect(JSON.stringify(result.structuredContent)).not.toContain(tinyPng.data);
    expect(result.text).not.toContain("NOT forwarded"); // direct result really carries pixels
  });

  it("keeps a bounded image when oversized metadata is truncated", async () => {
    const available = new CakeOperationRegistry([
      imageOperation(async () =>
        cakeOperationImageResult({ description: "x".repeat(1_100_000) }, [tinyPng]),
      ),
    ]);

    const result = await available.invoke({ command: "context.image" }, context());

    expect(result.content.at(-1)).toEqual(tinyPng);
    expect(result.details).toMatchObject({ result: { truncated: true } });
    expect(JSON.stringify(result.details)).not.toContain(tinyPng.data);
  });

  it("keeps oversized JSON readable as valid JSON without corrupting canonical data", async () => {
    const payload = { title: '\\"\\n'.repeat(20_000) };
    const available = new CakeOperationRegistry([
      {
        command: "context.fixture",
        topic: "context",
        summary: "Fixture.",
        inputSchema: Schema.Struct({}),
        outputSchema: Schema.Struct({ title: Schema.String }),
        result: "A title.",
        examples: [],
        execute: async () => payload,
      },
    ]);
    const result = await available.invoke({ command: "context.fixture" }, context());
    expect(JSON.parse(result.text)).toMatchObject({
      truncated: true,
      characterLength: JSON.stringify(payload, null, 2).length,
      preview: expect.any(String),
      guidance: expect.stringContaining("pagination"),
    });
    expect(result.structuredContent).toEqual({ command: "context.fixture", result: payload });
    expect(result.details).toEqual({
      protocol: "cake.operation/v1",
      command: "context.fixture",
      result: payload,
    });
    expect(result.content).toEqual([{ type: "text", text: result.text }]);
  });

  it.each([
    {
      name: "unsupported MIME type",
      images: [{ ...tinyPng, mimeType: "image/svg+xml" }] as unknown as CakeOperationImageContent[],
      message: /mimeType/,
    },
    {
      name: "malformed base64",
      images: [{ ...tinyPng, data: "not base64" }],
      message: /data/,
    },
    {
      name: "an empty image list",
      images: [],
      message: /require an image/,
    },
    {
      name: "too many images",
      images: Array.from({ length: 5 }, () => tinyPng),
      message: /at most 4 images/,
    },
    {
      name: "too many decoded bytes",
      images: Array.from({ length: 4 }, () => ({
        ...tinyPng,
        data: Buffer.alloc(MAX_CAKE_OPERATION_IMAGE_BYTES / 4 + 1).toString("base64"),
      })),
      message: /byte limit/,
    },
  ])("rejects $name before content reaches Pi", async ({ images, message }) => {
    const available = new CakeOperationRegistry([
      imageOperation(async () => cakeOperationImageResult({ boardId: "board-1" }, images)),
    ]);

    await expect(available.invoke({ command: "context.image" }, context())).rejects.toThrow(
      message,
    );
  });

  it("forwards registry-native image content through the Pi tool definition", async () => {
    const tool = createCakeToolDefinition([
      imageOperation(async () => cakeOperationImageResult({ boardId: "board-1" }, [tinyPng])),
    ]);

    const result = await tool.execute(
      "call-1",
      { command: "context.image" },
      new AbortController().signal,
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

    expect(result.content).toEqual([
      { type: "text", text: JSON.stringify({ boardId: "board-1" }, null, 2) },
      tinyPng,
    ]);
    expect(JSON.stringify(result.details)).not.toContain(tinyPng.data);
  });
});
