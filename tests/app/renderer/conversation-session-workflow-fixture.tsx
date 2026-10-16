import { act, render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { VirtuosoMockContext } from "react-virtuoso";
import { CAKE_CHAT_SESSION_ID } from "../../../src/contracts/cake-chats/cake-chat-identity";
import type { ConversationSnapshot } from "../../../src/contracts/conversations/conversation-data";
import type { UiPart } from "../../../src/contracts/conversations/session-contract";
import { Chat } from "../../../src/renderer/components/chat";
import { applyConversationUpdate } from "../../../src/renderer/reducers/ConversationReducer";
import { projectRecord, sessionSummary } from "./fixtures/catalog-fixtures";
import { createRendererStoreFixture } from "./renderer-store-fixture";
import type { TestClientOverrides } from "./test-client";

export type ConversationSessionProfile = "project" | "cake-chat";
export const originalUserPart: UiPart = {
  id: "user-part",
  entryId: "user-entry",
  kind: "text",
  role: "user",
  text: "Original prompt",
  status: "complete",
};
export const workingAssistantPart: UiPart = {
  id: "assistant-part",
  entryId: "assistant-entry",
  kind: "text",
  role: "assistant",
  text: "Working on the prompt",
  status: "streaming",
};
export function queuedUserPart(text: string): UiPart {
  return {
    id: "queued-part",
    kind: "text",
    role: "user",
    text,
    status: "complete",
    deliveryState: "queued",
    queuedInput: {
      itemId: "20000000-0000-4000-8000-000000000001",
      text,
      attachments: [],
      renderUserMessageAsMarkdown: false,
    },
  };
}

export function renderConversationSession(
  profile: ConversationSessionProfile,
  client: TestClientOverrides,
  parts: UiPart[] = [originalUserPart, workingAssistantPart],
) {
  const sessionId = profile === "project" ? "conversation-session" : CAKE_CHAT_SESSION_ID;
  const fixture = createRendererStoreFixture({
    projects: [projectRecord({ path: "/project", name: "Project" })],
    sessions: profile === "project" ? [sessionSummary({ sessionId, projectPath: "/project" })] : [],
    client,
  });
  const session =
    profile === "project"
      ? fixture.root.sessionRegistry.load(sessionId, "/project")
      : fixture.root.cakeChatCollectionStore.registry.load(sessionId);
  const model = session.model;
  let revision = 0;
  let snapshot: ConversationSnapshot = {
    sessionId,
    sessionFile: `/sessions/${sessionId}.jsonl`,
    parts,
    models: [],
    model: { provider: "openai", id: "gpt-4.1", name: "GPT-4.1" },
    thinkingLevel: "off",
    availableThinkingLevels: ["off"],
    streaming: true,
    diagnostics: [],
    commands: [],
    compatibility: { resources: [], diagnostics: [] },
    extensionUi: { statuses: [] },
    tree: [],
  };
  const publish = (changes: Partial<ConversationSnapshot>) => {
    snapshot = { ...snapshot, ...changes };
    applyConversationUpdate(model, { _tag: "Snapshot", revision: ++revision, snapshot });
  };
  publish({});
  if (profile === "project") {
    fixture.root.appShellStore.selectProjectSession(sessionId);
    fixture.root.projectWorkbenchStore.showLoadedSession(sessionId);
  } else fixture.root.appShellStore.selectCakeChat(sessionId);
  // jsdom cannot settle the initial bottom alignment. Begin at the top so the
  // real latest-prompt action mounts; native scrolling is not under test.
  session.conversationSessionStore.chatStore.transcriptInteraction.setTranscriptScrollPosition({
    kind: "top",
  });
  const view = render(
    // Deterministic virtual-list dimensions let jsdom mount the real transcript controls;
    // this does not replace the Chat implementation or claim native geometry/focus proof.
    <VirtuosoMockContext.Provider value={{ viewportHeight: 800, itemHeight: 100 }}>
      <Chat
        store={session.conversationSessionStore.chatStore}
        embedded
        composerFocusEnabled={false}
      />
    </VirtuosoMockContext.Provider>,
  );
  return {
    sessionId,
    inputLabel: profile === "project" ? "Message" : "Message Cake Chat",
    user: userEvent.setup(),
    publish(changes: Partial<ConversationSnapshot>) {
      act(() => publish(changes));
    },
    [Symbol.dispose]() {
      view.unmount();
      fixture[Symbol.dispose]();
    },
  };
}
