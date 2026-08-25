import { applySnapshot, isObservable, reaction, toSnapshot } from "r-state-tree";
import { describe, expect, it } from "vitest";
import type { SessionSnapshot } from "../../../src/ipc/session-contract";
import { Message } from "../../../src/models/Message";
import { ModelOption } from "../../../src/models/ModelOption";
import { ReviewThread } from "../../../src/models/ReviewThread";
import { Session } from "../../../src/models/Session";
import { SessionTreeEntry } from "../../../src/models/SessionTreeEntry";
import { toSessionSnapshot } from "../../../src/utils/session-snapshot";

const snapshot: SessionSnapshot = {
  workspacePath: "/project",
  sessionId: "session-1",
  sessionFile: "/sessions/one.jsonl",
  parts: [
    {
      id: "message-1",
      kind: "text",
      role: "assistant",
      entryId: "assistant-entry-1",
      text: "Hello",
      status: "streaming",
    },
  ],
  model: { provider: "openai", id: "model-1", name: "Model" },
  models: [
    {
      provider: "openai",
      providerName: "OpenAI",
      id: "model-1",
      name: "Model",
      reasoning: true,
      availableThinkingLevels: ["off", "medium"],
      input: ["text", "image"],
      authenticated: true,
      authTypes: ["api_key"],
    },
    {
      provider: "gateway",
      providerName: "Gateway",
      id: "model-1",
      name: "Model through gateway",
      reasoning: true,
      availableThinkingLevels: ["off", "medium"],
      input: ["text"],
      authenticated: false,
      authTypes: ["api_key"],
    },
  ],
  thinkingLevel: "medium",
  availableThinkingLevels: ["off", "medium"],
  streaming: true,
  diagnostics: [],
  commands: [
    {
      name: "skill:fixture",
      description: "Fixture skill",
      source: "skill",
      sourceInfo: {
        path: "/fixture/SKILL.md",
        source: "fixture",
        scope: "project",
        origin: "top-level",
      },
    },
  ],
  usage: {
    tokens: { input: 120, output: 30, cacheRead: 80, cacheWrite: 0, total: 230 },
    cost: 0.0042,
    context: { tokens: 200, contextWindow: 1_000, percent: 20 },
  },
  compatibility: {
    resources: [
      {
        id: "extension:/fixture.ts",
        kind: "extension",
        name: "fixture.ts",
        path: "/fixture.ts",
        source: "fixture",
        scope: "project",
        origin: "package",
        commands: ["fixture"],
        tools: [],
        enabled: true,
      },
    ],
    diagnostics: [
      {
        id: "compat:one",
        severity: "warning",
        source: "compatibility",
        method: "custom",
        message: "Unavailable",
      },
    ],
  },
  extensionUi: { statuses: [] },
  sessions: [
    {
      id: "session-1",
      title: "Session",
      created: new Date(0).toISOString(),
      modified: new Date(0).toISOString(),
      messageCount: 1,
      resolved: false,
    },
  ],
  tree: [{ id: "entry-1", type: "message", preview: "Hello", active: true }],
};

describe("Session", () => {
  it("hydrates observable arrays and proper child models", () => {
    const model = Session.create();
    const thinkingLevels = model.availableThinkingLevels;
    const diagnostics = model.diagnostics;
    applySnapshot(model, toSessionSnapshot(snapshot));

    expect(model.availableThinkingLevels).toBe(thinkingLevels);
    expect(model.diagnostics).toBe(diagnostics);
    expect(model.compatibility).toEqual(snapshot.compatibility);
    expect(model.commands).toEqual(snapshot.commands);
    expect(model.usage).toEqual(snapshot.usage);
    expect(isObservable(model.parts)).toBe(true);
    expect(isObservable(model.models)).toBe(true);
    expect(isObservable(model.availableThinkingLevels)).toBe(true);
    expect(isObservable(model.diagnostics)).toBe(true);
    expect(isObservable(model.tree)).toBe(true);
    expect(model.parts[0]).toBeInstanceOf(Message);
    expect(model.models[0]).toBeInstanceOf(ModelOption);
    expect(model.tree[0]).toBeInstanceOf(SessionTreeEntry);
    model[Symbol.dispose]();
  });

  it("applies a full session snapshot atomically", () => {
    const model = Session.create();
    const updates: unknown[] = [];
    const stop = reaction(
      () => ({ sessionId: model.sessionId, text: model.parts[0]?.text }),
      (next) => updates.push(next),
    );

    applySnapshot(model, toSessionSnapshot(snapshot));
    expect(updates).toHaveLength(1);
    expect(model.uiParts[0]).toMatchObject({
      entryId: "assistant-entry-1",
      text: "Hello",
      status: "streaming",
    });
    stop();
    model[Symbol.dispose]();
  });

  it("creates and updates message children without replacing the parts array", () => {
    const model = Session.create();
    applySnapshot(model, toSessionSnapshot(snapshot));
    const parts = model.parts;
    const message = model.parts[0];

    model.upsertPart({
      id: "message-1",
      kind: "text",
      role: "assistant",
      text: "Streaming",
      status: "streaming",
    });

    expect(model.parts).toBe(parts);
    expect(model.parts[0]).toBe(message);
    expect(model.uiParts[0]).toMatchObject({ text: "Streaming" });
    expect(toSnapshot(model).sessionId).toBe("session-1");
    model[Symbol.dispose]();
  });

  it("replaces a pointer-projected artifact with its live tool call", () => {
    const model = Session.create();
    model.upsertPart({
      id: "entry-request-pointer-artifact",
      kind: "tool",
      name: "cake",
      command: "requests.open",
      input: "",
      artifactId: "request-1",
      state: "success",
    });
    model.upsertPart({
      id: "tool-request-call",
      kind: "tool",
      name: "cake",
      command: "requests.open",
      input: JSON.stringify({ command: "requests.open" }),
      artifactId: "request-1",
      state: "success",
    });

    expect(model.uiParts).toEqual([
      expect.objectContaining({
        id: "tool-request-call",
        command: "requests.open",
        artifactId: "request-1",
      }),
    ]);
    model[Symbol.dispose]();
  });

  it("creates and updates persisted review-run parts", () => {
    const model = Session.create();
    applySnapshot(
      model,
      toSessionSnapshot({
        ...snapshot,
        parts: [
          {
            id: "review-run-1",
            kind: "review-run",
            operationId: "00000000-0000-4000-8000-000000000001",
            threadIds: ["review-1"],
            commentCount: 2,
            status: "running",
          },
        ],
      }),
    );
    const message = model.parts[0];

    model.upsertPart({
      id: "review-run-1",
      kind: "review-run",
      operationId: "00000000-0000-4000-8000-000000000001",
      threadIds: ["review-1"],
      commentCount: 2,
      status: "complete",
    });

    expect(model.parts[0]).toBe(message);
    expect(model.uiParts[0]).toMatchObject({
      kind: "review-run",
      commentCount: 2,
      status: "complete",
    });
    model[Symbol.dispose]();
  });

  it("hydrates queued delivery, skill, and compaction transcript parts", () => {
    const model = Session.create();
    applySnapshot(
      model,
      toSessionSnapshot({
        ...snapshot,
        parts: [
          {
            id: "queued-1",
            kind: "text",
            role: "user",
            text: "Next",
            status: "complete",
            deliveryState: "queued",
          },
          {
            id: "skill-1",
            kind: "skill",
            name: "pdf-tools",
            content: "Extract text from PDFs.",
          },
          {
            id: "compaction-1",
            kind: "compaction",
            summary: "Earlier work",
            tokensBefore: 12_000,
            firstKeptEntryId: "entry-2",
          },
        ],
      }),
    );

    expect(model.uiParts).toEqual([
      expect.objectContaining({ kind: "text", deliveryState: "queued" }),
      expect.objectContaining({
        kind: "skill",
        name: "pdf-tools",
        content: "Extract text from PDFs.",
      }),
      expect.objectContaining({
        kind: "compaction",
        summary: "Earlier work",
        tokensBefore: 12_000,
      }),
    ]);
    model[Symbol.dispose]();
  });

  it("reconciles identified children through native snapshot hydration", () => {
    const model = Session.create();
    applySnapshot(model, toSessionSnapshot(snapshot));
    const message = model.parts[0];
    const openAiModel = model.models[0];
    const gatewayModel = model.models[1];
    const treeEntry = model.tree[0];
    const resource = model.resources[0];
    const diagnostic = model.resourceDiagnostics[0];

    applySnapshot(
      model,
      toSessionSnapshot({
        ...snapshot,
        parts: [
          {
            id: "message-1",
            kind: "text",
            role: "assistant",
            entryId: "assistant-entry-1",
            text: "Updated",
            status: "streaming",
          },
        ],
        models: [snapshot.models[1]!, { ...snapshot.models[0]!, name: "Updated model" }],
        tree: [{ ...snapshot.tree[0]!, preview: "Updated" }],
        compatibility: {
          resources: [{ ...snapshot.compatibility.resources[0]!, name: "Updated resource" }],
          diagnostics: [
            { ...snapshot.compatibility.diagnostics[0]!, message: "Updated diagnostic" },
          ],
        },
      }),
    );

    expect(model.parts[0]).toBe(message);
    expect(model.parts[0]?.text).toBe("Updated");
    expect(model.models).toEqual([gatewayModel, openAiModel]);
    expect(model.models[1]?.name).toBe("Updated model");
    expect(model.tree[0]).toBe(treeEntry);
    expect(model.resources[0]).toBe(resource);
    expect(model.resourceDiagnostics[0]).toBe(diagnostic);
    model[Symbol.dispose]();
  });

  it("does not regress an artifact when an older snapshot arrives late", () => {
    const model = Session.create({ workspacePath: "/project", sessionId: "session-1" });
    const record = (revision: number, markdown: string) => ({
      artifact: {
        protocol: "cake.artifact/v1" as const,
        id: "artifact-1",
        sessionId: "session-1",
        revision,
        kind: "markdown" as const,
        payload: { markdown },
        fallback: { markdown },
      },
      workspacePath: "/project",
      digest: String(revision).repeat(64),
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(revision).toISOString(),
    });

    model.upsertArtifact(record(2, "new"));
    const artifact = model.artifacts[0];
    model.upsertArtifact(record(1, "old"));

    expect(model.artifacts[0]).toBe(artifact);
    expect(model.artifacts[0]?.revision).toBe(2);
    expect(model.artifacts[0]?.payload).toEqual({ markdown: "new" });
    model[Symbol.dispose]();
  });

  it("keeps one review model instance while its sidecar turn settles", () => {
    const model = Session.create({ workspacePath: "/project", sessionId: "session-1" });
    const now = new Date(0).toISOString();
    const thread = {
      id: "review-1",
      workspacePath: "/project",
      sessionId: "session-1",
      status: "open" as const,
      createdAt: now,
      updatedAt: now,
      anchor: {
        path: "src/app.ts",
        start: { diffLine: 1, newLine: 2 },
        end: { diffLine: 1, newLine: 2 },
        selectedText: "value",
        contextBefore: "",
        contextAfter: "",
        diff: "+value",
      },
      parts: [
        {
          id: "comment-1",
          kind: "text" as const,
          role: "user" as const,
          text: "Rename this",
          status: "complete" as const,
          deliveryState: "sending" as const,
        },
      ],
    };
    model.applyReviewThreads([thread]);
    const review = model.reviewThreads[0]!;

    expect(review).toBeInstanceOf(ReviewThread);
    expect(review.pending).toBe(true);

    model.upsertReviewThread({
      ...thread,
      updatedAt: new Date(1).toISOString(),
      parts: [
        { ...thread.parts[0]!, deliveryState: undefined },
        { id: "reply-1", kind: "text", role: "assistant", text: "Renamed it.", status: "complete" },
      ],
    });

    expect(model.reviewThreads[0]).toBe(review);
    expect(review.pending).toBe(false);
    model[Symbol.dispose]();
  });
});
