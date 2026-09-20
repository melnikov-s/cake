import { describe, expect, it } from "vitest";
import type { DiscussionThread } from "../../../../src/domain/discussion-sessions/discussion-session-data";
import type { ConversationSnapshot } from "../../../../src/domain/conversations/conversation-data";
import { RootProjection } from "../../../../src/renderer/models/RootProjection";
import { CakeSession } from "../../../../src/renderer/models/CakeSession";
import { applyDiscussionSessionUpdate } from "../../../../src/renderer/reducers/ConversationReducer";
import { applyDiscussionCatalogUpdate } from "../../../../src/renderer/reducers/DiscussionReducer";

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

const conversation = (sessionId: string): ConversationSnapshot => ({
  workingDirectory: "/project",
  sessionId,
  sessionFile: `/reviews/${sessionId}.jsonl`,
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
});

describe("DiscussionReducer", () => {
  it("reconciles threads in order without reapplying unrelated session state", () => {
    const session = CakeSession.create({
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

  it("keeps the live sidecar conversation apart from catalog metadata refreshes", () => {
    const projection = RootProjection.create({});
    const parent = projection.projectSession("session", "/project");
    const sidecar = projection.discussionSession("sidecar-one", "/project");
    const linked: DiscussionThread = {
      ...thread("one"),
      sidecarSessionId: "sidecar-one",
      // The persisted preview lags the live stream (and can be empty while the
      // sidecar file is still being written).
      parts: [],
    };
    applyDiscussionCatalogUpdate(parent, "session", {
      _tag: "Snapshot",
      revision: 1,
      parentSessionId: "session",
      threads: [linked],
    });
    const retained = parent.reviewThreads[0]!;
    expect(retained.sidecarSessionId).toBe("sidecar-one");

    applyDiscussionSessionUpdate(sidecar, "sidecar-one", {
      _tag: "Snapshot",
      revision: 1,
      snapshot: {
        identity: {
          _tag: "DiscussionSession",
          sessionId: "sidecar-one",
          parentSessionId: "session",
        },
        conversation: conversation("sidecar-one"),
      },
    });
    expect(sidecar.observedSnapshotRevision).toBe(1);
    expect(sidecar.model?.modelId).toBe("gemini-3.5-flash-lite");
    expect(sidecar.thinkingLevel).toBe("low");
    applyDiscussionSessionUpdate(sidecar, "sidecar-one", {
      _tag: "Event",
      revision: 2,
      sessionId: "sidecar-one",
      event: { _tag: "StreamingChanged", sessionId: "sidecar-one", streaming: true },
    });
    applyDiscussionSessionUpdate(sidecar, "sidecar-one", {
      _tag: "Event",
      revision: 3,
      sessionId: "sidecar-one",
      event: {
        _tag: "PartUpdated",
        sessionId: "sidecar-one",
        part: { id: "user-1", kind: "text", role: "user", text: "Explain", status: "complete" },
      },
    });
    applyDiscussionSessionUpdate(sidecar, "sidecar-one", {
      _tag: "Event",
      revision: 4,
      sessionId: "sidecar-one",
      event: {
        _tag: "PartUpdated",
        sessionId: "sidecar-one",
        part: {
          id: "assistant-1",
          kind: "text",
          role: "assistant",
          text: "Streamed answer",
          status: "complete",
        },
      },
    });
    const streamedParts = sidecar.parts;
    const answer = sidecar.parts[1];

    // Settling a turn refreshes the parent's catalog; the row still carries the
    // stale preview plus the thread's updated metadata.
    applyDiscussionCatalogUpdate(parent, "session", {
      _tag: "Event",
      revision: 5,
      parentSessionId: "session",
      event: {
        _tag: "Replaced",
        threads: [{ ...linked, updatedAt: "2026-01-02", status: "resolved" }],
      },
    });

    expect(parent.reviewThreads[0]).toBe(retained);
    expect(retained.updatedAt).toBe("2026-01-02");
    expect(retained.status).toBe("resolved");
    expect(retained.uiParts).toEqual([]);
    expect(sidecar.parts).toBe(streamedParts);
    expect(sidecar.parts[1]).toBe(answer);
    expect(sidecar.uiParts.map((part) => part.id)).toEqual(["user-1", "assistant-1"]);
    expect(sidecar.streaming).toBe(true);
    expect(projection.findDiscussionSession("sidecar-one")).toBe(sidecar);
    projection[Symbol.dispose]();
  });

  it("rejects sidecar updates addressed to another conversation", () => {
    const sidecar = CakeSession.create({ sessionId: "sidecar-one" });
    expect(() =>
      applyDiscussionSessionUpdate(sidecar, "sidecar-one", {
        _tag: "Snapshot",
        revision: 1,
        snapshot: {
          identity: { _tag: "DiscussionSession", sessionId: "other", parentSessionId: "session" },
          conversation: conversation("other"),
        },
      }),
    ).toThrow(/identity collision/);
    expect(() =>
      applyDiscussionSessionUpdate(sidecar, "sidecar-one", {
        _tag: "Event",
        revision: 2,
        sessionId: "other",
        event: { _tag: "StreamingChanged", sessionId: "other", streaming: true },
      }),
    ).toThrow(/identity collision/);
    expect(sidecar.observedSnapshotRevision).toBe(0);
    sidecar[Symbol.dispose]();
  });

  it("validates every catalog row before mutating the collection", () => {
    const session = CakeSession.create({ sessionId: "session" });
    expect(() =>
      applyDiscussionCatalogUpdate(session, "session", {
        _tag: "Snapshot",
        revision: 1,
        parentSessionId: "session",
        threads: [thread("valid"), { ...thread("invalid"), parts: [{ kind: "nonsense" }] }],
      }),
    ).toThrow();
    expect(session.reviewThreads).toHaveLength(0);
    session[Symbol.dispose]();
  });
});
