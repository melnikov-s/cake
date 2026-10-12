import { act, render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ConversationSnapshot } from "../../../src/contracts/conversations/conversation-data";
import { Chat } from "../../../src/renderer/components/chat";
import { applyConversationUpdate } from "../../../src/renderer/reducers/ConversationReducer";
import { projectRecord, sessionSummary } from "./fixtures/catalog-fixtures";
import { createRendererStoreFixture } from "./renderer-store-fixture";
import type { TestClientOverrides } from "./test-client";

export const deliverySessionId = "delivery-session";
export const originalExchange: ConversationSnapshot["parts"] = [
  {
    id: "original-user",
    entryId: "original-entry",
    kind: "text",
    role: "user",
    text: "Original text",
    status: "complete",
  },
  {
    id: "original-reply",
    entryId: "assistant-entry",
    kind: "text",
    role: "assistant",
    text: "Original reply",
    status: "complete",
  },
];

export function deliveryGate<Value>() {
  let resolve!: (value: Value) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<Value>((complete, fail) => {
    resolve = complete;
    reject = fail;
  });
  return { promise, resolve, reject };
}

export function renderConversationDelivery(
  client: TestClientOverrides,
  parts: ConversationSnapshot["parts"] = [],
) {
  const fixture = createRendererStoreFixture({
    client,
    projects: [projectRecord({ path: "/project", name: "Project" })],
    sessions: [sessionSummary({ sessionId: deliverySessionId, projectPath: "/project" })],
  });
  const session = fixture.root.sessionRegistry.load(deliverySessionId, "/project");
  fixture.root.appShellStore.selectProjectSession(deliverySessionId);
  fixture.root.projectWorkbenchStore.showLoadedSession(deliverySessionId);
  let revision = 0;
  function publish(parts: ConversationSnapshot["parts"], streaming: boolean) {
    applyConversationUpdate(session.model, {
      _tag: "Snapshot",
      revision: ++revision,
      snapshot: {
        sessionId: deliverySessionId,
        sessionFile: "/project/delivery-session.jsonl",
        parts,
        models: [],
        thinkingLevel: "off",
        availableThinkingLevels: ["off"],
        streaming,
        diagnostics: [],
        commands: [],
        compatibility: { resources: [], diagnostics: [] },
        extensionUi: { statuses: [] },
        tree: [],
      },
    });
  }
  publish(parts, false);
  const view = render(
    <Chat
      store={session.conversationSessionStore.chatStore}
      compact
      embedded
      composerFocusEnabled={false}
    />,
  );
  return {
    user: userEvent.setup(),
    publish(parts: ConversationSnapshot["parts"], streaming = false) {
      act(() => publish(parts, streaming));
    },
    [Symbol.dispose]() {
      view.unmount();
      fixture[Symbol.dispose]();
    },
  };
}
