/** @vitest-environment jsdom */
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { VirtuosoMockContext } from "react-virtuoso";
import { applySnapshot } from "r-state-tree";
import { Effect, Layer, ManagedRuntime } from "effect";
import * as projectTodos from "../../../src/domain/projects/projectTodos";
import { upsertProject } from "../../../src/domain/application/application";
import { ApplicationState } from "../../../src/services/storage/ApplicationState";
import { ApplicationStorage } from "../../../src/services/storage/ApplicationStorage";
import {
  defaultApplicationState,
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
import {
  applyConversationUpdate,
  unloadConversationProjection,
} from "../../../src/renderer/reducers/ConversationReducer";
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
          <VirtuosoMockContext.Provider value={{ viewportHeight: 800, itemHeight: 100 }}>
            <App />
          </VirtuosoMockContext.Provider>
        </MarkdownLinkProvider>
      </StoreProvider>
    </StoreProvider>,
  );
  return {
    ...f,
    user: userEvent.setup(),
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

it("mounts each Project Chat with its first history projection, without waiting for the live runtime", async () => {
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
    await f.user.click(screen.getByRole("button", { name: `Open Project Chat for ${name}` }));
    // The destination is observed before it is selected; the current chat stays
    // intact, without an empty destination, timer, fade or loading placeholder.
    expect(pane(id!)).toBeNull();
    expect(pane(previous!)).toBeTruthy();
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
    act(() => unloadConversationProjection(f.models.cakeChatConversation(previous!)));
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
  expect(screen.getByRole("status", { name: "Opening chat in progress" })).toBeTruthy();
  expect(screen.queryByText("Let’s talk about this project")).toBeNull();
  f.publish(projectId, [], false);
  expect(screen.getByRole("heading", { name: "Let’s talk about this project" })).toBeTruthy();
});

it("selects the latest requested Project Chat when snapshots arrive out of order", async () => {
  using f = await fixture(undefined, undefined, undefined, false);
  await f.user.click(screen.getByRole("button", { name: "Open Project Chat for zombies" }));
  await f.user.click(screen.getByRole("button", { name: "Open Project Chat for finance" }));
  f.publish(projectId, [], false);
  expect(f.root.appShellStore.activeConversation?.sessionId).toBe(CAKE_CHAT_SESSION_ID);
  f.publish(otherId, [], false);
  await waitFor(() => expect(f.root.appShellStore.activeConversation?.sessionId).toBe(otherId));
});

it.each(["/zombies", "/managed/task-worktree"])(
  "opens the session header's owning Project Chat from %s, not the globally selected project",
  async (workingDirectory) => {
    using f = await fixture(undefined, undefined, workingDirectory);
    await act(async () => f.root.navigationStore.openCakeChat(otherId));
    await f.user.click(screen.getByRole("button", { name: /^task(?: |$)/ }));
    await waitFor(() =>
      expect(
        document.querySelector('[data-slot="session-pane"][data-session-id="task"]'),
      ).toBeTruthy(),
    );
    act(() => f.root.projectWorkbenchStore.projectOpenStore.activate("/finance"));
    const header = document.querySelector<HTMLElement>(
      '[data-slot="session-pane"][data-session-id="task"] [data-slot="workspace-header"]',
    )!;
    const link = within(header).getByRole("button", { name: "Go to Project Chat for zombies" });
    expect(link.querySelector('[data-slot="avatar"]')).toBeTruthy();
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
  const header = pane.querySelector<HTMLElement>('[data-slot="workspace-header"]')!;
  const link = within(header).getByRole("button", { name: "Go to Project Chat for zombies" });
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

it.each(["Split right", "Split down"])(
  "opens Project Chat in shared panes with %s and preserves routing on focus, switching and close",
  async (direction) => {
    using f = await fixture();
    await f.user.click(screen.getByRole("button", { name: "Open Project Chat for zombies" }));
    const pane = () =>
      document.querySelector<HTMLElement>(
        `[data-slot="session-pane"][data-session-id="${projectId}"]`,
      )!;
    const input = within(pane()).getByRole("combobox", { name: "Message Project Chat" });
    await f.user.type(input, "Project Chat draft");
    await f.user.click(within(pane()).getByRole("button", { name: "To-do" }));
    expect(within(pane()).getByRole("complementary", { name: "To-do" })).toBeTruthy();
    f.publish(
      projectId,
      [
        {
          id: "entry-project-answer-text-0",
          entryId: "project-answer",
          renderKey: "assistant-project-answer-text-0",
          kind: "text",
          role: "assistant",
          text: "Only Project Chat sees this",
          status: "complete",
        },
      ],
      false,
    );
    expect(
      f.root.cakeChatCollectionStore.registry.find(projectId)!.conversationSessionStore.chatStore
        .parts,
    ).toContainEqual(expect.objectContaining({ text: "Only Project Chat sees this" }));
    await f.user.click(within(pane()).getByRole("button", { name: direction }));
    expect(document.querySelectorAll('[data-slot="session-pane"]')).toHaveLength(2);
    expect(
      f.root.cakeChatCollectionStore.registry.find(projectId)!.conversationSessionStore.chatStore
        .parts,
    ).toContainEqual(expect.objectContaining({ text: "Only Project Chat sees this" }));
    const other = () =>
      document.querySelector<HTMLElement>('[data-slot="session-pane"][data-focused="true"]')!;
    expect(other()).not.toBe(pane());
    await f.user.type(
      within(other()).getByRole("combobox", { name: "Message" }),
      "New session draft",
    );
    await f.user.click(screen.getByRole("button", { name: /^task(?: |$)/ }));
    await waitFor(() => expect(other().dataset.sessionId).toBe("task"));
    expect(
      f.root.sessionRegistry.findSession("task")!.conversationSessionStore.chatStore.parts,
    ).toEqual([]);
    // Opening the same canonical Project Chat focuses its existing pane, not a duplicate.
    await f.user.click(
      within(other()).getByRole("button", { name: "Go to Project Chat for zombies" }),
    );
    expect(document.querySelectorAll('[data-slot="session-pane"]')).toHaveLength(2);
    expect(pane().dataset.focused).toBe("true");
    expect(within(pane()).getByRole("combobox", { name: "Message Project Chat" })).toHaveProperty(
      "value",
      "Project Chat draft",
    );
    expect(within(pane()).getByRole("complementary", { name: "To-do" })).toBeTruthy();
    expect(f.root.appShellStore.activeConversation).toEqual({
      kind: "cake-chat",
      sessionId: projectId,
    });
    expect(f.root.sessionRegistry.findSession(projectId)).toBeUndefined();
    expect(
      f.root.cakeChatCollectionStore.registry.observationTargets.some(
        (target) => target.sessionId === projectId,
      ),
    ).toBe(true);
    await f.user.click(within(pane()).getByRole("button", { name: "Close pane" }));
    expect(document.querySelectorAll('[data-slot="session-pane"]')).toHaveLength(1);
    expect(
      document.querySelector('[data-slot="session-pane"]')?.getAttribute("data-session-id"),
    ).toBe("task");
    await f.user.click(screen.getByRole("button", { name: "Open Project Chat for zombies" }));
    expect(screen.getByRole("combobox", { name: "Message Project Chat" })).toHaveProperty(
      "value",
      "Project Chat draft",
    );
    await f.user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() =>
      expect(f.prompt).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: projectId, text: "Project Chat draft" }),
        expect.anything(),
      ),
    );
    await f.user.click(screen.getByRole("button", { name: /^task(?: |$)/ }));
    const taskInput = await screen.findByRole("combobox", { name: "Message" });
    await f.user.type(taskInput, "Task-only input");
    await f.user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() =>
      expect(f.prompt).toHaveBeenLastCalledWith(
        expect.objectContaining({ sessionId: "task", text: "Task-only input" }),
        expect.anything(),
      ),
    );
  },
);

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
      const panel = () => screen.queryByRole("complementary", { name: "To-do" });
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
      expect(screen.getByRole("button", { name: "To-do" }).textContent).toBe("0");
      if (alreadyOpen) await f.user.click(screen.getByRole("button", { name: "To-do" }));
      const first = await runtime.runPromise(
        projectTodos.create("/zombies", {
          title: "First commitment",
          description: "Investigate the first commitment.",
          status: "Investigating",
        }),
      );
      await publish();
      expect(within(panel()!).getByText(first.title)).toBeTruthy();
      expect(screen.getByRole("button", { name: "To-do" }).getAttribute("aria-pressed")).toBe(
        "true",
      );
      await f.user.click(screen.getByRole("button", { name: "Close To-do" }));
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
      await f.user.click(screen.getByRole("button", { name: "To-do" }));
      expect(within(panel()!).getByText("New work after Done")).toBeTruthy();
      await f.user.click(screen.getByRole("button", { name: "To-do" }));
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
    expect(screen.queryByRole("complementary", { name: "To-do" })).toBeNull();
    // Unrelated live updates after hydration cannot turn it into a creation event.
    act(() =>
      applyProjectCatalogUpdate(f.models.projects, {
        _tag: "Event",
        revision: 2,
        event: { _tag: "Upserted", project: { ...projects[0]!, name: "Renamed" } },
      }),
    );
    expect(screen.queryByRole("complementary", { name: "To-do" })).toBeNull();
    await f.user.click(screen.getByRole("button", { name: "To-do" }));
    expect(screen.getByText("Existing commitment")).toBeTruthy();
  },
);

it("toggles Project Chat to-dos in the existing side pane, selects/deselects, completes/reopens and navigates titled work links", async () => {
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
    const toggle = screen.getByRole("button", { name: "To-do" });
    // Count only open items, with the label reserved for accessibility and the tooltip.
    expect(toggle.textContent).toBe("1");
    expect(toggle.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
    await f.user.click(toggle);
    const panel = screen.getByRole("complementary", { name: "To-do" });
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    expect(within(panel).getByText(item.description)).toBeTruthy();
    expect(within(panel).queryByText("Earlier question")).toBeNull();
    const select = within(panel).getByRole("button", { name: item.title });
    await f.user.click(select);
    await waitFor(() => expect(select.getAttribute("aria-pressed")).toBe("true"));
    expect(f.models.cakeChatConversation(projectId).parts).toHaveLength(0);
    await f.user.click(select);
    await waitFor(() => expect(select.getAttribute("aria-pressed")).toBe("false"));
    expect(f.models.cakeChatConversation(projectId).parts).toHaveLength(0);
    await f.user.click(select);
    await waitFor(() => expect(select.getAttribute("aria-pressed")).toBe("true"));
    await f.user.click(within(panel).getByRole("button", { name: `Mark done: ${item.title}` }));
    await waitFor(() =>
      expect(within(panel).queryByRole("list", { name: "Active to-dos" })).toBeNull(),
    );
    expect(toggle.textContent).toBe("0");
    await f.user.click(within(panel).getByRole("button", { name: "Done (2)" }));
    await f.user.click(within(panel).getByRole("button", { name: `Reopen: ${item.title}` }));
    await waitFor(() =>
      expect(within(panel).getByRole("list", { name: "Active to-dos" })).toBeTruthy(),
    );
    expect(toggle.textContent).toBe("1");
    expect(
      within(panel).getByRole("button", { name: item.title }).getAttribute("aria-pressed"),
    ).toBe("false");
    await f.user.click(screen.getByRole("button", { name: "Close To-do" }));
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByRole("combobox", { name: "Message Project Chat" })).toBeTruthy();
    await f.user.click(toggle);
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
          selectedId: second,
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
    await f.user.click(screen.getByRole("button", { name: "To-do" }));
    const title = surface === "response" ? "Cake" : "Table";
    await f.user.click(await screen.findByRole("button", { name: `View ${surface} fullscreen` }));
    const reader = screen.getByRole("dialog", { name: title });
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
              selectedId: second,
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
    // Folding is deferred, not overridden: the attributed answer folds on exit.
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
      await f.user.click(screen.getByRole("button", { name: /^task(?: |$)/ }));
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

it("opens Project Chat from its collapsed project header with VS Code and Terminal at the registered project root", async () => {
  using f = await fixture();
  await f.user.click(screen.getByRole("button", { name: "Collapse zombies" }));
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
  await f.user.click(screen.getByRole("button", { name: "Open VS Code" }));
  await waitFor(() => expect(f.editorOpen).toHaveBeenCalledWith("/zombies", expect.anything()));
  expect(screen.getByRole("region", { name: "VS Code workspace" })).toBeTruthy();
  await f.user.click(screen.getByRole("button", { name: "Back to agent" }));
  expect(screen.getByRole("combobox", { name: "Message Project Chat" })).toBeTruthy();
});

it("shows each chat's own status and selection on its project header", async () => {
  using f = await fixture();
  const projectHeader = screen
    .getByRole("button", { name: "Open Project Chat for zombies" })
    .closest<HTMLElement>('[data-slot="project-header"]')!;
  const financeHeader = screen
    .getByRole("button", { name: "Open Project Chat for finance" })
    .closest<HTMLElement>('[data-slot="project-header"]')!;
  expect(within(projectHeader).queryByRole("img")).toBeNull();
  expect(projectHeader.classList.contains("bg-sidebar-active")).toBe(false);
  expect(financeHeader.classList.contains("bg-sidebar-active")).toBe(false);
  act(() =>
    applyConversationUpdate(f.models.cakeChatConversation(projectId), {
      _tag: "Event",
      revision: 2,
      event: { _tag: "StreamingChanged", sessionId: projectId, streaming: true },
    }),
  );
  expect(within(projectHeader).getByRole("img", { name: "Running" })).toBeTruthy();
  expect(within(financeHeader).queryByRole("img")).toBeNull();
  await f.user.click(
    within(projectHeader).getByRole("button", { name: "Open Project Chat for zombies" }),
  );
  expect(
    within(projectHeader)
      .getByRole("button", { name: "Open Project Chat for zombies" })
      .getAttribute("aria-current"),
  ).toBe("page");
  expect(projectHeader.classList.contains("bg-sidebar-active")).toBe(true);
  expect(financeHeader.classList.contains("bg-sidebar-active")).toBe(false);

  // Expansion is independent of selection, including when opening a collapsed chat.
  await f.user.click(screen.getByRole("button", { name: "Collapse zombies" }));
  expect(projectHeader.classList.contains("bg-sidebar-active")).toBe(true);
  await f.user.click(screen.getByRole("button", { name: "Expand zombies" }));
  const task = document.querySelector<HTMLElement>('[data-session-id="task"]')!;
  await f.user.click(within(task).getByRole("button", { name: /^task / }));
  await waitFor(() => expect(task.getAttribute("data-navigation-active")).toBe("true"));
  expect(projectHeader.classList.contains("bg-sidebar-active")).toBe(false);

  await f.user.click(
    within(financeHeader).getByRole("button", { name: "Open Project Chat for finance" }),
  );
  expect(financeHeader.classList.contains("bg-sidebar-active")).toBe(true);
  expect(projectHeader.classList.contains("bg-sidebar-active")).toBe(false);
  await f.user.click(screen.getByRole("button", { name: "Cake Chat" }));
  expect(financeHeader.classList.contains("bg-sidebar-active")).toBe(false);
  expect(projectHeader.classList.contains("bg-sidebar-active")).toBe(false);
});

it.each(
  (["projects", "activity"] as const).flatMap((surface) =>
    (["complete", "failed", "aborted", "stopped"] as const).map((ending) => ({ surface, ending })),
  ),
)(
  "matches Project Chat and Session dots through $ending transitions in $surface",
  async ({ surface, ending }) => {
    using f = await fixture();
    if (surface === "activity")
      await f.user.click(screen.getByRole("button", { name: "Show activity" }));
    const entries = () => [
      document.querySelector<HTMLElement>(
        surface === "projects"
          ? `[data-slot="project-header"][data-session-id="${projectId}"]`
          : `[data-slot="project-chat-item"][data-session-id="${projectId}"]`,
      )!,
      document.querySelector<HTMLElement>('.session-item[data-session-id="task"]')!,
    ];
    const openEntry = async (entry: HTMLElement, index: number) => {
      await f.user.click(
        within(entry).getByRole("button", {
          name:
            index === 1
              ? /^task(?: |$)/
              : surface === "projects"
                ? "Open Project Chat for zombies"
                : /^zombies /,
        }),
      );
      await screen.findByRole("combobox", {
        name: index === 1 ? "Message" : "Message Project Chat",
      });
    };
    const models = [
      f.models.cakeChatConversation(projectId),
      f.models.projectConversation("task", "/zombies"),
    ];
    let revision = 1;
    const turnId = TurnId.make("00000000-0000-4000-8000-000000000001");
    const assertDots = (label?: string, color?: string) => {
      for (const entry of entries()) {
        if (!label) expect(within(entry).queryByRole("img")).toBeNull();
        else {
          const dot = within(entry).getByRole("img", { name: label });
          expect(dot.classList).toContain(color);
          expect(dot.classList).toContain("size-2");
          expect(dot.classList).not.toContain("bg-muted-foreground");
          expect(dot.classList).not.toContain("bg-primary");
        }
      }
    };
    assertDots();
    act(() => {
      for (const model of models)
        applyConversationUpdate(model, {
          _tag: "Event",
          revision: ++revision,
          event: { _tag: "TurnAccepted", sessionId: model.sessionId, turnId, delivery: "prompt" },
        });
    });
    assertDots("Running", "bg-running");
    // Selection must not turn either running dot neutral, or hide it.
    for (const [index, entry] of entries().entries()) {
      await openEntry(entry, index);
      assertDots("Running", "bg-running");
    }
    await f.user.click(screen.getByRole("button", { name: "Cake Chat" }));
    act(() => {
      for (const model of models) {
        if (ending === "stopped")
          applyConversationUpdate(model, {
            _tag: "Event",
            revision: ++revision,
            event: {
              _tag: "PartUpdated",
              sessionId: model.sessionId,
              part: {
                id: "deliberate-stop",
                kind: "notice",
                tone: "info",
                title: "Stopped",
                detail: "Stopped by you",
              },
            },
          });
        applyConversationUpdate(model, {
          _tag: "Event",
          revision: ++revision,
          event: {
            _tag: "TurnSettled",
            sessionId: model.sessionId,
            turnId,
            outcome: ending === "stopped" ? "aborted" : ending,
          },
        });
      }
    });
    if (ending === "stopped") assertDots();
    else
      assertDots(
        ending === "complete" ? "Ready, unread" : "Error",
        ending === "complete" ? "bg-success" : "bg-destructive",
      );
    // Reading acknowledges completed responses, not unresolved execution errors.
    for (const [index, entry] of entries().entries()) {
      await openEntry(entry, index);
      if (ending === "failed" || ending === "aborted") assertDots("Error", "bg-destructive");
    }
    await f.user.click(screen.getByRole("button", { name: "Cake Chat" }));
    if (ending === "failed" || ending === "aborted") {
      assertDots("Error", "bg-destructive");
      // A successful retry replaces the error with an ordinary unread response.
      const retryTurnId = TurnId.make("00000000-0000-4000-8000-000000000002");
      act(() => {
        for (const model of models)
          applyConversationUpdate(model, {
            _tag: "Event",
            revision: ++revision,
            event: {
              _tag: "TurnAccepted",
              sessionId: model.sessionId,
              turnId: retryTurnId,
              delivery: "prompt",
            },
          });
      });
      assertDots("Running", "bg-running");
      act(() => {
        for (const model of models)
          applyConversationUpdate(model, {
            _tag: "Event",
            revision: ++revision,
            event: {
              _tag: "TurnSettled",
              sessionId: model.sessionId,
              turnId: retryTurnId,
              outcome: "complete",
            },
          });
      });
      assertDots("Ready, unread", "bg-success");
      for (const [index, entry] of entries().entries()) await openEntry(entry, index);
      await f.user.click(screen.getByRole("button", { name: "Cake Chat" }));
      assertDots();
    } else assertDots();
  },
);

it("gives global and project chats their own Browser destinations and returns to the same composer", async () => {
  using f = await fixture();
  expect(screen.queryByRole("button", { name: "Open VS Code" })).toBeNull();
  await f.user.click(screen.getByRole("button", { name: "Open Browser Mode" }));
  await waitFor(() =>
    expect(screen.getByRole("textbox", { name: "Browser address" })).toHaveProperty(
      "value",
      "https://example.com/",
    ),
  );
  expect(f.browserOpen).toHaveBeenCalledWith(CAKE_CHAT_SESSION_ID, undefined, expect.anything());
  await f.user.click(screen.getByRole("button", { name: "Back to agent" }));
  expect(screen.getByRole("combobox", { name: "Message Cake Chat" })).toBeTruthy();
  await act(async () => f.root.navigationStore.openCakeChat(projectId));
  await f.user.click(screen.getByRole("button", { name: "Open Browser Mode" }));
  await waitFor(() =>
    expect(f.browserOpen).toHaveBeenLastCalledWith(projectId, undefined, expect.anything()),
  );
  expect(screen.getByRole("combobox", { name: "Message Project Chat" })).toBeTruthy();
});

it("keeps Activity in creation order through task and Project Chat message updates", async () => {
  using f = await fixture();
  await f.user.click(screen.getByRole("button", { name: "Show activity" }));
  const rows = () =>
    [...document.querySelectorAll<HTMLElement>('[data-slot="sidebar"] [data-session-id]')].map(
      (row) => row.dataset.sessionId,
    );
  expect(rows().indexOf("task")).toBeLessThan(rows().indexOf(projectId));
  act(() =>
    applySnapshot(f.models.sessionCatalog, {
      sessions: [
        sessionSummary({
          sessionId: "task",
          projectPath: "/zombies",
          createdAt: "2026-01-03T00:00:00Z",
          modifiedAt: "2026-01-05T00:00:00Z",
        }),
      ],
      resolvedHasMoreByProject: {},
    }),
  );
  expect(rows().indexOf("task")).toBeLessThan(rows().indexOf(projectId));
  act(() =>
    applySnapshot(f.models.cakeChatCatalog, {
      loaded: true,
      sessions: [
        chatSummary(CAKE_CHAT_SESSION_ID),
        chatSummary(projectId, "/zombies", "2026-01-06T00:00:00Z"),
        chatSummary(otherId, "/finance"),
      ],
    }),
  );
  expect(rows().indexOf("task")).toBeLessThan(rows().indexOf(projectId));
});
