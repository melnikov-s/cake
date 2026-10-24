import { act, render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { VirtuosoMockContext } from "react-virtuoso";
import { StoreProvider } from "r-state-tree/react";
import type { ConversationSnapshot } from "../../../src/contracts/conversations/conversation-data";
import type { UiPart } from "../../../src/contracts/conversations/session-contract";
import { Chat } from "../../../src/renderer/components/chat";
import { applyConversationUpdate } from "../../../src/renderer/reducers/ConversationReducer";
import { projectRecord, sessionSummary } from "./fixtures/catalog-fixtures";
import { createRendererStoreFixture } from "./renderer-store-fixture";
import type { TestClientOverrides } from "./test-client";

export function renderTranscriptRendering(
  parts: UiPart[],
  options: { streaming?: boolean; client?: TestClientOverrides } = {},
) {
  const fixture = createRendererStoreFixture({
    client: options.client,
    projects: [projectRecord({ path: "/project", name: "Project" })],
    sessions: [sessionSummary({ sessionId: "transcript-rendering", projectPath: "/project" })],
  });
  const session = fixture.root.sessionRegistry.load("transcript-rendering", "/project");
  fixture.root.navigationStore.selectProjectSession("transcript-rendering");
  fixture.root.projectWorkbenchStore.showLoadedSession("transcript-rendering");
  const snapshot: ConversationSnapshot = {
    sessionId: "transcript-rendering",
    sessionFile: "/project/transcript-rendering.jsonl",
    parts,
    models: [],
    thinkingLevel: "off",
    availableThinkingLevels: ["off"],
    streaming: options.streaming ?? false,
    diagnostics: [],
    commands: [],
    compatibility: { resources: [], diagnostics: [] },
    extensionUi: { statuses: [] },
    tree: [],
  };
  let revision = 1;
  applyConversationUpdate(session.model, { _tag: "Snapshot", revision, snapshot });
  const user = userEvent.setup();
  // Content proof only; native alignment/scrolling is covered in Electron.
  session.conversationSessionStore.chatStore.transcriptInteraction.setTranscriptScrollPosition({
    kind: "top",
  });
  const view = render(
    <VirtuosoMockContext.Provider value={{ viewportHeight: 800, itemHeight: 100 }}>
      <StoreProvider store={fixture.root.fullscreenSurfaceStore}>
        <Chat
          store={session.conversationSessionStore.chatStore}
          compact
          composerFocusEnabled={false}
        />
      </StoreProvider>
    </VirtuosoMockContext.Provider>,
  );
  return {
    user,
    chat: session.conversationSessionStore.chatStore,
    container: view.container,
    publish(nextParts: UiPart[], streaming = false) {
      act(() => {
        applyConversationUpdate(session.model, {
          _tag: "Snapshot",
          revision: ++revision,
          snapshot: { ...snapshot, parts: nextParts, streaming },
        });
      });
    },
    [Symbol.dispose]() {
      view.unmount();
      fixture[Symbol.dispose]();
    },
  };
}
