/** @vitest-environment jsdom */
import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Client } from "../../../src/renderer/client/Client";
import { defaultApplicationState } from "../../../src/contracts/application/application-data";
import { TurnId } from "../../../src/contracts/conversations/conversation-data";
import type { WorktreeRecord } from "../../../src/contracts/worktrees/managed-worktree-data";
import { projectRecord } from "./fixtures/catalog-fixtures";
import { fakeSavedDrafts } from "./fakes/saved-drafts";
import { renderSidebarNavigation, sidebarSummary } from "./sidebar-navigation-fixture";

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
const rowButton = (id: string) =>
  within(screen.getByRole("complementary", { name: "Workspace" })).getByRole("button", {
    name: new RegExp(`^${id}(?: |$)`),
  });
const row = (id: string) => rowButton(id).closest<HTMLElement>(".session-item")!;
function deferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

describe("Workspace Sessions navigation workflow", () => {
  it("opens on primary down before release and retains keyboard activation in Sessions", async () => {
    const sessions = [sidebarSummary("first"), sidebarSummary("second", 2)];
    using fixture = renderSidebarNavigation({
      projects: [project],
      sessions,
      loadedIds: ["first", "second"],
      client: { projectSessions: { open: async () => undefined } },
    });
    await fixture.selectSession("first");
    await fixture.showSessions();
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
      loadedIds: ["original"],
      client: {
        electron: { showSessionContextMenu: menu },
        projectSessions: { rename, open: async () => undefined },
        workspaces: { setSessionUnread, deleteSession },
      },
    });
    await fixture.selectSession("original");
    await fixture.showSessions();
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
    await fixture.showSessions(true);
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

  it("opens project settings from the rail context menu and blocks project removal until the service completes", async () => {
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
    expect(screen.queryByRole("button", { name: "Open Project Chat for cake" })).toBeNull();
  });

  it("closes Remove only confirmation without waiting for fallback navigation and retires removed observations", async () => {
    const fallback = deferred<void>();
    const open = vi
      .fn<Client["projectSessions"]["open"]>()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockImplementationOnce(() => fallback.promise);
    const other = projectRecord({ path: "/other" });
    const removeProject = vi.fn<Client["workspaces"]["removeProject"]>(async () => ({
      ...defaultApplicationState(),
      projects: [other],
    }));
    using fixture = renderSidebarNavigation({
      projects: [project, other],
      sessions: [
        sidebarSummary("removed", 1, { running: true }),
        sidebarSummary("retained", 2, { projectPath: "/other", workingDirectory: "/other" }),
      ],
      loadedIds: ["removed", "retained"],
      client: {
        electron: { showProjectContextMenu: async () => "remove-project" },
        projectSessions: { open },
        workspaces: { removeProject },
      },
    });
    await fixture.selectSession("retained");
    await waitFor(() => expect(open).toHaveBeenCalledTimes(1));
    await fixture.selectSession("removed");
    await waitFor(() => expect(open).toHaveBeenCalledTimes(2));
    await fixture.user.pointer({
      target: screen.getByRole("button", { name: "Open Project Chat for cake" }),
      keys: "[MouseRight]",
    });
    const dialog = await screen.findByRole("alertdialog", { name: "Remove cake?" });
    await fixture.user.click(within(dialog).getByRole("button", { name: "Remove only" }));
    await waitFor(() => expect(open).toHaveBeenCalledTimes(3));
    expect(removeProject).toHaveBeenCalledWith(
      "/cake",
      false,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(screen.queryByRole("alertdialog")).toBeNull();
    // The authority still owns the saved session; only window identity/demand is retired.
    expect(fixture.models.sessionCatalog.find("removed")).toBeDefined();
    expect(fixture.root.sessionRegistry.findSession("removed")).toBeUndefined();
    expect(
      fixture.root.sessionRegistry.observationRetention.sessions.map((s) => s.sessionId),
    ).not.toContain("removed");
    expect(fixture.root.sessionLayoutStore.focusedSessionHistory).not.toContain("removed");
    await fixture.publishProjects([other]);
    await fixture.publishSessions([
      sidebarSummary("retained", 2, { projectPath: "/other", workingDirectory: "/other" }),
    ]);
    await act(async () => fallback.resolve());
    await fixture.user.click(screen.getByRole("button", { name: "Settings" }));
    expect(await screen.findByRole("heading", { name: "Settings" })).toBeDefined();
  });

  it("retires an active Project Chat from the shared project layout on Remove only", async () => {
    const sessionId = `project-chat:${"a".repeat(64)}`;
    using fixture = renderSidebarNavigation({
      projects: [project],
      client: {
        electron: { showProjectContextMenu: async () => "remove-project" },
        workspaces: { removeProject: async () => defaultApplicationState() },
      },
    });
    await fixture.publishProjectChats([
      {
        sessionId,
        projectPath: "/cake",
        title: "Project Chat",
        createdAt: project.addedAt,
        modifiedAt: project.lastOpenedAt,
        messageCount: 0,
        resolved: false,
        unread: false,
      },
    ]);
    const projectButton = screen.getByRole("button", { name: "Open Project Chat for cake" });
    await fixture.user.click(projectButton);
    expect(document.querySelector(`[data-session-id="${sessionId}"]`)).not.toBeNull();
    await fixture.user.pointer({ target: projectButton, keys: "[MouseRight]" });
    const dialog = await screen.findByRole("alertdialog", { name: "Remove cake?" });
    await fixture.user.click(within(dialog).getByRole("button", { name: "Remove only" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(screen.getByRole("heading", { name: "What should we build?" })).toBeDefined();
    expect(fixture.root.sessionLayoutStore.focusedSessionHistory).not.toContain(sessionId);
    expect(fixture.root.cakeChatCollectionStore.registry.find(sessionId)).toBeUndefined();
  });

  it("shows a removal failure inside the confirmation and allows retry", async () => {
    const removeProject = vi
      .fn<Client["workspaces"]["removeProject"]>()
      .mockRejectedValueOnce(new Error("Project could not be removed"))
      .mockResolvedValueOnce(defaultApplicationState());
    using fixture = renderSidebarNavigation({
      projects: [project],
      sessions: [sidebarSummary("kept")],
      client: {
        electron: { showProjectContextMenu: async () => "remove-project" },
        workspaces: { removeProject },
      },
    });
    await fixture.user.pointer({
      target: screen.getByRole("button", { name: "Open Project Chat for cake" }),
      keys: "[MouseRight]",
    });
    const dialog = await screen.findByRole("alertdialog", { name: "Remove cake?" });
    await fixture.user.click(within(dialog).getByRole("button", { name: "Remove only" }));
    expect(await within(dialog).findByText("Project could not be removed")).toBeDefined();
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toHaveProperty(
      "disabled",
      false,
    );
    expect(screen.getByRole("button", { name: "Open Project Chat for cake" })).toBeDefined();
    await fixture.user.click(within(dialog).getByRole("button", { name: "Remove only" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(removeProject).toHaveBeenCalledTimes(2);
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

  it("archives and restores a saved Draft through the same Sessions rows without opening its runtime", async () => {
    const drafts = fakeSavedDrafts();
    await drafts.client.create({
      sessionId: "draft",
      projectPath: "/cake",
      title: "Saved plan",
      modifiedAt: "2026-01-31T00:00:00.000Z",
      text: "Later",
      attachments: [],
    });
    const open = vi.fn<Client["projectSessions"]["open"]>(async () => undefined);
    using fixture = renderSidebarNavigation({
      projects: [project],
      sessions: [sidebarSummary("root")],
      loadedIds: ["root"],
      client: { savedDrafts: drafts.client, projectSessions: { open } },
    });
    await fixture.selectSession("root");
    await fixture.showSessions();
    open.mockClear();
    expect(await screen.findByRole("button", { name: /^Saved plan / })).toBeTruthy();
    await fixture.user.click(screen.getByRole("button", { name: "Resolve Saved plan" }));
    await waitFor(() => expect(drafts.records.get("draft")?.resolved).toBe(true));
    expect(open).not.toHaveBeenCalled();
    await fixture.showSessions(true);
    await fixture.user.click(await screen.findByRole("button", { name: "Restore Saved plan" }));
    await waitFor(() => expect(drafts.records.get("draft")?.resolved).toBe(false));
    expect(open).not.toHaveBeenCalled();
  });
  it("renders live waiting/running/failure facts and worktree lifecycle metadata without truncating titles", async () => {
    const title =
      "A very long title that stays intact in the accessible navigation label instead of being shortened by test Store stubs";
    const sessions = [
      sidebarSummary("waiting"),
      sidebarSummary("running", 2),
      sidebarSummary("failed", 3, { workingDirectory: "/worktree" }),
      sidebarSummary("main", 4, { title }),
      sidebarSummary("green", 1, { unread: true }),
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
    await fixture.selectSession("waiting");
    await fixture.showSessions();
    expect(screen.getByRole("button", { name: new RegExp(`^${title} `) })).toBeDefined();
    expect(within(row("failed")).getByRole("img", { name: "Open worktree" })).toBeDefined();
    await fixture.publishWorktrees([{ ...worktree, state: "landed" }]);
    expect(within(row("failed")).getByRole("img", { name: "Merged worktree" })).toBeDefined();
    expect(within(row("failed")).getByText("fix")).toBeDefined();
    expect(within(row("failed")).getByText("base")).toBeDefined();
    const worktreeMetadata = row("failed").querySelector('[data-slot="session-description"]')!;
    expect(worktreeMetadata.querySelector("time")?.getAttribute("datetime")).toBe(
      sessions.find((session) => session.sessionId === "failed")!.modifiedAt,
    );
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
    expect(plainMetadata.querySelector("time")?.getAttribute("datetime")).toBe(
      sessions.find((session) => session.sessionId === "main")!.modifiedAt,
    );
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
    // Waiting still owns an active turn, so shares Working's priority below green.
    for (const id of ["waiting", "running", "failed"]) {
      // Hover/focus Resolve replaces every status dot, including active and failed turns.
      expect(within(row(id)).getByRole("button", { name: `Resolve ${id}` })).toBeDefined();
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
      await fixture.selectSession("retry");
      await fixture.showSessions();
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
});
