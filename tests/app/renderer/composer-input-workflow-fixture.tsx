import { act, render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { UiPart } from "../../../src/contracts/conversations/session-contract";
import { Chat } from "../../../src/renderer/components/chat";
import { applyConversationUpdate } from "../../../src/renderer/reducers/ConversationReducer";
import { projectRecord, sessionSummary } from "./fixtures/catalog-fixtures";
import { createRendererStoreFixture } from "./renderer-store-fixture";
import type { TestClientOverrides } from "./test-client";

export const composerInputSessionId = "composer-input-session";

export function createComposerInputFixture(client: TestClientOverrides, parts: UiPart[] = []) {
  const fixture = createRendererStoreFixture({
    client,
    projects: [projectRecord({ path: "/project", name: "Project" })],
    sessions: [sessionSummary({ sessionId: composerInputSessionId, projectPath: "/project" })],
  });
  const session = fixture.root.sessionRegistry.load(composerInputSessionId, "/project");
  fixture.root.appShellStore.selectProjectSession(composerInputSessionId);
  fixture.root.projectWorkbenchStore.showLoadedSession(composerInputSessionId);
  let revision = 1;
  applyConversationUpdate(session.model, {
    _tag: "Snapshot",
    revision,
    snapshot: {
      sessionId: composerInputSessionId,
      sessionFile: "/project/composer-input-session.jsonl",
      parts,
      models: [],
      thinkingLevel: "off",
      availableThinkingLevels: ["off"],
      streaming: false,
      diagnostics: [],
      commands: [],
      compatibility: { resources: [], diagnostics: [] },
      extensionUi: { statuses: [] },
      tree: [],
    },
  });
  return {
    conversation: session.conversationSessionStore,
    publishPart(part: UiPart) {
      act(() =>
        applyConversationUpdate(session.model, {
          _tag: "Event",
          revision: ++revision,
          sessionId: composerInputSessionId,
          event: { _tag: "PartUpdated", sessionId: composerInputSessionId, part },
        }),
      );
    },
    [Symbol.dispose]() {
      fixture[Symbol.dispose]();
    },
  };
}

export function renderComposerInput(client: TestClientOverrides) {
  const fixture = createComposerInputFixture(client);
  const view = render(
    <Chat store={fixture.conversation.chatStore} compact embedded composerFocusEnabled={false} />,
  );
  return {
    user: userEvent.setup(),
    publishPart: fixture.publishPart,
    [Symbol.dispose]() {
      view.unmount();
      fixture[Symbol.dispose]();
    },
  };
}
