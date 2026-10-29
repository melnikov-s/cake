import { describe, expect, it } from "vitest";
import type { DiscussionThread } from "../../../../src/contracts/discussion-sessions/discussion-session-data";
import type { ConversationSnapshot } from "../../../../src/contracts/conversations/conversation-data";
import { DiscussionCatalog } from "../../../../src/renderer/models/DiscussionCatalog";
import { Conversation } from "../../../../src/renderer/models/Conversation";
import { applyDiscussionSessionUpdate } from "../../../../src/renderer/reducers/ConversationReducer";
import { applyDiscussionCatalogUpdate } from "../../../../src/renderer/reducers/DiscussionReducer";

const thread = (id: string): DiscussionThread => ({
  id,
  workingDirectory: "/project",
  parentSessionId: "session",
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

// Live sidecar behavior through stale catalog refreshes is exercised by
// projection-finish-workflow. Keep only keyed identity and malformed transport
// atomicity here: valid user actions cannot produce foreign/invalid authority rows.
describe("Discussion projection identity and transport validation", () => {
  it("reconciles threads in order without reapplying unrelated session state", () => {
    const session = DiscussionCatalog.create({ sessionId: "session" });
    applyDiscussionCatalogUpdate(session, "session", {
      _tag: "Snapshot",
      revision: 1,
      parentSessionId: "session",
      threads: [thread("one"), thread("two")],
    });
    const retained = session.threads[1]!;
    const part = retained.parts[0];
    const threads = session.threads;
    applyDiscussionCatalogUpdate(session, "session", {
      _tag: "Event",
      revision: 2,
      parentSessionId: "session",
      event: {
        _tag: "Replaced",
        threads: [thread("three"), { ...thread("two"), status: "resolved" }],
      },
    });
    expect(session.threads).toBe(threads);
    expect(session.threads.map((item) => item.id)).toEqual(["three", "two"]);
    expect(session.threads[1]).toBe(retained);
    expect(retained.parts[0]).toBe(part);
    expect(retained.status).toBe("resolved");
    session[Symbol.dispose]();
  });

  it("rejects sidecar updates addressed to another conversation", () => {
    const sidecar = Conversation.create({ sessionId: "sidecar-one" });
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
    const session = DiscussionCatalog.create({ sessionId: "session" });
    expect(() =>
      applyDiscussionCatalogUpdate(session, "session", {
        _tag: "Snapshot",
        revision: 1,
        parentSessionId: "session",
        threads: [thread("valid"), { ...thread("invalid"), parts: [{ kind: "nonsense" }] }],
      }),
    ).toThrow();
    expect(session.threads).toHaveLength(0);
    session[Symbol.dispose]();
  });
});
