import { describe, expect, it } from "vitest";
import type { SessionSnapshot } from "../../../src/ipc/session-contract";
import { resolveAgentModel, resolveSessionRef, sessionRef } from "../../../src/main/plugin-agent-host";

const model = (provider: string, id: string, authenticated = true) => ({ provider, id, providerName: provider, name: id, reasoning: true, input: ["text" as const], authenticated, authTypes: [] });
const base = {
  workspacePath: "/project", sessionId: "session", sessionFile: "/sessions/session.jsonl", parts: [],
  model: { provider: "current", id: "active", name: "Active" },
  models: [model("utility", "small"), model("default", "standard"), model("current", "active")],
  thinkingLevel: "high", availableThinkingLevels: ["off", "high"], streaming: false, diagnostics: [], commands: [],
  compatibility: { resources: [], diagnostics: [] }, extensionUi: { statuses: [] }, sessions: [], tree: []
} satisfies SessionSnapshot;

describe("plugin agent model resolution", () => {
  it("falls back from unavailable utility to Pi default with observable metadata", () => {
    const snapshot = { ...base, piSettings: { defaultProvider: "default", defaultModel: "standard", defaultThinkingLevel: "low" } } as unknown as SessionSnapshot;
    expect(resolveAgentModel({ prefer: "utility" }, snapshot, { provider: "missing", modelId: "unknown", thinkingLevel: "minimal" })).toEqual({
      requested: "utility", source: "default", provider: "default", modelId: "standard", thinkingLevel: "low",
      fallbacks: [{ source: "utility", reason: "unknown-model" }]
    });
  });

  it("requires exact models to pass preflight and preserves current reasoning", () => {
    expect(() => resolveAgentModel({ prefer: "exact", provider: "missing", modelId: "nope" }, base, undefined)).toThrow(/unknown/);
    expect(resolveAgentModel({ prefer: "current" }, base, undefined)).toMatchObject({ source: "current", thinkingLevel: "high", fallbacks: [] });
  });

  it("round-trips opaque host session references", () => {
    expect(resolveSessionRef(sessionRef("/project/with spaces", "session-1"))).toEqual({ workspacePath: "/project/with spaces", sessionId: "session-1" });
  });
});
