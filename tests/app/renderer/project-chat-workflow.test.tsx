/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { applySnapshot } from "r-state-tree";
import { Effect, Layer, ManagedRuntime } from "effect";
import * as projectTodos from "../../../src/domain/projects/projectTodos";
import { upsertProject } from "../../../src/domain/application/application";
import { ApplicationState } from "../../../src/services/storage/ApplicationState";
import { ApplicationStorage } from "../../../src/services/storage/ApplicationStorage";
import {
  defaultApplicationState,
  defaultProjectSettings,
  type ProjectRecord,
} from "../../../src/contracts/application/application-data";
import { emptyProjectTodos } from "../../../src/contracts/projects/project-todos";
import { applyProjectCatalogUpdate } from "../../../src/renderer/reducers/CatalogReducer";
import { StoreProvider } from "r-state-tree/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CAKE_CHAT_SESSION_ID } from "../../../src/contracts/cake-chats/cake-chat-identity";
import { TurnId } from "../../../src/contracts/conversations/conversation-data";
import type { UiPart } from "../../../src/contracts/conversations/session-contract";
import { App } from "../../../src/renderer/components/app";
import { MarkdownLinkProvider } from "../../../src/renderer/components/ai-elements/markdown";
import { isMacPlatform } from "../../../src/renderer/lib/platform";
import { applyConversationUpdate } from "../../../src/renderer/reducers/ConversationReducer";
import type { Client } from "../../../src/renderer/client/Client";
import { projectRecord, sessionSummary } from "./fixtures/catalog-fixtures";
import { createRendererStoreFixture } from "./renderer-store-fixture";

const projectId = `project-chat:${"a".repeat(64)}`;
const otherId = `project-chat:${"b".repeat(64)}`;
const chatSummary = (
  sessionId: string,
  projectPath?: string,
  modifiedAt = "2026-01-02T00:00:00Z",
) => ({
  sessionId,
  title: projectPath?.slice(1) ?? "Cake Chat",
  projectPath,
  createdAt: "2026-01-01T00:00:00Z",
  modifiedAt,
  messageCount: 2,
  resolved: false,
  unread: false,
});

beforeEach(() => {
  Object.defineProperty(SVGElement.prototype, "getBBox", {
    configurable: true,
    value: () => ({ x: 0, y: 0, width: 24, height: 24 }),
  });
});
afterEach(() => {
  cleanup();
  Reflect.deleteProperty(SVGElement.prototype, "getBBox");
});

async function fixture(
  mutateTodos?: Client["projectTodos"]["mutateUser"],
  projects: readonly ProjectRecord[] = [
    projectRecord({ path: "/zombies", name: "zombies" }),
    projectRecord({ path: "/finance", name: "finance" }),
  ],
  taskWorkingDirectory = "/zombies",
  hydrateProjectChats = true,
) {
  const browserState = (sessionId: string) => ({
    sessionId,
    url: "https://example.com/",
    title: "Example",
    loading: false,
    canGoBack: false,
    canGoForward: false,
    inspecting: false,
  });
  const browserOpen = vi.fn<Client["browser"]["open"]>(async (id) => browserState(id));
  const editorOpen = vi.fn<Client["vscode"]["open"]>(async () => undefined);
  const terminalOpen = vi.fn<Client["terminals"]["open"]>(async () => ({
    terminalId: "terminal-1",
    shell: "zsh",
  }));
  const setFullscreenSurfaceOpen = vi.fn<Client["electron"]["setFullscreenSurfaceOpen"]>(
    async () => undefined,
  );
  const chatOpen = vi.fn<Client["cakeChats"]["open"]>(async () => undefined);
  const prompt = vi.fn<Client["sessionChats"]["prompt"]>(async () =>
    TurnId.make("00000000-0000-4000-8000-000000000001"),
  );
  const f = createRendererStoreFixture({
    projects,
    sessions: [
      sessionSummary({
        sessionId: "task",
        projectPath: "/zombies",
        workingDirectory: taskWorkingDirectory,
        createdAt: "2026-01-03T00:00:00Z",
        modifiedAt: "2026-01-03T00:00:00Z",
      }),
    ],
    client: {
      electron: { setFullscreenSurfaceOpen },
      cakeChats: { open: chatOpen, setUnread: async () => undefined },
      sessionChats: { prompt },
      projectSessions: { open: async () => undefined },
      workspaces: { loadStagedSlashCommands: async () => [] },
      projectTodos: mutateTodos ? { mutateUser: mutateTodos } : {},
      browser: {
        open: browserOpen,
        updateBounds: async ({ sessionId }) => browserState(sessionId),
      },
      vscode: {
        open: editorOpen,
        updateBounds: async () => undefined,
        updateAnnotations: async () => undefined,
        updateSelectionHighlights: async () => undefined,
        release: async () => undefined,
      },
      terminals: { open: terminalOpen, close: async () => undefined },
    },
  });
  applySnapshot(f.models.cakeChatCatalog, {
    loaded: true,
    sessions: [
      chatSummary(CAKE_CHAT_SESSION_ID),
      chatSummary(projectId, "/zombies"),
      chatSummary(otherId, "/finance"),
    ],
  });
  f.root.sessionRegistry.load("task", taskWorkingDirectory);
  let revision = 0;
  const publish = (id: string, parts: UiPart[] = [], streaming = false, preview = false) => {
    const model =
      id === "task"
        ? f.models.projectConversation(id, taskWorkingDirectory)
        : f.models.cakeChatConversation(id);
    applyConversationUpdate(model, {
      _tag: preview ? "Preview" : "Snapshot",
      revision: ++revision,
      snapshot: {
        sessionId: id,
        sessionFile: id === "task" ? "/sessions/task.jsonl" : `/chats/${id}/coordinator.sqlite`,
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
  };
  for (const id of [CAKE_CHAT_SESSION_ID, projectId, otherId, "task"])
    if (hydrateProjectChats || (id !== projectId && id !== otherId)) publish(id);
  await f.root.cakeChatCollectionStore.initialize();
  f.root.terminalStore.readyForEvents();
  f.root.navigationStore.selectCakeChat(CAKE_CHAT_SESSION_ID);
  f.root.workspaceNavigatorStore.close();
  const user = userEvent.setup();
  const view = render(
    <StoreProvider store={f.root}>
      <StoreProvider store={f.root.fullscreenSurfaceStore}>
        <MarkdownLinkProvider
          actions={{
            openSession: (id, messageId, attachmentId) =>
              void f.root.navigationStore.openSessionLink(id, messageId, attachmentId),
            openExternalUrl: () => undefined,
          }}
        >
          <>
            <App />
          </>
        </MarkdownLinkProvider>
      </StoreProvider>
    </StoreProvider>,
  );
  return {
    ...f,
    user,
    async openTask() {
      await user.click(screen.getByRole("button", { name: "Search sessions" }));
      await user.type(
        within(screen.getByRole("dialog", { name: "Search sessions" })).getByRole("combobox", {
          name: "Search session titles",
        }),
        "task",
      );
      await user.keyboard("{Enter}");
    },
    publish(id: string, parts: UiPart[], streaming: boolean, preview = false) {
      act(() => publish(id, parts, streaming, preview));
    },
    setFullscreenSurfaceOpen,
    chatOpen,
    prompt,
    browserOpen,
    editorOpen,
    terminalOpen,
    [Symbol.dispose]() {
      view.unmount();
      f[Symbol.dispose]();
    },
  };
}

async function openTodos(user: ReturnType<typeof userEvent.setup>) {
  const open = screen.queryByRole("button", { name: "Open Workspace" });
  if (open) await user.click(open);
  const tab = screen.getByRole("button", { name: /^To-dos / });
  await user.click(tab);
  return tab;
}

it("selects each Project Chat synchronously before history or runtime startup completes", async () => {
  using f = await fixture(undefined, undefined, undefined, false);
  f.chatOpen.mockClear();
  const history = (text: string): UiPart[] => [
    {
      id: `entry-${text}-text-0`,
      entryId: text,
      renderKey: `assistant-${text}-text-0`,
      kind: "text",
      role: "assistant",
      text,
      status: "complete",
    },
  ];
  const pane = (id: string) =>
    document.querySelector(`[data-slot="session-pane"][data-session-id="${id}"]`);
  for (const [id, name, text, previous] of [
    [projectId, "zombies", "Zombies history", CAKE_CHAT_SESSION_ID],
    [otherId, "finance", "Finance history", projectId],
    [projectId, "zombies", "Zombies history reloaded", otherId],
  ]) {
    fireEvent.click(screen.getByRole("button", { name: `Open Project Chat for ${name}` }));
    expect(f.root.appShellStore.activeConversation?.sessionId).toBe(id);
    expect(pane(id!)).toBeTruthy();
    expect(pane(previous!)).toBeNull();
    expect(f.root.cakeChatCollectionStore.registry.observationTargets).toContainEqual(
      expect.objectContaining({ sessionId: id }),
    );
    f.publish(id!, history(text!), false, true);
    await waitFor(() => expect(pane(id!)).toBeTruthy());
    expect(f.models.cakeChatConversation(id!).uiParts).toContainEqual(
      expect.objectContaining({ text }),
    );
    expect(
      within(pane(id!) as HTMLElement).getByRole("combobox", { name: "Message Project Chat" }),
    ).toBeTruthy();
    // Native virtualized row layout is covered by project-chat-first-render.smoke.spec.ts.
    expect(screen.queryByText("Let’s talk about this project")).toBeNull();
    expect(f.models.cakeChatConversation(id!).historyOnly).toBe(true);
  }
  // Observation owns runtime acquisition; navigation no longer starts a second
  // acquire that could force the history path to wait for runtime startup.
  expect(f.chatOpen).not.toHaveBeenCalled();
});

it("keeps genuine empty Project Chats empty only after their snapshot arrives", async () => {
  using f = await fixture(undefined, undefined, undefined, false);
  await f.user.click(screen.getByRole("button", { name: "Open Project Chat for zombies" }));
  expect(screen.queryByText("Let’s talk about this project")).toBeNull();
  f.publish(projectId, [], false);
  expect(
    await screen.findByRole("heading", { name: "Let’s talk about this project" }),
  ).toBeTruthy();
});

it("distinguishes a restored Project Chat's missing snapshot from a genuinely empty snapshot", async () => {
  using f = await fixture(undefined, undefined, undefined, false);
  act(() => {
    f.root.cakeChatCollectionStore.registry.load(projectId);
    f.root.navigationStore.selectCakeChat(projectId);
  });
  expect(screen.getByRole("combobox", { name: "Message Project Chat" })).toBeTruthy();
  expect(screen.queryByText("Let’s talk about this project")).toBeNull();
  f.publish(projectId, [], false);
  expect(screen.getByRole("heading", { name: "Let’s talk about this project" })).toBeTruthy();
});

it("selects the latest requested Project Chat when snapshots arrive out of order", async () => {
  using f = await fixture(undefined, undefined, undefined, false);
  await f.user.click(screen.getByRole("button", { name: "Open Project Chat for zombies" }));
  await f.user.click(screen.getByRole("button", { name: "Open Project Chat for finance" }));
  f.publish(projectId, [], false);
  expect(f.root.appShellStore.activeConversation?.sessionId).toBe(otherId);
  f.publish(otherId, [], false);
  await waitFor(() => expect(f.root.appShellStore.activeConversation?.sessionId).toBe(otherId));
});

it.each(
  ["/zombies", "/managed/task-worktree"].flatMap((workingDirectory) =>
    ["normal", "browser", "vscode"].flatMap((mode) =>
      (mode === "normal" ? [true] : [true, false]).map((chatSidebarVisible) => ({
        workingDirectory,
        mode,
        chatSidebarVisible,
      })),
    ),
  ),
)(
  "opens the owning Project Chat from $workingDirectory in $mode (chat sidebar: $chatSidebarVisible), not the globally selected project",
  async ({ workingDirectory, mode, chatSidebarVisible }) => {
    using f = await fixture(undefined, undefined, workingDirectory);
    await act(async () => f.root.navigationStore.openCakeChat(otherId));
    await f.openTask();
    await waitFor(() =>
      expect(
        document.querySelector('[data-slot="session-pane"][data-session-id="task"]'),
      ).toBeTruthy(),
    );
    if (mode !== "normal") {
      await f.user.click(
        screen.getByRole("button", {
          name: mode === "browser" ? "Browser" : "VS Code",
        }),
      );
      expect(
        screen.getByRole("region", {
          name: mode === "browser" ? "Browser workspace" : "VS Code workspace",
        }),
      ).toBeTruthy();
      if (!chatSidebarVisible) {
        act(() => {
          f.root.sessionRegistry.findSession("task")!.toggleWorkspaceChatSidebar();
          f.root.workspaceNavigatorStore.close();
        });
      }
    }
    act(() => f.root.projectWorkbenchStore.projectOpenStore.activate("/finance"));
    const link = within(
      screen.getByRole("navigation", { name: "Conversation breadcrumb" }),
    ).getByRole("button", { name: "zombies" });
    await f.user.click(link);
    await waitFor(() =>
      expect(
        document.querySelector(`[data-slot="session-pane"][data-session-id="${projectId}"]`),
      ).toBeTruthy(),
    );
    expect(screen.getByRole("combobox", { name: "Message Project Chat" })).toBeTruthy();
    expect(f.root.cakeChatCollectionStore.registry.observationTargets).toContainEqual(
      expect.objectContaining({ sessionId: projectId }),
    );
  },
);

it("shows the owning project artwork in Project Chat and reuses the chat and pane on activation", async () => {
  using f = await fixture();
  await f.user.click(screen.getByRole("button", { name: "Open Project Chat for zombies" }));
  const pane = document.querySelector<HTMLElement>(
    `[data-slot="session-pane"][data-session-id="${projectId}"]`,
  )!;
  const link = screen.getByRole("button", { name: "Open Project Chat for zombies" });
  expect(link.querySelector('[data-slot="avatar"] img')).toBeTruthy();
  const input = screen.getByRole("combobox", { name: "Message Project Chat" });
  await f.user.type(input, "Keep my project draft");
  f.chatOpen.mockClear();
  await f.user.click(link);
  expect(document.querySelectorAll('[data-slot="session-pane"]')).toHaveLength(1);
  expect(document.querySelector('[data-slot="session-pane"]')).toBe(pane);
  expect(screen.getByRole("combobox", { name: "Message Project Chat" })).toHaveProperty(
    "value",
    "Keep my project draft",
  );
  expect(f.chatOpen).not.toHaveBeenCalled();
});

function createTodoRuntime() {
  return ManagedRuntime.make(
    ApplicationState.layer.pipe(
      Layer.provide(
        Layer.succeed(
          ApplicationStorage,
          ApplicationStorage.of({
            load: () => Effect.succeed({ state: defaultApplicationState(), source: "current" }),
            save: () => Effect.void,
          }),
        ),
      ),
    ),
  );
}

it.each(
  (["Replaced", "Upserted"] as const).flatMap((eventTag) =>
    [false, true].map((alreadyOpen) => ({ eventTag, alreadyOpen })),
  ),
)(
  "opens only on first live to-do creation ($eventTag, already open: $alreadyOpen)",
  async ({ eventTag, alreadyOpen }) => {
    const runtime = createTodoRuntime();
    try {
      await runtime.runPromise(upsertProject("/zombies", "zombies"));
      await runtime.runPromise(upsertProject("/finance", "finance"));
      using f = await fixture();
      await f.user.click(screen.getByRole("button", { name: "Open Project Chat for zombies" }));
      const panel = () => screen.queryByRole("complementary", { name: "Workspace" });
      let revision = 0;
      const publish = async () => {
        const projects = await runtime.runPromise(
          Effect.map(ApplicationState, (state) => state.snapshot().projects),
        );
        act(() => {
          if (eventTag === "Replaced")
            applyProjectCatalogUpdate(f.models.projects, {
              _tag: "Event",
              revision: ++revision,
              event: { _tag: "Replaced", projects },
            });
          else
            for (const project of projects)
              applyProjectCatalogUpdate(f.models.projects, {
                _tag: "Event",
                revision: ++revision,
                event: { _tag: "Upserted", project },
              });
        });
      };
      // A different project's creation must not open the visible Project Chat's pane.
      await runtime.runPromise(
        projectTodos.create("/finance", {
          title: "Budget",
          description: "Review the finance budget.",
          status: "",
        }),
      );
      await publish();
      expect(panel()).toBeNull();
      expect(f.root.cakeChatCollectionStore.registry.load(projectId).todos.openItems).toHaveLength(
        0,
      );
      if (alreadyOpen) await openTodos(f.user);
      const first = await runtime.runPromise(
        projectTodos.create("/zombies", {
          title: "First commitment",
          description: "Investigate the first commitment.",
          status: "Investigating",
        }),
      );
      await publish();
      expect(within(panel()!).getByText(first.title)).toBeTruthy();
      expect(screen.getByRole("button", { name: /^To-dos / }).getAttribute("aria-pressed")).toBe(
        "true",
      );
      await f.user.click(screen.getByRole("button", { name: "Close Workspace" }));
      // Closing remains respected across later creation, status and lifecycle changes.
      const second = await runtime.runPromise(
        projectTodos.create("/zombies", {
          title: "Second commitment",
          description: "Follow up on the second commitment.",
          status: "",
        }),
      );
      await publish();
      expect(panel()).toBeNull();
      for (const item of [first, second]) {
        await runtime.runPromise(
          projectTodos.update("/zombies", { id: item.id, expectedRevision: 0, state: "done" }),
        );
      }
      await publish();
      expect(panel()).toBeNull();
      await runtime.runPromise(
        projectTodos.update("/zombies", {
          id: first.id,
          expectedRevision: 1,
          state: "open",
          status: "Following up",
        }),
      );
      await publish();
      expect(panel()).toBeNull();
      await runtime.runPromise(
        projectTodos.update("/zombies", { id: first.id, expectedRevision: 2, state: "done" }),
      );
      await publish();
      await runtime.runPromise(
        projectTodos.create("/zombies", {
          title: "New work after Done",
          description: "Track new work after earlier commitments finish.",
          status: "",
        }),
      );
      await publish();
      expect(panel()).toBeNull(); // Done history means the list is not empty.
      await openTodos(f.user);
      expect(within(panel()!).getByText("New work after Done")).toBeTruthy();
      await f.user.click(screen.getByRole("button", { name: "Close Workspace" }));
      expect(panel()).toBeNull();
    } finally {
      await runtime.dispose();
    }
  },
);

it.each(["initial load", "snapshot hydration"] as const)(
  "does not auto-open existing to-dos on %s",
  async (mode) => {
    const projects = [
      {
        ...projectRecord({ path: "/zombies", name: "zombies" }),
        todos: {
          ...emptyProjectTodos(),
          items: [
            {
              id: "00000000-0000-4000-8000-000000000001",
              title: "Existing commitment",
              description: "Review the existing commitment.",
              status: "Awaiting review",
              state: "open" as const,
              revision: 0,
              associations: [],
            },
          ],
        },
      },
    ];
    using f = await fixture(undefined, mode === "initial load" ? projects : undefined);
    await f.user.click(screen.getByRole("button", { name: "Open Project Chat for zombies" }));
    if (mode === "snapshot hydration")
      act(() =>
        applyProjectCatalogUpdate(f.models.projects, { _tag: "Snapshot", revision: 1, projects }),
      );
    expect(screen.queryByRole("complementary", { name: "Workspace" })).toBeNull();
    // Unrelated live updates after hydration cannot turn it into a creation event.
    act(() =>
      applyProjectCatalogUpdate(f.models.projects, {
        _tag: "Event",
        revision: 2,
        event: { _tag: "Upserted", project: { ...projects[0]!, name: "Renamed" } },
      }),
    );
    expect(screen.queryByRole("complementary", { name: "Workspace" })).toBeNull();
    await openTodos(f.user);
    expect(screen.getByText("Existing commitment")).toBeTruthy();
  },
);

it("toggles Project Chat to-dos in the existing side pane, focuses/unfocuses, completes/reopens and navigates titled work links", async () => {
  const runtime = createTodoRuntime();
  try {
    await runtime.runPromise(upsertProject("/zombies", "zombies"));
    await runtime.runPromise(upsertProject("/finance", "finance"));
    const item = await runtime.runPromise(
      projectTodos.create("/zombies", {
        title: "Investigate startup",
        description: "Find startup bottlenecks and recommend a focused fix.",
        status: "Report delivered; awaiting your review",
        associations: [{ kind: "session", sessionId: "task", title: "Startup investigation" }],
      }),
    );
    const completed = await runtime.runPromise(
      projectTodos.create("/zombies", {
        title: "Earlier question",
        description: "Earlier question.",
        status: "Answered",
      }),
    );
    await runtime.runPromise(
      projectTodos.update("/zombies", { id: completed.id, expectedRevision: 0, state: "done" }),
    );
    const projectSnapshot = () =>
      runtime.runPromise(Effect.map(ApplicationState, (state) => state.snapshot().projects));
    using f = await fixture(async (request) => {
      const value = await runtime.runPromise(
        projectTodos.mutateUser(request.scope, request.mutation),
      );
      const projects = await projectSnapshot();
      act(() =>
        applyProjectCatalogUpdate(f.models.projects, {
          _tag: "Snapshot",
          revision: value.sequence + 1,
          projects,
        }),
      );
      return value;
    });
    const initialProjects = await projectSnapshot();
    act(() =>
      applyProjectCatalogUpdate(f.models.projects, {
        _tag: "Snapshot",
        revision: 1,
        projects: initialProjects,
      }),
    );
    await f.user.click(screen.getByRole("button", { name: "Open Project Chat for zombies" }));
    const toggle = await openTodos(f.user);
    // The Workspace tab counts only open items, not completed history.
    expect(toggle.textContent).toBe("To-dos 1");
    const panel = screen.getByRole("complementary", { name: "Workspace" });
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    expect(within(panel).queryByText(item.description)).toBeNull();
    expect(within(panel).queryByText("Earlier question")).toBeNull();
    const row = () => within(panel).getByRole("button", { name: item.title });
    await f.user.hover(row());
    expect(await screen.findByText(item.description)).toBeTruthy();
    const focusList = () =>
      panel.querySelector<HTMLElement>('[data-todo-id][data-todo-section="Focus"]')!;
    await f.user.click(row());
    expect(within(focusList()).getByRole("button", { name: item.title })).toBeTruthy();
    expect(row().getAttribute("aria-pressed")).toBe("true");
    expect(f.models.cakeChatConversation(projectId).parts).toHaveLength(0);
    // Clicking the focused row again returns to the unfiltered transcript.
    await f.user.click(row());
    expect(row().getAttribute("aria-pressed")).toBe("false");
    expect(f.models.cakeChatConversation(projectId).parts).toHaveLength(0);
    await f.user.click(row());
    expect(row().getAttribute("aria-pressed")).toBe("true");
    await f.user.click(within(panel).getByRole("button", { name: `Mark done: ${item.title}` }));
    await waitFor(() => expect(toggle.textContent).toBe("To-dos 0"));
    expect(panel.querySelector('[data-todo-id][data-todo-section="Active"]')).toBeNull();
    // Completion keeps window-local focus; the row stays in Focus with its Reopen action.
    expect(row().getAttribute("aria-pressed")).toBe("true");
    await f.user.click(within(panel).getByRole("button", { name: `Reopen: ${item.title}` }));
    await waitFor(() => expect(toggle.textContent).toBe("To-dos 1"));
    await f.user.click(within(panel).getByRole("button", { name: `Unfocus to-do: ${item.title}` }));
    expect(
      within(panel.querySelector<HTMLElement>('[data-todo-id][data-todo-section="Active"]')!)
        .getByRole("button", { name: item.title })
        .getAttribute("aria-pressed"),
    ).toBe("false");
    await f.user.click(screen.getByRole("button", { name: "Close Workspace" }));
    expect(screen.queryByRole("complementary", { name: "Workspace" })).toBeNull();
    expect(screen.getByRole("combobox", { name: "Message Project Chat" })).toBeTruthy();
    await openTodos(f.user);
    await f.user.click(screen.getByRole("link", { name: "Startup investigation" }));
    await waitFor(() => expect(f.root.appShellStore.activeConversation?.sessionId).toBe("task"));
  } finally {
    await runtime.dispose();
  }
});

it.each(["response", "table"] as const)(
  "keeps the selected fullscreen %s through background Project Chat activity",
  async (surface) => {
    const first = "00000000-0000-4000-8000-000000000001";
    const second = "00000000-0000-4000-8000-000000000002";
    using f = await fixture(undefined, [
      {
        ...projectRecord({ path: "/zombies", name: "zombies" }),
        todos: {
          ...emptyProjectTodos(),
          items: [first, second].map((id) => ({
            id,
            title: `Task ${id}`,
            description: "A tracked task",
            status: "",
            state: "open" as const,
            revision: 0,
            associations: [],
          })),
        },
      },
    ]);
    const input: UiPart = {
      id: "input",
      kind: "text",
      role: "user",
      text: "Earlier task",
      status: "complete",
    };
    const answer: UiPart = {
      id: "answer",
      kind: "text",
      role: "assistant",
      text: `${"Selected answer. ".repeat(340)}\n\n| Selected content | Value |\n| --- | --- |\n| Original table | Retained |`,
      status: "complete",
    };
    act(() =>
      f.root.cakeChatCollectionStore.registry
        .load(projectId)
        .conversationSessionStore.chatStore.transcriptInteraction.setTranscriptScrollPosition({
          kind: "top",
        }),
    );
    f.publish(projectId, [input, answer], false);
    await f.user.click(screen.getByRole("button", { name: "Open Project Chat for zombies" }));
    await openTodos(f.user);
    const title = surface === "response" ? "Cake" : "Table";
    await f.user.click(await screen.findByRole("button", { name: `View ${surface} fullscreen` }));
    const reader = screen.getByRole("dialog", { name: title });
    // A background focus change must not unmount the message owning the reader.
    act(() => {
      const todos = f.root.cakeChatCollectionStore.registry.load(projectId).todos;
      todos.toggleFocus(todos.value!.items.find((item) => item.id === second)!);
    });
    // Attribution arrives with a transcript refresh, not a user navigation or dismissal.
    f.publish(projectId, [{ ...input, taskTodoId: first }, answer], false);
    expect(screen.getByRole("dialog", { name: title })).toBe(reader);
    // A catalog reconciliation, to-do revision and another streaming reply must
    // not navigate away or replace the content that the user chose.
    act(() => {
      applySnapshot(f.models.cakeChatCatalog, {
        loaded: true,
        sessions: [
          chatSummary(CAKE_CHAT_SESSION_ID),
          chatSummary(projectId, "/zombies", "2026-01-03T00:00:00Z"),
          chatSummary(otherId, "/finance"),
        ],
      });
      applyProjectCatalogUpdate(f.models.projects, {
        _tag: "Event",
        revision: 1,
        event: {
          _tag: "Upserted",
          project: {
            ...projectRecord({ path: "/zombies", name: "zombies" }),
            todos: {
              ...emptyProjectTodos(),
              items: [first, second].map((id) => ({
                id,
                title: `Updated task ${id}`,
                description: "Updated in background",
                status: "Working",
                state: "open",
                revision: 1,
                associations: [],
              })),
            },
          },
        },
      });
    });
    f.publish(
      projectId,
      [
        { ...input, taskTodoId: first },
        answer,
        { ...answer, id: "later", text: "A different streaming answer.", status: "streaming" },
      ],
      true,
    );
    expect(screen.getByRole("dialog", { name: title })).toBe(reader);
    expect(within(reader).getByText("Original table")).toBeTruthy();
    expect(reader.textContent).not.toContain("A different streaming answer.");
    expect(f.setFullscreenSurfaceOpen.mock.calls.map(([, open]) => open)).toEqual([true]);
    await f.user.click(within(reader).getByRole("button", { name: `Exit fullscreen ${title}` }));
    expect(screen.queryByRole("dialog", { name: title })).toBeNull();
    // Filtering is deferred, not overridden: the untagged answer disappears on exit.
    expect(screen.queryByRole("button", { name: `View ${surface} fullscreen` })).toBeNull();
  },
);

it.each([projectId, CAKE_CHAT_SESSION_ID, "task"])(
  "keeps the latest-response fullscreen reader on its completed message in %s",
  async (id) => {
    using f = await fixture();
    const live: UiPart = {
      id: "entry-live-task-text-0",
      kind: "text",
      role: "assistant",
      renderKey: "assistant-1234-text-0",
      text: "An answer still streaming. ".repeat(24),
      status: "streaming",
    };
    f.publish(id, [live], true);
    if (id === "task") {
      await f.openTask();
      await screen.findByRole("combobox", { name: "Message" });
    } else if (id === projectId) {
      await f.user.click(screen.getByRole("button", { name: "Open Project Chat for zombies" }));
    }
    // App's no-hover shortcut is distinct from the transcript-message affordance.
    // Native keyboard/hover routing is also covered by streaming-response-fullscreen.smoke.
    await f.user.keyboard(isMacPlatform ? "{Meta>}{Enter}{/Meta}" : "{Alt>}{Enter}{/Alt}");
    const reader = screen.getByRole("dialog", { name: "Cake" });
    const settled: UiPart = {
      ...live,
      id: "entry-persisted-text-0",
      entryId: "persisted",
      text: `${live.text}Final completed answer.`,
      status: "complete",
    };
    f.publish(id, [settled], false);
    expect(screen.getByRole("dialog", { name: "Cake" })).toBe(reader);
    expect(reader.textContent).toContain("Final completed answer.");
    expect(f.setFullscreenSurfaceOpen.mock.calls.map(([, open]) => open)).toEqual([true]);
    // Later activity must neither replace the selected answer nor dismiss the reader.
    f.publish(
      id,
      [
        settled,
        { ...live, id: "next", renderKey: "assistant-5678-text-0", text: "A later answer." },
      ],
      true,
    );
    expect(screen.getByRole("dialog", { name: "Cake" })).toBe(reader);
    expect(reader.textContent).not.toContain("A later answer.");
    await f.user.click(within(reader).getByRole("button", { name: "Exit fullscreen Cake" }));
    expect(screen.queryByRole("dialog", { name: "Cake" })).toBeNull();
    f.publish(id, [settled], false);
    expect(screen.queryByRole("dialog", { name: "Cake" })).toBeNull();
  },
);

it("opens Project Chat from its project rail with VS Code and Terminal at the registered project root", async () => {
  using f = await fixture();
  await f.user.click(screen.getByRole("button", { name: "Open Project Chat for zombies" }));
  await waitFor(() =>
    expect(screen.getByRole("combobox", { name: "Message Project Chat" })).toBeTruthy(),
  );
  expect(screen.queryByRole("button", { name: /Review changes/ })).toBeNull();
  expect(screen.queryByRole("complementary", { name: "Changes" })).toBeNull();
  await f.user.click(screen.getByRole("button", { name: "Terminal" }));
  await waitFor(() =>
    expect(f.terminalOpen).toHaveBeenCalledWith(
      expect.objectContaining({ target: { workingDirectory: "/zombies" } }),
    ),
  );
  act(() => f.root.terminalStore.hide());
  await f.user.click(screen.getByRole("button", { name: "VS Code" }));
  await waitFor(() => expect(f.editorOpen).toHaveBeenCalledWith("/zombies", expect.anything()));
  expect(screen.getByRole("region", { name: "VS Code workspace" })).toBeTruthy();
  await f.user.click(screen.getByRole("button", { name: "Main" }));
  expect(screen.getByRole("combobox", { name: "Message Project Chat" })).toBeTruthy();
});

it("keeps own Project Chat and Session running/error states distinct while switching the focused conversation", async () => {
  using f = await fixture();
  await f.user.click(screen.getByRole("button", { name: "Open Project Chat for zombies" }));
  await f.user.click(screen.getByRole("button", { name: "Open Workspace" }));
  await f.user.click(screen.getByRole("button", { name: /^Sessions / }));
  const row = (id: string) =>
    document.querySelector<HTMLElement>(
      `[data-slot="conversation-navigator-row"][data-session-id="${id}"]`,
    )!;
  const models = [
    f.models.cakeChatConversation(projectId),
    f.models.projectConversation("task", "/zombies"),
  ];
  const turnId = TurnId.make("00000000-0000-4000-8000-000000000001");
  let revision = 10;
  act(() => {
    for (const model of models)
      applyConversationUpdate(model, {
        _tag: "Event",
        revision: ++revision,
        event: { _tag: "TurnAccepted", sessionId: model.sessionId, turnId, delivery: "prompt" },
      });
  });
  for (const id of [projectId, "task"]) {
    const dot = within(row(id)).getByRole("img", { name: "Running" });
    expect(dot.classList).toContain("bg-accent");
  }
  await f.user.click(within(row("task")).getByRole("button", { name: /^task / }));
  expect(await screen.findByRole("combobox", { name: "Message" })).toBeTruthy();
  act(() => {
    for (const model of models)
      applyConversationUpdate(model, {
        _tag: "Event",
        revision: ++revision,
        event: { _tag: "TurnSettled", sessionId: model.sessionId, turnId, outcome: "failed" },
      });
  });
  for (const id of [projectId, "task"])
    expect(within(row(id)).getByRole("img", { name: "Error" }).classList).toContain(
      "bg-destructive",
    );
  await f.user.click(within(row(projectId)).getByRole("button", { name: "zombies" }));
  expect(await screen.findByRole("combobox", { name: "Message Project Chat" })).toBeTruthy();
  for (const id of [projectId, "task"])
    expect(within(row(id)).getByRole("img", { name: "Error" })).toBeTruthy();
});

it("gives global and project chats their own Browser destinations and returns to the same composer", async () => {
  using f = await fixture();
  expect(screen.queryByRole("button", { name: "VS Code" })).toBeNull();
  await f.user.click(screen.getByRole("button", { name: "Browser" }));
  await waitFor(() =>
    expect(screen.getByRole("textbox", { name: "Browser address" })).toHaveProperty(
      "value",
      "https://example.com/",
    ),
  );
  expect(f.browserOpen).toHaveBeenCalledWith(CAKE_CHAT_SESSION_ID, undefined, expect.anything());
  await f.user.click(screen.getByRole("button", { name: "Main" }));
  expect(screen.getByRole("combobox", { name: "Message Cake Chat" })).toBeTruthy();
  await act(async () => f.root.navigationStore.openCakeChat(projectId));
  await f.user.click(screen.getByRole("button", { name: "Browser" }));
  await waitFor(() =>
    expect(f.browserOpen).toHaveBeenLastCalledWith(projectId, undefined, expect.anything()),
  );
  expect(screen.getByRole("combobox", { name: "Message Project Chat" })).toBeTruthy();
});

it("shows a visible error when a registered project's chat is missing from the catalog", async () => {
  using f = await fixture();
  act(() => {
    const sessions = f.models.cakeChatCatalog.sessions;
    sessions.splice(
      sessions.findIndex((chat) => chat.sessionId === projectId),
      1,
    );
  });
  await f.user.click(screen.getByRole("button", { name: "Open Project Chat for zombies" }));
  expect(await screen.findByText("Could not open Project Chat")).toBeTruthy();
  expect(screen.getByRole("alert").textContent).toContain("unavailable");
});

it("shows a destination history error in the selected chat without blocking navigation", async () => {
  using f = await fixture(undefined, undefined, undefined, false);
  fireEvent.click(screen.getByRole("button", { name: "Open Project Chat for zombies" }));
  expect(f.root.appShellStore.activeConversation?.sessionId).toBe(projectId);
  act(() => {
    f.models.cakeChatConversation(projectId).observationError = "Project directory is unavailable";
  });
  expect(await screen.findByText("Could not open chat")).toBeTruthy();
  expect(screen.getByText("Project directory is unavailable")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Open Project Chat for finance" }));
  expect(f.root.appShellStore.activeConversation?.sessionId).toBe(otherId);
});

it("keeps the destination selected and accepts a draft while its authority has not responded", async () => {
  using f = await fixture(undefined, undefined, undefined, false);
  fireEvent.click(screen.getByRole("button", { name: "Open Project Chat for zombies" }));
  expect(f.root.appShellStore.activeConversation?.sessionId).toBe(projectId);
  await f.user.type(screen.getByRole("combobox", { name: "Message Project Chat" }), "Keep writing");
  fireEvent.click(screen.getByRole("button", { name: "Open Project Chat for finance" }));
  expect(f.root.appShellStore.activeConversation?.sessionId).toBe(otherId);
  f.publish(projectId, [], false);
  expect(f.root.appShellStore.activeConversation?.sessionId).toBe(otherId);
  fireEvent.click(screen.getByRole("button", { name: "Open Project Chat for zombies" }));
  expect(screen.getByRole("combobox", { name: "Message Project Chat" })).toHaveProperty(
    "value",
    "Keep writing",
  );
});

it("roots project breadcrumbs in sidebar artwork and name, preserving session and global navigation", async () => {
  const icon = { mimeType: "image/png", data: "project-artwork" } as const;
  using f = await fixture(undefined, [
    projectRecord({
      path: "/zombies",
      name: "Orchard",
      settings: { ...defaultProjectSettings(), icon },
    }),
    projectRecord({ path: "/finance", name: "Ledger" }),
  ]);
  for (const name of ["Orchard", "Ledger"]) {
    await f.user.click(screen.getByRole("button", { name: `Open Project Chat for ${name}` }));
    const breadcrumb = within(screen.getByRole("navigation", { name: "Conversation breadcrumb" }));
    expect(breadcrumb.getAllByRole("button").map((button) => button.textContent)).toEqual([name]);
    expect(breadcrumb.queryByRole("button", { name: "Cake Chat" })).toBeNull();
    expect(breadcrumb.queryByText("›")).toBeNull();
    const projectButton = breadcrumb.getByRole("button", { name });
    const artwork = projectButton.querySelector('[data-slot="avatar"]')!;
    expect(artwork.getAttribute("aria-hidden")).toBe("true");
    const source = artwork.querySelector("img")!.getAttribute("src");
    expect(source).toBe(
      screen
        .getByRole("button", { name: `Open Project Chat for ${name}` })
        .querySelector('[data-slot="avatar"] img')!
        .getAttribute("src"),
    );
    expect(source).toMatch(
      name === "Orchard" ? /^data:image\/png;base64,project-artwork$/ : /^data:image\/svg\+xml/,
    );
    expect(breadcrumb.getByRole("button", { name }).getAttribute("aria-current")).toBe("page");
    expect(breadcrumb.queryByRole("button", { name: "Project Chat" })).toBeNull();
    expect(
      document.querySelector('[data-slot="workspace-title"] [aria-current="page"]')?.textContent,
    ).toBe(name);
    const open = screen.queryByRole("button", { name: "Open Workspace" });
    if (open) await f.user.click(open);
    const workspace = within(screen.getByRole("complementary", { name: "Workspace" }));
    await f.user.click(workspace.getByRole("button", { name: /^Sessions/ }));
    expect(workspace.getByRole("button", { name })).toBeTruthy();
    expect(workspace.queryByRole("button", { name: "Project Chat" })).toBeNull();
  }
  await act(async () => {
    await f.root.navigationStore.openSession("task");
  });
  const breadcrumb = within(screen.getByRole("navigation", { name: "Conversation breadcrumb" }));
  expect(breadcrumb.getAllByRole("button").map((button) => button.textContent)).toEqual([
    "Orchard",
    "task",
  ]);
  expect(breadcrumb.queryByRole("button", { name: "Cake Chat" })).toBeNull();
  expect(breadcrumb.getByRole("button", { name: "task" }).getAttribute("aria-current")).toBe(
    "page",
  );
  expect(
    breadcrumb.getByRole("button", { name: "Orchard" }).querySelector("img")?.getAttribute("src"),
  ).toBe("data:image/png;base64,project-artwork");
  expect(
    breadcrumb.getByRole("button", { name: "Orchard" }).getAttribute("aria-current"),
  ).toBeNull();
  await f.user.click(breadcrumb.getByRole("button", { name: "Orchard" }));
  expect(screen.getByRole("combobox", { name: "Message Project Chat" })).toBeTruthy();
  await f.user.click(screen.getByRole("button", { name: "Open Cake Chat" }));
  const global = within(screen.getByRole("navigation", { name: "Conversation breadcrumb" }));
  expect(global.getAllByRole("button").map((button) => button.textContent)).toEqual(["Cake Chat"]);
  expect(global.getByRole("button", { name: "Cake Chat" }).getAttribute("aria-current")).toBe(
    "page",
  );
  await f.user.click(global.getByRole("button", { name: "Cake Chat" }));
  expect(screen.getByRole("combobox", { name: "Message Cake Chat" })).toBeTruthy();
});
