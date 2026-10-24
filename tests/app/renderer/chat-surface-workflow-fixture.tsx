import { act, render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { VirtuosoMockContext } from "react-virtuoso";
import { StoreProvider } from "r-state-tree/react";
import type { ConversationSnapshot } from "../../../src/contracts/conversations/conversation-data";
import type { UiPart } from "../../../src/contracts/conversations/session-contract";
import { Chat } from "../../../src/renderer/components/chat";
import { WorkLogControls } from "../../../src/renderer/components/work-log-controls";
import { applyConversationUpdate } from "../../../src/renderer/reducers/ConversationReducer";
import { projectRecord, sessionSummary } from "./fixtures/catalog-fixtures";
import { createRendererStoreFixture } from "./renderer-store-fixture";
import type { TestClientOverrides } from "./test-client";

export const chatSessionId = "chat-surface";
export const changedFile: UiPart = {
  id: "write-one",
  kind: "tool",
  name: "write",
  filePath: "src/one.ts",
  input: JSON.stringify({ path: "src/one.ts", content: "export const one = 1;" }),
  state: "success",
};

export function renderChatSurface(
  options: {
    parts?: UiPart[];
    snapshot?: Partial<ConversationSnapshot>;
    client?: TestClientOverrides;
  } = {},
) {
  const fixture = createRendererStoreFixture({
    client: options.client,
    projects: [projectRecord({ path: "/project", name: "Project" })],
    sessions: [sessionSummary({ sessionId: chatSessionId, projectPath: "/project" })],
  });
  const session = fixture.root.sessionRegistry.load(chatSessionId, "/project");
  fixture.root.navigationStore.selectProjectSession(chatSessionId);
  fixture.root.projectWorkbenchStore.showLoadedSession(chatSessionId);
  let snapshot: ConversationSnapshot = {
    sessionId: chatSessionId,
    sessionFile: "/project/chat-surface.jsonl",
    parts: options.parts ?? [],
    models: [],
    thinkingLevel: "off",
    availableThinkingLevels: ["off"],
    streaming: false,
    diagnostics: [],
    commands: [],
    compatibility: { resources: [], diagnostics: [] },
    extensionUi: { statuses: [] },
    tree: [],
    ...options.snapshot,
  };
  let revision = 1;
  applyConversationUpdate(session.model, { _tag: "Snapshot", revision, snapshot });
  const chat = session.conversationSessionStore.chatStore;
  // Content proof only; native initial bottom alignment is covered in Electron.
  chat.transcriptInteraction.setTranscriptScrollPosition({ kind: "top" });
  const view = render(
    <StoreProvider store={fixture.root.fullscreenSurfaceStore}>
      <VirtuosoMockContext.Provider value={{ viewportHeight: 800, itemHeight: 100 }}>
        <WorkLogControls store={chat} />
        <Chat store={chat} compact composerFocusEnabled={false} />
      </VirtuosoMockContext.Provider>
    </StoreProvider>,
  );
  return {
    user: userEvent.setup(),
    models: fixture.models,
    publish(parts: UiPart[], streaming = false) {
      act(() => {
        snapshot = { ...snapshot, parts, streaming };
        applyConversationUpdate(session.model, {
          _tag: "Snapshot",
          revision: ++revision,
          snapshot,
        });
      });
    },
    [Symbol.dispose]() {
      view.unmount();
      fixture[Symbol.dispose]();
    },
  };
}
