/** @vitest-environment jsdom */
import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Client } from "../../../src/renderer/client/Client";
import { defaultApplicationState } from "../../../src/contracts/application/application-data";
import { TurnId } from "../../../src/contracts/conversations/conversation-data";
import type { WorktreeRecord } from "../../../src/contracts/worktrees/managed-worktree-data";
import { projectRecord } from "./fixtures/catalog-fixtures";
import { fakeSavedDrafts } from "./fakes/saved-drafts";
import {
  renderSidebarNavigation,
  sidebarFamily,
  sidebarSummary,
} from "./sidebar-navigation-fixture";

beforeEach(() => {
  vi.stubGlobal("PointerEvent", MouseEvent);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  Object.defineProperty(SVGElement.prototype, "getBBox", {
    configurable: true,
    value: () => ({ x: 0, y: 0, width: 24, height: 24 }),
  });
  vi.stubGlobal("matchMedia", (query: string): MediaQueryList => ({
    media: query,
    matches: query === "(prefers-reduced-motion: reduce)",
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent: () => true,
  }));
});
afterEach(() => {
  cleanup();
  Reflect.deleteProperty(SVGElement.prototype, "getBBox");
  vi.unstubAllGlobals();
});

const project = projectRecord({ path: "/cake" });
const rowButton = (id: string) => screen.getByRole("button", { name: new RegExp(`^${id}(?: |$)`) });
const row = (id: string) => rowButton(id).closest<HTMLElement>(".session-item")!;
const order = (container: HTMLElement = document.body) =>
  [...container.querySelectorAll<HTMLElement>(".session-item")].map(
    (element) => element.dataset.sessionId,
  );
const projectGroup = (name: string) =>
  screen
    .getByRole("button", { name: `Open Project Chat for ${name}` })
    .closest<HTMLElement>('[data-slot="project-group"]')!;
const resolvedGroup = (name: string) =>
  screen
    .getAllByRole("button", { name: `Collapse ${name} resolved` })[0]!
    .closest<HTMLElement>('[data-slot="project-group"]')!;

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

describe("Sidebar navigation workflow", () => {
  it.each(["projects", "activity"] as const)(
    "opens on primary down before release and retains keyboard activation in %s",
    async (mode) => {
      const sessions = [sidebarSummary("first"), sidebarSummary("second", 2)];
      using fixture = renderSidebarNavigation({
        projects: [project],
        sessions,
        loadedIds: ["first", "second"],
        client: { projectSessions: { open: async () => undefined } },
      });
      if (mode === "activity")
        await fixture.user.click(screen.getByRole("button", { name: "Show activity" }));
      const paneId = () =>
        document.querySelector('[data-slot="session-pane"]')?.getAttribute("data-session-id");
      await fixture.user.pointer({ target: rowButton("first"), keys: "[MouseLeft>]" });
      await waitFor(() => expect(paneId()).toBe("first"));
      expect(row("first").getAttribute("data-navigation-active")).toBe("true");
      await fixture.user.pointer({ keys: "[/MouseLeft]" });
      expect(paneId()).toBe("first");
      rowButton("second").focus();
      await fixture.user.keyboard("{Enter}");
      await waitFor(() => expect(paneId()).toBe("second"));
      rowButton("first").focus();
      await fixture.user.keyboard(" ");
      await waitFor(() => expect(paneId()).toBe("first"));
    },
  );

  it.each(["New chat in pi"])(
    "starts an unsent conversation in the inactive project through %s",
    async (control) => {
      const inspect = vi.fn<Client["workspaces"]["inspect"]>(async (request) => ({
        ...request,
        trustRequired: false,
      }));
      const start = vi.fn<Client["projectSessions"]["start"]>();
      using fixture = renderSidebarNavigation({
        projects: [project, projectRecord({ path: "/pi" })],
        sessions: [sidebarSummary("current")],
        loadedIds: ["current"],
        client: {
          workspaces: {
            inspect,
            registerProject: async () => defaultApplicationState(),
            loadStagedSlashCommands: async () => [],
          },
          projectSessions: { start },
          managedWorktrees: { landing: async () => ({}) },
        },
      });
      await fixture.user.click(screen.getByRole("button", { name: control }));
      expect(await screen.findByRole("combobox", { name: "Message" })).toBeDefined();
      expect(inspect).toHaveBeenCalledWith(
        expect.objectContaining({ path: "/pi" }),
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
      expect(start).not.toHaveBeenCalled();
    },
  );

  it("changes visible order by label and date without changing the stable project order", async () => {
    const labelled = projectRecord({
      path: "/cake",
      workflow: {
        labels: [{ id: "10000000-0000-4000-8000-000000000001", name: "Feature", color: "blue" }],
        assignments: [{ sessionId: "older", labelIds: ["10000000-0000-4000-8000-000000000001"] }],
        sessionDetails: [],
      },
    });
    using fixture = renderSidebarNavigation({
      projects: [labelled, projectRecord({ path: "/pi" })],
      sessions: [sidebarSummary("newer", 3), sidebarSummary("older", 1)],
      snapshot: {
        state: {},
        children: {
          projectCatalogStore: { state: { projectOrder: ["/pi", "/cake"] }, children: {} },
        },
      },
    });
    const projectOrder = () =>
      screen
        .getAllByRole("button", { name: /^Open Project Chat for/ })
        .map((button) => button.textContent);
    expect(projectOrder()).toEqual(["pi", "cake"]);
    expect(order()).toEqual(["newer", "older"]);
    await fixture.user.click(screen.getByRole("button", { name: "Sort sessions in cake" }));
    await fixture.user.click(screen.getByRole("menuitemradio", { name: "By label" }));
    expect(order()).toEqual(["older", "newer"]);
    await fixture.user.click(screen.getByRole("button", { name: "Sort sessions in cake" }));
    expect(
      screen.getByRole("menuitemradio", { name: "By label" }).getAttribute("aria-checked"),
    ).toBe("true");
    await fixture.user.click(screen.getByRole("menuitemradio", { name: "By date" }));
    expect(order()).toEqual(["newer", "older"]);
    await fixture.publishSessions([sidebarSummary("newer", 3), sidebarSummary("older", 5)]);
    expect(order()).toEqual(["older", "newer"]);
    expect(projectOrder()).toEqual(["pi", "cake"]);
  });

  it("routes rename, unread and resolved deletion from native menu responses into services and authoritative rows", async () => {
    const menu = vi
      .fn<Client["electron"]["showSessionContextMenu"]>()
      .mockResolvedValueOnce({ action: "rename" })
      .mockResolvedValueOnce({ action: "mark-unread" })
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ action: "delete" });
    const rename = vi.fn<Client["projectSessions"]["rename"]>(async () => undefined);
    const setSessionUnread = vi.fn<Client["workspaces"]["setSessionUnread"]>(async () =>
      defaultApplicationState(),
    );
    const deleteSession = vi.fn<Client["workspaces"]["deleteSession"]>(async () =>
      defaultApplicationState(),
    );
    const initial = [sidebarSummary("original"), sidebarSummary("archive", 2, { resolved: true })];
    using fixture = renderSidebarNavigation({
      projects: [project],
      sessions: initial,
      client: {
        electron: { showSessionContextMenu: menu },
        projectSessions: { rename },
        workspaces: { setSessionUnread, deleteSession },
      },
    });
    const context = (target: HTMLElement) => fixture.user.pointer({ target, keys: "[MouseRight]" });
    await context(rowButton("original"));
    const input = await screen.findByRole("textbox", { name: "Session name" });
    expect(input).toHaveProperty("value", "original");
    await fixture.user.clear(input);
    await fixture.user.type(input, "Renamed work{Enter}");
    await waitFor(() =>
      expect(rename).toHaveBeenCalledWith(
        { sessionId: "original", name: "Renamed work" },
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      ),
    );
    const renamed = { ...initial[0]!, title: "Renamed work" };
    await fixture.publishSessions([renamed, initial[1]!]);
    await context(screen.getByRole("button", { name: /^Renamed work / }));
    await waitFor(() =>
      expect(setSessionUnread).toHaveBeenCalledWith(
        "original",
        true,
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      ),
    );
    await fixture.publishSessions([{ ...renamed, unread: true }, initial[1]!]);
    const unreadRow = screen
      .getByRole("button", { name: /^Renamed work / })
      .closest<HTMLElement>(".session-item")!;
    expect(within(unreadRow).getByRole("img", { name: "Ready, unread" })).toBeDefined();
    expect(within(unreadRow).getByRole("button", { name: "Resolve Renamed work" })).toBeDefined();
    expect(unreadRow.querySelector("time")?.dateTime).toBe(renamed.modifiedAt);
    await context(screen.getByRole("button", { name: /^Renamed work / }));
    await waitFor(() =>
      expect(menu).toHaveBeenLastCalledWith(
        expect.objectContaining({ sessionId: "original", unread: true, resolved: false }),
      ),
    );
    expect(setSessionUnread).toHaveBeenCalledTimes(1);
    await fixture.user.click(screen.getByRole("button", { name: "Expand Resolved" }));
    await fixture.user.click(screen.getAllByRole("button", { name: "Expand cake resolved" })[0]!);
    await context(rowButton("archive"));
    await waitFor(() =>
      expect(deleteSession).toHaveBeenCalledWith(
        "archive",
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      ),
    );
    expect(menu).toHaveBeenLastCalledWith(
      expect.objectContaining({ sessionId: "archive", resolved: true, draft: false }),
    );
    await fixture.publishSessions([{ ...renamed, unread: true }]);
    expect(screen.queryByRole("button", { name: /^archive / })).toBeNull();
  });

  it("opens project settings from both actions and blocks project removal until the service completes", async () => {
    const menu = vi
      .fn<Client["electron"]["showProjectContextMenu"]>()
      .mockResolvedValueOnce("settings")
      .mockResolvedValueOnce("remove-project");
    const pending = deferred<Awaited<ReturnType<Client["workspaces"]["removeProject"]>>>();
    const removeProject = vi.fn<Client["workspaces"]["removeProject"]>(() => pending.promise);
    using fixture = renderSidebarNavigation({
      projects: [project],
      sessions: [sidebarSummary("kept")],
      client: { electron: { showProjectContextMenu: menu }, workspaces: { removeProject } },
    });
    await fixture.user.click(screen.getByRole("button", { name: "Open settings for cake" }));
    expect(screen.getByRole("dialog", { name: "cake settings" })).toBeDefined();
    await fixture.user.click(screen.getByRole("button", { name: "Cancel" }));
    await fixture.user.pointer({
      target: screen.getByRole("button", { name: "Open Project Chat for cake" }),
      keys: "[MouseRight]",
    });
    expect(await screen.findByRole("dialog", { name: "cake settings" })).toBeDefined();
    await fixture.user.click(screen.getByRole("button", { name: "Cancel" }));
    await fixture.user.pointer({
      target: screen.getByRole("button", { name: "Open Project Chat for cake" }),
      keys: "[MouseRight]",
    });
    const dialog = await screen.findByRole("alertdialog", { name: "Remove cake?" });
    expect(within(dialog).getByText(/its 1 session/)).toBeDefined();
    await fixture.user.click(
      within(dialog).getByRole("button", { name: "Remove and delete sessions" }),
    );
    expect(removeProject).toHaveBeenCalledWith(
      "/cake",
      true,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toHaveProperty("disabled", true);
    expect(within(dialog).getByText("Removing project")).toBeDefined();
    await fixture.user.keyboard("{Escape}");
    expect(screen.getByRole("alertdialog")).toBe(dialog);
    await act(async () => pending.resolve(defaultApplicationState()));
    await fixture.publishProjects([]);
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(screen.getByText("Add a folder to start a project.")).toBeDefined();
  });

  it("keeps cleanup confirmation blocking while main deletes resolved worktrees", async () => {
    const pending =
      deferred<Awaited<ReturnType<Client["managedWorktrees"]["discardResolvedForProject"]>>>();
    const discard = vi.fn<Client["managedWorktrees"]["discardResolvedForProject"]>(
      () => pending.promise,
    );
    using fixture = renderSidebarNavigation({
      projects: [project],
      sessions: [sidebarSummary("archive", 1, { resolved: true, workingDirectory: "/worktree" })],
      worktrees: [
        {
          projectPath: "/cake",
          worktreePath: "/worktree",
          branch: "agent/done",
          baseBranch: "main",
          state: "landed",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ],
      client: {
        electron: { showProjectContextMenu: async () => "delete-resolved-worktrees" },
        managedWorktrees: {
          inspectResolvedForProject: async () => ({
            projectPath: "/cake",
            workingDirectories: ["/worktree"],
          }),
          discardResolvedForProject: discard,
        },
        terminals: {
          workingDirectoryStatus: async () => ({ runningProgramCount: 0 }),
          closeWorkingDirectory: async () => undefined,
        },
      },
    });
    await fixture.user.pointer({
      target: screen.getByRole("button", { name: "Open Project Chat for cake" }),
      keys: "[MouseRight]",
    });
    const dialog = await screen.findByRole("alertdialog", { name: "Delete resolved worktrees?" });
    expect(within(dialog).getByText(/1 landed worktree/)).toBeDefined();
    await fixture.user.click(within(dialog).getByRole("button", { name: "Delete worktrees" }));
    await waitFor(() => expect(discard).toHaveBeenCalled());
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toHaveProperty("disabled", true);
    expect(within(dialog).getByRole("button", { name: "Delete worktrees" })).toHaveProperty(
      "disabled",
      true,
    );
    expect(within(dialog).getByText("Deleting worktrees")).toBeDefined();
    await fixture.user.keyboard("{Escape}");
    expect(screen.getByRole("alertdialog")).toBe(dialog);
    await act(async () =>
      pending.resolve({
        projectPath: "/cake",
        discardedWorkingDirectories: ["/worktree"],
        failures: [],
      }),
    );
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  });

  it("interleaves saved Drafts by activity and archives them without opening a conversation", async () => {
    const drafts = fakeSavedDrafts();
    await drafts.client.create({
      sessionId: "draft",
      projectPath: "/cake",
      title: "Saved plan",
      modifiedAt: "2026-01-31T00:00:00.000Z",
      text: "Later",
      attachments: [],
    });
    const open = vi.fn<Client["projectSessions"]["open"]>();
    using fixture = renderSidebarNavigation({
      projects: [project, projectRecord({ path: "/pi" })],
      sessions: [
        ...sidebarFamily,
        sidebarSummary("newest", 31, {
          projectPath: "/pi",
          modifiedAt: new Date(
            Date.parse(drafts.records.get("draft")!.modifiedAt) + 60_000,
          ).toISOString(),
        }),
      ],
      client: { savedDrafts: drafts.client, projectSessions: { open } },
    });
    await screen.findByRole("button", { name: /^Saved plan / });
    await fixture.user.click(screen.getByRole("button", { name: "Show activity" }));
    expect(order()).toEqual(["newest", "draft", "root", "planner", "worker", "sibling"]);
    expect(screen.getByRole("button", { name: "Cake Chat" })).toBeDefined();
    expect(within(row("newest")).getByText("pi")).toBeDefined();
    await fixture.user.click(screen.getByRole("button", { name: "Resolve Saved plan" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: /^Saved plan / })).toBeNull());
    expect(open).not.toHaveBeenCalled();
    expect(drafts.records.get("draft")?.resolved).toBe(true);
    await fixture.user.click(screen.getByRole("button", { name: "Show projects" }));
    await fixture.user.click(screen.getByRole("button", { name: "Expand Resolved" }));
    await fixture.user.click(screen.getAllByRole("button", { name: "Expand cake resolved" })[0]!);
    expect(screen.getByRole("button", { name: /^Saved plan / })).toBeDefined();
    await fixture.user.click(screen.getByRole("button", { name: "Restore Saved plan" }));
    await waitFor(() =>
      expect(
        within(projectGroup("cake")).getByRole("button", { name: /^Saved plan / }),
      ).toBeDefined(),
    );
  });
  it("renders live waiting/running/failure facts and worktree lifecycle metadata without truncating titles", async () => {
    const title =
      "A very long title that stays intact in the accessible navigation label instead of being shortened by test Store stubs";
    const sessions = [
      sidebarSummary("waiting"),
      sidebarSummary("running", 2),
      sidebarSummary("failed", 3, { workingDirectory: "/worktree" }),
      sidebarSummary("main", 4, { title }),
    ];
    const worktree: WorktreeRecord = {
      projectPath: "/cake",
      worktreePath: "/worktree",
      branch: "agent/fix",
      baseBranch: "agent/base",
      state: "active",
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    using fixture = renderSidebarNavigation({
      projects: [project],
      sessions,
      loadedIds: ["waiting", "running", "failed"],
      worktrees: [worktree],
    });
    expect(screen.getByRole("button", { name: new RegExp(`^${title} `) })).toBeDefined();
    expect(within(row("failed")).getByRole("img", { name: "Open worktree" })).toBeDefined();
    await fixture.publishWorktrees([{ ...worktree, state: "landed" }]);
    expect(within(row("failed")).getByRole("img", { name: "Merged worktree" })).toBeDefined();
    expect(within(row("failed")).getByText("fix")).toBeDefined();
    expect(within(row("failed")).getByText("base")).toBeDefined();
    const worktreeMetadata = row("failed").querySelector('[data-slot="session-description"]')!;
    expect(worktreeMetadata.firstElementChild?.tagName).toBe("TIME");
    expect(
      worktreeMetadata
        .querySelector("time")!
        .compareDocumentPosition(
          within(row("failed")).getByRole("img", { name: "Merged worktree" }),
        ) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    const plainMetadata = document.querySelector(
      '[data-session-id="main"] [data-slot="session-description"]',
    )!;
    expect(plainMetadata.firstElementChild?.tagName).toBe("TIME");
    expect(plainMetadata.children).toHaveLength(1);
    expect(screen.getAllByRole("img", { name: /worktree$/ })).toHaveLength(1);
    await fixture.publishInterview({
      id: "interview-1",
      sessionId: "waiting",
      request: {
        protocol: "cake.request/v1",
        id: "question",
        title: "Choose",
        responseSchema: { type: "object" },
        view: { type: "form", fields: [{ id: "name", label: "Name", type: "text" }] },
        fallback: { markdown: "What next?" },
      },
    });
    await fixture.publishStreaming(["running"], true);
    await fixture.publishConversation("failed", {
      parts: [
        {
          id: "failure",
          kind: "notice",
          tone: "error",
          title: "Model request failed",
          message: "Provider unavailable",
        },
      ],
    });
    await fixture.publishEvent({
      _tag: "TurnSettled",
      sessionId: "failed",
      turnId: TurnId.make("10000000-0000-4000-8000-000000000001"),
      outcome: "failed",
    });
    expect(
      within(row("waiting")).getByRole("img", { name: "Waiting for your answer" }),
    ).toBeDefined();
    expect(within(row("running")).getByRole("img", { name: "Running" })).toBeDefined();
    expect(within(row("failed")).getByRole("img", { name: "Error" })).toBeDefined();
    for (const id of ["waiting", "running", "failed"]) {
      expect(within(row(id)).queryByRole("button", { name: `Resolve ${id}` })).toBeNull();
      if (id === "failed") {
        expect(row(id).querySelector("time")?.dateTime).toBe(
          sessions.find((session) => session.sessionId === id)!.modifiedAt,
        );
      } else expect(row(id).querySelector("time")?.textContent).toBe("Working");
    }
  });

  it.each(["failed", "aborted"] as const)(
    "shows the current turn after %s -> continue -> success, and a fresh failure reappears",
    async (outcome) => {
      const failed = sidebarSummary("retry", 1, { latestTurnOutcome: outcome });
      using fixture = renderSidebarNavigation({
        projects: [project],
        sessions: [failed],
        loadedIds: ["retry"],
      });
      if (outcome === "failed")
        expect(within(row("retry")).getByRole("img", { name: "Error" })).toBeDefined();
      // Viewing acknowledges unread content, never the current failure.
      await fixture.user.click(rowButton("retry"));
      if (outcome === "failed")
        expect(within(row("retry")).getByRole("img", { name: "Error" })).toBeDefined();
      // Live turn acceptance can reach the window before the catalog update.
      await fixture.publishEvent({
        _tag: "TurnAccepted",
        sessionId: "retry",
        turnId: TurnId.make("10000000-0000-4000-8000-000000000002"),
        delivery: "prompt",
      });
      expect(within(row("retry")).getByRole("img", { name: "Running" })).toBeDefined();
      await fixture.publishSessions([{ ...failed, running: true, latestTurnOutcome: undefined }]);
      await fixture.publishEvent({
        _tag: "TurnSettled",
        sessionId: "retry",
        turnId: TurnId.make("10000000-0000-4000-8000-000000000002"),
        outcome: "complete",
      });
      await fixture.publishSessions([{ ...failed, latestTurnOutcome: "complete" }]);
      expect(within(row("retry")).queryByRole("img", { name: "Error" })).toBeNull();
      expect(within(row("retry")).queryByRole("img", { name: "Running" })).toBeNull();
      await fixture.publishSessions([{ ...failed, latestTurnOutcome: "failed" }]);
      expect(within(row("retry")).getByRole("img", { name: "Error" })).toBeDefined();
    },
  );

  it("restores window/list preferences and expands a collapsed project when entering focus", async () => {
    const menu = vi.fn<Client["electron"]["showProjectContextMenu"]>(async () => "sort-by-date");
    using fixture = renderSidebarNavigation({
      projects: [project, projectRecord({ path: "/pi" })],
      sessions: [...sidebarFamily, sidebarSummary("standalone", 3)],
      client: { electron: { showProjectContextMenu: menu } },
      snapshot: {
        state: {},
        children: {
          sidebarStore: {
            state: { hidden: true, width: 344, navigationMode: "activity" },
            children: {
              sessionListStore: {
                state: {
                  projectSessionSorts: { "/cake": "label" },
                  expandedActiveGroups: { "cake-chat": true, "/cake": false },
                  collapsedFamilies: { root: true },
                },
                children: {},
              },
            },
          },
        },
      },
    });
    expect(screen.queryByRole("complementary")).toBeNull();
    await fixture.user.click(screen.getAllByRole("button", { name: "Toggle sidebar" })[0]!);
    expect(screen.getByRole("main").style.getPropertyValue("--sidebar-width")).toBe("344px");
    expect(screen.getByRole("button", { name: "Show projects" })).toBeDefined();
    expect(order()).toEqual(["root", "standalone"]);
    await fixture.user.click(screen.getByRole("button", { name: "Show projects" }));
    expect(screen.getByRole("button", { name: "Expand cake" })).toBeDefined();
    expect(screen.queryByRole("button", { name: /^root / })).toBeNull();
    await fixture.user.click(screen.getByRole("button", { name: "Focus on cake" }));
    expect(screen.getByRole("button", { name: "Exit focus mode for cake" })).toBeDefined();
    expect(order()).toEqual(["root", "standalone"]);
    await fixture.user.pointer({
      target: screen.getByRole("button", { name: "Open Project Chat for cake" }),
      keys: "[MouseRight]",
    });
    expect(menu).toHaveBeenCalledWith(
      expect.objectContaining({ path: "/cake", sessionSort: "label" }),
    );
    await fixture.user.click(screen.getByRole("button", { name: "Exit focus mode for cake" }));
    expect(screen.getByRole("button", { name: "Focus on pi" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Collapse cake" })).toBeDefined();
    await fixture.user.click(screen.getByRole("button", { name: "Expand children of root" }));
    expect(order()).toEqual(["root", "planner", "worker", "sibling", "standalone"]);
  });

  it.each([false, true])(
    "treats IDE sidebar visibility as an override, preserving the ordinary preference (hidden: %s)",
    async (hidden) => {
      const open = vi.fn<Client["vscode"]["open"]>(async () => undefined);
      using fixture = renderSidebarNavigation({
        projects: [project],
        sessions: [sidebarSummary("editor")],
        loadedIds: ["editor"],
        ide: { sidebarAutoHide: "always" },
        snapshot: { state: {}, children: { sidebarStore: { state: { hidden }, children: {} } } },
        client: { vscode: { open } },
      });
      const sidebar = () => document.querySelector('[data-slot="sidebar"]');
      expect(!!sidebar()).toBe(!hidden);
      await fixture.user.click(screen.getByRole("button", { name: "Open VS Code" }));
      expect(open).toHaveBeenCalledWith(
        "/cake",
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
      expect(sidebar()).toBeNull();
      fixture.hostToggleSidebar();
      expect(sidebar()).not.toBeNull();
      // Once shown, Cake's sidebar provides its own real toggle control.
      await fixture.user.click(screen.getByRole("button", { name: "Toggle sidebar" }));
      expect(sidebar()).toBeNull();
      await fixture.user.click(screen.getAllByRole("button", { name: "Back to agent" })[0]!);
      expect(!!sidebar()).toBe(!hidden);
      // Each new IDE entry resets only its temporary visibility override.
      await fixture.user.click(screen.getByRole("button", { name: "Open VS Code" }));
      fixture.hostToggleSidebar();
      expect(sidebar()).not.toBeNull();
      await fixture.user.click(screen.getAllByRole("button", { name: "Back to agent" })[0]!);
      expect(!!sidebar()).toBe(!hidden);
    },
  );

  it.each(["projects", "activity"] as const)(
    "groups work first and follows live recency within both groups in %s",
    async (mode) => {
      const sessions = ["newest", "middle", "oldest", "idle"].map((id, index) =>
        sidebarSummary(id, 4 - index),
      );
      using fixture = renderSidebarNavigation({
        projects: [project],
        sessions,
        loadedIds: sessions.map((session) => session.sessionId),
        client: { projectSessions: { open: async () => undefined } },
      });
      if (mode === "activity")
        await fixture.user.click(screen.getByRole("button", { name: "Show activity" }));
      await fixture.publishStreaming(["middle", "oldest"], true);
      expect(order()).toEqual(["middle", "oldest", "newest", "idle"]);
      await fixture.user.click(rowButton("oldest"));
      await waitFor(() => expect(row("oldest").dataset.navigationActive).toBe("true"));
      await fixture.publishSessions([
        sidebarSummary("oldest", 6),
        sidebarSummary("middle", 5),
        sidebarSummary("idle", 10),
        sidebarSummary("newest", 4),
      ]);
      expect(order()).toEqual(["oldest", "middle", "idle", "newest"]);
      expect(row("oldest").dataset.navigationActive).toBe("true");
      expect(row("oldest").querySelector("time")?.textContent).toBe("Working");
      await fixture.publishStreaming(["oldest"], false);
      expect(order()).toEqual(["middle", "idle", "oldest", "newest"]);
      expect(row("oldest").querySelector("time")?.dateTime).toBe(
        sidebarSummary("oldest", 6).modifiedAt,
      );
      await fixture.publishStreaming(["middle"], false);
      expect(order()).toEqual(["idle", "oldest", "middle", "newest"]);
      await fixture.publishStreaming(["newest"], true);
      expect(order()).toEqual(["newest", "idle", "oldest", "middle"]);
    },
  );

  it("breaks equal working and idle recency ties by identity across catalog refresh and remount", async () => {
    const sessions = [
      sidebarSummary("beta", 2, { running: true }),
      sidebarSummary("alpha", 2, { running: true }),
      sidebarSummary("delta", 3),
      sidebarSummary("charlie", 3),
    ];
    const saved = await (async () => {
      using fixture = renderSidebarNavigation({ projects: [project], sessions });
      expect(order()).toEqual(["alpha", "beta", "charlie", "delta"]);
      await fixture.publishSessions([...sessions].reverse());
      expect(order()).toEqual(["alpha", "beta", "charlie", "delta"]);
      return fixture.snapshot();
    })();
    using fixture = renderSidebarNavigation({ projects: [project], sessions, snapshot: saved });
    expect(order()).toEqual(["alpha", "beta", "charlie", "delta"]);
    await fixture.publishSessions([...sessions].reverse());
    expect(order()).toEqual(["alpha", "beta", "charlie", "delta"]);
  });

  it("marks Activity Project Chats with their Project's icon in the session status column", async () => {
    const iconProject = projectRecord({
      path: "/cake",
      settings: {
        ...project.settings!,
        icon: { mimeType: "image/png", data: "aWNvbg==" },
      },
    });
    using fixture = renderSidebarNavigation({
      projects: [iconProject],
      sessions: [sidebarSummary("session", 1)],
      loadedIds: ["session"],
    });
    const chat = (unread: boolean) => ({
      sessionId: "project-chat",
      title: "cake",
      projectPath: "/cake",
      createdAt: sidebarSummary("unused", 1).modifiedAt,
      modifiedAt: sidebarSummary("unused", 2).modifiedAt,
      messageCount: 2,
      resolved: false,
      unread,
    });
    await fixture.publishProjectChats([chat(false)]);
    await fixture.publishProjectChatStreaming("project-chat", true);
    await fixture.user.click(screen.getByRole("button", { name: "Show activity" }));
    const chatRow = document.querySelector<HTMLElement>('[data-slot="project-chat-item"]')!;
    const leading = chatRow.querySelector('[data-slot="project-chat-leading"]')!;
    expect(leading.querySelector("img")?.getAttribute("src")).toBe(
      "data:image/png;base64,aWNvbg==",
    );
    const status = chatRow.querySelector<HTMLElement>('[data-slot="project-chat-status"]')!;
    expect(within(status).getByRole("img", { name: "Running" })).toBeDefined();

    await fixture.publishProjectChatStreaming("project-chat", false);
    expect(
      document.querySelector('[data-slot="project-chat-item"] [data-slot="project-chat-status"]'),
    ).toBeNull();
    await fixture.publishProjectChats([chat(true)]);
    expect(
      within(
        document.querySelector<HTMLElement>(
          '[data-slot="project-chat-item"] [data-slot="project-chat-status"]',
        )!,
      ).getByRole("img", { name: "Ready, unread" }),
    ).toBeDefined();
  });

  it("orders running Project Chats and sessions by live activity before idle entries", async () => {
    const sessions = [sidebarSummary("newest", 4), sidebarSummary("oldest", 1)];
    using fixture = renderSidebarNavigation({
      projects: [project],
      sessions,
      loadedIds: ["newest", "oldest"],
    });
    const chat = (day: number) => ({
      sessionId: "project-chat",
      title: "Project Chat",
      projectPath: "/cake",
      createdAt: sidebarSummary("unused", 1).modifiedAt,
      modifiedAt: sidebarSummary("unused", day).modifiedAt,
      messageCount: 2,
      resolved: false,
      unread: false,
    });
    await fixture.publishProjectChats([chat(2)]);
    await fixture.publishStreaming(["newest", "oldest"], true);
    await fixture.publishProjectChatStreaming("project-chat", true);
    await fixture.user.click(screen.getByRole("button", { name: "Show activity" }));
    const mixedOrder = () =>
      [...document.querySelectorAll('[data-slot="activity-feed"] [data-session-id]')].map(
        (element) => element.getAttribute("data-session-id"),
      );
    expect(mixedOrder()).toEqual(["newest", "project-chat", "oldest"]);
    const chatRow = document.querySelector('[data-slot="project-chat-item"]')!;
    expect(chatRow.textContent).toBe("Project ChatProject Chat");
    await fixture.publishProjectChats([chat(9)]);
    await fixture.publishSessions([sidebarSummary("oldest", 10), sidebarSummary("newest", 8)]);
    expect(mixedOrder()).toEqual(["oldest", "project-chat", "newest"]);
    await fixture.publishProjectChatStreaming("project-chat", false);
    expect(mixedOrder()).toEqual(["oldest", "newest", "project-chat"]);
    expect(document.querySelector('[data-slot="project-chat-item"]')!.textContent).not.toBe(
      "Project ChatProject Chat",
    );
  });

  it.each(["projects", "activity"] as const)(
    "reorders selected and unselected inactive sessions by activity in %s without changing the open conversation",
    async (mode) => {
      const sessions = [
        sidebarSummary("newest", 3),
        sidebarSummary("middle", 2),
        sidebarSummary("oldest", 1),
      ];
      using fixture = renderSidebarNavigation({
        projects: [project],
        sessions,
        loadedIds: sessions.map((session) => session.sessionId),
        client: { projectSessions: { open: async () => undefined } },
      });
      if (mode === "activity")
        await fixture.user.click(screen.getByRole("button", { name: "Show activity" }));
      await fixture.user.click(rowButton("middle"));
      await waitFor(() =>
        expect(
          document.querySelector('[data-slot="session-pane"]')?.getAttribute("data-session-id"),
        ).toBe("middle"),
      );
      const pane = document.querySelector('[data-slot="session-pane"]');
      const assertSelection = () => {
        expect(
          document
            .querySelector('[data-navigation-active="true"].session-item')
            ?.getAttribute("data-session-id"),
        ).toBe("middle");
        expect(document.querySelector('[data-slot="session-pane"]')).toBe(pane);
        expect(pane?.getAttribute("data-session-id")).toBe("middle");
      };
      expect(order()).toEqual(["newest", "middle", "oldest"]);
      // Selection alone does not pin an inactive row against recency.
      await fixture.publishSessions([sessions[0]!, sidebarSummary("middle", 5), sessions[2]!]);
      expect(order()).toEqual(["middle", "newest", "oldest"]);
      assertSelection();
      // Background activity moves above the selection, but never navigates to it.
      await fixture.publishSessions([
        sessions[0]!,
        sidebarSummary("middle", 5),
        sidebarSummary("oldest", 6),
      ]);
      expect(order()).toEqual(["oldest", "middle", "newest"]);
      assertSelection();
    },
  );

  it("moves a family on selected descendant activity without changing its selected child or open pane", async () => {
    using fixture = renderSidebarNavigation({
      projects: [project],
      sessions: [...sidebarFamily, sidebarSummary("standalone", 31)],
      loadedIds: ["worker"],
      client: { projectSessions: { open: async () => undefined } },
    });
    await fixture.user.click(rowButton("worker"));
    await waitFor(() =>
      expect(
        document.querySelector('[data-slot="session-pane"]')?.getAttribute("data-session-id"),
      ).toBe("worker"),
    );
    const pane = document.querySelector('[data-slot="session-pane"]');
    expect(order()).toEqual(["standalone", "root", "planner", "worker", "sibling"]);
    await fixture.publishSessions([
      ...sidebarFamily.map((session) =>
        session.sessionId === "worker"
          ? { ...session, modifiedAt: "2026-02-01T00:00:00.000Z" }
          : session,
      ),
      sidebarSummary("standalone", 31),
    ]);
    expect(order()).toEqual(["root", "planner", "worker", "sibling", "standalone"]);
    expect(row("worker").getAttribute("data-navigation-active")).toBe("true");
    expect(document.querySelector('[data-slot="session-pane"]')).toBe(pane);
    expect(pane?.getAttribute("data-session-id")).toBe("worker");
  });

  it("flattens nested families parent-first and moves descendant activity onto collapsed ancestors", async () => {
    using fixture = renderSidebarNavigation({
      projects: [project],
      sessions: [...sidebarFamily, sidebarSummary("standalone", 3)],
      loadedIds: ["worker"],
    });
    expect(order()).toEqual(["root", "planner", "worker", "sibling", "standalone"]);
    await fixture.publishStreaming(["worker"], true);
    expect(within(row("root")).queryByRole("img", { name: "Running" })).toBeNull();
    expect(within(row("worker")).getByRole("img", { name: "Running" })).toBeDefined();
    expect(row("worker").querySelector("time")?.textContent).toBe("Working");
    expect(row("root").querySelector("time")).not.toBeNull();
    await fixture.user.click(screen.getByRole("button", { name: "Collapse children of planner" }));
    expect(order()).toEqual(["root", "planner", "sibling", "standalone"]);
    expect(within(row("planner")).getByRole("img", { name: "Running" })).toBeDefined();
    expect(row("planner").querySelector("time")?.textContent).toBe("Working");
    expect(within(row("root")).queryByRole("img", { name: "Running" })).toBeNull();
    await fixture.user.click(screen.getByRole("button", { name: "Collapse children of root" }));
    expect(order()).toEqual(["root", "standalone"]);
    expect(within(row("root")).getByRole("img", { name: "Running" })).toBeDefined();
    expect(row("root").querySelector("time")?.textContent).toBe("Working");
    await fixture.user.click(screen.getByRole("button", { name: "Show activity" }));
    // The root's own timestamp is older: hidden descendants still determine family recency.
    expect(order()).toEqual(["root", "standalone"]);
    await fixture.user.click(screen.getByRole("button", { name: "Show projects" }));
    await fixture.user.click(screen.getByRole("button", { name: "Expand children of root" }));
    expect(order()).toEqual(["root", "planner", "sibling", "standalone"]);
    expect(within(row("root")).queryByRole("img", { name: "Running" })).toBeNull();
    await fixture.user.click(screen.getByRole("button", { name: "Expand children of planner" }));
    expect(order()).toEqual(["root", "planner", "worker", "sibling", "standalone"]);
  });

  describe("revealing a selected family descendant", () => {
    let scrollIntoView: ReturnType<typeof vi.fn>;
    beforeEach(() => {
      scrollIntoView = vi.fn();
      Object.defineProperty(Element.prototype, "scrollIntoView", {
        configurable: true,
        value: scrollIntoView,
      });
    });
    afterEach(() => {
      Reflect.deleteProperty(Element.prototype, "scrollIntoView");
    });
    const familySessions = [...sidebarFamily, sidebarSummary("standalone", 3)];
    const renderFamily = (snapshot: Parameters<typeof renderSidebarNavigation>[0]["snapshot"]) =>
      renderSidebarNavigation({
        projects: [project],
        sessions: familySessions,
        loadedIds: familySessions.map((session) => session.sessionId),
        client: { projectSessions: { open: async () => undefined } },
        snapshot,
      });
    const collapsed = (collapsedFamilies: Record<string, boolean>, projectCollapsed = false) => ({
      state: {},
      children: {
        sidebarStore: {
          state: {},
          children: {
            sessionListStore: {
              state: {
                collapsedFamilies,
                expandedActiveGroups: { "cake-chat": true, "/cake": !projectCollapsed },
              },
              children: {},
            },
          },
        },
      },
    });

    it("expands the collapsed Project and every collapsed ancestor of a linked grandchild, persists it, and scrolls the row into view", async () => {
      const saved = await (async () => {
        using fixture = renderFamily(collapsed({ root: true, planner: true }, true));
        expect(order()).toEqual([]);
        await fixture.openSessionLink("worker");
        expect(order()).toEqual(["root", "planner", "worker", "sibling", "standalone"]);
        expect(row("worker").getAttribute("data-navigation-active")).toBe("true");
        expect(scrollIntoView.mock.contexts).toContain(row("worker"));
        expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
        return fixture.snapshot();
      })();
      // Like a manual expand, the reveal persists with window presentation…
      using fixture = renderFamily(saved);
      expect(order()).toEqual(["root", "planner", "worker", "sibling", "standalone"]);
      // …and is one-time: collapsing the selected row's parent or Project afterwards sticks.
      await fixture.openSessionLink("worker");
      await fixture.user.click(
        screen.getByRole("button", { name: "Collapse children of planner" }),
      );
      expect(order()).toEqual(["root", "planner", "sibling", "standalone"]);
      await fixture.user.click(screen.getByRole("button", { name: "Collapse cake" }));
      expect(order()).toEqual([]);
    });

    it("expands only the ancestors of a linked child, leaving its own children collapsed", async () => {
      using fixture = renderFamily(collapsed({ root: true, planner: true }));
      await fixture.openSessionLink("planner");
      expect(order()).toEqual(["root", "planner", "sibling", "standalone"]);
      expect(row("planner").getAttribute("data-navigation-active")).toBe("true");
      expect(screen.getByRole("button", { name: "Expand children of planner" })).toBeDefined();
    });

    it("leaves family expansion alone for a visible child or top-level session, revealing only its collapsed Project", async () => {
      using fixture = renderFamily(collapsed({ planner: true }));
      await fixture.user.click(rowButton("sibling"));
      await waitFor(() =>
        expect(row("sibling").getAttribute("data-navigation-active")).toBe("true"),
      );
      expect(order()).toEqual(["root", "planner", "sibling", "standalone"]);
      await fixture.user.click(screen.getByRole("button", { name: "Collapse children of root" }));
      await fixture.user.click(screen.getByRole("button", { name: "Collapse cake" }));
      expect(order()).toEqual([]);
      await fixture.openSessionLink("standalone");
      expect(row("standalone").getAttribute("data-navigation-active")).toBe("true");
      expect(order()).toEqual(["root", "standalone"]);
      await fixture.user.click(screen.getByRole("button", { name: "Expand children of root" }));
      expect(screen.getByRole("button", { name: "Expand children of planner" })).toBeDefined();
    });
  });

  it("reacts to nested work and completion on collapsed Projects without changing expanded activity or selection", async () => {
    using fixture = renderSidebarNavigation({
      projects: [project],
      sessions: sidebarFamily,
      loadedIds: ["worker"],
      client: { projectSessions: { open: async () => undefined } },
    });
    const header = () =>
      projectGroup("cake").querySelector<HTMLElement>('[data-slot="project-header"]')!;
    const headerStatus = () =>
      within(header()).queryByRole("img", { name: /Running|Ready, unread/ });
    await fixture.publishStreaming(["worker"], true);
    expect(headerStatus()).toBeNull();
    await fixture.user.click(screen.getByRole("button", { name: "Collapse children of planner" }));
    await fixture.user.click(screen.getByRole("button", { name: "Collapse children of root" }));
    expect(within(row("root")).getByRole("img", { name: "Running" })).toBeDefined();
    await fixture.user.click(screen.getByRole("button", { name: "Collapse cake" }));
    expect(order()).toEqual([]);
    expect(headerStatus()?.getAttribute("aria-label")).toBe("Running");

    await fixture.publishStreaming(["worker"], false);
    expect(headerStatus()).toBeNull();
    await fixture.publishStreaming(["worker"], true);
    expect(headerStatus()?.getAttribute("aria-label")).toBe("Running");
    await fixture.publishStreaming(["worker"], false);
    await fixture.publishEvent({
      _tag: "TurnSettled",
      sessionId: "worker",
      turnId: TurnId.make("10000000-0000-4000-8000-000000000002"),
      outcome: "complete",
    });
    expect(headerStatus()?.getAttribute("aria-label")).toBe("Ready, unread");
    await fixture.user.click(screen.getByRole("button", { name: "Expand cake" }));
    expect(headerStatus()).toBeNull();
    expect(within(row("root")).getByRole("img", { name: "Ready, unread" })).toBeDefined();
    await fixture.user.click(screen.getByRole("button", { name: "Expand children of root" }));
    await fixture.user.click(screen.getByRole("button", { name: "Expand children of planner" }));
    await fixture.user.click(rowButton("worker"));
    await waitFor(() => expect(row("worker").getAttribute("data-navigation-active")).toBe("true"));
    const pane = document.querySelector('[data-slot="session-pane"]');
    await fixture.user.click(screen.getByRole("button", { name: "Collapse cake" }));
    expect(headerStatus()).toBeNull();
    expect(document.querySelector('[data-slot="session-pane"]')).toBe(pane);
    expect(pane?.getAttribute("data-session-id")).toBe("worker");
  });

  it.each([
    ["waiting", "Waiting for your answer"],
    ["running", "Running"],
    ["blocked", "Needs your input"],
    ["error", "Error"],
    ["unread", "Ready, unread"],
    ["stopped", undefined],
  ] as const)(
    "shares collapsed-family precedence for mixed states starting with %s",
    async (state, label) => {
      const states = ["waiting", "running", "blocked", "error", "unread", "stopped"];
      const included = (activity: string) => states.indexOf(activity) >= states.indexOf(state);
      const sessions = [
        ...sidebarFamily.map((session) => ({
          ...session,
          ...(session.sessionId === "root"
            ? {
                familyChildSessionIds: ["planner", "sibling", "blocked", "waiting"],
                latestTurnOutcome: "aborted" as const,
              }
            : {}),
          ...(session.sessionId === "planner" && included("error")
            ? { latestTurnOutcome: "failed" as const }
            : {}),
          ...(session.sessionId === "worker" ? { running: included("running") } : {}),
          ...(session.sessionId === "sibling" ? { unread: included("unread") } : {}),
        })),
        sidebarSummary("blocked", 1, {
          familyParentSessionId: "root",
          recoveryIssue: included("blocked") ? "Needs recovery" : undefined,
        }),
        sidebarSummary("waiting", 1, { familyParentSessionId: "root" }),
      ];
      using fixture = renderSidebarNavigation({
        projects: [project],
        sessions,
        loadedIds: ["waiting"],
      });
      if (included("waiting"))
        await fixture.publishInterview({
          id: "precedence-question",
          sessionId: "waiting",
          request: {
            protocol: "cake.request/v1",
            id: "question",
            title: "Choose",
            responseSchema: { type: "object" },
            view: { type: "form", fields: [{ id: "name", label: "Name", type: "text" }] },
            fallback: { markdown: "What next?" },
          },
        });
      await fixture.user.click(screen.getByRole("button", { name: "Collapse children of root" }));
      const parentDot = row("root").querySelector(".session-status");
      expect(parentDot?.getAttribute("aria-label")).toBe(label);
      await fixture.user.click(screen.getByRole("button", { name: "Collapse cake" }));
      const projectDot = projectGroup("cake").querySelector(
        '[data-slot="project-chat-status"] .session-status',
      );
      expect(projectDot?.getAttribute("aria-label")).toBe(label);
    },
  );

  it("excludes resolved descendants from active family activity and includes them again on restore", async () => {
    using fixture = renderSidebarNavigation({
      projects: [project],
      sessions: sidebarFamily.map((session) =>
        session.sessionId === "worker" ? { ...session, resolved: true, unread: true } : session,
      ),
    });
    expect(order()).not.toContain("worker");
    await fixture.user.click(screen.getByRole("button", { name: "Collapse children of root" }));
    expect(within(row("root")).queryByRole("img", { name: "Ready, unread" })).toBeNull();
    await fixture.user.click(screen.getByRole("button", { name: "Collapse cake" }));
    expect(within(projectGroup("cake")).queryByRole("img", { name: "Ready, unread" })).toBeNull();
    await fixture.publishSessions(
      sidebarFamily.map((session) =>
        session.sessionId === "worker" ? { ...session, resolved: false, unread: true } : session,
      ),
    );
    expect(within(projectGroup("cake")).getByRole("img", { name: "Ready, unread" })).toBeDefined();
  });

  it("includes unpaginated sessions but not other Projects or standalone resolved rows, and retains Project Chat's own activity", async () => {
    const sessions = [
      ...Array.from({ length: 11 }, (_, index) =>
        sidebarSummary(`task-${index}`, index + 1, { running: index === 0 }),
      ),
      sidebarSummary("resolved", 20, { resolved: true, recoveryIssue: "Needs recovery" }),
      sidebarSummary("other-project", 20, { projectPath: "/pi", running: true }),
    ];
    using fixture = renderSidebarNavigation({
      projects: [project, projectRecord({ path: "/pi" })],
      sessions,
    });
    const chat = {
      sessionId: "project-chat",
      title: "Project Chat",
      projectPath: "/cake",
      createdAt: sessions[0]!.createdAt,
      modifiedAt: sessions[0]!.modifiedAt,
      messageCount: 2,
      resolved: false,
      unread: true,
    };
    await fixture.publishProjectChats([chat]);
    const status = () =>
      projectGroup("cake").querySelector('[data-slot="project-chat-status"] .session-status');
    expect(order()[0]).toBe("task-0");
    expect(order()).not.toContain("task-1");
    expect(status()?.getAttribute("aria-label")).toBe("Ready, unread");
    await fixture.user.click(screen.getByRole("button", { name: "Collapse cake" }));
    expect(status()?.getAttribute("aria-label")).toBe("Running");
    await fixture.publishSessions(
      sessions.map((session) =>
        session.sessionId === "task-0" ? { ...session, running: false } : session,
      ),
    );
    expect(status()?.getAttribute("aria-label")).toBe("Ready, unread");
    await fixture.publishProjectChats([{ ...chat, unread: false }]);
    expect(status()).toBeNull();
    await fixture.publishProjectChatStreaming("project-chat", true);
    expect(status()?.getAttribute("aria-label")).toBe("Running");
    await fixture.user.click(screen.getByRole("button", { name: "Expand cake" }));
    expect(status()?.getAttribute("aria-label")).toBe("Running");
    await fixture.publishProjectChatStreaming("project-chat", false);
    expect(status()).toBeNull();
  });

  it("keeps project and worktree details visible in Activity through mode and lifecycle changes", async () => {
    using fixture = renderSidebarNavigation({
      projects: [project],
      sessions: [
        sidebarSummary("feature", 3, { workingDirectory: "/cake-feature" }),
        sidebarSummary("checkout", 2),
        sidebarSummary("draft", 1, { workingDirectory: "/cake-feature", draft: true }),
      ],
    });
    const worktree = {
      projectPath: "/cake",
      worktreePath: "/cake-feature",
      branch: "agent/feature-branch",
      baseBranch: "agent/release",
      state: "active" as const,
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    await fixture.publishWorktrees([worktree]);
    const assertWorktree = (state: "Open worktree" | "Merged worktree") => {
      expect(within(row("feature")).getByText("feature-branch")).toBeDefined();
      expect(within(row("feature")).getByText("release")).toBeDefined();
      expect(within(row("feature")).getByRole("img", { name: state })).toBeDefined();
      expect(row("feature").querySelector("time")?.textContent).toBeTruthy();
      expect(row("checkout").querySelector("[data-worktree-state]")).toBeNull();
      expect(row("draft").querySelector("[data-worktree-state]")).toBeNull();
      expect(within(row("draft")).queryByText("feature-branch")).toBeNull();
    };
    assertWorktree("Open worktree");
    await fixture.user.click(screen.getByRole("button", { name: "Show activity" }));
    assertWorktree("Open worktree");
    for (const id of ["feature", "checkout", "draft"]) {
      expect(within(row(id)).getByText("cake")).toBeDefined();
    }
    await fixture.publishWorktrees([{ ...worktree, state: "landed" }]);
    assertWorktree("Merged worktree");
    await fixture.user.click(screen.getByRole("button", { name: "Show projects" }));
    assertWorktree("Merged worktree");
    await fixture.user.click(screen.getByRole("button", { name: "Show activity" }));
    assertWorktree("Merged worktree");
    expect(within(row("feature")).getByText("cake")).toBeDefined();
  });

  it("reveals ten roots per click without charging family children or sharing limits across projects and lanes", async () => {
    const singles = Array.from({ length: 20 }, (_, index) =>
      sidebarSummary(`single-${index}`, 20 - index),
    );
    const piSessions = Array.from({ length: 11 }, (_, index) =>
      sidebarSummary(`pi-${index}`, 20 - index, { projectPath: "/pi" }),
    );
    const archives = Array.from({ length: 21 }, (_, index) =>
      sidebarSummary(`archive-${index}`, 25 - index, { resolved: true }),
    );
    using fixture = renderSidebarNavigation({
      projects: [project, projectRecord({ path: "/pi" })],
      sessions: [...sidebarFamily, ...singles, ...piSessions, ...archives],
    });
    expect(order(projectGroup("cake"))).toEqual([
      "root",
      "planner",
      "worker",
      "sibling",
      ...singles.slice(0, 9).map((session) => session.sessionId),
    ]);
    expect(order(projectGroup("pi"))).toHaveLength(10);
    await fixture.user.click(
      within(projectGroup("cake")).getByRole("button", { name: "Show more" }),
    );
    expect(order(projectGroup("cake"))).toHaveLength(23);
    expect(within(projectGroup("cake")).queryByRole("button", { name: /^single-19 / })).toBeNull();
    expect(order(projectGroup("pi"))).toHaveLength(10);
    await fixture.user.click(screen.getByRole("button", { name: "Expand Resolved" }));
    await fixture.user.click(screen.getAllByRole("button", { name: "Expand cake resolved" })[0]!);
    expect(order(resolvedGroup("cake"))).toHaveLength(10);
    await fixture.user.click(
      within(resolvedGroup("cake")).getByRole("button", { name: "Show more" }),
    );
    expect(order(resolvedGroup("cake"))).toHaveLength(20);
    expect(order(projectGroup("cake"))).toHaveLength(23);
    expect(order(projectGroup("pi"))).toHaveLength(10);
    await fixture.user.click(
      within(projectGroup("cake")).getByRole("button", { name: "Show more" }),
    );
    expect(order(projectGroup("cake"))).toHaveLength(24);
    expect(within(projectGroup("cake")).queryByRole("button", { name: "Show more" })).toBeNull();
    expect(order(resolvedGroup("cake"))).toHaveLength(20);
  }, 15_000);

  it("shows every active session on project focus while keeping archives paginated and returning to the ordinary limit on exit", async () => {
    const sessions = [false, true].flatMap((resolved) =>
      Array.from({ length: 11 }, (_, index) =>
        sidebarSummary(`${resolved ? "archive" : "active"}-${index}`, index + 1, { resolved }),
      ),
    );
    using fixture = renderSidebarNavigation({
      projects: [project, projectRecord({ path: "/pi" })],
      sessions,
    });
    expect(order(projectGroup("cake"))).toHaveLength(10);
    await fixture.user.click(screen.getByRole("button", { name: "Collapse cake" }));
    expect(order(projectGroup("cake"))).toHaveLength(0);
    await fixture.user.click(screen.getByRole("button", { name: "Focus on cake" }));
    expect(order(projectGroup("cake"))).toHaveLength(11);
    expect(within(projectGroup("cake")).queryByRole("button", { name: "Show more" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Open Project Chat for pi" })).toBeNull();
    await fixture.user.click(screen.getByRole("button", { name: "Expand Resolved" }));
    const archives = screen.getByRole("region", { name: "Resolved sessions" });
    expect(order(archives)).toHaveLength(10);
    expect(within(archives).getByRole("button", { name: "Show more" })).toBeDefined();
    await fixture.user.click(screen.getByRole("button", { name: "Exit focus mode for cake" }));
    expect(order(projectGroup("cake"))).toHaveLength(10);
    expect(screen.getByRole("button", { name: "Open Project Chat for pi" })).toBeDefined();
  });

  it("shows queued landing as running only while it waits, not when landing work starts", async () => {
    using fixture = renderSidebarNavigation({
      projects: [project],
      sessions: [
        sidebarSummary("queued", 1, { workingDirectory: "/cake-worktree" }),
        sidebarSummary("landing", 2, { workingDirectory: "/other-worktree" }),
      ],
    });
    const queued = {
      operationId: "merge-1",
      workspacePath: "/cake-worktree",
      sessionId: "queued",
      kind: "landing" as const,
      phase: "waiting" as const,
      allowDirtyTarget: false,
    };
    const landing = {
      operationId: "merge-2",
      workspacePath: "/other-worktree",
      sessionId: "landing",
      kind: "landing" as const,
      phase: "landing" as const,
      allowDirtyTarget: false,
    };
    await fixture.publishWorktreeOperations([queued, landing]);
    expect(within(row("queued")).getByRole("img", { name: "Running" })).toBeDefined();
    expect(within(row("landing")).queryByRole("img", { name: "Running" })).toBeNull();
    await fixture.publishWorktreeOperations([{ ...queued, phase: "landing" }, landing]);
    expect(within(row("queued")).queryByRole("img", { name: "Running" })).toBeNull();
    expect(within(row("landing")).queryByRole("img", { name: "Running" })).toBeNull();
  });
});
