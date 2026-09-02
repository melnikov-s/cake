import type { WebContents } from "electron";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CakeRuntimeEvent } from "../../../../src/services/pi/runtime/cake-runtime";
import type { SessionSnapshot } from "../../../../src/ipc/session-contract";
import {
  PluginAgentHost,
  type PluginAgentDriver,
  resolveSessionRef,
  sessionRef,
  workspaceRef,
} from "../../../../src/services/plugins/plugin-agent-host";
import { resolveAgentModel } from "../../../../src/domain/pluginAgents";

const model = (provider: string, id: string, authenticated = true) => ({
  provider,
  id,
  providerName: provider,
  name: id,
  reasoning: true,
  availableThinkingLevels: ["off" as const, "high" as const],
  input: ["text" as const],
  authenticated,
  authTypes: [],
});
const base = {
  workspacePath: "/project",
  sessionId: "session",
  sessionFile: "/sessions/session.jsonl",
  parts: [],
  model: { provider: "current", id: "active", name: "Active" },
  models: [model("utility", "small"), model("default", "standard"), model("current", "active")],
  thinkingLevel: "high",
  availableThinkingLevels: ["off", "high"],
  streaming: false,
  diagnostics: [],
  commands: [],
  compatibility: { resources: [], diagnostics: [] },
  extensionUi: { statuses: [] },
  tree: [],
} satisfies SessionSnapshot;

const makeDriver = (overrides: Partial<PluginAgentDriver>): PluginAgentDriver => ({
  openAgent: async () => base,
  configureAgent: async () => base,
  subscribeAgent: () => () => undefined,
  agentSnapshot: async () => base,
  agentPrompt: async () => base,
  agentAbort: async () => base,
  releaseAgent: () => undefined,
  ...overrides,
});

afterEach(() => vi.useRealTimers());

describe("plugin agent model resolution", () => {
  it("falls back from unavailable utility to Pi default with observable metadata", () => {
    const snapshot = {
      ...base,
      piSettings: {
        defaultProvider: "default",
        defaultModel: "standard",
        defaultThinkingLevel: "low",
      },
    } as unknown as SessionSnapshot;
    expect(
      resolveAgentModel({ prefer: "utility" }, snapshot, {
        provider: "missing",
        modelId: "unknown",
        thinkingLevel: "minimal",
      }),
    ).toEqual({
      requested: "utility",
      source: "default",
      provider: "default",
      modelId: "standard",
      thinkingLevel: "low",
      fallbacks: [{ source: "utility", reason: "unknown-model" }],
    });
  });

  it("requires exact models to pass preflight and preserves current reasoning", () => {
    expect(() =>
      resolveAgentModel({ prefer: "exact", provider: "missing", modelId: "nope" }, base, undefined),
    ).toThrow(/unknown/);
    expect(resolveAgentModel({ prefer: "current" }, base, undefined)).toMatchObject({
      source: "current",
      thinkingLevel: "high",
      fallbacks: [],
    });
  });

  it("round-trips opaque host session references", () => {
    expect(resolveSessionRef(sessionRef("session-1"))).toBe("session-1");
  });

  it("keeps plugin fallback policy observable and executes the resolved profile through PiModels", async () => {
    const completeModel = vi.fn(async () => "summary");
    const driver = makeDriver({
      agentSnapshot: vi.fn(async () => base),
    });
    const host = new PluginAgentHost({
      utilityModel: () => ({
        provider: "utility",
        modelId: "small",
        thinkingLevel: "off",
      }),
      completeModel,
      driver: () => driver,
      resolveSessionWorkspacePath: async () => "/project",
      resolveModel: resolveAgentModel,
      emit: () => undefined,
    });

    const result = await host.complete(
      "plugin.test",
      {
        model: { prefer: "utility" },
        context: { kind: "session", selection: "last-message" },
        instructions: "Summarize",
        maximumOutputCharacters: 1_024,
      },
      sessionRef("session"),
    );

    expect(result).toMatchObject({
      text: "summary",
      resolvedModel: {
        requested: "utility",
        source: "utility",
        provider: "utility",
        modelId: "small",
        thinkingLevel: "off",
        fallbacks: [],
      },
    });
    expect(completeModel).toHaveBeenCalledWith(
      expect.objectContaining({
        selection: {
          provider: "utility",
          modelId: "small",
          thinkingLevel: "off",
          fastMode: false,
        },
        instructions: "Summarize",
        maximumOutputCharacters: 1_024,
        timeoutMs: 30_000,
      }),
      expect.any(AbortSignal),
    );
  });

  it("coalesces live part events without launching a full snapshot for every token", async () => {
    vi.useFakeTimers();
    let listener: ((event: CakeRuntimeEvent) => void) | undefined;
    const releaseAgent = vi.fn();
    const agentSnapshot = vi.fn(async () => base);
    const driver = makeDriver({
      openAgent: vi.fn(async () => base),
      configureAgent: vi.fn(async () => base),
      subscribeAgent: vi.fn((_sessionId: string, next: (event: CakeRuntimeEvent) => void) => {
        listener = next;
        return vi.fn();
      }),
      agentSnapshot,
      releaseAgent,
    });
    const emitted: unknown[] = [];
    const host = new PluginAgentHost({
      utilityModel: () => undefined,
      completeModel: async () => "completed",
      driver: () => driver,
      resolveSessionWorkspacePath: async () => "/project",
      resolveModel: resolveAgentModel,
      emit: (_owner, event) => emitted.push(event),
    });
    const owner = { id: 1 } as WebContents;
    const opened = await host.open(owner, "plugin.test", {
      session: { kind: "new", workspace: workspaceRef("/project"), visibility: "private" },
      model: { prefer: "current" },
    });

    for (let index = 1; index <= 100; index += 1) {
      listener?.({
        type: "part-updated",
        sessionId: base.sessionId,
        part: {
          id: "stream",
          kind: "text",
          role: "assistant",
          text: "x".repeat(index),
          status: "streaming",
        },
      });
    }
    await vi.advanceTimersByTimeAsync(50);

    expect(agentSnapshot).not.toHaveBeenCalled();
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      type: "plugin-agent-event",
      snapshot: { parts: [expect.objectContaining({ text: "x".repeat(100) })] },
    });

    host.detach(owner, "plugin.test", opened.handleId);
    expect(releaseAgent).toHaveBeenCalledWith(base.sessionId);
  });
});
