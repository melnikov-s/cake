import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  CakeOperationRegistry,
  cakeToolEnvelopeSchema,
  cakeToolDescription,
} from "../../../src/agent/cake-operation-registry";

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
      inputSchema: z.object({ instructions: z.string().optional() }).strict(),
      examples: [{ input: { instructions: "Keep decisions" } }],
      result: "A completion status.",
      execute,
    },
    {
      command: "session.info",
      topic: "sessions",
      summary: "Inspect this session.",
      inputSchema: z.object({}).strict(),
      examples: [{}],
      result: "Minimal session information.",
      execute: async () => ({ sessionId: "one" }),
    },
  ]);
}

describe("Cake operation registry", () => {
  it("keeps the model-visible envelope and description compact", () => {
    const schema = z.toJSONSchema(cakeToolEnvelopeSchema);
    expect(schema.properties).toEqual(
      expect.objectContaining({ command: expect.any(Object), input: expect.any(Object) }),
    );
    expect(JSON.stringify(schema)).not.toContain("context.compact");
    expect(schema.properties?.command).toEqual(
      expect.objectContaining({
        description: "Exact topic or operation command. Omit for the help index.",
      }),
    );
    expect(schema.properties?.input).toEqual(
      expect.objectContaining({
        description: "Operation arguments only. Omit for help and topic protocol discovery.",
      }),
    );
    expect(cakeToolDescription).toContain(
      'set command to the exact topic name, for example {"command":"vscode"}',
    );
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
});
