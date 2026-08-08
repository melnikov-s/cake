import { isObservable, reaction, toSnapshot } from "r-state-tree";
import { describe, expect, it } from "vitest";
import type { SessionSnapshot } from "../../../../src/ipc/session-contract";
import { MessageModel } from "../../../../src/renderer/models/message";
import { ModelOptionModel } from "../../../../src/renderer/models/model-option";
import { SessionModel } from "../../../../src/renderer/models/session";
import { SessionSummaryModel } from "../../../../src/renderer/models/session-summary";
import { SessionTreeNodeModel } from "../../../../src/renderer/models/session-tree-node";

const snapshot: SessionSnapshot = {
  workspacePath: "/project",
  sessionId: "session-1",
  sessionFile: "/sessions/one.jsonl",
  parts: [{ id: "message-1", kind: "text", role: "assistant", text: "Hello", status: "streaming" }],
  model: { provider: "openai", id: "model-1", name: "Model" },
  models: [
    { provider: "openai", providerName: "OpenAI", id: "model-1", name: "Model", reasoning: true, input: ["text", "image"], authenticated: true, authTypes: ["api_key"] },
    { provider: "gateway", providerName: "Gateway", id: "model-1", name: "Model through gateway", reasoning: true, input: ["text"], authenticated: false, authTypes: ["api_key"] }
  ],
  thinkingLevel: "medium",
  availableThinkingLevels: ["off", "medium"],
  streaming: true,
  diagnostics: [],
  compatibility: { resources: [{ id: "extension:/fixture.ts", kind: "extension", name: "fixture.ts", path: "/fixture.ts", source: "fixture", scope: "project", origin: "package", commands: ["fixture"], tools: [], enabled: true }], diagnostics: [{ id: "compat:one", severity: "warning", source: "compatibility", method: "custom", message: "Unavailable" }] },
  extensionUi: { statuses: [], widgets: [] },
  sessions: [{ id: "session-1", title: "Session", created: new Date(0).toISOString(), modified: new Date(0).toISOString(), messageCount: 1, archived: false }],
  tree: [{ id: "entry-1", type: "message", preview: "Hello", active: true, children: [] }]
};

describe("SessionModel", () => {
  it("uses observable arrays and proper child models", () => {
    const model = SessionModel.create();
    const parts = model.parts;
    const models = model.models;
    const thinkingLevels = model.availableThinkingLevels;
    const diagnostics = model.diagnostics;
    const sessions = model.sessions;
    const tree = model.tree;
    model.applySnapshot(snapshot);

    expect(model.parts).toBe(parts);
    expect(model.models).toBe(models);
    expect(model.availableThinkingLevels).toBe(thinkingLevels);
    expect(model.diagnostics).toBe(diagnostics);
    expect(model.sessions).toBe(sessions);
    expect(model.tree).toBe(tree);
    expect(model.compatibility).toEqual(snapshot.compatibility);
    expect(isObservable(model.parts)).toBe(true);
    expect(isObservable(model.models)).toBe(true);
    expect(isObservable(model.availableThinkingLevels)).toBe(true);
    expect(isObservable(model.diagnostics)).toBe(true);
    expect(isObservable(model.sessions)).toBe(true);
    expect(isObservable(model.tree)).toBe(true);
    expect(model.parts[0]).toBeInstanceOf(MessageModel);
    expect(model.models[0]).toBeInstanceOf(ModelOptionModel);
    expect(model.sessions[0]).toBeInstanceOf(SessionSummaryModel);
    expect(model.tree[0]).toBeInstanceOf(SessionTreeNodeModel);
    model[Symbol.dispose]();
  });

  it("applies a full session snapshot atomically", () => {
    const model = SessionModel.create();
    const updates: unknown[] = [];
    const stop = reaction(
      () => ({ sessionId: model.sessionId, text: model.parts[0]?.text, title: model.sessions[0]?.title }),
      (next) => updates.push(next)
    );

    model.applySnapshot(snapshot);
    expect(updates).toHaveLength(1);
    expect(model.uiParts[0]).toMatchObject({ text: "Hello", status: "streaming" });
    stop();
    model[Symbol.dispose]();
  });

  it("creates and updates message children without replacing the parts array", () => {
    const model = SessionModel.create();
    model.applySnapshot(snapshot);
    const parts = model.parts;
    const message = model.parts[0];

    model.upsertPart({ id: "message-1", kind: "text", role: "assistant", text: "Streaming", status: "streaming" });

    expect(model.parts).toBe(parts);
    expect(model.parts[0]).toBe(message);
    expect(model.uiParts[0]).toMatchObject({ text: "Streaming" });
    expect(toSnapshot(model).sessionId).toBe("session-1");
    model[Symbol.dispose]();
  });
});
