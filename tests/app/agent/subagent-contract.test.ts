import { Schema } from "effect";
import { describe, expect, it, vi } from "vitest";
import { resolveCakeModelSelection } from "../../../src/domain/model-presets/cake-model-selection";
import { CakeOperationRegistry } from "../../../src/services/pi/runtime/cake-operation-registry";
import { createAgentControlOperations } from "../../../src/domain/subagents/cake-subagent-operations";
import { subagentTaskSchema } from "../../../src/contracts/subagents/subagent-tool-input";

describe("subagent contract", () => {
  it("accepts one general-purpose subagent task shape", () => {
    expect(Schema.decodeUnknownSync(subagentTaskSchema)({ task: "Inspect the adapter" })).toEqual({
      task: "Inspect the adapter",
    });
    expect(
      Schema.decodeUnknownSync(subagentTaskSchema)({
        task: "Inspect the adapter",
        projectPath: "/registered/project",
      }),
    ).toEqual({ task: "Inspect the adapter", projectPath: "/registered/project" });
  });

  it("forwards exact inputRefs on every task and follow-up operation without reading content", async () => {
    const first = "00000000-0000-4000-8000-000000000001";
    const second = "00000000-0000-4000-8000-000000000002";
    const messageRef = "cake://session/source?message=entry-1";
    const control = {
      run: vi.fn(async () => ({ status: "complete" })),
      start: vi.fn(async () => ({ status: "queued" })),
      parallel: vi.fn(async () => ({ status: "complete" })),
      prompt: vi.fn(async () => ({ status: "complete" })),
      wait: vi.fn(async () => ({ status: "complete" })),
      abort: vi.fn(async () => ({ status: "aborted" })),
      close: vi.fn(async () => ({ status: "closed" })),
    };
    const registry = new CakeOperationRegistry(
      createAgentControlOperations(
        control,
        () => "cake-chat",
        () => ({ provider: "test", modelId: "model", thinkingLevel: "off", fastMode: false }),
        true,
      ),
    );
    const context = {
      signal: new AbortController().signal,
      toolCallId: "attachments",
      runtime: {},
    };
    for (const command of ["subagents.run", "subagents.start"])
      await registry.invoke(
        {
          command,
          input: { task: "Inspect selected input", inputRefs: [first], messageRefs: [messageRef] },
        },
        context,
      );
    expect(control.run).toHaveBeenCalledWith(
      expect.objectContaining({ inputRefs: [first], messageRefs: [messageRef] }),
      "cake-chat",
      context.signal,
      undefined,
      "tool-attachments",
    );
    expect(control.start).toHaveBeenCalledWith(
      expect.objectContaining({ inputRefs: [first], messageRefs: [messageRef] }),
      "cake-chat",
      context.signal,
      "tool-attachments",
    );
    await registry.invoke(
      {
        command: "subagents.parallel",
        input: {
          tasks: [
            { task: "First", inputRefs: [first] },
            { task: "Second", inputRefs: [second] },
          ],
        },
      },
      context,
    );
    expect(control.parallel).toHaveBeenCalledWith(
      {
        tasks: [
          expect.objectContaining({ inputRefs: [first] }),
          expect.objectContaining({ inputRefs: [second] }),
        ],
      },
      "cake-chat",
      context.signal,
      undefined,
      "tool-attachments",
    );
    for (const [command, delivery] of [
      ["subagents.prompt", "prompt"],
      ["subagents.follow-up", "follow-up"],
    ]) {
      await registry.invoke(
        {
          command,
          input: {
            handleId: first,
            text: "Inspect this too",
            inputRefs: [second],
            messageRefs: [messageRef],
          },
        },
        context,
      );
      expect(control.prompt).toHaveBeenLastCalledWith(
        {
          handleId: first,
          text: "Inspect this too",
          inputRefs: [second],
          messageRefs: [messageRef],
          delivery,
        },
        "cake-chat",
        context.signal,
      );
    }
    await expect(
      registry.invoke(
        {
          command: "subagents.start",
          input: { task: "Too many", inputRefs: Array.from({ length: 21 }, () => first) },
        },
        context,
      ),
    ).rejects.toThrow();
    const help = await registry.invoke({ command: "subagents.start.help" }, context);
    expect(help.text).toContain("inputRefs");
    expect(help.text).toContain("messageRefs");
    await expect(
      registry.invoke(
        {
          command: "subagents.start",
          input: { task: "Bad ref", messageRefs: ["not-a-message-link"] },
        },
        context,
      ),
    ).rejects.toThrow();
    expect(help.text).toContain("attachments.read");
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

    const resolve = (selection: Parameters<typeof resolveCakeModelSelection>[0]) =>
      resolveCakeModelSelection(selection, { presets: [preset] }, inherited);
    await new CakeOperationRegistry(
      createAgentControlOperations(
        control,
        () => "parent",
        (selection) =>
          resolveCakeModelSelection(
            selection,
            { presets: [preset], defaultPresetId: preset.id },
            inherited,
          ),
      ),
    ).invoke(
      { command: "subagents.start", input: { task: "Use the default model" } },
      { signal: new AbortController().signal, toolCallId: "call-default", runtime: {} },
    );
    expect(control.start).toHaveBeenLastCalledWith(
      expect.objectContaining({
        task: "Use the default model",
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
      "tool-call-default",
    );
    const ordinary = createAgentControlOperations(control, () => "parent", resolve);
    const projectAware = createAgentControlOperations(control, () => "cake-chat", resolve, true);
    expect(ordinary[0]?.guidance).toContain(
      "Use subagents only when the user explicitly requested delegation, subagents, or parallel agent work.",
    );
    expect(projectAware[0]?.guidance?.join("\n")).toContain(
      "Delegate every question depending on a registered project's code",
    );
    expect(projectAware[0]?.guidance?.join("\n")).toContain("clarify ambiguous project identity");
    await new CakeOperationRegistry(projectAware).invoke(
      {
        command: "subagents.start",
        input: { task: "Inspect current config", projectPath: "/registered/project" },
      },
      { signal: new AbortController().signal, toolCallId: "call-project", runtime: {} },
    );
    expect(control.start).toHaveBeenCalledWith(
      expect.objectContaining({
        projectPath: "/registered/project",
        model: {
          prefer: "exact",
          provider: inherited.provider,
          modelId: inherited.modelId,
          thinkingLevel: inherited.thinkingLevel,
        },
        fastMode: false,
      }),
      "cake-chat",
      expect.any(AbortSignal),
      "tool-call-project",
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
