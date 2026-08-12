import { isObservable, reaction, toSnapshot } from "r-state-tree";
import { describe, expect, it } from "vitest";
import type { SessionSnapshot } from "../../../../src/ipc/session-contract";
import { MessageModel } from "../../../../src/renderer/models/message";
import { ModelOptionModel } from "../../../../src/renderer/models/model-option";
import { SessionModel } from "../../../../src/renderer/models/session";
import { SessionSummaryModel } from "../../../../src/renderer/models/session-summary";
import { SessionTreeNodeModel } from "../../../../src/renderer/models/session-tree-node";
import { ReviewThreadModel } from "../../../../src/renderer/models/review-thread";

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
  commands: [{ name: "skill:fixture", description: "Fixture skill", source: "skill", sourceInfo: { path: "/fixture/SKILL.md", source: "fixture", scope: "project", origin: "top-level" } }],
  usage: { tokens: { input: 120, output: 30, cacheRead: 80, cacheWrite: 0, total: 230 }, cost: 0.0042, context: { tokens: 200, contextWindow: 1_000, percent: 20 } },
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
    expect(model.commands).toEqual(snapshot.commands);
    expect(model.usage).toEqual(snapshot.usage);
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

  it("keeps one review model instance and derives actionable comments from its messages", () => {
    const model = SessionModel.create({ workspacePath: "/project", sessionId: "session-1" });
    const now = new Date(0).toISOString();
    const thread = {
      id: "review-1", workspacePath: "/project", sessionId: "session-1", status: "open" as const, createdAt: now, updatedAt: now,
      anchor: { path: "src/app.ts", start: { diffLine: 1, newLine: 2 }, end: { diffLine: 1, newLine: 2 }, selectedText: "value", contextBefore: "", contextAfter: "", diff: "+value" },
      messages: [{ id: "comment-1", role: "user" as const, body: "Rename this", createdAt: now, delivered: false, status: "complete" as const }]
    };
    model.applyReviewThreads([thread]);
    const review = model.reviewThreads[0]!;

    expect(review).toBeInstanceOf(ReviewThreadModel);
    expect(review.actionableCommentCount).toBe(1);

    model.upsertReviewThread({ ...thread, updatedAt: new Date(1).toISOString(), messages: [
      { ...thread.messages[0]!, delivered: true },
      { id: "reply-1", role: "assistant", body: "Renamed it.", createdAt: new Date(1).toISOString(), delivered: true, status: "complete" }
    ] });

    expect(model.reviewThreads[0]).toBe(review);
    expect(review.actionableCommentCount).toBe(0);
    model[Symbol.dispose]();
  });
});
