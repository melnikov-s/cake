import { Schema } from "effect";
import { describe, expect, it, vi } from "vitest";
import { resolveCakeModelSelection } from "../../../src/domain/cake-model-selection";
import { CakeOperationRegistry } from "../../../src/services/pi/runtime/cake-operation-registry";
import { createAgentControlOperations } from "../../../src/services/pi/runtime/cake-runtime";
import { subagentTaskSchema } from "../../../src/services/pi/runtime/subagent-contract";

describe("subagent contract", () => {
  it("inherits the model when omitted and defaults isolated one-shot execution settings", () => {
    expect(Schema.decodeUnknownSync(subagentTaskSchema)({ task: "Inspect the adapter" })).toEqual({
      task: "Inspect the adapter",
      profile: "worker",
      maxDepth: 0,
      retain: false,
    });
  });

  it("uses the shared preset-or-explicit model selection schema", () => {
    expect(
      Schema.decodeUnknownSync(subagentTaskSchema)({
        task: "Inspect the adapter",
        model: "Sol",
      }),
    ).toMatchObject({ model: "Sol" });
    expect(
      Schema.decodeUnknownSync(subagentTaskSchema)({
        task: "Inspect the adapter",
        model: {
          provider: "openai-codex",
          modelId: "gpt-5.6-sol",
          thinkingLevel: "high",
          fastMode: true,
        },
      }),
    ).toMatchObject({
      model: {
        provider: "openai-codex",
        modelId: "gpt-5.6-sol",
        thinkingLevel: "high",
        fastMode: true,
      },
    });
    expect(() =>
      Schema.decodeUnknownSync(subagentTaskSchema)({
        task: "Inspect the adapter",
        model: { prefer: "current" },
      }),
    ).toThrow();
  });

  it("resolves public subagent model selections before calling the domain control", async () => {
    const run = vi.fn(async () => ({ status: "complete" }));
    const control = {
      run,
      start: vi.fn(async () => ({ status: "running" })),
      parallel: vi.fn(async () => ({ status: "complete" })),
      prompt: vi.fn(async () => ({ status: "complete" })),
      wait: vi.fn(async () => ({ status: "complete" })),
      abort: vi.fn(async () => ({ status: "aborted" })),
      close: vi.fn(async () => ({ status: "closed" })),
    };
    const preset = {
      id: "00000000-0000-4000-8000-000000000001",
      name: "Sol-Fast",
      provider: "openai-codex",
      modelId: "gpt-5.6-sol",
      thinkingLevel: "high" as const,
      fastMode: true,
    };
    const inherited = {
      provider: "anthropic",
      modelId: "claude-opus",
      thinkingLevel: "max" as const,
      fastMode: false,
    };
    const operations = new CakeOperationRegistry(
      createAgentControlOperations(
        control,
        () => "parent",
        (selection) => resolveCakeModelSelection(selection, { presets: [preset] }, inherited),
      ),
    );

    await operations.invoke(
      {
        command: "subagents.run",
        input: { task: "Inspect the adapter", model: "Sol-Fast" },
      },
      {
        signal: new AbortController().signal,
        toolCallId: "call-1",
        runtime: {},
      },
    );

    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({
        task: "Inspect the adapter",
        model: {
          prefer: "exact",
          provider: "openai-codex",
          modelId: "gpt-5.6-sol",
          thinkingLevel: "high",
        },
        fastMode: true,
      }),
      "parent",
      expect.any(AbortSignal),
      undefined,
      "tool-call-1",
    );
  });
});
