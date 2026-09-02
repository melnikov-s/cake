import { describe, expect, it } from "vitest";
import type { ConversationSnapshot } from "../../../src/domain/conversation-data";
import type { ProjectSessionUpdate } from "../../../src/domain/project-session-data";
import { Session } from "../../../src/renderer/models/Session";
import { applyProjectSessionUpdate } from "../../../src/renderer/projections/ConversationProjection";

function conversation(extensionUi: ConversationSnapshot["extensionUi"]): ConversationSnapshot {
  return {
    workingDirectory: "/cake",
    sessionId: "session",
    sessionFile: "/cake/session.jsonl",
    parts: [],
    models: [],
    thinkingLevel: "off",
    availableThinkingLevels: ["off"],
    streaming: false,
    diagnostics: [],
    commands: [],
    compatibility: { resources: [], diagnostics: [] },
    extensionUi,
    sessions: [],
    tree: [],
  };
}

function snapshot(extensionUi: ConversationSnapshot["extensionUi"]): ProjectSessionUpdate {
  return {
    _tag: "Snapshot",
    revision: 1,
    snapshot: {
      identity: {
        _tag: "ProjectSession",
        sessionId: "session",
        projectPath: "/cake",
        workingDirectory: "/cake",
      },
      projectName: "Cake",
      resolved: false,
      unread: false,
      conversation: conversation(extensionUi),
    },
  };
}

describe("ConversationProjection extension UI ordering", () => {
  it("recovers extension UI emitted before the renderer subscribes from the first snapshot", () => {
    const session = Session.create({ sessionId: "session", workingDirectory: "/cake" });

    applyProjectSessionUpdate(
      session,
      "session",
      snapshot({
        revision: 2,
        statuses: [],
        notifications: [{ id: "notice", message: "Connected", tone: "info" }],
        editorText: { text: "extension draft", mode: "replace" },
        editorTextRevision: 1,
      }),
    );

    expect(session.extensionUi.notifications.map((item) => item.message)).toEqual(["Connected"]);
    expect(session.extensionUi.editorText).toEqual({ text: "extension draft", mode: "replace" });
    expect(session.extensionUi.editorTextRevision).toBe(1);
    session[Symbol.dispose]();
  });

  it("does not let an older snapshot overwrite a newer extension event", () => {
    const session = Session.create({ sessionId: "session", workingDirectory: "/cake" });
    applyProjectSessionUpdate(
      session,
      "session",
      snapshot({ revision: 0, statuses: [], notifications: [], editorTextRevision: 0 }),
    );
    applyProjectSessionUpdate(session, "session", {
      _tag: "Event",
      revision: 2,
      sessionId: "session",
      event: {
        _tag: "ExtensionUi",
        sessionId: "session",
        event: { kind: "editor-text", text: "newer", mode: "replace" },
      },
    });
    applyProjectSessionUpdate(session, "session", {
      _tag: "Event",
      revision: 3,
      sessionId: "session",
      event: {
        _tag: "SnapshotUpdated",
        snapshot: conversation({
          revision: 0,
          statuses: [],
          notifications: [],
          editorTextRevision: 0,
        }),
      },
    });

    expect(session.extensionUi.editorText).toEqual({ text: "newer", mode: "replace" });
    expect(session.extensionUi.revision).toBe(1);
    session[Symbol.dispose]();
  });
});
