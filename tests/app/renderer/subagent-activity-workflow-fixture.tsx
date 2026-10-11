import { act, render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { VirtuosoMockContext } from "react-virtuoso";
import {
  SubagentHandleId,
  type SubagentActivity,
  type SubagentUpdate,
} from "../../../src/contracts/subagents/subagent-data";
import type { ConversationSnapshot } from "../../../src/ipc/conversation-data";
import type { UiPart } from "../../../src/ipc/session-contract";
import { Chat } from "../../../src/renderer/components/chat";
import { SideChatLayout } from "../../../src/renderer/components/side-chat-layout";
import { applyConversationSnapshot } from "../../../src/renderer/reducers/ConversationReducer";
import { applySubagentUpdate } from "../../../src/renderer/reducers/SubagentReducer";
import { projectRecord, sessionSummary } from "./fixtures/catalog-fixtures";
import { createRendererStoreFixture } from "./renderer-store-fixture";
import type { TestClientOverrides } from "./test-client";

export const parentSessionId = "subagent-parent";
export const handleId = SubagentHandleId.make("10000000-0000-4000-8000-000000000001");

export function workerActivity(overrides: Partial<SubagentActivity> = {}): SubagentActivity {
  return {
    parentSessionId,
    anchorPartId: "tool-spawn",
    handleId,
    revision: 1,
    task: "Inspect the boundary",
    status: "running",
    resolvedModel: {
      requested: "current",
      source: "current",
      provider: "test",
      modelId: "model",
      thinkingLevel: "medium",
      fallbacks: [],
    },
    fastMode: false,
    streaming: true,
    parts: [
      {
        id: "child-text",
        kind: "text",
        role: "assistant",
        text: "Inspecting now",
        status: "streaming",
      },
    ],
    ...overrides,
  };
}

export function workerTranscript(result?: SubagentActivity): UiPart[] {
  const parts: UiPart[] = [
    {
      id: "tool-spawn",
      kind: "tool",
      name: "cake",
      command: "subagents.start",
      input: JSON.stringify({ task: "Inspect the boundary" }),
      output: JSON.stringify({ handleId, status: "running" }),
      state: "success",
    },
  ];
  if (result)
    parts.push({
      id: "tool-wait",
      kind: "tool",
      name: "cake",
      command: "subagents.wait",
      input: JSON.stringify({ handleId }),
      output: JSON.stringify(result),
      state: "success",
    });
  return parts;
}

export function renderSubagentActivity(options: {
  client?: TestClientOverrides;
  activity?: SubagentActivity;
  parts: UiPart[];
}) {
  const fixture = createRendererStoreFixture({
    client: options.client,
    projects: [projectRecord({ path: "/project", name: "Project" })],
    sessions: [sessionSummary({ sessionId: parentSessionId, projectPath: "/project" })],
  });
  const session = fixture.root.sessionRegistry.load(parentSessionId, "/project");
  fixture.root.appShellStore.selectProjectSession(parentSessionId);
  fixture.root.projectWorkbenchStore.showLoadedSession(parentSessionId);
  const snapshot: ConversationSnapshot = {
    sessionId: parentSessionId,
    sessionFile: `/project/${parentSessionId}.jsonl`,
    parts: options.parts,
    models: [],
    thinkingLevel: "off",
    availableThinkingLevels: ["off"],
    streaming: false,
    diagnostics: [],
    commands: [],
    compatibility: { resources: [], diagnostics: [] },
    extensionUi: { statuses: [] },
    tree: [],
  };
  applyConversationSnapshot(session.model, snapshot);
  const catalog = fixture.models.subagentCatalog(parentSessionId);
  applySubagentUpdate(catalog, parentSessionId, {
    _tag: "Snapshot",
    revision: 1,
    parentSessionId,
    activities: options.activity ? [options.activity] : [],
    backgroundActive: false,
  });
  // Content proof only: jsdom cannot settle Virtuoso's native bottom alignment.
  for (const chat of [
    session.conversationSessionStore.chatStore,
    ...session.subagentActivityStore.chatStores,
  ])
    chat.transcriptInteraction.setTranscriptScrollPosition({ kind: "top" });
  const view = render(
    <VirtuosoMockContext.Provider value={{ viewportHeight: 800, itemHeight: 100 }}>
      <SideChatLayout
        store={session.conversationSessionStore.sideChatStore}
        renderChat={(chat) => <Chat store={chat} embedded composerFocusEnabled={false} />}
      >
        <Chat
          store={session.conversationSessionStore.chatStore}
          transcriptBehavior={{ subagents: session.subagentActivityStore }}
          embedded
          composerFocusEnabled={false}
        />
      </SideChatLayout>
    </VirtuosoMockContext.Provider>,
  );
  return {
    user: userEvent.setup(),
    publish(update: SubagentUpdate, parts?: UiPart[]) {
      act(() => {
        if (parts) applyConversationSnapshot(session.model, { ...snapshot, parts });
        applySubagentUpdate(catalog, parentSessionId, update);
      });
    },
    [Symbol.dispose]() {
      view.unmount();
      fixture[Symbol.dispose]();
    },
  };
}
