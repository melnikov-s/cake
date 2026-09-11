import { describe, expect, it } from "vitest";
import type { DiscussionThread } from "../../../../src/domain/discussion-sessions/discussion-session-data";
import { Session } from "../../../../src/renderer/models/Session";
import {
  applyDiscussionCatalogUpdate,
  applyDiscussionUpdate,
} from "../../../../src/renderer/reducers/DiscussionReducer";

const thread = (id: string): DiscussionThread => ({
  id,
  parentSessionId: "session",
  workingDirectory: "/project",
  anchor: {
    path: "file.ts",
    start: { diffLine: 0 },
    end: { diffLine: 0 },
    selectedText: "text",
    contextBefore: "",
    contextAfter: "",
    diff: "",
  },
  parts: [{ id: "part", kind: "text", role: "user", text: id, status: "complete" }],
  status: "open",
  createdAt: "2026-01-01",
  updatedAt: "2026-01-01",
});

describe("DiscussionReducer", () => {
  it("reconciles threads in order without reapplying unrelated session state", () => {
    const session = Session.create({
      sessionId: "session",
      usage: {
        tokens: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, total: 1 },
        cost: 0,
      },
    });
    applyDiscussionCatalogUpdate(session, "session", {
      _tag: "Snapshot",
      revision: 1,
      parentSessionId: "session",
      threads: [thread("one"), thread("two")],
    });
    const retained = session.reviewThreads[1]!;
    const part = retained.parts[0];
    const usage = session.usage;
    const threads = session.reviewThreads;
    applyDiscussionCatalogUpdate(session, "session", {
      _tag: "Event",
      revision: 2,
      parentSessionId: "session",
      event: {
        _tag: "Replaced",
        threads: [thread("three"), { ...thread("two"), status: "resolved" }],
      },
    });
    expect(session.reviewThreads).toBe(threads);
    expect(session.reviewThreads.map((item) => item.id)).toEqual(["three", "two"]);
    expect(session.reviewThreads[1]).toBe(retained);
    expect(retained.parts[0]).toBe(part);
    expect(retained.status).toBe("resolved");
    expect(session.usage).toBe(usage);
    session[Symbol.dispose]();
  });

  it("validates discussion usage before mutating the collection", () => {
    const session = Session.create({ sessionId: "session" });
    expect(() =>
      applyDiscussionCatalogUpdate(session, "session", {
        _tag: "Snapshot",
        revision: 1,
        parentSessionId: "session",
        threads: [thread("valid"), { ...thread("invalid"), usage: "invalid" }],
      }),
    ).toThrow();
    expect(session.reviewThreads).toHaveLength(0);
    session[Symbol.dispose]();
  });

  it("keeps the sidecar's model across catalog updates that carry none", () => {
    const session = Session.create({ sessionId: "session" });
    applyDiscussionCatalogUpdate(session, "session", {
      _tag: "Snapshot",
      revision: 1,
      parentSessionId: "session",
      threads: [thread("one")],
    });
    const retained = session.reviewThreads[0]!;
    expect(retained.model).toBeUndefined();

    applyDiscussionUpdate(retained, "one", {
      _tag: "Event",
      revision: 2,
      threadId: "one",
      event: {
        _tag: "SnapshotUpdated",
        snapshot: {
          workingDirectory: "/project",
          sessionId: "sidecar",
          sessionFile: "/sessions/sidecar.jsonl",
          parts: [],
          model: { provider: "google", id: "gemini-3.5-flash-lite", name: "Gemini" },
          models: [],
          thinkingLevel: "low",
          availableThinkingLevels: ["off", "low"],
          streaming: false,
          diagnostics: [],
          commands: [],
          compatibility: { resources: [], diagnostics: [] },
          extensionUi: { statuses: [] },
          tree: [],
        },
      },
    });
    expect(retained.model).toEqual({
      provider: "google",
      modelId: "gemini-3.5-flash-lite",
      name: "Gemini",
    });
    expect(retained.thinkingLevel).toBe("low");

    applyDiscussionCatalogUpdate(session, "session", {
      _tag: "Event",
      revision: 3,
      parentSessionId: "session",
      event: { _tag: "Replaced", threads: [{ ...thread("one"), status: "resolved" }] },
    });
    expect(session.reviewThreads[0]).toBe(retained);
    expect(retained.model?.modelId).toBe("gemini-3.5-flash-lite");
    expect(retained.thinkingLevel).toBe("low");
    session[Symbol.dispose]();
  });
});
