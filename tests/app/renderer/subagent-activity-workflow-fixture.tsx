import { applySnapshot } from "r-state-tree";
import { StoreProvider } from "r-state-tree/react";
import type { ProjectTodos } from "../../../src/contracts/projects/project-todos";
import { ProjectTodosPanel } from "../../../src/renderer/components/project-todos-panel";
import { MarkdownLinkProvider } from "../../../src/renderer/components/ai-elements/markdown";
import { act, render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { VirtuosoMockContext } from "react-virtuoso";
import {
  SubagentHandleId,
  type SubagentActivity,
  type SubagentUpdate,
} from "../../../src/contracts/subagents/subagent-data";
import type { ConversationSnapshot } from "../../../src/contracts/conversations/conversation-data";
import type { UiPart } from "../../../src/contracts/conversations/session-contract";
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
  todos?: ProjectTodos;
  catalogReady?: boolean;
  /** Render the transcript of this Project Chat (with its to-do panel open) instead of a Project Session. */
  projectChat?: boolean;
}) {
  let todos = options.todos;
  const parent = options.projectChat ? "project-chat:/project" : parentSessionId;
  const fixture = createRendererStoreFixture({
    client: {
      ...options.client,
      ...(todos
        ? {
            projectTodos: {
              mutateUser: async ({ mutation }) => {
                if (!todos || mutation._tag !== "Select")
                  throw new Error("Unexpected to-do mutation");
                todos = { ...todos, selectedId: mutation.selectedId };
                applySnapshot(fixture.models.projects, {
                  projects: [{ ...projectRecord({ path: "/project", name: "Project" }), todos }],
                });
                return todos;
              },
            },
          }
        : {}),
    },
    projects: [
      { ...projectRecord({ path: "/project", name: "Project" }), ...(todos ? { todos } : {}) },
    ],
    sessions: [sessionSummary({ sessionId: parentSessionId, projectPath: "/project" })],
  });
  if (todos)
    applySnapshot(fixture.models.cakeChatCatalog, {
      loaded: true,
      sessions: [
        { sessionId: "project-chat:/project", title: "Project Chat", projectPath: "/project" },
      ],
    });
  const session = options.projectChat
    ? fixture.root.cakeChatCollectionStore.registry.load(parent)
    : fixture.root.sessionRegistry.load(parent, "/project");
  if (options.projectChat) {
    fixture.root.navigationStore.selectCakeChat(parent);
    fixture.root.cakeChatCollectionStore.registry.find(parent)!.todos.open();
  } else {
    fixture.root.navigationStore.selectProjectSession(parent);
    fixture.root.projectWorkbenchStore.showLoadedSession(parent);
  }
  const snapshot: ConversationSnapshot = {
    sessionId: parent,
    sessionFile: `/project/${parent}.jsonl`,
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
  const catalog = fixture.models.subagentCatalog(parent);
  applySubagentUpdate(catalog, parent, {
    _tag: "Snapshot",
    revision: 1,
    parentSessionId: parent,
    activities: options.activity ? [options.activity] : [],
    backgroundActive: false,
  });
  if (options.catalogReady === false) catalog.loaded = false;
  // Content proof only: jsdom cannot settle Virtuoso's native bottom alignment.
  for (const chat of [
    session.conversationSessionStore.chatStore,
    ...session.subagentActivityStore.chatStores,
  ])
    chat.transcriptInteraction.setTranscriptScrollPosition({ kind: "top" });
  const view = render(
    <StoreProvider store={fixture.root}>
      <MarkdownLinkProvider
        actions={{
          openExternalUrl: () => {
            throw new Error("Unexpected external navigation");
          },
          openSession: (id) => {
            void fixture.root.navigationStore.openSessionLink(id);
          },
          openSubagent: (parent, handle) => {
            void fixture.root.navigationStore.openSubagentLink(parent, handle);
          },
        }}
      >
        <VirtuosoMockContext.Provider value={{ viewportHeight: 800, itemHeight: 100 }}>
          {todos && !options.projectChat && (
            <ProjectTodosPanel
              store={
                fixture.root.cakeChatCollectionStore.registry.load("project-chat:/project").todos
              }
            />
          )}
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
        </VirtuosoMockContext.Provider>
      </MarkdownLinkProvider>
    </StoreProvider>,
  );
  return {
    user: userEvent.setup(),
    container: view.container,
    root: fixture.root,
    /** The persisted to-do document as the domain last committed it. */
    todos: () => todos,
    publish(update: SubagentUpdate, parts?: UiPart[]) {
      act(() => {
        if (parts) applyConversationSnapshot(session.model, { ...snapshot, parts });
        applySubagentUpdate(catalog, parent, update);
        for (const chat of session.subagentActivityStore.chatStores)
          chat.transcriptInteraction.setTranscriptScrollPosition({ kind: "top" });
      });
    },
    [Symbol.dispose]() {
      view.unmount();
      fixture[Symbol.dispose]();
    },
  };
}
