/** @vitest-environment jsdom */
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { applySnapshot } from "r-state-tree";
import { StoreProvider } from "r-state-tree/react";
import { expect, it, vi } from "vitest";
import { messageReference } from "../../../src/contracts/conversations/message-reference";
import { emptyProjectTodos, type ProjectTodo } from "../../../src/contracts/projects/project-todos";
import { MarkdownLinkProvider } from "../../../src/renderer/components/ai-elements/markdown";
import { ProjectTodosPanel } from "../../../src/renderer/components/project-todos-panel";
import { applyConversationUpdate } from "../../../src/renderer/reducers/ConversationReducer";
import type { Client } from "../../../src/renderer/client/Client";
import { projectRecord, sessionSummary } from "./fixtures/catalog-fixtures";
import { createRendererStoreFixture } from "./renderer-store-fixture";

it("jumps to the original findings in the conversation from a to-do after another topic and a newer response", async () => {
  const sessionId = "investigation";
  const entryId = "findings/1";
  const ref = messageReference(sessionId, entryId);
  const text = "Investigation findings: startup waits for the index.";
  const inspect = vi.fn<Client["sessionChats"]["inspect"]>();
  const item: ProjectTodo = {
    id: "00000000-0000-4000-8000-000000000011",
    title: "Investigate startup",
    description: "Find the startup bottleneck.",
    status: "Investigating",
    state: "open",
    revision: 0,
    associations: [{ kind: "session", sessionId, title: "Startup investigation" }],
  };
  const project = (todo: ProjectTodo) => ({
    ...projectRecord({ path: "/cake" }),
    todos: { ...emptyProjectTodos(), items: [todo] },
  });
  using fixture = createRendererStoreFixture({
    projects: [project(item)],
    sessions: [sessionId, "other-topic"].map((id) =>
      sessionSummary({ sessionId: id, projectPath: "/cake" }),
    ),
    client: {
      sessionChats: { inspect },
      projectSessions: { open: async () => undefined },
      electron: { setFullscreenSurfaceOpen: async () => undefined },
    },
  });
  const { root } = fixture;
  const session = root.sessionRegistry.load(sessionId, "/cake");
  applyConversationUpdate(session.model, {
    _tag: "Snapshot",
    revision: 1,
    snapshot: {
      sessionId,
      sessionFile: "/sessions/investigation.jsonl",
      parts: [
        {
          id: "entry-findings-text-0",
          entryId,
          kind: "text",
          role: "assistant",
          text,
          status: "complete",
        },
        {
          id: "entry-newer-text-0",
          entryId: "newer",
          kind: "text",
          role: "assistant",
          text: "Later unrelated response",
          status: "complete",
        },
      ],
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
  applySnapshot(fixture.models.cakeChatCatalog, {
    loaded: true,
    sessions: [{ sessionId: "project-chat:/cake", title: "Project Chat", projectPath: "/cake" }],
  });
  root.navigationStore.selectProjectSession("other-topic");
  const store = root.cakeChatCollectionStore.registry.load("project-chat:/cake").todos;
  store.open();
  const view = render(
    <StoreProvider store={root}>
      <StoreProvider store={root.fullscreenSurfaceStore}>
        <MarkdownLinkProvider
          actions={{
            openSession: (id, messageId) =>
              void root.navigationStore.openSessionLink(id, messageId),
            openExternalUrl: vi.fn(),
          }}
        >
          <ProjectTodosPanel store={store} />
        </MarkdownLinkProvider>
      </StoreProvider>
    </StoreProvider>,
  );
  try {
    // The authority attaches the retained ref when available, without presenting a summary
    // or navigating away from the user's current topic.
    await act(async () =>
      applySnapshot(fixture.models.projects, {
        projects: [
          project({
            ...item,
            revision: 1,
            status: "Report available",
            associations: [
              ...item.associations,
              { kind: "source", ref, title: "Investigation findings" },
            ],
          }),
        ],
      }),
    );
    expect(root.appShellStore.activeConversation?.sessionId).toBe("other-topic");
    expect(inspect).not.toHaveBeenCalled();
    const link = screen.getByRole("link", { name: "Investigation findings" });
    expect(link.getAttribute("href")).toBe(ref);
    await userEvent.setup().click(link);
    await waitFor(() => expect(root.appShellStore.activeConversation?.sessionId).toBe(sessionId));
    await waitFor(() =>
      expect(
        session.conversationSessionStore.chatStore.transcriptInteraction.selectedMessageId,
      ).toBe("entry-findings-text-0"),
    );
    expect(inspect).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Mark done: Investigate startup" })).toBeDefined();
    expect(screen.getByRole("link", { name: "Startup investigation" }).getAttribute("href")).toBe(
      "cake://session/investigation",
    );
  } finally {
    view.unmount();
  }
});
