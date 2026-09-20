import { describe, expect, it } from "vitest";
import type { ConversationSnapshot } from "../../../../src/domain/conversations/conversation-data";
import type { ProjectSessionUpdate } from "../../../../src/domain/project-sessions/project-session-data";
import { Conversation } from "../../../../src/renderer/models/Conversation";
import { applyProjectSessionUpdate } from "../../../../src/renderer/reducers/ConversationReducer";

function conversation(
  extensionUi: ConversationSnapshot["extensionUi"],
  parts: ConversationSnapshot["parts"] = [],
): ConversationSnapshot {
  return {
    workingDirectory: "/cake",
    sessionId: "session",
    sessionFile: "/cake/session.jsonl",
    parts,
    models: [],
    thinkingLevel: "off",
    availableThinkingLevels: ["off"],
    streaming: false,
    diagnostics: [],
    commands: [],
    compatibility: { resources: [], diagnostics: [] },
    extensionUi,
    tree: [],
  };
}

function snapshot(
  extensionUi: ConversationSnapshot["extensionUi"],
  resolved = false,
  parts: ConversationSnapshot["parts"] = [],
): ProjectSessionUpdate {
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
      resolved,
      unread: false,
      conversation: conversation(extensionUi, parts),
    },
  };
}

describe("ConversationReducer", () => {
  it("tracks active Conversation hydration without copying Project Session lifecycle", () => {
    const session = Conversation.create({ sessionId: "session", workingDirectory: "/cake" });

    applyProjectSessionUpdate(session, "session", snapshot({ statuses: [] }, true));
    expect(session.observedSnapshotRevision).toBe(0);

    applyProjectSessionUpdate(session, "session", snapshot({ statuses: [] }));
    expect(session.observedSnapshotRevision).toBe(1);
    session[Symbol.dispose]();
  });

  it("marks a session resolved without replacing its rendered transcript", () => {
    const session = Conversation.create({ sessionId: "session", workingDirectory: "/cake" });
    applyProjectSessionUpdate(
      session,
      "session",
      snapshot({ statuses: [] }, false, [
        {
          id: "message",
          kind: "text",
          role: "user",
          text: "Keep this rendered message",
          status: "complete",
        },
      ]),
    );
    const parts = session.parts;

    applyProjectSessionUpdate(session, "session", {
      _tag: "LifecycleChanged",
      revision: 2,
      sessionId: "session",
      resolved: true,
    });

    expect(session.parts).toBe(parts);
    expect(session.uiParts[0]).toMatchObject({ text: "Keep this rendered message" });
    expect(session.observedSnapshotRevision).toBe(1);
    session[Symbol.dispose]();
  });

  it("hydrates current extension status and title from a snapshot", () => {
    const session = Conversation.create({ sessionId: "session", workingDirectory: "/cake" });

    applyProjectSessionUpdate(
      session,
      "session",
      snapshot({
        title: "Extension workspace",
        statuses: [{ key: "fixture", text: "ready" }],
      }),
    );

    expect(session.extensionUi.title).toBe("Extension workspace");
    expect(session.extensionUi.statuses).toEqual([{ key: "fixture", text: "ready" }]);
    session[Symbol.dispose]();
  });

  it("applies ordered companion state events to the declared surface", () => {
    const session = Conversation.create({ sessionId: "session", workingDirectory: "/cake" });
    applyProjectSessionUpdate(
      session,
      "session",
      snapshot({
        statuses: [],
        companions: [
          {
            id: "plan-mode",
            name: "Plan mode",
            slot: "composer.above",
            moduleUrl: "cake-extension://module/plan-mode",
            actions: ["exit"],
            state: { active: true },
          },
        ],
      }),
    );

    applyProjectSessionUpdate(session, "session", {
      _tag: "Event",
      revision: 2,
      sessionId: "session",
      event: {
        _tag: "ExtensionUi",
        sessionId: "session",
        event: { kind: "companion-state", id: "plan-mode", state: { active: false } },
      },
    });

    expect(session.extensionUi.companions[0]?.state).toEqual({ active: false });
    session[Symbol.dispose]();
  });

  it("applies ordered extension state events without a nested revision", () => {
    const session = Conversation.create({ sessionId: "session", workingDirectory: "/cake" });
    applyProjectSessionUpdate(session, "session", snapshot({ statuses: [] }));
    applyProjectSessionUpdate(session, "session", {
      _tag: "Event",
      revision: 2,
      sessionId: "session",
      event: {
        _tag: "ExtensionUi",
        sessionId: "session",
        event: { kind: "status", key: "fixture", text: "ready" },
      },
    });

    expect(session.extensionUi.statuses).toEqual([{ key: "fixture", text: "ready" }]);
    session[Symbol.dispose]();
  });

  it("keeps queued follow-ups out of the active loading state", () => {
    const session = Conversation.create({ sessionId: "session", workingDirectory: "/cake" });
    applyProjectSessionUpdate(session, "session", snapshot({ statuses: [] }));

    applyProjectSessionUpdate(session, "session", {
      _tag: "Event",
      revision: 2,
      sessionId: "session",
      event: {
        _tag: "TurnAccepted",
        sessionId: "session",
        turnId: "00000000-0000-4000-8000-000000000001" as never,
        delivery: "follow-up",
      },
    });
    expect(session.activeTurnIds).toEqual([]);

    applyProjectSessionUpdate(session, "session", {
      _tag: "Event",
      revision: 3,
      sessionId: "session",
      event: {
        _tag: "TurnAccepted",
        sessionId: "session",
        turnId: "00000000-0000-4000-8000-000000000002" as never,
        delivery: "prompt",
      },
    });
    expect(session.activeTurnIds).toEqual(["00000000-0000-4000-8000-000000000002"]);
    session[Symbol.dispose]();
  });

  it("applies usage updates without replacing the conversation snapshot", () => {
    const session = Conversation.create({ sessionId: "session", workingDirectory: "/cake" });
    applyProjectSessionUpdate(session, "session", snapshot({ statuses: [] }));
    applyProjectSessionUpdate(session, "session", {
      _tag: "Event",
      revision: 2,
      sessionId: "session",
      event: {
        _tag: "UsageUpdated",
        sessionId: "session",
        usage: {
          tokens: { input: 12, output: 3, cacheRead: 4, cacheWrite: 5, total: 24 },
          cost: 0.01,
          context: { tokens: 1_024, contextWindow: 4_096, percent: 25 },
        },
      },
    });

    expect(session.usage?.context).toEqual({
      tokens: 1_024,
      contextWindow: 4_096,
      percent: 25,
    });
    session[Symbol.dispose]();
  });
});
