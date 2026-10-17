/** @vitest-environment jsdom */
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { applySnapshot } from "r-state-tree";
import { StoreProvider } from "r-state-tree/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CAKE_CHAT_SESSION_ID } from "../../../src/contracts/cake-chats/cake-chat-identity";
import { TurnId } from "../../../src/contracts/conversations/conversation-data";
import { App } from "../../../src/renderer/components/app";
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

async function fixture() {
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
  const f = createRendererStoreFixture({
    projects: [
      projectRecord({ path: "/zombies", name: "zombies" }),
      projectRecord({ path: "/finance", name: "finance" }),
    ],
    sessions: [
      sessionSummary({
        sessionId: "task",
        projectPath: "/zombies",
        modifiedAt: "2026-01-03T00:00:00Z",
      }),
    ],
    client: {
      cakeChats: { open: async () => undefined, setUnread: async () => undefined },
      projectSessions: { open: async () => undefined },
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
  f.root.sessionRegistry.load("task", "/zombies");
  for (const id of [CAKE_CHAT_SESSION_ID, projectId, otherId, "task"]) {
    const model =
      id === "task"
        ? f.models.projectConversation(id, "/zombies")
        : f.models.cakeChatConversation(id);
    applyConversationUpdate(model, {
      _tag: "Snapshot",
      revision: 1,
      snapshot: {
        sessionId: id,
        sessionFile: id === "task" ? "/sessions/task.jsonl" : `/chats/${id}/coordinator.sqlite`,
        parts: [],
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
  }
  await f.root.cakeChatCollectionStore.initialize();
  f.root.terminalStore.readyForEvents();
  f.root.appShellStore.selectCakeChat(CAKE_CHAT_SESSION_ID);
  const view = render(
    <StoreProvider store={f.root}>
      <App />
    </StoreProvider>,
  );
  return {
    ...f,
    user: userEvent.setup(),
    browserOpen,
    editorOpen,
    terminalOpen,
    [Symbol.dispose]() {
      view.unmount();
      f[Symbol.dispose]();
    },
  };
}

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
