/** @vitest-environment jsdom */
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { applySnapshot } from "r-state-tree";
import { observer, StoreProvider } from "r-state-tree/react";
import { expect, it } from "vitest";
import { Effect, Layer, ManagedRuntime, Stream } from "effect";
import { defaultApplicationState } from "../../../src/contracts/application/application-data";
import { upsertProject } from "../../../src/domain/application/application";
import * as projectTodos from "../../../src/domain/projects/projectTodos";
import { projectTodoHandlers } from "../../../src/ipc/server/ProjectTodoHandlers";
import { ApplicationState } from "../../../src/services/storage/ApplicationState";
import { ApplicationStorage } from "../../../src/services/storage/ApplicationStorage";
import { SessionArchiveStorage } from "../../../src/services/storage/SessionArchiveStorage";
import { SessionFamilyStorage } from "../../../src/services/storage/SessionFamilyStorage";
import { CakeSessionRuntimes } from "../../../src/services/pi/CakeSessionRuntimes";
import { ManagedWorktrees } from "../../../src/services/worktrees/ManagedWorktrees";
import { ProjectSessionConfiguration } from "../../../src/services/project-sessions/ProjectSessionConfiguration";
import { sessionDirectoryPath } from "../../../src/services/storage/session-files";
import {
  emptyProjectTodos,
  projectTodoBaseline,
  type ProjectTodo,
  type ProjectTodos,
  type ProjectTodoUserMutation,
} from "../../../src/contracts/projects/project-todos";
import { localSnoozeDateTime } from "../../../src/renderer/lib/project-todo-snooze";
import { defaultProjectSettings } from "../../../src/contracts/application/application-data";
import type { AutoMergeRequest } from "../../../src/contracts/worktrees/auto-merge";
import { WorkspaceNavigator } from "../../../src/renderer/components/workspace-navigator";
import { ProjectRail } from "../../../src/renderer/components/project-rail";
import { ConversationActivity } from "../../../src/renderer/components/conversation-activity";
import { SidebarNavigationControls } from "../../../src/renderer/components/sidebar-navigation-controls";
import { applySessionCatalogGroupUpdate } from "../../../src/renderer/reducers/CatalogReducer";
import { applyWorktreeOperationCatalogUpdate } from "../../../src/renderer/reducers/WorktreeOperationReducer";
import { projectRecord, sessionSummary } from "./fixtures/catalog-fixtures";
import { createRendererStoreFixture } from "./renderer-store-fixture";

// A virtual section spans non-contiguous mounted rows in the pane's one list.
function todoSection(label: string) {
  const title = label.replace(/ to-dos$/, "");
  const pane = screen.getByRole("list", { name: "To-dos" });
  const queries = within(pane);
  expect(
    pane.querySelectorAll(`[data-todo-id][data-todo-section="${title}"]`).length,
  ).toBeGreaterThan(0);
  const inSection = (element: Element) =>
    element.closest("[data-todo-id]")?.getAttribute("data-todo-section") === title;
  const one = (elements: HTMLElement[]) => {
    expect(elements).toHaveLength(1);
    return elements[0]!;
  };
  return {
    getByRole: (...args: Parameters<typeof queries.getByRole>) =>
      one(queries.queryAllByRole(...args).filter(inSection)),
    queryByRole: (...args: Parameters<typeof queries.queryByRole>) => {
      const elements = queries.queryAllByRole(...args).filter(inSection);
      expect(elements.length).toBeLessThanOrEqual(1);
      return elements[0] ?? null;
    },
    getByText: (...args: Parameters<typeof queries.getByText>) =>
      one(queries.queryAllByText(...args).filter(inSection)),
    getAllByRole: (...args: Parameters<typeof queries.getAllByRole>) => {
      const elements = queries.queryAllByRole(...args).filter(inSection);
      expect(elements.length).toBeGreaterThan(0);
      return elements;
    },
    querySelector: <T extends Element = Element>(selector: string) =>
      Array.from(pane.querySelectorAll<T>(selector)).find(inSection) ?? null,
    querySelectorAll: (selector: string) =>
      Array.from(pane.querySelectorAll(selector)).filter(inSection),
  };
}

const projectChat = `project-chat:${"a".repeat(64)}`;
const todoRegions = () =>
  within(screen.getByRole("complementary", { name: "Workspace" })).queryAllByRole("region");

function renderTodos(
  withSidebar = false,
  initial?: {
    todos: ProjectTodos;
    sessions: ReturnType<typeof sessionSummary>[];
    autoMergeRequests?: AutoMergeRequest[];
    autoMergeEnabled?: boolean;
    startOpen?: boolean;
    reconcile?: (scope: string) => Promise<ProjectTodos>;
  },
) {
  let todos: ProjectTodos = initial?.todos ?? {
    ...emptyProjectTodos(),
    items: [
      {
        id: "00000000-0000-4000-8000-000000000011",
        title: "Investigate startup",
        description: "Find the startup bottleneck.",
        status: "Report delivered",
        state: "open",
        revision: 0,
        associations: [
          { kind: "session", sessionId: "first", title: "First investigation" },
          { kind: "session", sessionId: "second", title: "Second investigation" },
          { kind: "source", ref: "https://example.com/report", title: "Report" },
          { kind: "source", ref: "cake://session/third", title: "Related report only" },
        ],
      },
      {
        id: "00000000-0000-4000-8000-000000000012",
        title: "Follow up",
        description: "Plan the next step.",
        status: "",
        state: "open",
        revision: 0,
        associations: [{ kind: "session", sessionId: "third", title: "Follow-up session" }],
      },
    ],
  };
  const mutations: ProjectTodoUserMutation[] = [];
  const autoMergeChanges: boolean[] = [];
  const reconciliationScopes: string[] = [];
  let landing: "merge" | "pull-request" = "merge";
  const project = () => ({
    ...projectRecord({
      path: "/cake",
      settings: { ...defaultProjectSettings(), worktreeLanding: landing },
    }),
    todos,
  });
  const sessions =
    initial?.sessions ??
    (withSidebar ? ["first", "second", "third"] : ["first", "second"]).map((sessionId) =>
      sessionSummary({
        sessionId,
        projectPath: "/cake",
        workingDirectory: sessionId === "first" ? "/worktrees/investigation" : "/cake",
        latestTurnOutcome: "complete",
        unread: true,
      }),
    );
  const fixture = createRendererStoreFixture({
    projects: [project()],
    sessions,
    client: {
      managedWorktrees: {
        setAutoMerge: async (projectPath, enabled) => {
          expect(projectPath).toBe("/cake");
          autoMergeChanges.push(enabled);
          fixture.models.worktreeOperations.autoMergeProjects.splice(
            0,
            fixture.models.worktreeOperations.autoMergeProjects.length,
            { projectPath, enabled, epoch: "test", status: enabled ? "On" : "Off" },
          );
        },
      },
      projectTodos: {
        reconcile: async ({ scope }) => {
          reconciliationScopes.push(scope);
          if (initial?.reconcile) {
            todos = await initial.reconcile(scope);
            act(() => applySnapshot(fixture.models.projects, { projects: [project()] }));
          }
        },
        mutateUser: async ({ mutation }) => {
          mutations.push(mutation);
          if (mutation._tag === "Select") todos = { ...todos, selectedId: mutation.selectedId };
          if (mutation._tag === "SetState")
            todos = {
              ...todos,
              selectedId: todos.selectedId === mutation.id ? null : todos.selectedId,
              items: todos.items.map((item) => {
                if (item.id !== mutation.id) return item;
                const active = { ...item };
                delete active.snoozedUntil;
                return {
                  ...active,
                  state: mutation.state,
                  needsAttention: false,
                  revision: item.revision + 1,
                };
              }),
            };
          if (mutation._tag === "SetAttention")
            todos = {
              ...todos,
              items: todos.items.map((item) =>
                item.id === mutation.id
                  ? {
                      ...item,
                      needsAttention: mutation.needsAttention,
                      ...(mutation.attentionReason
                        ? { attentionReason: mutation.attentionReason }
                        : null),
                      revision: item.revision + 1,
                    }
                  : item,
              ),
            };
          if (mutation._tag === "Snooze" || mutation._tag === "Unsnooze")
            todos = {
              ...todos,
              selectedId: todos.selectedId === mutation.id ? null : todos.selectedId,
              items: todos.items.map((item) => {
                if (item.id !== mutation.id) return item;
                const active = { ...item };
                delete active.snoozedUntil;
                return {
                  ...active,
                  ...(mutation._tag === "Snooze" ? { snoozedUntil: mutation.until } : {}),
                  revision: item.revision + 1,
                };
              }),
            };
          applySnapshot(fixture.models.projects, { projects: [project()] });
          return todos;
        },
      },
    },
  });
  applySnapshot(fixture.models.worktreeOperations, {
    operations: [],
    autoMergeProjects: [
      {
        projectPath: "/cake",
        enabled: initial?.autoMergeEnabled ?? false,
        epoch: "test",
        status: "Off",
      },
    ],
    autoMergeRequests: initial?.autoMergeRequests ?? [],
  });
  applySnapshot(fixture.models.cakeChatCatalog, {
    loaded: true,
    sessions: [{ sessionId: projectChat, title: "Project Chat", projectPath: "/cake" }],
  });
  const store = fixture.root.cakeChatCollectionStore.registry.load(projectChat).todos;
  const { root } = fixture;
  root.navigationStore.selectCakeChat(projectChat);
  if (initial?.startOpen === false) root.workspaceNavigatorStore.close();
  else store.open();
  const Surface = observer(function Surface() {
    return (
      <>
        <ProjectRail />
        <ConversationActivity
          sessionId={projectChat}
          subagents={root.cakeChatCollectionStore.registry.load(projectChat).subagentActivityStore}
          sideChat={
            root.cakeChatCollectionStore.registry.load(projectChat).conversationSessionStore
              .sideChatStore
          }
          placement="strip"
        />
        <SidebarNavigationControls />
        {root.workspaceNavigatorStore.visible && <WorkspaceNavigator />}
      </>
    );
  });
  const view = render(
    <StoreProvider store={fixture.root}>
      <Surface />
    </StoreProvider>,
  );
  const user = userEvent.setup();
  let revision = 1;
  return {
    user,
    container: view.container,
    root,
    store,
    todos: () => todos,
    mutations,
    autoMergeChanges,
    reconciliationScopes,
    async updateLanding(value: "merge" | "pull-request") {
      landing = value;
      await act(async () => applySnapshot(fixture.models.projects, { projects: [project()] }));
    },
    async updateMergeRequests(requests: AutoMergeRequest[]) {
      await act(async () =>
        applyWorktreeOperationCatalogUpdate(fixture.models.worktreeOperations, {
          operations: [],
          autoMergeProjects: fixture.models.worktreeOperations.autoMergeProjects,
          autoMergeRequests: requests,
        }),
      );
    },
    async updateSessions(next: ReturnType<typeof sessionSummary>[]) {
      await act(async () =>
        applySnapshot(fixture.models.sessionCatalog, {
          sessions: next,
          resolvedHasMoreByProject: {},
        }),
      );
    },
    async updateTodos(next: ProjectTodos) {
      todos = next;
      await act(async () => applySnapshot(fixture.models.projects, { projects: [project()] }));
    },
    async associated() {
      const closed = Boolean(screen.queryByRole("button", { name: "Open Workspace" }));
      if (closed) await user.click(screen.getByRole("button", { name: "Open Workspace" }));
      await user.click(screen.getByRole("button", { name: /^Sessions / }));
      const ids = Array.from(
        view.container.querySelectorAll("[data-session-id][data-associated=true]"),
        (row) => row.getAttribute("data-session-id"),
      );
      await user.click(screen.getByRole("button", { name: /^To-dos / }));
      if (closed) await user.click(screen.getAllByRole("button", { name: "Close Workspace" })[0]!);
      return ids;
    },
    async status(changes: Partial<(typeof sessions)[number]>) {
      await act(async () =>
        applySnapshot(fixture.models.sessionCatalog, {
          sessions: [{ ...sessions[0]!, recoveryIssue: undefined, ...changes }, sessions[1]!],
          resolvedHasMoreByProject: {},
        }),
      );
    },
    async read() {
      await act(async () =>
        applySessionCatalogGroupUpdate(
          fixture.models.sessionCatalog,
          { projectPath: "/cake", resolved: false },
          {
            _tag: "Event",
            revision: ++revision,
            event: { _tag: "StatusChanged", sessionId: "first", unread: false, resolved: false },
          },
        ),
      );
    },
    [Symbol.dispose]() {
      view.unmount();
      fixture[Symbol.dispose]();
    },
  };
}

function mergeRequest(
  sessionId: string,
  overrides: Partial<AutoMergeRequest> = {},
): AutoMergeRequest {
  return {
    id: `turn-${sessionId}`,
    sessionId,
    workspacePath: `/worktrees/${sessionId}`,
    readyToMerge: true,
    epoch: "enabled-epoch",
    runId: "current-run",
    commit: "a".repeat(40),
    state: "ready",
    ...overrides,
  };
}

it("keeps the rail free of global Auto-merge and hides project Activity and to-do controls on a live external transition", async () => {
  using fixture = renderTodos(false, {
    todos: emptyProjectTodos(),
    sessions: [
      sessionSummary({
        sessionId: "running",
        projectPath: "/cake",
        running: true,
        cakeChatLaunch: { requesterSessionId: projectChat, launchedAt: "2026-01-01T00:00:00Z" },
      }),
    ],
    autoMergeEnabled: true,
  });
  expect(screen.getAllByRole("button", { name: "Auto-merge: on" }).length).toBeGreaterThan(0);
  await fixture.updateLanding("pull-request");
  expect(screen.queryByRole("button", { name: /Auto-merge/ })).toBeNull();
  expect(screen.queryByText("Auto-merge")).toBeNull();
  expect(fixture.root.autoMergeForProject("/cake")?.enabled).toBe(true);
  expect(fixture.autoMergeChanges).toEqual([]);
  await fixture.updateLanding("merge");
  expect(screen.getAllByRole("button", { name: "Auto-merge: on" }).length).toBeGreaterThan(0);
});

it("external projects do not present retained readiness as merge-ready, but keep actual failure details", async () => {
  const ready = todo(991, undefined, ["ready"]);
  using fixture = renderTodos(false, {
    todos: { ...emptyProjectTodos(), items: [ready] },
    sessions: [
      sessionSummary({ sessionId: "ready", projectPath: "/cake", latestTurnOutcome: "complete" }),
    ],
    autoMergeRequests: [mergeRequest("ready")],
  });
  expect(todoSection("Ready to Merge to-dos")).toBeDefined();
  await fixture.updateLanding("pull-request");
  expect(screen.queryByRole("list", { name: "Ready to Merge to-dos" })).toBeNull();
  expect(screen.queryByLabelText("Merge status for ready")).toBeNull();
  await fixture.updateMergeRequests([
    mergeRequest("ready", { state: "failed", message: "Target dirty" }),
  ]);
  expect(screen.getByLabelText("Merge status for ready").textContent).toContain("Target dirty");
});

it("repairs only the opened list through the real backend and projection, never while closed or on projection refresh", async () => {
  const resolved = new Set<string>();
  let indexReads = 0;
  const runtime = ManagedRuntime.make(
    Layer.mergeAll(
      ApplicationState.layer.pipe(
        Layer.provide(
          Layer.succeed(ApplicationStorage, {
            load: () =>
              Effect.succeed({ state: defaultApplicationState(), source: "current" as const }),
            save: () => Effect.void,
          }),
        ),
      ),
      Layer.mock(SessionArchiveStorage, {
        resolutionSnapshot: () =>
          Effect.sync(() => {
            indexReads++;
            return {
              version: 1 as const,
              directories: {
                [sessionDirectoryPath({ workingDirectory: "/cake", root: "/sessions" })]: [
                  ...resolved,
                ],
              },
            };
          }),
      }),
      Layer.mock(SessionFamilyStorage, {
        state: () => Effect.succeed({ families: [], turns: [], spawnedSessions: [] }),
      }),
      Layer.mock(CakeSessionRuntimes, { sessionIds: () => Stream.make("first", "second") }),
      Layer.mock(ManagedWorktrees, { records: () => Effect.succeed([]) }),
      Layer.succeed(ProjectSessionConfiguration, {
        agentDirectory: "/agent",
        sessionDirectory: "/sessions",
        resolvedSessionDirectory: "/resolved",
      }),
    ),
  );
  try {
    await runtime.runPromise(upsertProject("/cake", "Cake"));
    await runtime.runPromise(upsertProject("/other", "Other"));
    const item = await runtime.runPromise(
      projectTodos.create("/cake", {
        title: "Interrupted completion",
        description: "Resolved while closed.",
        associations: [{ kind: "session", sessionId: "first", title: "Work" }],
      }),
    );
    const other = await runtime.runPromise(
      projectTodos.create("/other", {
        title: "Untouched list",
        description: "Not accessed.",
        associations: [{ kind: "session", sessionId: "second", title: "Other work" }],
      }),
    );
    const initial = await runtime.runPromise(projectTodos.list("/cake"));
    using fixture = renderTodos(false, {
      todos: initial,
      sessions: [],
      startOpen: false,
      reconcile: async (scope) => {
        await runtime.runPromise(projectTodoHandlers["projectTodos.reconcile"]({ scope }));
        return runtime.runPromise(projectTodos.list(scope));
      },
    });
    expect(fixture.reconciliationScopes).toEqual([]);
    expect(indexReads).toBe(0);
    resolved.add("first");
    resolved.add("second");
    await fixture.user.click(screen.getByRole("button", { name: "Open Workspace" }));
    await waitFor(() =>
      expect(fixture.store.doneItems.map((value) => value.id)).toEqual([item.id]),
    );
    expect(fixture.reconciliationScopes).toEqual(["/cake"]);
    expect(indexReads).toBe(1);
    expect((await runtime.runPromise(projectTodos.read("/other", other.id))).state).toBe("open");
    await fixture.updateTodos(fixture.todos());
    expect(fixture.reconciliationScopes).toEqual(["/cake"]);
    await fixture.user.click(screen.getAllByRole("button", { name: "Close Workspace" })[0]!);
    await fixture.user.click(screen.getByRole("button", { name: "Open Workspace" }));
    await waitFor(() => expect(fixture.reconciliationScopes).toEqual(["/cake", "/cake"]));
    expect(indexReads).toBe(1); // Already done: reopening needs no session discovery.
  } finally {
    await runtime.dispose();
  }
});

it("shows repair failures without closing the pane or claiming completion, and retries on reopen", async () => {
  using fixture = renderTodos(false, {
    todos: { ...emptyProjectTodos(), items: [todo(501)] },
    sessions: [],
    startOpen: false,
    reconcile: async () => {
      throw new Error("Cannot read resolution metadata");
    },
  });
  await fixture.user.click(screen.getByRole("button", { name: "Open Workspace" }));
  await waitFor(() =>
    expect(screen.getByRole("alert").textContent).toContain("Cannot read resolution metadata"),
  );
  expect(fixture.store.openItems).toHaveLength(1);
  expect(fixture.mutations).toEqual([]);
  await fixture.user.click(screen.getAllByRole("button", { name: "Close Workspace" })[0]!);
  await fixture.user.click(screen.getByRole("button", { name: "Open Workspace" }));
  await waitFor(() => expect(fixture.reconciliationScopes).toHaveLength(2));
});

it("groups accepted structured declarations and retains them while auto-merge is off", async () => {
  const ready = todo(201, undefined, ["ready"]);
  const finished = {
    ...todo(202, undefined, ["finished"]),
    title: "Ready to Merge — finished checkpoint",
    status: "readyToMerge: true",
  };
  const pending = todo(203, undefined, ["pending"]);
  const revoked = todo(204, undefined, ["revoked"]);
  const sessions = ["ready", "finished", "pending", "revoked"].map((sessionId) =>
    sessionSummary({ sessionId, projectPath: "/cake", latestTurnOutcome: "complete" }),
  );
  const requests = [
    mergeRequest("ready", { state: "canceled", epoch: "", message: "Auto-merge is off" }),
    mergeRequest("pending", { state: "pending" }),
    mergeRequest("revoked"),
    mergeRequest("revoked", { id: "later-turn", readyToMerge: false, state: "canceled" }),
  ];
  using fixture = renderTodos(false, {
    todos: { ...emptyProjectTodos(), items: [ready, finished, pending, revoked] },
    sessions,
    autoMergeRequests: requests,
  });
  const readyList = () => todoSection("Ready to Merge to-dos");
  expect(readyList().getByRole("button", { name: ready.title })).toBeDefined();
  expect(readyList().querySelectorAll("[data-todo-id]")).toHaveLength(2);
  const active = todoSection("Active to-dos");
  for (const item of [finished, revoked])
    expect(active.getByRole("button", { name: item.title })).toBeDefined();
  await fixture.updateSessions(sessions.map((session) => ({ ...session, unread: true })));
  await fixture.updateSessions(sessions);
  await fixture.updateMergeRequests(requests);
  expect(readyList().getByRole("button", { name: ready.title })).toBeDefined();
  expect(screen.getByLabelText("Merge status for ready").textContent).toContain(
    "Auto-merge is off",
  );
  await fixture.updateMergeRequests(
    requests.map((request) =>
      request.sessionId === "pending" ? { ...request, state: "ready" } : request,
    ),
  );
  expect(readyList().getByRole("button", { name: pending.title })).toBeDefined();
  await fixture.updateMergeRequests(
    requests.map((request) =>
      request.sessionId === "ready" || request.sessionId === "pending"
        ? { ...request, readyToMerge: false }
        : request,
    ),
  );
  expect(screen.queryByRole("region", { name: "Ready to Merge" })).toBeNull();
  expect(
    todoSection("Active to-dos").getByRole("button", {
      name: ready.title,
    }),
  ).toBeDefined();
  expect(fixture.autoMergeChanges).toEqual([]);
  expect(fixture.mutations).toEqual([]);
});

it("orders Ready to Merge between attention and Active, preserves collapse, and omits Auto-merge even when empty", async () => {
  const ready = todo(211, undefined, ["ready"]);
  using fixture = renderTodos(false, {
    todos: {
      ...emptyProjectTodos(),
      items: [
        { ...todo(210), needsAttention: true, attentionReason: "Review this" },
        ready,
        todo(212),
        { ...todo(213), snoozedUntil: "2099-01-01T00:00:00.000Z" },
        { ...todo(214), state: "done" },
      ],
    },
    sessions: [sessionSummary({ sessionId: "ready", projectPath: "/cake" })],
    autoMergeRequests: [mergeRequest("ready")],
  });
  expect(todoRegions().map((region) => region.getAttribute("aria-label"))).toEqual([
    "Needs attention",
    "Ready to Merge",
    "Active",
    "Snoozed",
    "Done",
  ]);
  const workspace = () => within(screen.getByRole("complementary", { name: "Workspace" }));
  const toggle = () => workspace().queryByRole("button", { name: /Auto-merge/ });
  expect(toggle()).toBeNull();
  expect(
    within(screen.getByRole("navigation", { name: "Projects and global utilities" })).queryByRole(
      "button",
      { name: /Auto-merge/ },
    ),
  ).toBeNull();
  expect(fixture.autoMergeChanges).toEqual([]);
  await fixture.user.click(screen.getByRole("button", { name: "Ready to Merge (1)" }));
  expect(screen.queryByRole("list", { name: "Ready to Merge to-dos" })).toBeNull();
  expect(toggle()).toBeNull();
  const search = screen.getByRole("searchbox", { name: "Search to-dos" });
  await fixture.user.type(search, "no matching task");
  expect(todoRegions()).toHaveLength(0);
  expect(toggle()).toBeNull();
  await fixture.user.clear(search);
  expect(
    screen.getByRole("button", { name: "Ready to Merge (1)" }).getAttribute("aria-expanded"),
  ).toBe("false");
  await fixture.user.click(screen.getByRole("button", { name: "Ready to Merge (1)" }));
  expect(screen.getByRole("button", { name: ready.title })).toBeDefined();
  await fixture.updateTodos(emptyProjectTodos());
  expect(todoRegions()).toHaveLength(0);
  expect(screen.getByRole("status").textContent).toBe("No to-dos.");
  expect(toggle()).toBeNull();
  expect(fixture.mutations).toEqual([]);
});

it("Activity retains Auto-merge control without adding it to Ready to Merge or changing ready work", async () => {
  using fixture = renderTodos(false, {
    todos: { ...emptyProjectTodos(), items: [todo(219, undefined, ["ready"])] },
    sessions: [
      sessionSummary({ sessionId: "ready", projectPath: "/cake" }),
      sessionSummary({
        sessionId: "running",
        projectPath: "/cake",
        running: true,
        cakeChatLaunch: {
          requesterSessionId: projectChat,
          launchedAt: "2026-01-01T00:00:00Z",
        },
      }),
    ],
    autoMergeRequests: [mergeRequest("ready")],
  });
  const activity = screen.getByRole("button", { name: "Activity · 1 running" });
  const bar = within(activity.parentElement!);
  const readyControl = () =>
    within(screen.getByRole("complementary", { name: "Workspace" })).queryByRole("button", {
      name: /Auto-merge/,
    });
  expect(bar.queryByText("Auto-merge off")).toBeNull();
  expect(bar.getByRole("button", { name: "Auto-merge: off" }).textContent).toBe("");
  await fixture.user.click(activity);
  await fixture.user.click(bar.getByRole("button", { name: "Auto-merge: off" }));
  expect(fixture.autoMergeChanges).toEqual([true]);
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(readyControl()).toBeNull();
  expect(activity.getAttribute("aria-expanded")).toBe("true");
  await fixture.user.click(bar.getByRole("button", { name: "Auto-merge: on" }));
  expect(fixture.autoMergeChanges).toEqual([true, false]);
  expect(bar.getByRole("button", { name: "Auto-merge: off" }).getAttribute("aria-pressed")).toBe(
    "false",
  );
  expect(todoSection("Ready to Merge to-dos")).toBeDefined();
  expect(fixture.mutations).toEqual([]);
});

it("keeps blocked and failed landings visible and reports partial resolution without claiming success", async () => {
  const item = todo(221, undefined, ["ready", "other"]);
  const sessions = ["ready", "other"].map((sessionId) =>
    sessionSummary({ sessionId, projectPath: "/cake" }),
  );
  using fixture = renderTodos(false, {
    todos: { ...emptyProjectTodos(), items: [item] },
    sessions,
    autoMergeRequests: [mergeRequest("ready")],
    autoMergeEnabled: true,
  });
  for (const [request, text] of [
    [
      mergeRequest("ready", { state: "canceled", message: "Blocked by active family member" }),
      "Blocked by active family member",
    ],
    [mergeRequest("ready", { state: "landing" }), "Landing…"],
    [
      mergeRequest("ready", { state: "failed", message: "Conflicting target changes" }),
      "Merge failed: Conflicting target changes",
    ],
    [
      mergeRequest("ready", {
        state: "failed",
        outcome: {
          targetBranch: "main",
          landedCommit: "b".repeat(40),
          merged: true,
          resolutionSucceeded: false,
          message: "Family resolution failed",
        },
      }),
      "Merged; resolution failed: Family resolution failed",
    ],
  ] as const) {
    await fixture.updateMergeRequests([request]);
    const list = todoSection("Ready to Merge to-dos");
    expect(list.getByRole("button", { name: item.title })).toBeDefined();
    expect(list.getByRole("link", { name: "ready" }).getAttribute("href")).toBe(
      "cake://session/ready",
    );
    expect(screen.getByLabelText("Merge status for ready").textContent).toContain(text);
    expect(screen.queryByRole("list", { name: "Active to-dos" })).toBeNull();
    expect(screen.queryByRole("region", { name: "Done" })).toBeNull();
  }
  await fixture.updateSessions([{ ...sessions[0]!, resolved: true }, sessions[1]!]);
  expect(screen.getByLabelText("Merge status for ready").textContent).toBe(
    "Merged; resolution failed: Family resolution failed",
  );
  expect(
    todoSection("Ready to Merge to-dos").getByRole("button", {
      name: item.title,
    }),
  ).toBeDefined();
  expect(fixture.todos().items[0]!.state).toBe("open");
  expect(fixture.mutations).toEqual([]);
});

it("waits for every associated session and removes successful work only through authoritative to-do resolution", async () => {
  const item = todo(231, undefined, ["first", "second"]);
  const sessions = ["first", "second"].map((sessionId) =>
    sessionSummary({ sessionId, projectPath: "/cake" }),
  );
  using fixture = renderTodos(false, {
    todos: { ...emptyProjectTodos(), items: [item] },
    sessions,
    autoMergeRequests: [mergeRequest("first")],
  });
  const landed = mergeRequest("first", {
    state: "landed",
    outcome: {
      targetBranch: "main",
      merged: true,
      resolutionSucceeded: true,
      message: "Merged and resolved",
    },
  });
  await fixture.updateMergeRequests([landed]);
  await fixture.updateSessions([{ ...sessions[0]!, resolved: true }, sessions[1]!]);
  expect(
    todoSection("Active to-dos").getByRole("button", {
      name: item.title,
    }),
  ).toBeDefined();
  expect(fixture.todos().items[0]!.state).toBe("open");
  await fixture.updateMergeRequests([landed, mergeRequest("second")]);
  expect(
    todoSection("Ready to Merge to-dos").getByRole("button", {
      name: item.title,
    }),
  ).toBeDefined();
  await fixture.updateMergeRequests([landed, mergeRequest("second", { state: "landed" })]);
  expect(fixture.todos().items[0]!.state).toBe("open");
  await fixture.updateSessions(sessions.map((session) => ({ ...session, resolved: true })));
  await fixture.updateTodos({
    ...emptyProjectTodos(),
    items: [{ ...item, state: "done", revision: 1, completion: { revision: 1, by: "sessions" } }],
  });
  expect(screen.queryByRole("region", { name: "Ready to Merge" })).toBeNull();
  await fixture.user.click(screen.getByRole("button", { name: "Done (1)" }));
  expect(
    todoSection("Done to-dos").getByRole("button", {
      name: item.title,
    }),
  ).toBeDefined();
  expect(fixture.mutations).toEqual([]);
});

it("preserves flags, snooze and focus without duplicate rows and shows every ready linked session", async () => {
  const attention = {
    ...todo(241, undefined, ["first", "second"]),
    needsAttention: true,
    attentionReason: "Review the findings",
  };
  const snoozed = { ...todo(242, undefined, ["third"]), snoozedUntil: "2099-01-01T00:00:00.000Z" };
  using fixture = renderTodos(false, {
    todos: { ...emptyProjectTodos(), items: [attention, snoozed] },
    sessions: ["first", "second", "third"].map((sessionId) =>
      sessionSummary({ sessionId, projectPath: "/cake" }),
    ),
    autoMergeRequests: [mergeRequest("first"), mergeRequest("second"), mergeRequest("third")],
  });
  expect(todoRegions().map((region) => region.getAttribute("aria-label"))).toEqual([
    "Needs attention",
    "Snoozed",
  ]);
  for (const sessionId of ["first", "second", "third"])
    expect(screen.getByLabelText(`Merge status for ${sessionId}`).textContent).toBe(
      "Ready to Merge",
    );
  expect(fixture.todos().items[0]).toMatchObject({
    needsAttention: true,
    attentionReason: attention.attentionReason,
  });
  await fixture.user.click(
    screen.getByRole("button", { name: `Dismiss attention: ${attention.title}` }),
  );
  const ready = () => todoSection("Ready to Merge to-dos");
  expect(ready().getByRole("button", { name: attention.title })).toBeDefined();
  await fixture.user.click(screen.getByRole("button", { name: attention.title }));
  expect(
    todoSection("Focus to-dos").getByRole("button", {
      name: attention.title,
    }),
  ).toBeDefined();
  expect(screen.getByLabelText("Merge status for second").textContent).toBe("Ready to Merge");
  await fixture.user.click(
    screen.getByRole("button", { name: `Unfocus to-do: ${attention.title}` }),
  );
  expect(ready().getByRole("button", { name: attention.title })).toBeDefined();
  for (const item of [attention, snoozed])
    expect(fixture.container.querySelectorAll(`[data-todo-id="${item.id}"]`)).toHaveLength(1);
  expect(fixture.mutations.map((mutation) => mutation._tag)).toEqual(["SetAttention"]);
});

it("counts accepted declarations while completion/handoff is pending, independently of unread state", async () => {
  const sessions = ["first", "second"].map((sessionId) =>
    sessionSummary({ sessionId, projectPath: "/cake", unread: true }),
  );
  using fixture = renderTodos(false, {
    todos: {
      ...emptyProjectTodos(),
      items: [todo(249, undefined, ["first"]), todo(250, undefined, ["second"])],
    },
    sessions,
    autoMergeRequests: [
      mergeRequest("first", { state: "pending", message: "Waiting for task completion" }),
      mergeRequest("second", { message: "Waiting for result handoff" }),
    ],
  });
  expect(screen.getByRole("button", { name: "Ready to Merge (2)" })).toBeDefined();
  expect(screen.getByLabelText("Merge status for second").textContent).toContain(
    "Waiting for result handoff",
  );
  await fixture.updateSessions(sessions.map((session) => ({ ...session, unread: false })));
  expect(screen.getByRole("button", { name: "Ready to Merge (2)" })).toBeDefined();
  expect(screen.getByLabelText("Merge status for first").textContent).toContain(
    "Waiting for task completion",
  );
});

it("renders only nonempty categories with separators between visible sections and preserves disclosure across filtering", async () => {
  using fixture = renderTodos(false, { todos: emptyProjectTodos(), sessions: [] });
  const categories = ["Needs attention", "Active", "Snoozed", "Done"];
  const visibleCategories = () => todoRegions().map((region) => region.getAttribute("aria-label"));
  expect(visibleCategories()).toEqual([]);
  expect(screen.getByRole("status").textContent).toBe("No to-dos.");

  const items: ProjectTodo[] = [
    { ...todo(100), needsAttention: true, attentionReason: "Review the findings" },
    todo(101),
    { ...todo(102), snoozedUntil: "2099-01-01T00:00:00.000Z" },
    { ...todo(103), state: "done" },
  ];
  await fixture.updateTodos({ ...emptyProjectTodos(), items });
  expect(visibleCategories()).toEqual(categories);
  expect(screen.queryByRole("status")).toBeNull();
  expect(screen.getByRole("heading", { name: "Needs attention 1" })).toBeDefined();
  for (const category of categories.slice(1)) {
    expect(screen.getByRole("region", { name: category }).className).toContain("border-t");
    expect(screen.getByRole("button", { name: `${category} (1)` })).toBeDefined();
  }
  await fixture.user.click(screen.getByRole("button", { name: "Active (1)" }));
  const search = screen.getByRole("searchbox", { name: "Search to-dos" });
  for (const [index, category] of categories.entries()) {
    await fixture.user.clear(search);
    await fixture.user.type(search, items[index]!.title);
    expect(visibleCategories()).toEqual([category]);
    expect(screen.getByRole("region", { name: category }).className).not.toMatch(
      /\b(mt-4|border-t|pt-2)\b/,
    );
    expect(screen.queryByRole("status")).toBeNull();
  }
  await fixture.user.clear(search);
  await fixture.user.type(search, "no such task");
  expect(visibleCategories()).toEqual([]);
  expect(screen.getByRole("status").textContent).toBe("No matching to-dos.");
  await fixture.user.clear(search);
  expect(visibleCategories()).toEqual(categories);
  expect(screen.getByRole("button", { name: "Active (1)" }).getAttribute("aria-expanded")).toBe(
    "false",
  );
  expect(screen.queryByRole("list", { name: "Active to-dos" })).toBeNull();
  await fixture.user.click(screen.getByRole("button", { name: "Active (1)" }));
  expect(screen.getByRole("button", { name: items[1]!.title })).toBeDefined();
  expect(fixture.todos().items).toEqual(items);
  expect(fixture.mutations).toEqual([]);
  await fixture.updateTodos(emptyProjectTodos());
  expect(visibleCategories()).toEqual([]);
  expect(screen.getByRole("status").textContent).toBe("No to-dos.");
});

it("presents workspace attention in occurrence FIFO order, including filtered results", async () => {
  const items = [3, 1, 4, 2].map((sequence, index) => ({
    ...todo(200 + index, `2026-01-0${index + 1}T00:00:00.000Z`),
    title: `Request ${sequence}`,
    needsAttention: true,
    attentionReason: `Review finding ${sequence}`,
    attentionSequence: sequence,
  }));
  using fixture = renderTodos(false, { todos: { ...emptyProjectTodos(), items }, sessions: [] });
  const titles = () =>
    todoSection("Needs attention to-dos")
      .getAllByRole("listitem")
      .map((row) => row.getAttribute("data-todo-id"));
  expect(titles()).toEqual([items[1]!.id, items[3]!.id, items[0]!.id, items[2]!.id]);
  await fixture.updateTodos({
    ...fixture.todos(),
    items: items.map((item, index) =>
      index === 3 ? { ...item, modifiedAt: "2027-01-01T00:00:00.000Z", revision: 1 } : item,
    ),
  });
  expect(titles()).toEqual([items[1]!.id, items[3]!.id, items[0]!.id, items[2]!.id]);
  await fixture.user.type(screen.getByRole("searchbox", { name: "Search to-dos" }), "finding");
  expect(titles()).toEqual([items[1]!.id, items[3]!.id, items[0]!.id, items[2]!.id]);
});

it("shows action-first requests, dismisses without selection/lifecycle effects, restores, and hides retained reasons from search", async () => {
  const item = {
    ...todo(100),
    title: "Startup investigation",
    needsAttention: true,
    attentionReason: "Review the startup findings",
    associations: [
      { kind: "source" as const, ref: "https://example.com/report", title: "Findings" },
    ],
  };
  using fixture = renderTodos(false, {
    todos: {
      ...emptyProjectTodos(),
      items: [
        item,
        todo(101),
        { ...todo(102), snoozedUntil: "2099-01-01T00:00:00.000Z" },
        { ...todo(103), state: "done" },
      ],
    },
    sessions: [],
  });
  const attention = () => todoSection("Needs attention to-dos");
  expect(attention().getByRole("button", { name: item.title }).textContent).toBe(item.title);
  expect(attention().querySelector(`[data-todo-id="${item.id}"]`)?.textContent).toContain(
    item.attentionReason,
  );
  expect(attention().getByRole("link", { name: "Findings" })).toBeDefined();
  expect(todoRegions().map((region) => region.getAttribute("aria-label"))).toEqual([
    "Needs attention",
    "Active",
    "Snoozed",
    "Done",
  ]);
  await fixture.user.click(screen.getByRole("button", { name: item.title }));
  const selection = fixture.todos().selectedId;
  expect(
    screen.getAllByRole("button", { name: /^(Unfocus to-do|Dismiss attention):/ }),
  ).toHaveLength(1);
  await fixture.user.click(screen.getByRole("button", { name: `Unfocus to-do: ${item.title}` }));
  expect(fixture.todos().selectedId).toBe(selection);
  expect(fixture.todos().items[0]).toMatchObject({
    state: "open",
    needsAttention: true,
    attentionReason: item.attentionReason,
  });
  expect(fixture.mutations).toEqual([]);
  expect(attention().getByRole("button", { name: item.title })).toBeDefined();
  expect(
    screen.getAllByRole("button", { name: /^(Unfocus to-do|Dismiss attention):/ }),
  ).toHaveLength(1);
  await fixture.user.click(
    screen.getByRole("button", { name: `Dismiss attention: ${item.title}` }),
  );
  expect(screen.getByRole("button", { name: item.title }).getAttribute("aria-pressed")).toBe(
    "false",
  );
  expect(fixture.todos().selectedId).toBe(selection);
  expect(fixture.todos().items[0]).toMatchObject({
    state: "open",
    needsAttention: false,
    attentionReason: item.attentionReason,
  });
  expect(fixture.mutations.map((mutation) => mutation._tag)).toEqual(["SetAttention"]);
  expect(screen.queryByRole("region", { name: "Needs attention" })).toBeNull();
  await fixture.user.click(screen.getByRole("button", { name: item.title }));
  const row = todoSection("Focus to-dos").getByRole("button", {
    name: item.title,
  });
  expect(row.textContent).not.toContain(item.attentionReason);
  const search = screen.getByRole("searchbox", { name: "Search to-dos" });
  await fixture.user.type(search, "startup findings");
  expect(screen.queryByRole("button", { name: item.title })).toBeNull();
  await fixture.user.clear(search);
  await fixture.user.pointer({
    target: screen.getByRole("button", { name: item.title }),
    keys: "[MouseRight]",
  });
  await fixture.user.click(screen.getByRole("menuitem", { name: "Restore needs attention" }));
  expect(todoSection("Focus to-dos").getByText(item.attentionReason)).toBeDefined();
  expect(fixture.todos().selectedId).toBe(selection);
  await fixture.user.click(screen.getByRole("button", { name: "Active (1)" }));
  await fixture.user.click(screen.getByRole("button", { name: "Done (1)" }));
  expect(screen.getByRole("button", { name: "Snoozed (1)" }).getAttribute("aria-expanded")).toBe(
    "true",
  );
  expect(todoSection("Focus to-dos").getByText(item.attentionReason)).toBeDefined();
});

it("labels Needs attention rows by title and shows only informative reasons beneath", () => {
  const items = [
    { ...todo(100), title: "Clean up title-bar icons", attentionReason: "Open linked result" },
    {
      ...todo(101),
      title: "Queued attention items",
      attentionReason: "Open result: Queued attention items",
    },
    { ...todo(102), title: "Pick a sidebar layout", attentionReason: "Choose sidebar or tabs" },
  ].map((item) => ({ ...item, needsAttention: true }));
  using _fixture = renderTodos(false, {
    todos: { ...emptyProjectTodos(), items },
    sessions: [],
  });
  const list = todoSection("Needs attention to-dos");
  const [generic, named, custom] = items.map((item) => {
    const row = list.querySelector<HTMLElement>(`[data-todo-id="${item.id}"]`)!;
    expect(within(row).getByRole("button", { name: item.title }).textContent).toBe(item.title);
    return row.textContent;
  });
  expect(generic).not.toContain("Open linked result");
  expect(named).not.toContain("Open result");
  expect(custom).toContain("Choose sidebar or tabs");
});

it("places Focus above the other four sections without duplicating focused rows", async () => {
  using fixture = renderTodos(false, {
    todos: {
      ...emptyProjectTodos(),
      items: [
        { ...todo(100), needsAttention: true, attentionReason: "Review this" },
        todo(101),
        todo(102),
        { ...todo(103), snoozedUntil: "2099-01-01T00:00:00.000Z" },
        { ...todo(104), state: "done" },
      ],
    },
    sessions: [],
  });
  await fixture.user.click(screen.getByRole("button", { name: "Task 101" }));
  await waitFor(() =>
    expect(todoRegions().map((region) => region.getAttribute("aria-label"))).toEqual([
      "Focus",
      "Needs attention",
      "Active",
      "Snoozed",
      "Done",
    ]),
  );
  expect(fixture.container.querySelectorAll(`[data-todo-id="${todo(101).id}"]`)).toHaveLength(1);
  expect(
    todoSection("Focus to-dos").getByRole("button", {
      name: "Task 101",
    }),
  ).toBeDefined();
});

it("restores underlying sections on row toggle or explicit unfocus and preserves attachments and item state", async () => {
  const items: ProjectTodo[] = [
    { ...todo(100), needsAttention: true, attentionReason: "Review this" },
    todo(101),
    { ...todo(102), snoozedUntil: "2099-01-01T00:00:00.000Z", needsAttention: true },
    { ...todo(103), state: "done" },
  ];
  using fixture = renderTodos(false, { todos: { ...emptyProjectTodos(), items }, sessions: [] });
  await fixture.user.click(screen.getByRole("button", { name: "Done (1)" }));
  const focus = () => todoSection("Focus to-dos");
  await fixture.user.click(screen.getByRole("button", { name: items[0]!.title }));
  expect(focus().getAllByRole("button", { name: /^Unfocus to-do:/ })).toHaveLength(1);
  expect(todoRegions().map((region) => region.getAttribute("aria-label"))).toEqual([
    "Focus",
    "Active",
    "Snoozed",
    "Done",
  ]);
  const draft =
    fixture.root.cakeChatCollectionStore.registry.load(projectChat).conversationSessionStore
      .composerStore.draftStore;
  expect(draft.attachments).toHaveLength(0);
  await fixture.user.click(
    focus().getByRole("button", { name: `Attach to-do as context: ${items[0]!.title}` }),
  );
  expect(draft.attachments).toHaveLength(1);
  expect(fixture.store.focusedItems).toHaveLength(1);
  expect(fixture.todos().items).toEqual(items);
  // Attach an unfocused task without focusing it; removing view focus never removes context.
  for (const [index, section] of ["Needs attention", "Active", "Snoozed", "Done"].entries()) {
    const item = items[index]!;
    if (index > 0) await fixture.user.click(screen.getByRole("button", { name: item.title }));
    await fixture.user.click(
      screen.getByRole("button", {
        name: index === 0 ? `Unfocus to-do: ${item.title}` : item.title,
      }),
    );
    expect(
      todoSection(`${section} to-dos`)
        .getByRole("button", { name: item.title })
        .getAttribute("aria-pressed"),
    ).toBe("false");
    expect(draft.attachments).toHaveLength(1);
  }
  await fixture.user.click(
    screen.getByRole("button", { name: `Attach to-do as context: ${items[1]!.title}` }),
  );
  expect(draft.attachments).toHaveLength(2);
  expect(fixture.store.focusedItems).toEqual([]);
  expect(fixture.todos().items).toEqual(items);
  expect(fixture.mutations).toEqual([]);
});

it("uses a manual reason editor for Mark/Edit, rejects blank, supports cancel, and keeps snooze precedence", async () => {
  const item = todo(100);
  using fixture = renderTodos(false, {
    todos: { ...emptyProjectTodos(), items: [item] },
    sessions: [],
  });
  const menu = async (label: string) => {
    await fixture.user.pointer({
      target: screen.getByRole("button", { name: item.title }),
      keys: "[MouseRight]",
    });
    await fixture.user.click(screen.getByRole("menuitem", { name: label }));
  };
  await menu("Mark needs attention…");
  await fixture.user.click(screen.getByRole("button", { name: /^Add$/ }));
  expect(screen.getByRole("alert").textContent).toContain("Enter what needs your attention");
  expect(fixture.mutations).toHaveLength(0);
  await fixture.user.type(
    screen.getByRole("textbox", { name: "What needs your attention?" }),
    "Choose sidebar or tabs",
  );
  await fixture.user.click(screen.getByRole("button", { name: /^Add$/ }));
  expect(fixture.mutations.at(-1)).toMatchObject({
    _tag: "SetAttention",
    needsAttention: true,
    attentionReason: "Choose sidebar or tabs",
  });
  await menu("Edit attention reason…");
  expect(
    (screen.getByRole("textbox", { name: "What needs your attention?" }) as HTMLInputElement).value,
  ).toBe("Choose sidebar or tabs");
  await fixture.user.click(screen.getByRole("button", { name: "Cancel" }));
  expect(fixture.mutations).toHaveLength(1);
  await menu("Edit attention reason…");
  const input = screen.getByRole("textbox", { name: "What needs your attention?" });
  await fixture.user.clear(input);
  await fixture.user.type(input, "Review the change before merging");
  await fixture.user.click(screen.getByRole("button", { name: /^Save$/ }));
  await fixture.user.pointer({
    target: screen.getByRole("button", { name: item.title }),
    keys: "[MouseRight]",
  });
  await fixture.user.click(screen.getByRole("menuitem", { name: /^Snooze$/ }));
  await fixture.user.click(screen.getByRole("menuitem", { name: "15 minutes" }));
  expect(
    todoSection("Snoozed to-dos").getByRole("button", {
      name: item.title,
    }),
  ).toBeDefined();
  expect(fixture.todos().items[0]?.needsAttention).toBe(true);
  expect(screen.queryByRole("region", { name: "Needs attention" })).toBeNull();
  await fixture.user.pointer({
    target: screen.getByRole("button", { name: item.title }),
    keys: "[MouseRight]",
  });
  await fixture.user.click(screen.getByRole("menuitem", { name: "Unsnooze" }));
  expect(
    todoSection("Needs attention to-dos").getByText("Review the change before merging"),
  ).toBeDefined();
  await fixture.user.click(screen.getByRole("button", { name: `Mark done: ${item.title}` }));
  await fixture.user.click(screen.getByRole("button", { name: "Done (1)" }));
  await fixture.user.click(screen.getByRole("button", { name: `Reopen: ${item.title}` }));
  expect(
    todoSection("Active to-dos").getByRole("button", {
      name: item.title,
    }),
  ).toBeDefined();
});

function todo(id: number, createdAt?: string, sessionIds: string[] = []): ProjectTodo {
  return {
    id: `00000000-0000-4000-8000-${String(id).padStart(12, "0")}`,
    title: `Task ${id}`,
    description: "Latest finding.",
    status: "",
    state: "open",
    revision: 0,
    ...(createdAt ? { createdAt } : {}),
    associations: sessionIds.map((sessionId) => ({ kind: "session", sessionId, title: sessionId })),
  };
}

it("virtualizes thousands of Done rows in the pane's one list and excludes collapsed sections", async () => {
  const done = Array.from({ length: 5000 }, (_, index): ProjectTodo => ({
    ...todo(index + 1000),
    state: "done",
  }));
  using fixture = renderTodos(false, {
    todos: { ...emptyProjectTodos(), items: [todo(1), ...done] },
    sessions: [],
  });
  const pane = screen.getByRole("list", { name: "To-dos" });
  expect(pane.querySelectorAll('[data-todo-section="Done"]')).toHaveLength(0);
  expect(pane.querySelector("[aria-setsize]")?.getAttribute("aria-setsize")).toBe("3");
  await fixture.user.click(screen.getByRole("button", { name: "Active (1)" }));
  expect(pane.querySelectorAll('[data-todo-section="Active"]')).toHaveLength(0);
  expect(pane.querySelector("[aria-setsize]")?.getAttribute("aria-setsize")).toBe("2");
  await fixture.user.click(screen.getByRole("button", { name: "Active (1)" }));
  await fixture.user.click(screen.getByRole("button", { name: "Done (5000)" }));
  await waitFor(() => {
    const mounted = pane.querySelectorAll("[data-todo-id]").length;
    expect(mounted).toBeGreaterThan(1);
    expect(mounted).toBeLessThan(150);
  });
  expect(pane.querySelector("[aria-setsize]")?.getAttribute("aria-setsize")).toBe("5003");
  expect(fixture.container.querySelectorAll('[data-slot="todo-scroll-pane"]')).toHaveLength(1);
  expect(pane.querySelectorAll('[role="list"]')).toHaveLength(0);
  // Reveal must reach an unmounted row by key, not by querying the current DOM.
  const last = done[0]!;
  await act(async () => fixture.store.reveal(last));
  await waitFor(() => expect(screen.getByRole("button", { name: last.title })).toBeDefined());
  await fixture.updateTodos({
    ...fixture.todos(),
    items: [...fixture.todos().items, { ...todo(9000), state: "done" }],
  });
  expect(pane.querySelectorAll("[data-todo-id]").length).toBeLessThan(150);
  // A background update must not replay the completed reveal.
  expect(fixture.store.paneRequest).toBeUndefined();
  await act(async () => fixture.store.toggleDone());
  await waitFor(() => expect(pane.querySelectorAll('[data-todo-section="Done"]')).toHaveLength(0));
  expect(pane.querySelector("[aria-setsize]")?.getAttribute("aria-setsize")).toBe("3");
});

const activityTime = (day: number) => `2026-02-${String(day).padStart(2, "0")}T00:00:00.000Z`;
const openOrder = () =>
  Array.from(todoSection("Active to-dos").querySelectorAll("[data-todo-id]"), (row) =>
    row.getAttribute("data-todo-id"),
  );

it("keeps attention FIFO and other sections newest-created first through additions and search", async () => {
  const categories = ["Needs attention", "Active", "Snoozed", "Done"];
  const inSection = (item: ProjectTodo, section: number): ProjectTodo =>
    section === 0
      ? { ...item, needsAttention: true, attentionReason: "Review this finding" }
      : section === 2
        ? { ...item, snoozedUntil: "2099-01-01T00:00:00.000Z" }
        : section === 3
          ? { ...item, state: "done" }
          : item;
  // Deliberately neither creation nor ID order.
  const items = categories.flatMap((_, section) =>
    [2, 1, 3].map((day) => inSection(todo(section * 10 + day, activityTime(day)), section)),
  );
  using fixture = renderTodos(false, {
    todos: { ...emptyProjectTodos(), items },
    sessions: [],
  });
  await fixture.user.click(screen.getByRole("button", { name: "Done (3)" }));
  const sectionOrder = (category: string) =>
    Array.from(todoSection(`${category} to-dos`).querySelectorAll("[data-todo-id]"), (row) =>
      row.getAttribute("data-todo-id"),
    );
  const checkOrder = (days: number[], attentionDays: number[]) => {
    expect(todoRegions().map((region) => region.getAttribute("aria-label"))).toEqual(categories);
    categories.forEach((category, section) =>
      expect(sectionOrder(category)).toEqual(
        (section === 0 ? attentionDays : days).map((day) => todo(section * 10 + day).id),
      ),
    );
  };
  checkOrder([3, 2, 1], [2, 1, 3]);
  const additions = categories.map((_, section) =>
    inSection(todo(section * 10 + 4, activityTime(4)), section),
  );
  await fixture.updateTodos({ ...fixture.todos(), items: [...items, ...additions] });
  await waitFor(() => checkOrder([4, 3, 2, 1], [2, 1, 3, 4]));
  expect(fixture.todos().items).toEqual([...items, ...additions]);
  // Search filters the sorted projection rather than falling back to storage order.
  await fixture.user.type(
    screen.getByRole("searchbox", { name: "Search to-dos" }),
    "Latest finding",
  );
  checkOrder([4, 3, 2, 1], [2, 1, 3, 4]);
});

it("breaks equal creation timestamps by ID independently of storage order", () => {
  const items = [
    todo(4, activityTime(1)),
    todo(2, activityTime(2)),
    todo(3, activityTime(1)),
    todo(1, activityTime(2)),
  ];
  for (const order of [items, [...items].reverse()]) {
    using fixture = renderTodos(false, {
      todos: { ...emptyProjectTodos(), items: order },
      sessions: [],
    });
    expect(openOrder()).toEqual([1, 2, 3, 4].map((id) => todo(id).id));
    expect(fixture.todos().items).toEqual(order);
  }
});

it("keeps untimestamped saved items in reverse creation order, unaffected by later edits", async () => {
  const items = [todo(9), todo(2), todo(6)];
  using fixture = renderTodos(false, {
    todos: { ...emptyProjectTodos(), items },
    sessions: [],
  });
  const expected = [6, 2, 9].map((id) => todo(id).id);
  expect(openOrder()).toEqual(expected);
  await fixture.updateTodos({
    ...fixture.todos(),
    items: items.map((item, index) =>
      index === 0
        ? { ...item, description: "Edited old item", modifiedAt: activityTime(10), revision: 1 }
        : item,
    ),
  });
  expect(openOrder()).toEqual(expected);
  await fixture.updateTodos({
    ...fixture.todos(),
    items: [...fixture.todos().items, todo(1, activityTime(1))],
  });
  await waitFor(() => expect(openOrder()).toEqual([todo(1).id, ...expected]));
});

it("keeps creation order and selection through description/status edits and linked-session activity changes", async () => {
  const items = [todo(1, activityTime(1), ["first"]), todo(2, activityTime(2), ["second"])];
  const sessions = ["first", "second"].map((sessionId) =>
    sessionSummary({
      sessionId,
      projectPath: "/cake",
      unread: true,
      latestTurnOutcome: "complete",
      modifiedAt: activityTime(2),
    }),
  );
  using fixture = renderTodos(false, { todos: { ...emptyProjectTodos(), items }, sessions });
  expect(openOrder()).toEqual([items[1]!.id, items[0]!.id]);
  await fixture.user.click(screen.getByRole("button", { name: "Task 1" }));
  const expected = [items[1]!.id];
  for (const changes of [
    { unread: false },
    { running: true },
    { running: false, modifiedAt: activityTime(9) },
    { recoveryIssue: "Choose the next step" },
  ]) {
    await fixture.updateSessions(
      sessions.map((session) =>
        session.sessionId === "first" ? { ...session, ...changes } : session,
      ),
    );
    expect(openOrder()).toEqual(expected);
  }
  act(() => fixture.root.sessionRegistry.load("first", "/cake").model.activeTurnIds.push("turn"));
  expect(openOrder()).toEqual(expected);
  act(() => fixture.root.sessionRegistry.findModel("first")!.activeTurnIds.splice(0));
  await fixture.updateTodos({
    ...fixture.todos(),
    items: items.map((item, index) =>
      index === 0
        ? {
            ...item,
            modifiedAt: activityTime(10),
            revision: 1,
            description: "New finding.",
            status: "Ready for review",
          }
        : item,
    ),
  });
  expect(openOrder()).toEqual(expected);
  expect(screen.queryByText("New finding.")).toBeNull();
  await fixture.user.hover(screen.getByRole("button", { name: "Task 1" }));
  expect(await screen.findByText("New finding.")).toBeDefined();
  expect(screen.getByRole("button", { name: "Task 1" }).getAttribute("aria-pressed")).toBe("true");
});

it("filters titles and descriptions without changing selection or the authoritative list", async () => {
  using fixture = renderTodos();
  const search = screen.getByRole("searchbox", { name: "Search to-dos" });
  const title = () => screen.getByRole("button", { name: "Investigate startup" });
  await fixture.user.click(title());
  await fixture.user.type(search, "FOLLOW");
  expect(document.activeElement).toBe(search);
  expect(fixture.store.query).toBe("FOLLOW");
  expect(screen.getByRole("button", { name: "Follow up" })).toBeDefined();
  await waitFor(() =>
    expect(screen.queryByRole("button", { name: "Investigate startup" })).toBeNull(),
  );
  expect(fixture.store.focusedItemIds).toEqual([fixture.todos().items[0]!.id]);
  expect(fixture.todos().items).toHaveLength(2);
  await fixture.user.clear(search);
  await fixture.user.type(search, "BOTTLENECK");
  expect(title().getAttribute("aria-pressed")).toBe("true");
  expect(screen.queryByRole("button", { name: "Follow up" })).toBeNull();
  await fixture.user.clear(search);
  await fixture.user.type(search, "Report delivered");
  expect(screen.queryByRole("region", { name: "Active" })).toBeNull();
  expect(screen.getByRole("status").textContent).toBe("No matching to-dos.");
  await fixture.user.click(screen.getByRole("button", { name: "Clear search to-dos" }));
  expect(title().getAttribute("aria-pressed")).toBe("true");
  expect(screen.getByRole("button", { name: "Follow up" })).toBeDefined();
  await fixture.user.type(search, "   ");
  expect(screen.getAllByRole("button", { name: /^Mark done:/ })).toHaveLength(2);
});

it("keeps matching done items grouped and preserves disclosure and done/reopen actions", async () => {
  using fixture = renderTodos();
  const search = screen.getByRole("searchbox", { name: "Search to-dos" });
  await fixture.user.click(screen.getByRole("button", { name: "Mark done: Follow up" }));
  await fixture.user.type(search, "STEP");
  expect(screen.queryByRole("region", { name: "Active" })).toBeNull();
  expect(screen.queryByRole("status")).toBeNull();
  const done = screen.getByRole("button", { name: "Done (1)" });
  expect(done.getAttribute("aria-expanded")).toBe("false");
  await fixture.user.click(done);
  expect(
    todoSection("Done to-dos").getByRole("button", {
      name: "Follow up",
    }),
  ).toBeDefined();
  await fixture.user.click(screen.getByRole("button", { name: "Reopen: Follow up" }));
  expect(
    todoSection("Active to-dos").getByRole("button", {
      name: "Follow up",
    }),
  ).toBeDefined();
  await fixture.user.click(screen.getByRole("button", { name: "Mark done: Follow up" }));
  expect(screen.getByRole("button", { name: "Done (1)" }).getAttribute("aria-expanded")).toBe(
    "true",
  );
  await fixture.user.clear(search);
  await fixture.user.type(search, "no such task");
  expect(screen.queryByRole("region", { name: "Active" })).toBeNull();
  expect(screen.queryByRole("region", { name: "Done" })).toBeNull();
  expect(screen.getByRole("status").textContent).toBe("No matching to-dos.");
  await fixture.user.click(screen.getByRole("button", { name: "Clear search to-dos" }));
  expect(todoSection("Done to-dos")).toBeDefined();
  expect(todoSection("Active to-dos")).toBeDefined();
});

it("switches and toggles title focus, with independent done/reopen and explicit unfocus", async () => {
  using fixture = renderTodos();
  const title = () => screen.getByRole("button", { name: "Investigate startup" });
  const followUp = () => screen.getByRole("button", { name: "Follow up" });
  expect(screen.queryByText("Find the startup bottleneck.")).toBeNull();
  await fixture.user.click(title());
  expect(title().getAttribute("aria-pressed")).toBe("true");
  await fixture.user.click(followUp());
  expect(title().getAttribute("aria-pressed")).toBe("false");
  expect(followUp().getAttribute("aria-pressed")).toBe("true");
  await fixture.user.click(followUp());
  expect(followUp().getAttribute("aria-pressed")).toBe("false");
  expect(fixture.store.focusedItems).toEqual([]);
  await fixture.user.click(title());
  expect(title().getAttribute("aria-pressed")).toBe("true");
  await fixture.user.click(screen.getByRole("button", { name: "Mark done: Investigate startup" }));
  expect(title().getAttribute("aria-pressed")).toBe("true");
  expect(screen.getAllByRole("img", { name: "Ready for review" })).toHaveLength(2);
  await fixture.user.click(screen.getByRole("button", { name: "Reopen: Investigate startup" }));
  await fixture.user.click(
    screen.getByRole("button", { name: "Unfocus to-do: Investigate startup" }),
  );
  expect(
    todoSection("Active to-dos")
      .getByRole("button", { name: "Investigate startup" })
      .getAttribute("aria-pressed"),
  ).toBe("false");
});

it("keeps each associated session link and projects readiness across read, new work, waiting and settlement", async () => {
  using fixture = renderTodos();
  expect(screen.getByRole("link", { name: "First investigation" }).getAttribute("href")).toBe(
    "cake://session/first",
  );
  expect(screen.getByRole("link", { name: "Second investigation" }).getAttribute("href")).toBe(
    "cake://session/second",
  );
  expect(screen.getAllByRole("img", { name: "Ready for review" })).toHaveLength(2);
  await fixture.read();
  expect(screen.getAllByRole("img", { name: "Ready for review" })).toHaveLength(2);
  await fixture.status({ running: true, unread: false });
  expect(screen.getByRole("img", { name: "Running" }).className).toContain("bg-accent");
  expect(screen.getAllByRole("img", { name: "Ready for review" })).toHaveLength(1);
  await fixture.status({ running: false, recoveryIssue: "Needs a decision", unread: false });
  expect(screen.getByRole("img", { name: "Needs your input" }).className).toContain("bg-attention");
  await fixture.status({ running: false, unread: false, resolved: true });
  expect(screen.getAllByRole("img", { name: "Ready for review" })).toHaveLength(2);
  expect(screen.getByRole("button", { name: "Mark done: Investigate startup" })).toBeDefined();
  await fixture.status({ latestTurnOutcome: "failed" });
  expect(screen.getByRole("img", { name: "Error" }).className).toContain("bg-destructive");
  await fixture.status({ latestTurnOutcome: "aborted" });
  expect(screen.getAllByRole("img", { name: "Ready for review" })).toHaveLength(1);
  await fixture.status({ latestTurnOutcome: undefined, unread: true });
  expect(screen.getAllByRole("img", { name: "Ready for review" })).toHaveLength(1);
});

it("highlights every linked session, including sessions in a managed worktree", async () => {
  using fixture = renderTodos(true);
  await fixture.user.click(screen.getByRole("button", { name: "Investigate startup" }));
  expect(await fixture.associated()).toEqual(["first", "second"]);
  expect(
    fixture.container.querySelectorAll("[data-session-id][data-navigation-active=true]"),
  ).toHaveLength(0);
});

it("preserves focused to-dos while switching the exclusive accessory to linked sessions", async () => {
  using fixture = renderTodos(true);
  await fixture.user.click(screen.getByRole("button", { name: "Investigate startup" }));
  expect(await fixture.associated()).toEqual(["first", "second"]);
  expect(
    screen.getByRole("button", { name: "Investigate startup" }).getAttribute("aria-pressed"),
  ).toBe("true");
  await fixture.user.click(screen.getByRole("button", { name: "Follow up" }));
  expect(await fixture.associated()).toEqual(["third"]);
  await fixture.user.click(screen.getByRole("button", { name: "Unfocus to-do: Follow up" }));
  expect(await fixture.associated()).toEqual([]);
  await fixture.user.click(screen.getByRole("button", { name: "Investigate startup" }));
  expect(await fixture.associated()).toEqual(["first", "second"]);
  await fixture.user.click(screen.getByRole("button", { name: "Mark done: Investigate startup" }));
  expect(await fixture.associated()).toEqual(["first", "second"]);
  await fixture.user.click(
    screen.getByRole("button", { name: "Unfocus to-do: Investigate startup" }),
  );
  expect(await fixture.associated()).toEqual([]);
  expect(fixture.root.appShellStore.selection).toEqual({
    kind: "cake-chat",
    sessionId: projectChat,
  });
});

it("closing the to-do panel preserves view focus without attaching composer context", async () => {
  using fixture = renderTodos(true);
  await fixture.user.click(screen.getByRole("button", { name: "Investigate startup" }));
  expect(await fixture.associated()).toEqual(["first", "second"]);
  expect(fixture.store.focusedItemIds).toEqual(["00000000-0000-4000-8000-000000000011"]);
  await act(async () => fixture.store.toggle());
  expect(fixture.store.visible).toBe(false);
  expect(await fixture.associated()).toEqual(["first", "second"]);
  expect(fixture.todos().selectedId).toBeNull();
  const baseline = projectTodoBaseline(fixture.todos());
  expect(baseline).toContain('"activeCount":2');
  await act(async () => fixture.store.open());
  expect(
    screen.getByRole("button", { name: "Investigate startup" }).getAttribute("aria-pressed"),
  ).toBe("true");
});

it("keeps project to-do cues available in worker conversations and restores them after global navigation", async () => {
  using fixture = renderTodos(true);
  await fixture.user.click(screen.getByRole("button", { name: "Investigate startup" }));
  expect(await fixture.associated()).toEqual(["first", "second"]);
  act(() => fixture.root.navigationStore.selectProjectSession("third"));
  expect(await fixture.associated()).toEqual(["first", "second"]);
  act(() => fixture.root.navigationStore.selectCakeChat("cake-chat"));
  expect(await fixture.associated()).toEqual([]);
  // The accessory stays available, but global Cake Chat has its own to-do scope.
  expect(fixture.root.workspaceNavigatorStore.visible).toBe(true);
  expect(fixture.store.focusedItemIds).toEqual(["00000000-0000-4000-8000-000000000011"]);
  act(() => fixture.root.navigationStore.selectCakeChat(projectChat));
  expect(await fixture.associated()).toEqual(["first", "second"]);
});

it("snoozes focused work independently, restores its section on unfocus and unsnoozes early", async () => {
  using fixture = renderTodos();
  const title = "Investigate startup";
  const row = () => screen.getByRole("button", { name: title });
  await fixture.user.click(row());
  const before = Date.now();
  await fixture.user.pointer({ target: row(), keys: "[MouseRight]" });
  await fixture.user.click(screen.getByRole("menuitem", { name: "Snooze" }));
  await fixture.user.click(screen.getByRole("menuitem", { name: "15 minutes" }));
  const mutation = fixture.mutations.at(-1)!;
  expect(mutation).toMatchObject({
    _tag: "Snooze",
    id: fixture.todos().items[0]!.id,
    expectedRevision: 0,
  });
  if (mutation._tag !== "Snooze") throw new Error("Expected snooze mutation");
  expect(new Date(mutation.until).getTime()).toBeGreaterThanOrEqual(before + 15 * 60_000);
  expect(mutation.until).toBe(new Date(mutation.until).toISOString());
  expect(fixture.todos().selectedId).toBeNull();
  expect(
    todoSection("Focus to-dos").getByRole("button", { name: title }).getAttribute("aria-pressed"),
  ).toBe("true");
  await fixture.user.click(screen.getByRole("button", { name: `Unfocus to-do: ${title}` }));
  const snoozed = todoSection("Snoozed to-dos");
  expect(snoozed.getByRole("button", { name: title }).getAttribute("aria-disabled")).toBe("false");
  expect(snoozed.getByRole("link", { name: "Report" })).toBeDefined();
  expect(
    todoSection("Active to-dos").queryByRole("button", {
      name: title,
    }),
  ).toBeNull();
  const count = fixture.mutations.length;
  await fixture.user.click(row());
  expect(fixture.mutations).toHaveLength(count);
  expect(row().getAttribute("aria-pressed")).toBe("true");
  await fixture.user.click(screen.getByRole("button", { name: `Unfocus to-do: ${title}` }));
  await fixture.user.pointer({ target: row(), keys: "[MouseRight]" });
  await fixture.user.click(screen.getByRole("menuitem", { name: "Unsnooze" }));
  expect(fixture.mutations.at(-1)).toMatchObject({ _tag: "Unsnooze", expectedRevision: 1 });
  expect(
    todoSection("Active to-dos").getByRole("button", {
      name: title,
    }),
  ).toBeDefined();
  expect(fixture.todos().items[0]!.snoozedUntil).toBeUndefined();
});

it("validates custom local time, changes an existing deadline, searches snoozed work and completes it", async () => {
  using fixture = renderTodos();
  const title = "Investigate startup";
  const openCustom = async (change = false) => {
    await fixture.user.pointer({
      target: screen.getByRole("button", { name: title }),
      keys: "[MouseRight]",
    });
    await fixture.user.click(
      screen.getByRole("menuitem", { name: change ? "Change snooze" : "Snooze" }),
    );
    await fixture.user.click(screen.getByRole("menuitem", { name: "Custom" }));
    expect(screen.getByRole("dialog", { name: "Custom" })).toBeDefined();
    expect(screen.getByRole("grid")).toBeDefined();
    return {
      date: screen.getByLabelText("Date") as HTMLInputElement,
      time: screen.getByLabelText("Time") as HTMLInputElement,
    };
  };
  const input = await openCustom();
  fireEvent.change(input.date, { target: { value: "2000-01-01" } });
  fireEvent.change(input.time, { target: { value: "10:00" } });
  await fixture.user.click(screen.getByRole("button", { name: "Snooze" }));
  expect(screen.getByRole("alert").textContent).toBe("Choose a future date and time.");
  expect(fixture.mutations).toHaveLength(0);
  const future = localSnoozeDateTime(new Date(Date.now() + 2 * 86400_000).toISOString());
  fireEvent.change(input.date, { target: { value: future.split("T")[0] } });
  fireEvent.change(input.time, { target: { value: future.split("T")[1] } });
  await fixture.user.click(screen.getByRole("button", { name: "Snooze" }));
  expect(fixture.mutations.at(-1)).toMatchObject({
    _tag: "Snooze",
    until: new Date(future).toISOString(),
  });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(fixture.container.querySelector("time")?.dateTime).toBe(new Date(future).toISOString());
  const editing = await openCustom(true);
  expect(editing.date.value).toBe(future.split("T")[0]);
  expect(editing.time.value).toBe(future.split("T")[1]);
  const day = new Date(future);
  day.setDate(1);
  day.setMonth(day.getMonth() + 1);
  const later = localSnoozeDateTime(day.toISOString());
  await fixture.user.click(screen.getByRole("button", { name: "Go to the Next Month" }));
  await fixture.user.click(
    within(screen.getByRole("grid")).getByRole("button", {
      name: new RegExp(`${day.toLocaleString("en-US", { month: "long" })} ${day.getDate()}\\D`),
    }),
  );
  expect(editing.date.value).toBe(later.split("T")[0]);
  expect(editing.time.value).toBe(future.split("T")[1]);
  await fixture.user.click(screen.getByRole("button", { name: "Save" }));
  expect(fixture.mutations.at(-1)).toMatchObject({
    _tag: "Snooze",
    expectedRevision: 1,
    until: new Date(later).toISOString(),
  });
  await fixture.user.type(screen.getByRole("searchbox", { name: "Search to-dos" }), "bottleneck");
  expect(todoSection("Snoozed to-dos").querySelectorAll("[data-todo-id]")).toHaveLength(1);
  expect(
    fixture.container.querySelectorAll(`[data-todo-id="${fixture.todos().items[0]!.id}"]`),
  ).toHaveLength(1);
  await fixture.user.click(screen.getByRole("button", { name: `Mark done: ${title}` }));
  await fixture.user.click(screen.getByRole("button", { name: "Done (1)" }));
  expect(
    todoSection("Done to-dos").getByRole("button", {
      name: title,
    }),
  ).toBeDefined();
  await fixture.user.pointer({
    target: screen.getByRole("button", { name: title }),
    keys: "[MouseRight]",
  });
  expect(screen.queryByRole("menu")).toBeNull();
  await fixture.user.click(screen.getByRole("button", { name: `Reopen: ${title}` }));
  expect(
    todoSection("Active to-dos").getByRole("button", {
      name: title,
    }),
  ).toBeDefined();
  expect(fixture.todos().items[0]!.snoozedUntil).toBeUndefined();
});
