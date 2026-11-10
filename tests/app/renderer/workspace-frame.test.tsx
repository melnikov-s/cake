/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { applySnapshot, toSnapshot } from "r-state-tree";
import { StoreProvider } from "r-state-tree/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { settleListLayout } from "./settle-list-layout";
import { App } from "../../../src/renderer/components/app";
import { SidebarNavigationControls } from "../../../src/renderer/components/sidebar-navigation-controls";
import type { Client } from "../../../src/renderer/client/Client";
import { editorLease } from "./embedded-editor-workflow-fixture";
import { CakeChatWorkspaceSurface } from "../../../src/renderer/components/cake-chat-workspace-surface";
import { ProjectWorkspaceSurface } from "../../../src/renderer/components/project-workspace-surface";
import { applyConversationSnapshot } from "../../../src/renderer/reducers/ConversationReducer";
import { applyPartUpdate } from "../../../src/renderer/reducers/SessionPartReducer";
import { emptyProjectTodos } from "../../../src/contracts/projects/project-todos";
import { projectRecord, sessionSummary } from "./fixtures/catalog-fixtures";
import { createRendererStoreFixture } from "./renderer-store-fixture";

const projectId = "workspace-project";
const cakeChatId = `project-chat:${"a".repeat(64)}`;
type Kind = "project" | "cake-chat";
type Mode = "browser" | "vscode";

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    () => new DOMRect(0, 0, 1200, 900),
  );
  // jsdom has no SVG/text layout; Electron verifies actual geometry and input.
  Object.defineProperty(SVGElement.prototype, "getBBox", {
    configurable: true,
    value: () => ({ x: 0, y: 0, width: 24, height: 24 }),
  });
  const rect = new DOMRect(0, 0, 100, 20);
  Object.defineProperty(Range.prototype, "getBoundingClientRect", {
    configurable: true,
    value: () => rect,
  });
  Object.defineProperty(Range.prototype, "getClientRects", {
    configurable: true,
    value: () => [rect],
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  Reflect.deleteProperty(SVGElement.prototype, "getBBox");
  Reflect.deleteProperty(Range.prototype, "getBoundingClientRect");
  Reflect.deleteProperty(Range.prototype, "getClientRects");
});

function renderWorkspace(kind: Kind, mode: Mode, startInChat = false, fullApp = startInChat) {
  const reveal = vi.fn<Client["vscode"]["reveal"]>(async () => ({
    outcome: { view: "file" },
    locations: [],
  }));
  const browserState = (sessionId: string) => ({
    sessionId,
    url: "about:blank",
    title: "Browser",
    loading: false,
    canGoBack: false,
    canGoForward: false,
    inspecting: false,
  });
  const fixture = createRendererStoreFixture({
    projects: [projectRecord({ path: "/project", name: "Project" })],
    sessions: [
      sessionSummary({ sessionId: projectId, projectPath: "/project", title: "Project task" }),
    ],
    client: {
      projectSessions: { open: async () => undefined },
      cakeChats: { open: async () => undefined },
      browser: {
        open: async (sessionId) => browserState(sessionId),
        state: async (sessionId) => browserState(sessionId),
        updateBounds: async ({ sessionId }) => browserState(sessionId),
      },
      filesystem: {
        prepareFileLocation: async ({ location }) => ({ viewer: "vscode", location }),
      },
      vscode: {
        open: async () => editorLease("a"),
        reveal,
        release: async () => undefined,
        updateBounds: async () => undefined,
        updateAnnotations: async () => undefined,
        updateSelectionHighlights: async () => undefined,
        setTheme: async () => undefined,
      },
    },
  });
  const { root, models } = fixture;
  applySnapshot(models.cakeChatCatalog, {
    loaded: true,
    sessions: [{ sessionId: cakeChatId, title: "Project coordinator", projectPath: "/project" }],
  });
  const session =
    kind === "project"
      ? root.sessionRegistry.load(projectId, "/project")
      : root.cakeChatCollectionStore.registry.load(cakeChatId);
  if (kind === "project") {
    root.navigationStore.selectProjectSession(session.sessionId);
    root.projectWorkbenchStore.showLoadedSession(session.sessionId);
    root.sessionLayoutStore.ensureSession(session.sessionId);
  } else {
    root.navigationStore.selectCakeChat(session.sessionId);
    root.cakeChatCollectionStore.sessionLayoutStore.ensureSession(session.sessionId);
  }
  session.showPresentation(startInChat ? "normal" : mode);
  if (startInChat) session.toggleWorkspaceChatSidebar();
  session.setWorkspaceChatSidebarWidth(440);
  applyConversationSnapshot(session.model, {
    sessionId: session.sessionId,
    sessionFile: `/sessions/${session.sessionId}`,
    parts: [
      {
        id: "answer",
        kind: "text",
        role: "assistant",
        entryId: "entry-answer",
        text: "Workspace answer",
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
  });
  session.conversationSessionStore.chatStore.transcriptInteraction.setTranscriptScrollPosition({
    kind: "top",
  });
  const surface =
    kind === "project" ? (
      <ProjectWorkspaceSurface
        session={root.sessionRegistry.findSession(projectId)!}
        mode={mode}
        browserMode={false}
      />
    ) : (
      <CakeChatWorkspaceSurface
        session={root.cakeChatCollectionStore.registry.find(cakeChatId)!}
        mode={mode}
        browserMode={false}
      />
    );
  const view = render(
    <StoreProvider store={root}>
      <>
        {fullApp ? (
          <StoreProvider store={root.fullscreenSurfaceStore}>
            <App />
          </StoreProvider>
        ) : (
          <>
            <SidebarNavigationControls />
            {surface}
          </>
        )}
      </>
    </StoreProvider>,
  );
  return {
    root,
    models,
    session,
    reveal,
    view,
    user: userEvent.setup(),
    [Symbol.dispose]() {
      view.unmount();
      fixture[Symbol.dispose]();
    },
  };
}

it.each<Mode>(["browser", "vscode"])(
  "%s companion toggles and switches transcript to-do focus like the header clear action",
  async (mode) => {
    using f = renderWorkspace("cake-chat", mode);
    const session = f.root.cakeChatCollectionStore.registry.find(cakeChatId)!;
    const items = ["A", "B"].map((title, index) => ({
      id: `00000000-0000-4000-8000-00000000001${index}`,
      title: `Task ${title}`,
      description: "",
      status: "",
      state: "open" as const,
      revision: 0,
      associations: [],
    }));
    act(() => {
      applySnapshot(f.models.projects, {
        projects: [
          {
            ...projectRecord({ path: "/project", name: "Project" }),
            todos: { ...emptyProjectTodos(), items },
          },
        ],
      });
      for (const item of items) {
        applyPartUpdate(
          session.model.parts,
          {
            id: `${item.id}-prompt`,
            kind: "text",
            role: "user",
            text: `${item.title} prompt`,
            status: "complete",
            taskTodoId: item.id,
          },
          session.sessionId,
        );
        applyPartUpdate(
          session.model.parts,
          {
            id: `${item.id}-answer`,
            kind: "text",
            role: "assistant",
            text: `${item.title} answer`,
            status: "complete",
          },
          session.sessionId,
        );
      }
    });
    const companion = within(
      screen.getByRole("complementary", {
        name: "Current conversation companion",
      }),
    );
    const focus = (title: string) =>
      companion.getByRole("button", { name: `Focus to-do: ${title}` });
    const expanded = () =>
      ["Task A", "Task B"].map((title) =>
        companion
          .queryAllByRole("button", { name: title })
          .find((button) => button.hasAttribute("aria-expanded"))
          ?.getAttribute("aria-expanded"),
      );
    await settleListLayout();
    await f.user.click(focus("Task A"));
    expect(expanded()).toEqual(["true", undefined]);
    expect(companion.queryByText("Task A answer")).toBeNull();
    expect(companion.queryByText("Task B prompt")).toBeNull();
    act(() => session.todos.toggleFocus(items[1]!));
    expect(expanded()).toEqual([undefined, "true"]);
    expect(session.todos.focusedItemIds).toEqual([items[1]!.id]);
    await f.user.click(focus("Task B"));
    expect(expanded()).toEqual(["true", "true"]);
    expect(session.todos.focusedItems).toEqual([]);
    expect(session.todos.transcriptFocusRequest).toBeUndefined();
    expect(companion.getByText("Task A answer")).toBeDefined();
    expect(companion.getByText("Task B answer")).toBeDefined();
    await f.user.click(focus("Task A"));
    await f.user.click(companion.getByRole("button", { name: "Clear to-do focus" }));
    expect(expanded()).toEqual(["true", "true"]);
    expect(session.todos.focusedItems).toEqual([]);
    expect(f.models.projects.projects[0]!.todos.items).toEqual(items);
  },
);

// Real workflow Stores, Models, controls, Chat and side-chat composition.
// These assertions cover rendered wiring, not pixel layout, native input or focus.
describe.each<Kind>(["project", "cake-chat"])("%s workspace frame", (kind) => {
  it("places one VS Code work-log trigger immediately before the shell pane toggle and preserves its behavior", async () => {
    using f = renderWorkspace(kind, "vscode", false, true);
    const shellControls = document.querySelector('[data-slot="shell-workspace-controls"]')!;
    const trigger = () => screen.getByRole("button", { name: "Work log display options" });
    const expectToolbarPlacement = () => {
      const buttons = screen.getAllByRole("button");
      expect(buttons[buttons.indexOf(trigger()) - 1]).toBe(
        screen.getByRole("button", { name: "Terminal" }),
      );
      expect(shellControls.contains(trigger())).toBe(false);
    };
    // A saved VS Code preference is not enough: the editor must actually be shown.
    expectToolbarPlacement();
    await f.user.click(screen.getByRole("button", { name: "VS Code" }));
    const expectShellPlacement = () => {
      expect(screen.getAllByRole("button", { name: "Work log display options" })).toHaveLength(1);
      expect(shellControls.contains(trigger())).toBe(true);
      const buttons = within(shellControls as HTMLElement).getAllByRole("button");
      expect(buttons).toEqual([
        trigger(),
        document.querySelector('[data-slot="shell-workspace-toggle"]'),
      ]);
      expect(trigger().querySelectorAll("svg")).toHaveLength(1);
    };
    expectShellPlacement();
    const presentation = f.session.conversationSessionStore.chatStore.workLogPresentation;
    const setViewMode = vi.spyOn(presentation, "setViewMode");
    const setExpansion = vi.spyOn(presentation, "setExpansion");
    await f.user.click(trigger());
    for (const [name, value] of [
      ["Auto view mode", "auto"],
      ["Diff view mode", "diff"],
      ["Log view mode", "log"],
    ] as const) {
      await f.user.click(screen.getByRole("button", { name }));
      expect(setViewMode).toHaveBeenLastCalledWith(value);
      expect(screen.getByRole("button", { name }).getAttribute("aria-pressed")).toBe("true");
    }
    for (const [name, value] of [
      ["Collapsed work logs", "collapsed"],
      ["Compact work logs", "expanded"],
      ["Full work logs", "fully-expanded"],
    ] as const) {
      await f.user.click(screen.getByRole("button", { name }));
      expect(setExpansion).toHaveBeenLastCalledWith(value);
      expect(screen.getByRole("button", { name }).getAttribute("aria-pressed")).toBe("true");
    }
    await f.user.click(trigger());
    await f.user.click(screen.getByRole("button", { name: "Close Workspace" }));
    expectShellPlacement();
    await f.user.click(screen.getByRole("button", { name: "Open Workspace" }));
    expectShellPlacement();
    await f.user.click(screen.getByRole("button", { name: "Main" }));
    expectToolbarPlacement();
    await f.user.click(screen.getByRole("button", { name: /^Browser$/ }));
    expectToolbarPlacement();
    await f.user.click(screen.getByRole("button", { name: "VS Code" }));
    expectShellPlacement();
    await f.user.click(trigger());
    for (const name of ["Log view mode", "Full work logs"]) {
      expect(screen.getByRole("button", { name }).getAttribute("aria-pressed")).toBe("true");
    }
  });

  it.each(
    (["browser", "vscode"] as const).flatMap((mode) =>
      (["todos", "sessions"] as const).flatMap((tab) =>
        [false, true].map((hidden) => ({ mode, tab, hidden })),
      ),
    ),
  )(
    "navigating back to $mode selects visible Chat from $tab (hidden: $hidden)",
    async ({ mode, tab, hidden }) => {
      using f = renderWorkspace(kind, mode, false, true);
      const navigator = f.root.workspaceNavigatorStore;
      act(() => {
        navigator.show(tab);
        if (hidden) navigator.togglePane();
        f.root.sessionRegistry.load("other", "/project");
        f.root.navigationStore.showLoadedProjectSession("other");
      });
      expect(f.root.appShellStore.activeConversation?.sessionId).toBe("other");
      expect(navigator.companionTab).toBe(tab);
      expect(f.session.workspaceChatSidebarVisible).toBe(!hidden);

      await act(async () => {
        expect(await f.root.navigationStore.openSession(f.session.sessionId)).not.toBe(false);
      });
      expect(f.root.appShellStore.activeConversation?.sessionId).toBe(f.session.sessionId);
      expect(f.session.presentationMode).toBe(mode);
      expect(navigator.companionTab).toBe("chat");
      expect(navigator.paneVisible).toBe(true);
      const companion = screen.getByRole("complementary", {
        name: "Current conversation companion",
      });
      expect(within(companion).getByText("Workspace answer")).toBeDefined();
      expect(
        within(companion).getByRole("combobox", {
          name: kind === "project" ? "Message" : "Message Project Chat",
        }),
      ).toBeDefined();
      expect(
        screen.getByRole("region", {
          name: mode === "browser" ? "Browser workspace" : "VS Code workspace",
        }),
      ).toBeDefined();
      if (mode === "vscode")
        await waitFor(() =>
          expect(screen.getByTitle("VS Code workspace").getAttribute("src")).toBe(
            editorLease("a").endpoint,
          ),
        );

      // Same-session navigation and incoming projection updates must not undo manual controls.
      act(() => {
        navigator.show(tab);
        navigator.togglePane();
        applyPartUpdate(
          f.session.model.parts,
          {
            id: "streaming-answer",
            kind: "text",
            role: "assistant",
            text: "Incoming answer",
            status: "streaming",
          },
          f.session.sessionId,
        );
        applySnapshot(f.models.projects, {
          projects: [projectRecord({ path: "/project", name: "Refreshed project" })],
        });
      });
      await act(async () => {
        await f.root.navigationStore.openSession(f.session.sessionId);
      });
      expect(navigator.companionTab).toBe(tab);
      expect(navigator.paneVisible).toBe(false);
      act(() => navigator.togglePane());
      expect(navigator.companionTab).toBe(tab);
      expect(navigator.paneVisible).toBe(true);
      expect(f.session.presentationMode).toBe(mode);
    },
  );

  it.each(
    (["browser", "vscode"] as const).flatMap((mode) =>
      (["todos", "sessions"] as const).flatMap((tab) =>
        (["toolbar", "programmatic"] as const).map((entry) => ({ mode, tab, entry })),
      ),
    ),
  )("$entry entry into $mode defaults $tab to Chat only on entry", async ({ mode, tab, entry }) => {
    using f = renderWorkspace(kind, mode, true);
    const mainTab = () =>
      within(screen.getByRole("group", { name: "Workspace content" })).getByRole("button", {
        name: tab === "todos" ? /^To-dos/ : /^Sessions/,
      });
    const companionTab = (name: string) =>
      within(screen.getByRole("group", { name: "Companion content" })).getByRole("button", {
        name,
      });
    const tabName = tab === "todos" ? "Todos" : "Sessions";
    const modeName = mode === "browser" ? "Browser" : "VS Code";
    const programmaticEntry = async () => {
      await act(async () => {
        if (mode === "browser") {
          f.root.projectWorkbenchStore.receive({
            type: "browser-entered",
            sessionId: f.session.sessionId,
            workspacePath: "/project",
          });
        } else {
          expect(
            await f.root.applicationControlStore.invoke(
              { name: "vscode.enter", arguments: {} },
              {
                kind: kind === "project" ? "project-session" : "cake-chat",
                sessionId: f.session.sessionId,
                projectPath: "/project",
                workingDirectory: "/project",
                title: "Invoking conversation",
              },
            ),
          ).toMatchObject({ ok: true });
        }
      });
    };

    await f.user.click(mainTab());
    expect(mainTab().getAttribute("aria-pressed")).toBe("true");
    if (entry === "toolbar") await f.user.click(screen.getByRole("button", { name: modeName }));
    else await programmaticEntry();
    expect(companionTab("Chat").getAttribute("aria-pressed")).toBe("true");

    // Manual selection, projection refresh, and repeated same-mode entry keep the chosen tab.
    await f.user.click(companionTab(tabName));
    act(() =>
      applySnapshot(f.models.projects, {
        projects: [projectRecord({ path: "/project", name: "Refreshed project" })],
      }),
    );
    await programmaticEntry();
    expect(companionTab(tabName).getAttribute("aria-pressed")).toBe("true");

    await f.user.click(screen.getByRole("button", { name: "Main" }));
    expect(mainTab().getAttribute("aria-pressed")).toBe("true");
    expect(f.root.workspaceNavigatorStore.companionTab).toBe(tab);
    await f.user.click(screen.getByRole("button", { name: modeName }));
    expect(companionTab("Chat").getAttribute("aria-pressed")).toBe("true");

    // Switching directly between the two tool modes is also a fresh entry.
    await f.user.click(companionTab(tabName));
    await f.user.click(
      screen.getByRole("button", {
        name: mode === "browser" ? "VS Code" : "Browser",
      }),
    );
    expect(companionTab("Chat").getAttribute("aria-pressed")).toBe("true");
  });

  it("Main navigation preserves accessory tab and visibility", async () => {
    using f = renderWorkspace(kind, "browser", false, true);
    const navigator = f.root.workspaceNavigatorStore;
    act(() => {
      f.session.showPresentation("normal");
      navigator.show("sessions");
      navigator.togglePane();
      f.session.toggleWorkspaceChatSidebar();
      f.root.sessionRegistry.load("other", "/project");
      f.root.navigationStore.showLoadedProjectSession("other");
    });
    await act(async () => {
      await f.root.navigationStore.openSession(f.session.sessionId);
    });
    expect(f.session.presentationMode).toBe("normal");
    expect(navigator.companionTab).toBe("sessions");
    expect(navigator.mode).toBe("sessions");
    expect(navigator.paneVisible).toBe(false);
    expect(f.session.workspaceChatSidebarVisible).toBe(false);
    expect(
      screen.getByRole("combobox", {
        name: kind === "project" ? "Message" : "Message Project Chat",
      }),
    ).toBeDefined();
  });

  it.each(["tool", "toolbar"])(
    "shows the invoking conversation on %s VS Code entry and keeps the requested file",
    async (entry) => {
      using f = renderWorkspace(kind, "vscode", true);
      const draft = f.session.conversationSessionStore.composerStore.draftStore;
      act(() => draft.setText("Keep my draft"));
      const source = {
        kind: kind === "project" ? ("project-session" as const) : ("cake-chat" as const),
        sessionId: f.session.sessionId,
        projectPath: "/project",
        workingDirectory: "/project",
        title: "Invoking conversation",
      };
      const invoke = async (name: string, args = {}) => {
        await act(async () => {
          expect(
            await f.root.applicationControlStore.invoke({ name, arguments: args }, source),
          ).toMatchObject({ ok: true });
        });
      };
      if (entry === "tool") await invoke("vscode.enter");
      else await f.user.click(screen.getByRole("button", { name: "VS Code" }));
      const companion = screen.getByRole("complementary", {
        name: "Current conversation companion",
      });
      expect(await within(companion).findByText("Workspace answer")).toBeDefined();
      expect(
        within(companion).getByRole("combobox", {
          name: kind === "project" ? "Message" : "Message Project Chat",
        }).textContent,
      ).toBe("Keep my draft");
      await invoke("vscode.open", { path: "src/services/pi/runtime/prompts/cake-chat.md" });
      expect(f.reveal).toHaveBeenLastCalledWith(
        "/project",
        { kind: "working-directory", path: "src/services/pi/runtime/prompts/cake-chat.md" },
        expect.anything(),
      );
      expect(f.root.appShellStore.activeConversation?.sessionId).toBe(f.session.sessionId);
      expect(screen.getByTitle("VS Code workspace").getAttribute("src")).toBe(
        editorLease("a").endpoint,
      );
      expect(screen.getByRole("complementary", { name: "Current conversation companion" })).toBe(
        companion,
      );

      // File navigation honors a manual close; explicit entry shows the same chat again.
      await f.user.click(screen.getByRole("button", { name: "Close Workspace" }));
      await invoke("vscode.open", { path: "src/next.ts" });
      expect(
        screen.queryByRole("complementary", { name: "Current conversation companion" }),
      ).toBeNull();
      await invoke("vscode.enter");
      expect(await screen.findByText("Workspace answer")).toBeDefined();
      expect(f.reveal).toHaveBeenCalledTimes(2);
      await waitFor(() =>
        expect(screen.getByTitle("VS Code workspace").getAttribute("src")).toBe(
          editorLease("a").endpoint,
        ),
      );
    },
  );
  it.each(
    (["browser", "vscode"] as const).flatMap((mode) =>
      (["chat", "todos", "sessions"] as const).map((tab) => ({ mode, tab })),
    ),
  )(
    "$mode shell toggle hides/restores the entire $tab pane without changing mode",
    async ({ mode, tab }) => {
      using f = renderWorkspace(kind, mode, false, true);
      await f.user.click(
        screen.getByRole("button", {
          name: mode === "browser" ? "Browser" : "VS Code",
        }),
      );
      const navigator = f.root.workspaceNavigatorStore;
      act(() => (tab === "chat" ? navigator.showChat() : navigator.show(tab)));
      const workspace = screen.getByRole("region", {
        name: mode === "browser" ? "Browser workspace" : "VS Code workspace",
      });
      const companion = () =>
        screen.queryByRole("complementary", { name: "Current conversation companion" });
      expect(companion()).not.toBeNull();
      expect(document.querySelectorAll('[data-slot="shell-workspace-toggle"]')).toHaveLength(1);
      expect(document.querySelector('[data-slot="header-chat-toggle"]')).toBeNull();
      expect(document.querySelector('[data-slot="header-sidebar-toggle"]')).toBeNull();
      const close = screen.getByRole("button", { name: "Close Workspace" });
      expect(close.getAttribute("aria-expanded")).toBe("true");
      await f.user.click(close);
      expect(companion()).toBeNull();
      expect(f.session.presentationMode).toBe(mode);
      expect(workspace.isConnected).toBe(true);
      const reopen = screen.getByRole("button", { name: "Open Workspace" });
      expect(reopen.getAttribute("aria-expanded")).toBe("false");
      await f.user.click(reopen);
      expect(companion()).not.toBeNull();
      expect(navigator.companionTab).toBe(tab);
      expect(f.session.presentationMode).toBe(mode);
      expect(workspace.isConnected).toBe(true);
    },
  );

  it.each<Mode>(["browser", "vscode"])(
    "%s collapse survives window snapshots and Main keeps its own visibility",
    async (mode) => {
      using f = renderWorkspace(kind, mode, false, true);
      await f.user.click(
        screen.getByRole("button", {
          name: mode === "browser" ? "Browser" : "VS Code",
        }),
      );
      const navigator = f.root.workspaceNavigatorStore;
      act(() => navigator.show("sessions"));
      await f.user.click(screen.getByRole("button", { name: "Close Workspace" }));
      const saved = toSnapshot(f.root);
      using restored = createRendererStoreFixture({
        snapshot: saved,
        projects: [projectRecord({ path: "/project", name: "Project" })],
        sessions: [
          sessionSummary({ sessionId: projectId, projectPath: "/project", title: "Project task" }),
        ],
      });
      // Startup is global, not the saved destination. The old conversation retains its collapse.
      const restoredSession =
        kind === "project"
          ? restored.root.sessionRegistry.load(f.session.sessionId, "/project")
          : restored.root.cakeChatCollectionStore.registry.load(f.session.sessionId);
      expect(restoredSession.workspaceChatSidebarVisible).toBe(false);
      if (kind === "project")
        restored.root.navigationStore.showLoadedProjectSession(f.session.sessionId);
      else restored.root.navigationStore.selectCakeChat(f.session.sessionId);
      restoredSession.showPresentation(mode);
      // Explicit navigation reveals Chat, then the user's close is respected again.
      if (restored.root.workspaceNavigatorStore.paneVisible)
        restored.root.workspaceNavigatorStore.togglePane();
      expect(restored.root.workspaceNavigatorStore.paneVisible).toBe(false);
      expect(restored.root.workspaceNavigatorStore.companionTab).toBe("sessions");
      restored.root.workspaceNavigatorStore.togglePane();
      expect(restored.root.workspaceNavigatorStore.paneVisible).toBe(true);
      expect(restored.root.workspaceNavigatorStore.companionTab).toBe("sessions");

      await f.user.click(screen.getByRole("button", { name: "Main" }));
      expect(
        screen.getByRole("combobox", {
          name: kind === "project" ? "Message" : "Message Project Chat",
        }),
      ).toBeDefined();
      expect(screen.getByRole("complementary", { name: "Workspace" })).toBeDefined();
      await f.user.click(screen.getByRole("button", { name: "Close Workspace" }));
      expect(screen.queryByRole("complementary", { name: "Workspace" })).toBeNull();
      expect(
        screen.getByRole("combobox", {
          name: kind === "project" ? "Message" : "Message Project Chat",
        }),
      ).toBeDefined();
      await f.user.click(screen.getByRole("button", { name: "Open Workspace" }));
      expect(screen.getByRole("complementary", { name: "Workspace" })).toBeDefined();
      expect(f.session.presentationMode).toBe("normal");
      await f.user.click(
        screen.getByRole("button", {
          name: mode === "browser" ? "VS Code" : "Browser",
        }),
      );
      // Every fresh tool-mode entry reveals Chat, including after a manual close.
      expect(navigator.paneVisible).toBe(true);
      expect(navigator.companionTab).toBe("chat");
      expect(
        screen.getByRole("complementary", { name: "Current conversation companion" }),
      ).toBeDefined();
      await f.user.click(screen.getByRole("button", { name: "Close Workspace" }));
      await f.user.click(
        screen.getByRole("button", {
          name: mode === "browser" ? "Browser" : "VS Code",
        }),
      );
      expect(navigator.paneVisible).toBe(true);
      expect(navigator.companionTab).toBe("chat");
      expect(
        screen.getByRole("complementary", { name: "Current conversation companion" }),
      ).toBeDefined();
    },
  );

  it("sizes the companion against the available center, not the desktop width", () => {
    vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockReturnValue(
      new DOMRect(64, 0, 700, 900),
    );
    using f = renderWorkspace(kind, "browser");
    expect(screen.getByRole("main").style.getPropertyValue("--workspace-chat-sidebar-width")).toBe(
      "340px",
    );
    expect(f.session.workspaceChatSidebarWidth).toBe(440);
  });
  it.each<Mode>(["browser", "vscode"])(
    "%s companion retains the same conversation and draft when closed and reopened",
    async (mode) => {
      using f = renderWorkspace(kind, mode);
      const chat = f.session.conversationSessionStore.chatStore;
      const draft = f.session.conversationSessionStore.composerStore.draftStore;
      const sessionId = f.session.sessionId;
      act(() => draft.setText("Continue the same conversation"));
      await f.user.click(screen.getByRole("button", { name: "Close Workspace" }));
      expect(f.session.workspaceChatSidebarVisible).toBe(false);
      expect(f.session.sessionId).toBe(sessionId);
      expect(f.session.conversationSessionStore.chatStore).toBe(chat);
      expect(draft.text).toBe("Continue the same conversation");
      await f.user.click(screen.getByRole("button", { name: "Open Workspace" }));
      expect(f.session.workspaceChatSidebarVisible).toBe(true);
      expect(f.session.conversationSessionStore.chatStore).toBe(chat);
      expect(
        screen.getByRole("combobox", {
          name: kind === "project" ? "Message" : "Message Project Chat",
        }).textContent,
      ).toBe("Continue the same conversation");
    },
  );
  it.each<Mode>(["browser", "vscode"])(
    "%s retains the focused conversation, companion resizing, side chats and workflow slots",
    async (mode) => {
      using f = renderWorkspace(kind, mode);
      const main = screen.getByRole("main");
      const workspace = screen.getByRole("region", {
        name: mode === "browser" ? "Browser workspace" : "VS Code workspace",
      });
      expect(workspace).toBeDefined();
      expect(main.style.getPropertyValue("--workspace-chat-sidebar-width")).toBe("440px");
      expect(
        screen.getByRole("complementary", { name: "Current conversation companion" }),
      ).toBeDefined();
      expect(screen.getByRole("group", { name: "Conversation workspace" })).toBeDefined();
      expect(
        screen.getByText(kind === "project" ? "Project task" : "Project coordinator", {
          selector: "strong",
        }),
      ).toBeDefined();
      expect(
        screen.getByRole("button", {
          name: mode === "browser" ? "VS Code" : "Browser",
        }),
      ).toBeDefined();
      expect(
        screen.getByRole("combobox", {
          name: kind === "project" ? "Message" : "Message Project Chat",
        }),
      ).toBeDefined();
      expect(await screen.findByText("Workspace answer")).toBeDefined();
      expect(screen.getByRole("button", { name: "Ask session assistant" })).toBeDefined();
      expect(
        screen.queryByRole("button", { name: "Fork response with full context into new chat" }) !==
          null,
      ).toBe(kind === "project");
      expect(
        screen.queryByRole("button", { name: "Continue from response in session tree" }) !== null,
      ).toBe(kind === "project");

      fireEvent.keyDown(screen.getByRole("separator", { name: "Resize current session sidebar" }), {
        key: "ArrowLeft",
      });
      expect(main.style.getPropertyValue("--workspace-chat-sidebar-width")).toBe("456px");

      // The selection operation prepares the same real side-chat Store used by the transcript.
      act(() => {
        f.session.messageCommentsStore.prepareDraft({
          messageId: "answer",
          entryId: "entry-answer",
          selectedText: "Workspace",
          startOffset: 0,
          endOffset: 9,
          contextBefore: "",
          contextAfter: " answer",
        });
        f.session.conversationSessionStore.sideChatStore.open({
          key: "selection-draft",
          title: "Side chat",
          eyebrow: () => "Selection",
          chatStore: f.session.messageCommentsStore.draftChatStore,
        });
      });
      expect(screen.getByRole("combobox", { name: "Message about selected text" })).toBeDefined();
      await f.user.click(
        within(screen.getByRole("navigation", { name: "Conversation breadcrumb" })).getByRole(
          "button",
          { name: kind === "project" ? "Project task" : "Project" },
        ),
      );
      expect(
        screen.getByRole("combobox", {
          name: kind === "project" ? "Message" : "Message Project Chat",
        }),
      ).toBeDefined();

      expect(
        screen.getByRole("region", {
          name: mode === "browser" ? "Browser workspace" : "VS Code workspace",
        }),
      ).toBe(workspace);
    },
  );
});
