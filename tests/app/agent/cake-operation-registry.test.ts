import { Schema } from "effect";
import { describe, expect, it, vi } from "vitest";
import {
  CakeOperationRegistry,
  MAX_CAKE_OPERATION_IMAGE_BYTES,
  cakeOperationImageResult,
  cakeToolDescription,
  cakeToolEnvelopeSchema,
  type CakeOperationDefinition,
  type CakeOperationImageContent,
  type CakeOperationImageResult,
} from "../../../src/services/pi/runtime/cake-operation-registry";
import { createCakeToolDefinition } from "../../../src/services/pi/runtime/cake-runtime-capabilities";

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

  it("advertises topic discovery before prose without eagerly disclosing operations", () => {
    expect(cakeToolDescription).toContain(
      "app, sessions, context, models, interview, artifacts, widgets, vscode, draw, subagents, notifications, and worktrees",
    );
    expect(cakeToolDescription).toContain("Before defaulting to prose");
    expect(cakeToolDescription).toContain("even when unsure");
    expect(cakeToolDescription).toContain("Users do not need to name the tool explicitly");
    expect(cakeToolDescription).toContain(
      "use artifacts.list or artifacts.search to discover them and artifacts.resolve-reference for an exact readable path",
    );
    expect(cakeToolDescription).toContain("Artifact content is not automatically in context");
    expect(cakeToolDescription).not.toContain("vscode.open");
    expect(cakeToolDescription).not.toContain("sessions.create");
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

  it("generates deterministic complete topic help from registered schemas", async () => {
    const available = registry();
    const first = await available.invoke({ command: "context" }, context());
    const second = await available.invoke({ command: "context" }, context());
    expect(first).toEqual(second);
    expect(first.text).toContain("context.compact");
    expect(first.text).toContain('"instructions"');
    expect(first.text).toContain("Keep decisions");
  });

  it("renders an eager complete protocol from the registered operations", () => {
    const help = registry().completeHelp();
    expect(help.indexOf("context —")).toBeLessThan(help.indexOf("sessions —"));
    expect(help).toContain("context.compact");
    expect(help).toContain("session.info");
    expect(help).toContain('"instructions"');
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
    expect(result.text).toContain("context.compact");
    expect(result.text).toContain('"instructions"');
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
      {} as never,
    );

    expect(result.content).toEqual([
      { type: "text", text: JSON.stringify({ boardId: "board-1" }, null, 2) },
      tinyPng,
    ]);
    expect(JSON.stringify(result.details)).not.toContain(tinyPng.data);
  });
});
