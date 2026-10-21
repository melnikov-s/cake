/** @vitest-environment jsdom */
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
  const f = createRendererStoreFixture({
    projects,
    sessions: [
      sessionSummary({
        sessionId: "task",
        projectPath: "/zombies",
        workingDirectory: taskWorkingDirectory,
        modifiedAt: "2026-01-03T00:00:00Z",
      }),
    ],
    client: {
      electron: { setFullscreenSurfaceOpen },
      cakeChats: { open: chatOpen, setUnread: async () => undefined },
      projectSessions: { open: async () => undefined },
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
  const publish = (id: string, parts: UiPart[] = [], streaming = false) => {
    const model =
      id === "task"
        ? f.models.projectConversation(id, taskWorkingDirectory)
        : f.models.cakeChatConversation(id);
    applyConversationUpdate(model, {
      _tag: "Snapshot",
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
  for (const id of [CAKE_CHAT_SESSION_ID, projectId, otherId, "task"]) publish(id);
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
          <App />
        </MarkdownLinkProvider>
      </StoreProvider>
    </StoreProvider>,
  );
  return {
    ...f,
    user: userEvent.setup(),
    publish(id: string, parts: UiPart[], streaming: boolean) {
      act(() => publish(id, parts, streaming));
    },
    setFullscreenSurfaceOpen,
    chatOpen,
    browserOpen,
    editorOpen,
    terminalOpen,
    [Symbol.dispose]() {
      view.unmount();
      f[Symbol.dispose]();
    },
  };
}

it.each(["/zombies", "/managed/task-worktree"])(
  "opens the session header's owning Project Chat from %s, not the globally selected project",
  async (workingDirectory) => {
    using f = await fixture(undefined, undefined, workingDirectory);
    await act(async () => f.root.navigationStore.openCakeChat(otherId));
    await f.user.click(screen.getByRole("button", { name: /^task(?: |$)/ }));
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
    expect(f.chatOpen).toHaveBeenLastCalledWith(
      expect.objectContaining({ sessionId: projectId }),
      expect.anything(),
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
        projectTodos.mutateUser(request.projectPath, request.mutation),
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
    expect(within(panel).getByText("Report delivered; awaiting your review")).toBeTruthy();
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
      expect(
        within(panel).getByText(
          "No open to-dos. Your agent can add a thread when taking on a commitment.",
        ),
      ).toBeTruthy(),
    );
    expect(toggle.textContent).toBe("0");
    await f.user.click(within(panel).getByRole("button", { name: "Done (2)" }));
    await f.user.click(within(panel).getByRole("button", { name: `Reopen: ${item.title}` }));
    await waitFor(() =>
      expect(within(panel).getByRole("list", { name: "Open to-dos" })).toBeTruthy(),
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
    const openEntry = (entry: HTMLElement, index: number) =>
      f.user.click(
        within(entry).getByRole("button", {
          name:
            index === 1
              ? /^task(?: |$)/
              : surface === "projects"
                ? "Open Project Chat for zombies"
                : /^zombies /,
        }),
      );
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
    assertDots("Running", "bg-accent");
    // Selection must not turn either running dot neutral, or hide it.
    for (const [index, entry] of entries().entries()) {
      await openEntry(entry, index);
      assertDots("Running", "bg-accent");
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
    // Opening acknowledges completion/failure equally; leaving cannot resurrect a dot.
    for (const [index, entry] of entries().entries()) await openEntry(entry, index);
    await f.user.click(screen.getByRole("button", { name: "Cake Chat" }));
    assertDots();
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

it("orders Activity by the Project Chat's own timestamp, not its task sessions", async () => {
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
  expect(rows().indexOf(projectId)).toBeLessThan(rows().indexOf("task"));
});
