import { act } from "@testing-library/react";
import { observer } from "r-state-tree/react";
import { renderTranscriptContent as render } from "./render-transcript-content";
import userEvent from "@testing-library/user-event";
import type {
  ConversationSnapshot,
  TurnId,
} from "../../../src/contracts/conversations/conversation-data";
import { SESSION_ASSISTANT_ID } from "../../../src/contracts/cake-chats/cake-chat-identity";
import { SessionAssistant } from "../../../src/renderer/components/session-assistant";
import { Chat } from "../../../src/renderer/components/chat";
import {
  applyConversationSnapshot,
  applyConversationUpdate,
} from "../../../src/renderer/reducers/ConversationReducer";
import { projectRecord, sessionSummary } from "./fixtures/catalog-fixtures";
import { createRendererStoreFixture } from "./renderer-store-fixture";
import type { TestClientOverrides } from "./test-client";
import type { RootStore } from "../../../src/renderer/stores/RootStore";

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
const Surface = observer(function Surface({
  root,
  parentComposer,
}: {
  root: RootStore;
  parentComposer?: boolean;
}) {
  const session = root.workspaceSession;
  const assistant = (
    <SessionAssistant
      store={root.sessionAssistantStore}
      seed={session?.sessionId ?? "parent-1"}
      labels={[]}
      value={[]}
    />
  );
  return parentComposer && session ? (
    <Chat
      store={session.conversationSessionStore.chatStore}
      compact
      embedded
      composerFocusEnabled={false}
      composerLeadingAccessory={{ content: assistant, visible: true }}
    />
  ) : (
    assistant
  );
});

export function renderSessionAssistant(
  client: TestClientOverrides,
  options: { staged?: boolean; parentComposer?: boolean } = {},
) {
  const fixture = createRendererStoreFixture({
    client: {
      ...client,
      cakeChats: {
        open: async () => undefined,
        assistantContext: async () => undefined,
        ...client.cakeChats,
      },
    },
    projects: [projectRecord({ path: "/project", name: "Project" })],
    sessions: options.staged
      ? []
      : [
          sessionSummary({ sessionId: "parent-1", projectPath: "/project" }),
          sessionSummary({ sessionId: "parent-2", projectPath: "/project" }),
        ],
  });
  const session = options.staged
    ? fixture.root.sessionRegistry.pendingSessions.prepareStaged("/project", "parent-1")
    : fixture.root.sessionRegistry.load("parent-1", "/project");
  fixture.root.projectWorkbenchStore.projectOpenStore.projectPath = "/project";
  fixture.root.navigationStore.selectProjectSession("parent-1");
  applyConversationSnapshot(
    session.model,
    conversation("parent-1", {
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
  const assistant = fixture.root.sessionAssistantStore;
  const model = fixture.root.cakeChatCollectionStore.registry.load(SESSION_ASSISTANT_ID).model;
  let revision = 0;
  const observe = (parts: ConversationSnapshot["parts"], streaming = false) =>
    act(() =>
      applyConversationUpdate(model, {
        _tag: "Snapshot",
        revision: ++revision,
        snapshot: conversation(SESSION_ASSISTANT_ID, { parts, streaming }),
      }),
    );
  observe([]);
  assistant.chatStore.transcriptInteraction.setTranscriptScrollPosition({ kind: "top" });
  assistant.quickChatStore.transcriptInteraction.setTranscriptScrollPosition({ kind: "top" });
  const view = render(<Surface root={fixture.root} parentComposer={options.parentComposer} />);
  return {
    root: fixture.root,
    models: fixture.models,
    assistant,
    user: userEvent.setup(),
    observe,
    settle(turnId: TurnId, text: string, prompt: string) {
      observe([
        { id: "user-1", kind: "text", role: "user", text: prompt, status: "complete" },
        { id: "assistant-1", kind: "text", role: "assistant", text, status: "complete" },
      ]);
      act(() =>
        applyConversationUpdate(model, {
          _tag: "Event",
          revision: ++revision,
          event: {
            _tag: "TurnSettled",
            sessionId: SESSION_ASSISTANT_ID,
            turnId,
            outcome: "complete",
          },
        }),
      );
    },
    [Symbol.dispose]() {
      view.unmount();
      fixture[Symbol.dispose]();
    },
  };
}
