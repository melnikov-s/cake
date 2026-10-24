import { act } from "@testing-library/react";
import { renderTranscriptContent as render } from "./render-transcript-content";
import userEvent from "@testing-library/user-event";
import type {
  ConversationSnapshot,
  TurnId,
} from "../../../src/contracts/conversations/conversation-data";
import {
  sessionAssistantThreadPath,
  type DiscussionThread,
} from "../../../src/contracts/discussion-sessions/discussion-session-data";
import { SessionAssistant } from "../../../src/renderer/components/session-assistant";
import { Chat } from "../../../src/renderer/components/chat";
import {
  applyConversationSnapshot,
  applyDiscussionSessionUpdate,
} from "../../../src/renderer/reducers/ConversationReducer";
import { applyDiscussionCatalogUpdate } from "../../../src/renderer/reducers/DiscussionReducer";
import { projectRecord, sessionSummary } from "./fixtures/catalog-fixtures";
import { createRendererStoreFixture } from "./renderer-store-fixture";
import type { TestClientOverrides } from "./test-client";

export const assistantThread: DiscussionThread = {
  id: "assistant-thread",
  workingDirectory: "/project",
  parentSessionId: "parent-1",
  sidecarSessionId: "sidecar-assistant",
  anchor: {
    path: sessionAssistantThreadPath("parent-1"),
    view: "session",
    start: { diffLine: 0 },
    end: { diffLine: 0 },
    selectedText: "",
    contextBefore: "",
    contextAfter: "",
    diff: "",
  },
  parts: [],
  status: "open",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

function conversation(
  sessionId: string,
  overrides: Partial<ConversationSnapshot> = {},
): ConversationSnapshot {
  return {
    sessionId,
    sessionFile: `/sessions/${sessionId}.jsonl`,
    parts: [],
    models: [],
    thinkingLevel: "low",
    availableThinkingLevels: ["off", "low"],
    streaming: false,
    diagnostics: [],
    commands: [],
    compatibility: { resources: [], diagnostics: [] },
    extensionUi: { statuses: [] },
    tree: [],
    ...overrides,
  };
}

function createSessionAssistantFixture(
  client: TestClientOverrides,
  options: { staged?: boolean } = {},
) {
  const fixture = createRendererStoreFixture({
    client,
    projects: [projectRecord({ path: "/project", name: "Project" })],
    sessions: options.staged
      ? []
      : [sessionSummary({ sessionId: "parent-1", projectPath: "/project" })],
  });
  const session = options.staged
    ? fixture.root.sessionRegistry.pendingSessions.prepareStaged("/project", "parent-1")
    : fixture.root.sessionRegistry.load("parent-1", "/project");
  fixture.root.projectWorkbenchStore.projectOpenStore.projectPath = "/project";
  fixture.root.navigationStore.selectProjectSession("parent-1");
  applyConversationSnapshot(
    session.model,
    conversation("parent-1", {
      sessionFile: options.staged ? "" : "/sessions/parent-1.jsonl",
      parts: [
        {
          id: "parent-prompt",
          kind: "text",
          role: "user",
          text: "Draft the plan",
          status: "complete",
        },
      ],
    }),
  );
  session.conversationSessionStore.chatStore.transcriptInteraction.setTranscriptScrollPosition({
    kind: "top",
  });
  session.sessionAssistantStore.quickChatStore.transcriptInteraction.setTranscriptScrollPosition({
    kind: "top",
  });
  session.sessionAssistantStore.bootstrapChatStore.transcriptInteraction.setTranscriptScrollPosition(
    { kind: "top" },
  );
  let revision = 0;
  function observe(parts: ConversationSnapshot["parts"], streaming: boolean) {
    const sidecar = fixture.models.discussionConversation("sidecar-assistant", "/project");
    applyDiscussionSessionUpdate(sidecar, sidecar.sessionId, {
      _tag: "Snapshot",
      revision: ++revision,
      snapshot: {
        identity: {
          _tag: "DiscussionSession",
          sessionId: sidecar.sessionId,
          parentSessionId: "parent-1",
        },
        conversation: conversation(sidecar.sessionId, { parts, streaming }),
      },
    });
    applyDiscussionCatalogUpdate(fixture.models.discussionCatalog("parent-1"), "parent-1", {
      _tag: "Snapshot",
      revision,
      parentSessionId: "parent-1",
      threads: [assistantThread],
    });
    fixture.root.reviewsStore
      .chatStore(assistantThread.id)
      ?.transcriptInteraction.setTranscriptScrollPosition({ kind: "top" });
  }
  return {
    assistant: session.sessionAssistantStore,
    parentChat: session.conversationSessionStore.chatStore,
    observe(parts: ConversationSnapshot["parts"], streaming = false) {
      act(() => observe(parts, streaming));
    },
    settle(turnId: TurnId, text: string, prompt: string) {
      act(() => {
        const sidecar = fixture.models.discussionConversation("sidecar-assistant", "/project");
        const events = [
          {
            _tag: "PartUpdated" as const,
            sessionId: sidecar.sessionId,
            part: {
              id: "user-1",
              kind: "text" as const,
              role: "user" as const,
              text: prompt,
              status: "complete" as const,
            },
          },
          {
            _tag: "PartUpdated" as const,
            sessionId: sidecar.sessionId,
            part: {
              id: "assistant-1",
              kind: "text" as const,
              role: "assistant" as const,
              text,
              status: "complete" as const,
            },
          },
          { _tag: "StreamingChanged" as const, sessionId: sidecar.sessionId, streaming: false },
          {
            _tag: "TurnSettled" as const,
            sessionId: sidecar.sessionId,
            turnId,
            outcome: "complete" as const,
          },
        ];
        for (const event of events) {
          applyDiscussionSessionUpdate(sidecar, sidecar.sessionId, {
            _tag: "Event",
            revision: ++revision,
            sessionId: sidecar.sessionId,
            event,
          });
        }
      });
    },
    [Symbol.dispose]() {
      fixture[Symbol.dispose]();
    },
  };
}

export function renderSessionAssistant(
  client: TestClientOverrides,
  options: { staged?: boolean; parentComposer?: boolean } = {},
) {
  const fixture = createSessionAssistantFixture(client, options);
  const assistant = (
    <SessionAssistant store={fixture.assistant} seed="parent-1" labels={[]} value={[]} />
  );
  const view = render(
    options.parentComposer ? (
      <Chat
        store={fixture.parentChat}
        compact
        embedded
        composerFocusEnabled={false}
        composerLeadingAccessory={{ content: assistant, visible: true }}
      />
    ) : (
      assistant
    ),
  );
  return {
    user: userEvent.setup(),
    observe: fixture.observe,
    settle: fixture.settle,
    [Symbol.dispose]() {
      view.unmount();
      fixture[Symbol.dispose]();
    },
  };
}
