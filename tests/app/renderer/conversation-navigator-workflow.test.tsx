/** @vitest-environment jsdom */
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StoreProvider } from "r-state-tree/react";
import { applySnapshot } from "r-state-tree";
import { ConversationNavigator } from "../../../src/renderer/components/conversation-navigator";
import { SideChatsMenu } from "../../../src/renderer/components/side-chats-menu";
import { applyConversationUpdate } from "../../../src/renderer/reducers/ConversationReducer";
import { conversationNavigationKey } from "../../../src/renderer/lib/conversation-navigation-tree";
import { applyDiscussionCatalogUpdate } from "../../../src/renderer/reducers/DiscussionReducer";
import { createRendererStoreFixture } from "./renderer-store-fixture";
import { projectRecord } from "./fixtures/catalog-fixtures";
import {
  navigatorHomeId,
  navigatorProjectPath,
  navigatorSessions,
  populateConversationNavigationFixture,
} from "./fixtures/conversation-navigation-fixtures";

beforeEach(() => {
  Object.defineProperty(SVGElement.prototype, "getBBox", {
    configurable: true,
    value: () => ({ x: 0, y: 0, width: 24, height: 24 }),
  });
});
afterEach(() => {
  cleanup();
  Reflect.deleteProperty(SVGElement.prototype, "getBBox");
  vi.unstubAllGlobals();
});

function renderNavigator(projectPath: string | null = navigatorProjectPath, coldSideChat = false) {
  const fixture = createRendererStoreFixture({
    projects: [projectRecord({ path: navigatorProjectPath }), projectRecord({ path: "/other" })],
    sessions: navigatorSessions,
    client: {
      projectSessions: { open: async () => undefined },
      cakeChats: { open: async () => undefined, setUnread: async () => undefined },
      workspaces: {
        loadStagedSlashCommands: async () => [],
        setSessionUnread: async () => {
          throw new Error("Project Chat acknowledgement must not mark a Project Session read");
        },
      },
    },
  });
  const facts = populateConversationNavigationFixture(fixture.models);
  const catalog = fixture.models.discussionCatalog("layout");
  const thread = catalog.threads[0]!;
  const savedThread = {
    id: thread.id,
    parentSessionId: thread.parentSessionId,
    sidecarSessionId: thread.sidecarSessionId,
    workingDirectory: thread.workingDirectory,
    anchor: thread.anchor,
    parts: [],
    status: thread.status,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
  };
  if (coldSideChat) {
    catalog.metadata.push({
      id: savedThread.id,
      parentSessionId: savedThread.parentSessionId,
      sidecarSessionId: savedThread.sidecarSessionId,
      workingDirectory: savedThread.workingDirectory,
      title: "Pane widths",
      running: false,
      status: "open",
      createdAt: savedThread.createdAt,
      updatedAt: savedThread.updatedAt,
    });
    catalog.metadataLoaded = true;
    catalog.threads.splice(0, catalog.threads.length);
  }
  // These are the actual projected facts, not hand-assembled Store/component state.
  for (const session of navigatorSessions) {
    fixture.root.sessionRegistry.load(session.sessionId, session.workingDirectory);
    applyConversationUpdate(
      fixture.models.projectConversation(session.sessionId, session.workingDirectory),
      {
        _tag: "Snapshot",
        revision: 1,
        snapshot: {
          sessionId: session.sessionId,
          sessionFile: `/sessions/${session.sessionId}.jsonl`,
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
      },
    );
  }
  fixture.root.navigationStore.selectCakeChat(navigatorHomeId);
  const view = render(
    <StoreProvider store={fixture.root}>
      <ConversationNavigator projectPath={projectPath ?? undefined} />
      <SideChatsMenu store={{ sessionId: "layout" }} />
    </StoreProvider>,
  );
  return {
    ...fixture,
    ...facts,
    savedThread,
    user: userEvent.setup(),
    [Symbol.dispose]() {
      view.unmount();
      fixture[Symbol.dispose]();
    },
  };
}
function rowFor(name: string) {
  // Project Chat's title is the project name, not its composed status subtitle.
  const row = screen
    .getByText(name === "Project Chat" ? "cake" : name)
    .closest<HTMLElement>('[data-slot="conversation-navigator-row"]');
  if (!row) throw new Error(`Missing conversation row: ${name}`);
  return row;
}

function settleFixtureWorkers(fixture: ReturnType<typeof renderNavigator>) {
  act(() => {
    for (const catalog of fixture.models.subagentCatalogs)
      for (const worker of catalog.activities) {
        worker.status = "complete";
        worker.streaming = false;
      }
  });
}

describe("Sessions navigator workflow", () => {
  it.each(
    (["normal", "vscode", "browser"] as const).flatMap((mode) =>
      (["project-session", "cake-chat"] as const).flatMap((kind) =>
        [true, false].map((same) => ({ mode, kind, same })),
      ),
    ),
  )("reveals Chat for $kind in $mode (same selection: $same)", async ({ mode, kind, same }) => {
    using fixture = renderNavigator();
    const root = fixture.root;
    // Native tool restoration is covered in Electron; this test owns row routing/state.
    vi.spyOn(root.projectWorkbenchStore.presentationStore, "restore").mockImplementation(() => {});
    const target =
      kind === "project-session"
        ? ({ kind, sessionId: "layout" } as const)
        : ({ kind, sessionId: navigatorHomeId } as const);
    await act(async () => {
      await root.navigationStore.openConversationTarget(
        same ? target : { kind: "project-session", sessionId: "keyboard" },
      );
    });
    const session =
      kind === "project-session"
        ? root.sessionRegistry.findSession(target.sessionId)!
        : root.cakeChatCollectionStore.registry.load(target.sessionId);
    act(() => {
      session.showPresentation(mode);
      session.conversationSessionStore.composerStore.draftStore.setText("Keep this draft");
      root.workspaceNavigatorStore.show("sessions");
    });
    const draft = session.conversationSessionStore.composerStore.draftStore;
    const revision = draft.focusRequestRevision;
    await fixture.user.click(
      within(rowFor(kind === "project-session" ? "UI Layout Refactor" : "Project Chat")).getByRole(
        "button",
        { name: kind === "project-session" ? /^UI Layout Refactor/ : "cake" },
      ),
    );
    await waitFor(() => {
      expect(root.appShellStore.activeConversation).toEqual(target);
      expect(root.workspaceNavigatorStore.companionTab).toBe("chat");
      expect(draft.focusRequestRevision).toBeGreaterThan(revision);
      expect(draft.focusRequestIsExplicit).toBe(true);
    });
    expect(draft.text).toBe("Keep this draft");
    expect(session.presentationMode).toBe(mode);
    expect(root.workspaceNavigatorStore.mode).toBe("sessions");
  });

  it.each(["filtered global", "resolved"] as const)(
    "reveals Chat through the %s Sessions entry path",
    async (path) => {
      using fixture = renderNavigator(path === "filtered global" ? null : navigatorProjectPath);
      const root = fixture.root;
      if (path === "resolved") {
        act(() => {
          fixture.models.sessionCatalog.find("layout")!.resolved = true;
        });
        await fixture.user.click(screen.getByRole("button", { name: "Resolved sessions" }));
      } else {
        await fixture.user.type(
          screen.getByRole("searchbox", { name: "Search sessions" }),
          "UI Layout Refactor",
        );
      }
      act(() => root.workspaceNavigatorStore.show("sessions"));
      await fixture.user.click(screen.getByRole("button", { name: /^UI Layout Refactor/ }));
      await waitFor(() => {
        expect(root.appShellStore.activeConversation?.sessionId).toBe("layout");
        expect(root.workspaceNavigatorStore.companionTab).toBe("chat");
        expect(
          root.sessionRegistry.findSession("layout")!.conversationSessionStore.composerStore
            .draftStore.focusRequestIsExplicit,
        ).toBe(true);
      });
    },
  );

  it("keeps a later Sessions tab choice while the selected session finishes opening", async () => {
    using fixture = renderNavigator();
    const root = fixture.root;
    await act(async () => {
      await root.navigationStore.openSession("layout");
    });
    let finishOpen!: () => void;
    vi.spyOn(fixture.client.projectSessions, "open").mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishOpen = resolve;
        }),
    );
    const draft =
      root.sessionRegistry.findSession("keyboard")!.conversationSessionStore.composerStore
        .draftStore;
    let opening!: Promise<void>;
    act(() => {
      root.workspaceNavigatorStore.show("sessions");
      opening = root.navigationStore.openSessionFromNavigator({
        kind: "project-session",
        sessionId: "keyboard",
      });
    });
    await waitFor(() => {
      expect(root.appShellStore.activeConversation?.sessionId).toBe("keyboard");
      expect(finishOpen).toBeTypeOf("function");
    });
    act(() => root.workspaceNavigatorStore.show("sessions"));
    const revision = draft.focusRequestRevision;
    await act(async () => {
      finishOpen();
      await opening;
    });
    expect(root.workspaceNavigatorStore.companionTab).toBe("sessions");
    expect(draft.focusRequestRevision).toBe(revision);
  });

  it.each(["normal", "vscode", "browser"] as const)(
    "retains the chosen tab on ordinary same-conversation navigation in %s",
    async (mode) => {
      using fixture = renderNavigator();
      const root = fixture.root;
      await act(async () => {
        await root.navigationStore.openSession("layout");
      });
      vi.spyOn(root.projectWorkbenchStore.presentationStore, "restore").mockImplementation(
        () => {},
      );
      act(() => {
        root.sessionRegistry.findSession("layout")!.showPresentation(mode);
        root.workspaceNavigatorStore.show("sessions");
      });
      await act(async () => {
        await root.navigationStore.openConversationTarget({
          kind: "project-session",
          sessionId: "layout",
        });
      });
      expect(root.workspaceNavigatorStore.companionTab).toBe("sessions");
    },
  );

  it("hides only the Project Chat grouping rail without changing indentation or family rails", async () => {
    using fixture = renderNavigator();
    expect(rowFor("Project Chat").querySelector('[data-slot="depth-rails"]')).toBeNull();
    const assertRails = () => {
      for (const [name, depth] of [
        ["UI Layout Refactor", 1],
        ["Icon Placement Exploration", 1],
        ["Keyboard Editing & Navigation", 2],
        ["Nested child implementation", 3],
      ] as const) {
        const row = rowFor(name);
        const rails = row.querySelector<HTMLElement>('[data-slot="depth-rails"]')!;
        expect(row.dataset.depth).toBe(String(depth));
        expect(rails.parentElement!.style.width).toBe(`${depth * 6}px`);
        // Suppress only the first ancestor's border, not its width or deeper connectors.
        expect(rails.classList.contains("[&>span:first-child]:border-l-0")).toBe(true);
        expect(rails.children).toHaveLength(depth);
        for (const rail of rails.children) expect(rail.classList.contains("border-l")).toBe(true);
      }
    };
    assertRails();
    await fixture.user.click(screen.getByRole("button", { name: "Collapse cake" }));
    expect(screen.queryByText("UI Layout Refactor")).toBeNull();
    await fixture.user.click(screen.getByRole("button", { name: "Expand cake" }));
    assertRails();
    await fixture.user.click(screen.getByRole("button", { name: "Collapse UI Layout Refactor" }));
    expect(screen.queryByText("Keyboard Editing & Navigation")).toBeNull();
    await fixture.user.click(screen.getByRole("button", { name: "Expand UI Layout Refactor" }));
    assertRails();
  });

  it("preserves resolved Project Session connectors where there is no Project Chat ancestor", async () => {
    using fixture = renderNavigator();
    act(() => {
      for (const id of ["layout", "keyboard", "deep-child"])
        fixture.models.sessionCatalog.find(id)!.resolved = true;
    });
    await fixture.user.click(screen.getByRole("button", { name: "Resolved sessions" }));
    expect(rowFor("UI Layout Refactor").dataset.depth).toBe("0");
    for (const [name, depth] of [
      ["Keyboard Editing & Navigation", 1],
      ["Nested child implementation", 2],
    ] as const) {
      const row = rowFor(name);
      const rails = row.querySelector<HTMLElement>('[data-slot="depth-rails"]')!;
      expect(row.dataset.depth).toBe(String(depth));
      expect(rails.parentElement!.style.width).toBe(`${depth * 6}px`);
      expect(rails.classList.contains("[&>span:first-child]:border-l-0")).toBe(false);
      expect(rails.children).toHaveLength(depth);
      for (const rail of rails.children) expect(rail.classList.contains("border-l")).toBe(true);
    }
  });

  it("shows metadata without type prefixes for home, session, child and grandchild rows", () => {
    using fixture = renderNavigator();
    settleFixtureWorkers(fixture);
    const region = screen.getByRole("region", { name: "Sessions" });
    for (const label of ["Project Chat", "Session", "Child session"])
      expect(within(region).queryByText(label, { exact: true })).toBeNull();
    for (const [title, depth, relationship] of [
      ["UI Layout Refactor", "1", "grouped"],
      ["Keyboard Editing & Navigation", "2", "family-child"],
      ["Nested child implementation", "3", "family-child"],
    ] as const) {
      const row = rowFor(title);
      const description = row.querySelector('[data-slot="session-description"]')!;
      expect(description.textContent).toBe(row.querySelector("time")!.textContent);
      expect(description.textContent).not.toBe("");
      expect(row.dataset.depth).toBe(depth);
      expect(row.dataset.relationship).toBe(relationship);
      expect(within(row).getByLabelText("Idle")).toBeTruthy();
    }
    expect(rowFor("Project Chat").textContent).not.toContain("·");
    expect(within(rowFor("Project Chat")).getByLabelText("Idle")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Collapse UI Layout Refactor" })).toBeTruthy();
  });

  it.each([
    ["own", "layout"],
    ["child", "keyboard"],
    ["grandchild", "deep-child"],
    ["all idle", undefined],
  ] as const)("derives %s working identically when expanded and collapsed", async (_, activeId) => {
    using fixture = renderNavigator();
    settleFixtureWorkers(fixture);
    if (activeId)
      act(() => {
        fixture.models.sessionCatalog.find(activeId)!.running = true;
      });
    const assertStatus = (names = ["UI Layout Refactor", "Project Chat"]) => {
      const store = fixture.root.conversationNavigatorStore;
      const parent = store
        .tree(navigatorProjectPath)
        .byKey.get(conversationNavigationKey("layout"))!;
      expect(store.effectiveWorking(parent)).toBe(Boolean(activeId));
      for (const name of names) {
        const row = rowFor(name);
        expect(row.dataset.working).toBe(String(Boolean(activeId)));
        expect(within(row).queryByRole("img", { name: "Running" }) !== null).toBe(
          Boolean(activeId),
        );
        if (!activeId) expect(within(row).getByLabelText("Idle")).toBeTruthy();
      }
      expect(screen.queryByLabelText(/running descendants/)).toBeNull();
      expect(screen.queryByText(/↓\d+/)).toBeNull();
    };
    assertStatus();
    await fixture.user.click(screen.getByRole("button", { name: "Collapse UI Layout Refactor" }));
    assertStatus();
    await fixture.user.click(screen.getByRole("button", { name: "Collapse cake" }));
    expect(screen.queryByText("UI Layout Refactor")).toBeNull();
    assertStatus(["Project Chat"]);
    await fixture.user.click(screen.getByRole("button", { name: "Expand cake" }));
    await fixture.user.click(screen.getByRole("button", { name: "Expand UI Layout Refactor" }));
    assertStatus();
    if (activeId) {
      act(() => {
        fixture.models.sessionCatalog.find(activeId)!.running = false;
      });
      expect(rowFor("UI Layout Refactor").dataset.working).toBe("false");
      expect(within(rowFor("UI Layout Refactor")).getByLabelText("Idle")).toBeTruthy();
      expect(within(rowFor("Project Chat")).getByLabelText("Idle")).toBeTruthy();
    }
  });

  it.each(["unread", "error", "stopped", "blocked", "complete"] as const)(
    "keeps descendant %s independent of an idle parent",
    async (status) => {
      using fixture = renderNavigator();
      settleFixtureWorkers(fixture);
      act(() => {
        const child = fixture.models.sessionCatalog.find("deep-child")!;
        child.unread = status === "unread";
        child.latestTurnOutcome =
          status === "error"
            ? "failed"
            : status === "stopped"
              ? "aborted"
              : status === "complete"
                ? "complete"
                : undefined;
        if (status === "blocked") child.recoveryIssue = "Needs recovery";
      });
      const childLabel =
        status === "unread"
          ? "Ready, unread"
          : status === "error"
            ? "Error"
            : status === "blocked"
              ? "Needs your input"
              : undefined;
      if (childLabel)
        expect(
          within(rowFor("Nested child implementation")).getByRole("img", { name: childLabel }),
        ).toBeTruthy();
      const parent = fixture.models.sessionCatalog.find("layout")!;
      const assertIdle = () => {
        expect(rowFor("UI Layout Refactor").dataset.working).toBe("false");
        expect(within(rowFor("UI Layout Refactor")).getByLabelText("Idle")).toBeTruthy();
        expect(within(rowFor("Project Chat")).getByLabelText("Idle")).toBeTruthy();
        expect(
          fixture.root.sidebarStore.sessionListStore.sessionActivityForDisplay(parent),
        ).toBeUndefined();
        expect(
          fixture.root.sidebarStore.sessionListStore.projectActivityForDisplay(
            navigatorProjectPath,
          ),
        ).toBeUndefined();
        expect(parent.unread).toBe(false);
      };
      assertIdle();
      await fixture.user.click(screen.getByRole("button", { name: "Collapse UI Layout Refactor" }));
      assertIdle();
    },
  );

  it.each([false, true])(
    "reads Project Chat independently of unread descendants (collapsed: %s)",
    async (collapsed) => {
      using fixture = renderNavigator();
      settleFixtureWorkers(fixture);
      await fixture.user.click(screen.getByRole("button", { name: /^Icon Placement Exploration/ }));
      const setUnread = vi
        .spyOn(fixture.client.cakeChats, "setUnread")
        .mockImplementation(async ({ sessionId, unread }) => {
          act(() => {
            fixture.models.cakeChatCatalog.sessions.find(
              (chat) => chat.sessionId === sessionId,
            )!.unread = unread;
          });
        });
      const setSessionUnread = vi.spyOn(fixture.client.workspaces, "setSessionUnread");
      act(() => {
        fixture.models.cakeChatCatalog.sessions.find(
          (chat) => chat.sessionId === navigatorHomeId,
        )!.unread = true;
        for (const id of ["layout", "keyboard", "deep-child"]) {
          const session = fixture.models.sessionCatalog.find(id)!;
          session.unread = true;
          session.latestTurnOutcome = "complete";
        }
      });
      if (collapsed)
        await fixture.user.click(screen.getByRole("button", { name: "Collapse cake" }));
      expect(
        within(rowFor("Project Chat")).getByRole("img", { name: "Ready, unread" }),
      ).toBeTruthy();
      await fixture.user.click(screen.getByRole("button", { name: "cake" }));
      await waitFor(() =>
        expect(within(rowFor("Project Chat")).getByLabelText("Idle")).toBeTruthy(),
      );
      // Selection and open each acknowledge the owner before the catalog reply arrives.
      expect(setUnread.mock.calls.map(([input]) => input)).toEqual([
        { sessionId: navigatorHomeId, unread: false },
        { sessionId: navigatorHomeId, unread: false },
      ]);
      expect(setSessionUnread).not.toHaveBeenCalled();
      for (const id of ["layout", "keyboard", "deep-child"])
        expect(fixture.models.sessionCatalog.find(id)!.unread).toBe(true);
      if (collapsed) {
        // Opening reveals the selected row; collapse it again to check the read state hidden.
        await fixture.user.click(screen.getByRole("button", { name: "Collapse cake" }));
        expect(within(rowFor("Project Chat")).getByLabelText("Idle")).toBeTruthy();
        await fixture.user.click(screen.getByRole("button", { name: "Expand cake" }));
      }
      for (const name of [
        "UI Layout Refactor",
        "Keyboard Editing & Navigation",
        "Nested child implementation",
      ])
        expect(within(rowFor(name)).getByRole("img", { name: "Ready, unread" })).toBeTruthy();
      expect(within(rowFor("Project Chat")).getByLabelText("Idle")).toBeTruthy();
    },
  );

  it("preserves a parent's own unread indication and data while descendants work", async () => {
    using fixture = renderNavigator();
    settleFixtureWorkers(fixture);
    const parent = fixture.models.sessionCatalog.find("layout")!;
    act(() => {
      parent.unread = true;
      parent.latestTurnOutcome = "complete";
      fixture.models.cakeChatCatalog.sessions.find(
        (chat) => chat.sessionId === navigatorHomeId,
      )!.unread = true;
      fixture.models.sessionCatalog.find("deep-child")!.running = true;
    });
    const assertUnread = () => {
      expect(parent.unread).toBe(true);
      expect(fixture.root.sidebarStore.sessionListStore.sessionActivityForDisplay(parent)).toBe(
        "unread",
      );
      for (const name of ["UI Layout Refactor", "Project Chat"]) {
        expect(rowFor(name).dataset.working).toBe("true");
        expect(within(rowFor(name)).getByRole("img", { name: "Ready, unread" })).toBeTruthy();
      }
    };
    assertUnread();
    await fixture.user.click(screen.getByRole("button", { name: "Collapse UI Layout Refactor" }));
    assertUnread();
    act(() => {
      fixture.models.sessionCatalog.find("deep-child")!.running = false;
    });
    expect(parent.unread).toBe(true);
    expect(
      within(rowFor("UI Layout Refactor")).getByRole("img", { name: "Ready, unread" }),
    ).toBeTruthy();
  });

  it("renders a dense recursive source-list and inherits working through collapsed family edges", async () => {
    using fixture = renderNavigator();
    expect(rowFor("UI Layout Refactor").dataset.relationship).toBe("grouped");
    expect(rowFor("Keyboard Editing & Navigation").dataset.relationship).toBe("family-child");
    expect(rowFor("Nested child implementation").dataset.depth).toBe("3");
    expect(
      within(screen.getByRole("region", { name: "Sessions" })).queryByText("Pane widths"),
    ).toBeNull();
    await fixture.user.click(screen.getByRole("button", { name: "Side chats, 1 open" }));
    const menu = within(screen.getByRole("dialog", { name: "Open side chats" }));
    expect(menu.getAllByRole("heading").map((heading) => heading.textContent)).toEqual([
      "Side chats",
    ]);
    expect(menu.queryByText(/resolved|history/i)).toBeNull();
    expect(menu.getAllByRole("button").map((button) => button.getAttribute("aria-label"))).toEqual([
      "Pane widths",
    ]);
    expect(menu.queryByText("Shortcut review")).toBeNull();
    await fixture.user.keyboard("{Escape}");
    await fixture.user.click(screen.getByRole("button", { name: "Collapse UI Layout Refactor" }));
    expect(screen.queryByRole("button", { name: /^Nested child implementation/ })).toBeNull();
    act(() => {
      fixture.models.sessionCatalog.find("deep-child")!.running = true;
    });
    expect(within(rowFor("UI Layout Refactor")).getByRole("img", { name: "Running" })).toBeTruthy();
    expect(within(rowFor("Project Chat")).getByRole("img", { name: "Running" })).toBeTruthy();
    expect(screen.queryByLabelText(/running descendants/)).toBeNull();
    expect(screen.queryByText(/↓\d+/)).toBeNull();
    // Authority updates still propagate while the branch is closed.
    act(() => {
      fixture.models.sessionCatalog.find("keyboard")!.running = true;
    });
    expect(within(rowFor("UI Layout Refactor")).getByRole("img", { name: "Running" })).toBeTruthy();
  });

  it.each(["button", "Escape"] as const)(
    "preserves matching ancestors during search and restores prior disclosure on %s",
    async (clear) => {
      using fixture = renderNavigator();
      await fixture.user.click(screen.getByRole("button", { name: "Collapse UI Layout Refactor" }));
      await fixture.user.type(
        screen.getByRole("searchbox", { name: "Search sessions" }),
        "Nested child implementation",
      );
      expect(screen.getByRole("button", { name: /^Nested child implementation/ })).toBeTruthy();
      expect(rowFor("cake")).toBeTruthy();
      expect(rowFor("UI Layout Refactor")).toBeTruthy();
      expect(rowFor("Keyboard Editing & Navigation")).toBeTruthy();
      expect(rowFor("Nested child implementation")).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Icon Placement Exploration" })).toBeNull();
      if (clear === "button")
        await fixture.user.click(screen.getByRole("button", { name: "Clear search sessions" }));
      else await fixture.user.keyboard("{Escape}");
      expect(screen.getByRole("searchbox", { name: "Search sessions" })).toHaveProperty(
        "value",
        "",
      );
      expect(
        screen
          .getByRole("button", { name: "Expand UI Layout Refactor" })
          .getAttribute("aria-expanded"),
      ).toBe("false");
      expect(screen.queryByRole("button", { name: /^Nested child implementation/ })).toBeNull();
      expect(rowFor("Icon Placement Exploration")).toBeTruthy();
    },
  );

  it("retains a cold Side chat selection until its full catalog arrives, without a second click", async () => {
    using fixture = renderNavigator(navigatorProjectPath, true);
    const catalog = fixture.models.discussionCatalog("layout");
    expect(catalog.threads).toHaveLength(0);
    await fixture.user.click(screen.getByRole("button", { name: "Side chats, 1 open" }));
    await fixture.user.click(screen.getByRole("button", { name: "Pane widths" }));
    await waitFor(() =>
      expect(fixture.root.appShellStore.activeConversation?.sessionId).toBe("layout"),
    );
    expect(
      fixture.root.workspaceSession?.conversationSessionStore.sideChatStore.target,
    ).toBeUndefined();
    act(() =>
      applyDiscussionCatalogUpdate(catalog, "layout", {
        _tag: "Snapshot",
        revision: 2,
        parentSessionId: "layout",
        threads: [fixture.savedThread],
      }),
    );
    await waitFor(() =>
      expect(
        fixture.root.workspaceSession?.conversationSessionStore.sideChatStore.target?.key,
      ).toBe("discussion:widths"),
    );
    expect(rowFor("UI Layout Refactor").dataset.navigationActive).toBe("true");
    expect(
      fixture.root.conversationNavigatorStore.lineageFor("layout").map((node) => node.title),
    ).toEqual(["cake", "UI Layout Refactor"]);
  });

  it("retains resolved Session titles and family ancestry in breadcrumbs without adding them to active lists", () => {
    using fixture = renderNavigator();
    act(() =>
      applySnapshot(fixture.models.sessionCatalog, {
        sessions: navigatorSessions.map((session) => ({ ...session, resolved: true })),
        resolvedHasMoreByProject: {},
      }),
    );
    expect(
      fixture.root.conversationNavigatorStore
        .lineageFor("deep-child")
        .map((node) => node.target.sessionId),
    ).toEqual([navigatorHomeId, "layout", "keyboard", "deep-child"]);
    expect(
      fixture.root.conversationNavigatorStore
        .tree(navigatorProjectPath)
        .byKey.has(conversationNavigationKey("deep-child")),
    ).toBe(false);
  });

  it("opens a real child Session and reveals its selected ancestry after an external deep link", async () => {
    using fixture = renderNavigator();
    await fixture.user.click(screen.getByRole("button", { name: /^Nested child implementation/ }));
    await waitFor(() =>
      expect(rowFor("Nested child implementation").dataset.navigationActive).toBe("true"),
    );
    expect(fixture.root.appShellStore.activeConversation?.sessionId).toBe("deep-child");
    expect(
      fixture.root.conversationNavigatorStore
        .lineageFor("deep-child")
        .map((node) => node.target.sessionId),
    ).toEqual([navigatorHomeId, "layout", "keyboard", "deep-child"]);
    await fixture.user.click(screen.getByRole("button", { name: "Collapse UI Layout Refactor" }));
    await fixture.user.click(screen.getByRole("button", { name: /^Icon Placement Exploration/ }));
    await waitFor(() =>
      expect(rowFor("Icon Placement Exploration").dataset.navigationActive).toBe("true"),
    );
    // Same authoritative app-deep-link entry point used by session links/notifications.
    await act(async () => {
      await fixture.root.navigationStore.openSessionLink("deep-child");
    });
    expect(rowFor("Nested child implementation").dataset.navigationActive).toBe("true");
    expect(
      screen
        .getByRole("button", { name: "Collapse UI Layout Refactor" })
        .getAttribute("aria-expanded"),
    ).toBe("true");
    expect(rowFor("Nested child implementation").dataset.conversationKey).toBe(
      conversationNavigationKey("deep-child"),
    );
  });
});
