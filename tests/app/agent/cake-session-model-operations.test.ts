import { describe, expect, it, vi } from "vitest";
import { resolveCakeModelSelection } from "../../../src/domain/model-presets/cake-model-selection";
import { CakeOperationRegistry } from "../../../src/services/pi/runtime/cake-operation-registry";
import { createGlobalControlOperations } from "../../../src/domain/application/cake-global-control-operations";

const context = {
  signal: new AbortController().signal,
  toolCallId: "call-1",
  runtime: {},
};

const tool = (command: "sessions.create" | "sessions.create-draft") => ({
  command,
  topic: "sessions",
  summary: "Create a session.",
  parameters: { type: "object" },
  examples: [{ input: { model: "Sol" } }],
});

const catalog = {
  presets: [
    {
      id: "00000000-0000-4000-8000-000000000001",
      name: "Sol",
      provider: "openai-codex",
      modelId: "gpt-5.6-sol",
      thinkingLevel: "high" as const,
      fastMode: false,
    },
    {
      id: "00000000-0000-4000-8000-000000000002",
      name: "Sol-Fast",
      provider: "openai-codex",
      modelId: "gpt-5.6-sol",
      thinkingLevel: "high" as const,
      fastMode: true,
    },
  ],
};
const caller = {
  provider: "anthropic",
  modelId: "claude-opus",
  thinkingLevel: "max" as const,
  fastMode: true,
};

describe("Cake session model operations", () => {
  it("resolves preset names at global session-creation execution", async () => {
    const invoke = vi.fn(async () => ({ ok: true }));
    const registry = new CakeOperationRegistry(
      createGlobalControlOperations({ tools: [tool("sessions.create")], invoke }, (selection) =>
        resolveCakeModelSelection(selection, catalog, caller),
      ),
    );

    await registry.invoke(
      {
        command: "sessions.create",
        input: {
          workspacePath: "/project",
          name: "Implementation",
          initialPrompt: "Implement it",
          model: "Sol-Fast",
        },
      },
      context,
    );

    expect(invoke).toHaveBeenCalledWith(
      {
        name: "sessions.create",
        arguments: expect.objectContaining({
          model: {
            provider: "openai-codex",
            modelId: "gpt-5.6-sol",
            thinkingLevel: "high",
            fastMode: true,
            preset: { id: catalog.presets[1]!.id },
          },
        }),
      },
      context.signal,
    );
  });

  it("propagates explicit draft settings and defaults optional Fast mode", async () => {
    const invoke = vi.fn(async () => ({ ok: true }));
    const registry = new CakeOperationRegistry(
      createGlobalControlOperations(
        { tools: [tool("sessions.create-draft")], invoke },
        (selection) => resolveCakeModelSelection(selection, catalog, caller),
      ),
    );

    await registry.invoke(
      {
        command: "sessions.create-draft",
        input: {
          workspacePath: "/project",
          name: "Draft",
          initialPrompt: "Plan it",
          model: {
            provider: "openai-codex",
            modelId: "gpt-5.6-sol",
            thinkingLevel: "xhigh",
          },
        },
      },
      context,
    );

    expect(invoke).toHaveBeenCalledWith(
      expect.objectContaining({
        arguments: expect.objectContaining({
          model: {
            provider: "openai-codex",
            modelId: "gpt-5.6-sol",
            thinkingLevel: "xhigh",
            fastMode: false,
          },
        }),
      }),
      context.signal,
    );
  });

  it("uses the configured default preset, not Cake Chat's model, when model is omitted", async () => {
    const invoke = vi.fn(async () => ({ ok: true }));
    let defaultPresetId = catalog.presets[1]!.id;
    const registry = new CakeOperationRegistry(
      createGlobalControlOperations(
        { tools: [tool("sessions.create"), tool("sessions.create-draft")], invoke },
        (selection) =>
          resolveCakeModelSelection(selection, { ...catalog, defaultPresetId }, caller),
      ),
    );

    for (const command of ["sessions.create", "sessions.create-draft"] as const)
      await registry.invoke(
        {
          command,
          input: { workspacePath: "/project", name: "Default", initialPrompt: "Work" },
        },
        context,
      );
    const solFast = {
      preset: { id: catalog.presets[1]!.id },
      provider: "openai-codex",
      modelId: "gpt-5.6-sol",
      thinkingLevel: "high",
      fastMode: true,
    };
    expect(invoke).toHaveBeenNthCalledWith(
      1,
      { name: "sessions.create", arguments: expect.objectContaining({ model: solFast }) },
      context.signal,
    );
    expect(invoke).toHaveBeenNthCalledWith(
      2,
      { name: "sessions.create-draft", arguments: expect.objectContaining({ model: solFast }) },
      context.signal,
    );

    // A changed default applies to the next launch.
    defaultPresetId = catalog.presets[0]!.id;
    await registry.invoke(
      {
        command: "sessions.create",
        input: { workspacePath: "/project", name: "Default", initialPrompt: "Work" },
      },
      context,
    );
    expect(invoke).toHaveBeenLastCalledWith(
      expect.objectContaining({
        arguments: expect.objectContaining({
          model: { ...solFast, fastMode: false, preset: { id: catalog.presets[0]!.id } },
        }),
      }),
      context.signal,
    );
  });

  it("falls back to Cake Chat's settings without a default and rejects unknown presets", async () => {
    const invoke = vi.fn(async () => ({ ok: true }));
    const registry = new CakeOperationRegistry(
      createGlobalControlOperations({ tools: [tool("sessions.create")], invoke }, (selection) =>
        resolveCakeModelSelection(selection, catalog, caller),
      ),
    );

    await registry.invoke(
      {
        command: "sessions.create",
        input: { workspacePath: "/project", name: "Fallback", initialPrompt: "Work" },
      },
      context,
    );
    expect(invoke).toHaveBeenLastCalledWith(
      expect.objectContaining({ arguments: expect.objectContaining({ model: caller }) }),
      context.signal,
    );

    await expect(
      registry.invoke(
        {
          command: "sessions.create",
          input: {
            workspacePath: "/project",
            name: "Unknown",
            initialPrompt: "Work",
            model: "gpt-5.6-sol",
          },
        },
        context,
      ),
    ).rejects.toThrow('Unknown model preset "gpt-5.6-sol"');
    expect(invoke).toHaveBeenCalledTimes(1);
  });
});
