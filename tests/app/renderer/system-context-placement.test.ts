import {
  SessionManager,
  SettingsManager,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import { toSnapshot } from "r-state-tree";
import { describe, expect, it } from "vitest";
import type {
  ConversationSnapshot,
  UiPart,
} from "../../../src/contracts/conversations/session-contract";
import { Conversation } from "../../../src/renderer/models/Conversation";
import {
  applyConversationUpdate,
  applyDiscussionSessionUpdate,
} from "../../../src/renderer/reducers/ConversationReducer";
import { groupTranscriptParts } from "../../../src/renderer/components/chat-transcript-items";
import { createCakeSessionRuntimeEventProjection } from "../../../src/services/pi/runtime/cake-session-runtime-event-projection";
import { projectCakeSessionRuntimeSnapshot } from "../../../src/services/pi/runtime/cake-session-runtime-snapshot";
import { projectSessionEntries } from "../../../src/services/pi/runtime/session-projection";
import { projectRuntimeSystemPrompt } from "../../../src/services/pi/runtime/system-context-projection";

const sections = {
  preamble: "Base instructions",
  skills: "<skills>\nOriginal skills\n</skills>",
  project_context:
    '<project_context>\n<project_instructions path="/project/AGENTS.md">\nOriginal project rules\n</project_instructions>\n</project_context>',
};

function fixture() {
  const manager = SessionManager.inMemory("/project");
  const session = {
    sessionManager: manager,
    systemPrompt: Object.values(sections).join("\n\n"),
    agent: { state: { tools: [] } },
    get messages() {
      return manager
        .getBranch()
        .flatMap((entry) => (entry.type === "message" ? [entry.message] : []));
    },
    isStreaming: false,
    thinkingLevel: "off",
    getAvailableThinkingLevels: () => ["off"],
    getSteeringMessages: () => [],
    getFollowUpMessages: () => [],
  };
  const snapshot = () =>
    projectCakeSessionRuntimeSnapshot({
      workspacePath: "/project",
      sessionId: "session",
      sessionListed: true,
      auxiliary: false,
      session: session as unknown as AgentSession,
      settingsManager: SettingsManager.inMemory(),
      models: [],
      queuedParts: [],
      transientParts: [],
      fastMode: false,
      commands: [],
      slashCommands: undefined,
      usage: undefined,
      compatibility: { resources: [], diagnostics: [] },
      extensionUi: { statuses: [] },
      diagnostics: [],
      reloadPending: false,
    });
  return { manager, session, snapshot };
}

function visibleParts(model: Conversation): UiPart[] {
  return groupTranscriptParts(model.uiParts).flatMap((item) =>
    item.kind === "context-group" || item.kind === "activity-group" || item.kind === "source-group"
      ? item.parts
      : item.kind === "changed-files" || item.kind === "loading-state"
        ? []
        : [item],
  );
}

describe("runtime system baseline to shared transcript", () => {
  it.each(["conversation", "discussion"] as const)(
    "keeps late baselines first through preview, live reconciliation, reopen and rebuild (%s)",
    (surface) => {
      let revision = 0;
      const { manager, session, snapshot } = fixture();
      manager.appendMessage({ role: "user", content: "Existing conversation", timestamp: 1 });
      using model = Conversation.create({ sessionId: "session" });
      const hydrate = (value: ConversationSnapshot) => {
        if (surface === "discussion")
          applyDiscussionSessionUpdate(model, "session", {
            _tag: "Event",
            revision: ++revision,
            sessionId: "session",
            event: { _tag: "SnapshotUpdated", snapshot: value },
          });
        else
          applyConversationUpdate(model, {
            _tag: "Snapshot",
            revision: ++revision,
            snapshot: value,
          });
      };
      applyConversationUpdate(model, {
        _tag: "Preview",
        revision: ++revision,
        snapshot: {
          ...snapshot(),
          parts: projectSessionEntries(manager.getBranch()),
        },
      });
      const expected = [...projectRuntimeSystemPrompt(session.systemPrompt), ...model.uiParts];
      const connect = (target: Conversation) =>
        createCakeSessionRuntimeEventProjection({
          session: session as unknown as AgentSession,
          sessionId: "session",
          emit: (event) => {
            if (event.type !== "part-updated" && event.type !== "part-removed") return;
            const partEvent =
              event.type === "part-updated"
                ? { _tag: "PartUpdated" as const, sessionId: "session", part: event.part }
                : { _tag: "PartRemoved" as const, sessionId: "session", partId: event.partId };
            if (surface === "discussion")
              applyDiscussionSessionUpdate(target, "session", {
                _tag: "Event",
                revision: ++revision,
                sessionId: "session",
                event: partEvent,
              });
            else
              applyConversationUpdate(target, {
                _tag: "Event",
                revision: ++revision,
                event: partEvent,
              });
          },
          compactionQueuedMessages: () => [],
          isDisposed: () => false,
        });
      const projection = connect(model);
      try {
        // The preview already has dialogue; the first agent_start supplies new baseline IDs.
        projection.projectEvent({ type: "agent_start" });
        expect(visibleParts(model)).toEqual(expected);
        projection.projectEvent({ type: "agent_start" });
        expect(visibleParts(model)).toEqual(expected);
        hydrate(snapshot());
        expect(visibleParts(model)).toEqual(expected);
        using reopened = Conversation.create(toSnapshot(model));
        const rebuilt = connect(reopened);
        try {
          rebuilt.projectEvent({ type: "agent_start" });
          expect(visibleParts(reopened)).toEqual(expected);
          applyConversationUpdate(reopened, {
            _tag: "Snapshot",
            revision: ++revision,
            snapshot: snapshot(),
          });
          expect(visibleParts(reopened)).toEqual(expected);
          expect(new Set(reopened.uiParts.map((part) => part.id)).size).toBe(expected.length);
          const originalPrompt = session.systemPrompt;
          session.systemPrompt = sections.preamble;
          rebuilt.projectEvent({ type: "agent_start" });
          expect(visibleParts(reopened)).toEqual([expected[0], expected.at(-1)]);
          session.systemPrompt = originalPrompt;
          rebuilt.projectEvent({ type: "agent_start" });
          expect(visibleParts(reopened)).toEqual(expected);
        } finally {
          rebuilt.dispose();
        }
      } finally {
        projection.dispose();
      }
    },
  );

  it("deduplicates unchanged sections while retaining genuine Skills/AGENTS.md changes at their Pi position", () => {
    let revision = 0;
    const { manager, session, snapshot } = fixture();
    const initial = { role: "system" as const, content: "", sections, timestamp: 0 };
    manager.appendMessage(initial);
    manager.appendMessage({ role: "user", content: "Before update", timestamp: 1 });
    using model = Conversation.create({ sessionId: "session" });
    applyConversationUpdate(model, {
      _tag: "Snapshot",
      revision: ++revision,
      snapshot: snapshot(),
    });
    const projection = createCakeSessionRuntimeEventProjection({
      session: session as unknown as AgentSession,
      sessionId: "session",
      emit: (event) => {
        if (event.type === "part-updated")
          applyConversationUpdate(model, {
            _tag: "Event",
            revision: ++revision,
            event: { _tag: "PartUpdated", sessionId: "session", part: event.part },
          });
      },
      compactionQueuedMessages: () => [],
      isDisposed: () => false,
    });
    try {
      const before = visibleParts(model);
      projection.projectEvent({ type: "message_start", message: initial });
      expect(visibleParts(model)).toEqual(before);
      const changed = {
        ...initial,
        sections: {
          skills: "<skills>\nNew skills\n</skills>",
          project_context: sections.project_context.replace(
            "Original project rules",
            "New project rules",
          ),
        },
        timestamp: 2,
      };
      const changedId = manager.appendMessage(changed);
      projection.projectEvent({ type: "message_start", message: changed });
      const liveChanges = visibleParts(model).slice(-2);
      expect(liveChanges).toMatchObject([
        { title: "Skills", text: changed.sections.skills },
        { title: "AGENTS.md", text: expect.stringContaining("New project rules") },
      ]);
      expect(liveChanges.every((part) => part.id.startsWith("live-context-"))).toBe(true);
      projection.projectEvent({ type: "message_start", message: changed });
      expect(visibleParts(model).slice(-2)).toEqual(liveChanges);
      manager.appendMessage({ role: "user", content: "After update", timestamp: 3 });
      manager.appendMessage({ ...changed, timestamp: 4 });
      const originals = JSON.stringify(manager.getBranch());
      applyConversationUpdate(model, {
        _tag: "Snapshot",
        revision: ++revision,
        snapshot: snapshot(),
      });
      expect(visibleParts(model).slice(-3)).toMatchObject([
        {
          id: `entry-${changedId}-system-prompt-skills`,
          title: "Skills",
          text: changed.sections.skills,
        },
        {
          id: `entry-${changedId}-system-prompt-instructions`,
          title: "AGENTS.md",
          text: expect.stringContaining("New project rules"),
        },
        { kind: "text", text: "After update" },
      ]);
      expect(visibleParts(model).filter((part) => part.kind === "context")).toHaveLength(5);
      expect(JSON.stringify(manager.getBranch())).toBe(originals);
      expect(session.systemPrompt).toBe(Object.values(sections).join("\n\n"));
    } finally {
      projection.dispose();
    }
  });
});
