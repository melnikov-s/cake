import { describe, expect, it, vi } from "vitest";
import { resolveCakeModelSelection } from "../../../src/domain/cake-model-selection";
import { CakeOperationRegistry } from "../../../src/services/pi/runtime/cake-operation-registry";
import { createGlobalControlOperations } from "../../../src/services/pi/runtime/cake-runtime";

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
const inherited = {
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
        resolveCakeModelSelection(selection, catalog, inherited),
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
        (selection) => resolveCakeModelSelection(selection, catalog, inherited),
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

  it("snapshots inheritance when omitted and rejects unknown preset names", async () => {
    const invoke = vi.fn(async () => ({ ok: true }));
    const registry = new CakeOperationRegistry(
      createGlobalControlOperations({ tools: [tool("sessions.create")], invoke }, (selection) =>
        resolveCakeModelSelection(selection, catalog, inherited),
      ),
    );

    await registry.invoke(
      {
        command: "sessions.create",
        input: { workspacePath: "/project", name: "Inherited", initialPrompt: "Work" },
      },
      context,
    );
    expect(invoke).toHaveBeenLastCalledWith(
      expect.objectContaining({ arguments: expect.objectContaining({ model: inherited }) }),
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
