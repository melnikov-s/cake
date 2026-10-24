/** @vitest-environment jsdom */
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { applySnapshot } from "r-state-tree";
import { StoreProvider } from "r-state-tree/react";
import { VirtuosoMockContext } from "react-virtuoso";
import { expect, it, vi } from "vitest";
import { defaultApplicationState } from "../../../src/contracts/application/application-data";
import { CAKE_CHAT_SESSION_ID } from "../../../src/contracts/cake-chats/cake-chat-identity";
import type { ConversationSnapshot } from "../../../src/contracts/conversations/conversation-data";
import { CakeChatSurface } from "../../../src/renderer/components/cake-chat-surface";
import { ProjectConversationSurface } from "../../../src/renderer/components/project-conversation-surface";
import { applyConversationSnapshot } from "../../../src/renderer/reducers/ConversationReducer";
import { applySubagentUpdate } from "../../../src/renderer/reducers/SubagentReducer";
import {
  projectRecord,
  sessionSummary,
  type SessionSummaryFixture,
} from "./fixtures/catalog-fixtures";
import { createRendererStoreFixture } from "./renderer-store-fixture";
import { workerActivity } from "./subagent-activity-workflow-fixture";
import {
  SubagentHandleId,
  type SubagentActivity,
} from "../../../src/contracts/subagents/subagent-data";

const parentId = "10000000-0000-4000-8000-000000000010";
const childId = "10000000-0000-4000-8000-000000000011";
const otherId = "10000000-0000-4000-8000-000000000012";
const grandchildId = "10000000-0000-4000-8000-000000000013";

function snapshot(sessionId: string): ConversationSnapshot {
  return {
    sessionId,
    sessionFile: `/project/${sessionId}.jsonl`,
    parts: [
      {
        id: "request",
        kind: "text",
        role: "user",
        text: "Check the shared components",
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
  };
}

const child = (overrides: Partial<SessionSummaryFixture> = {}) =>
  sessionSummary({
    sessionId: childId,
    title: "Activity UI review",
    projectPath: "/project",
    familyId: "activity-family",
    familyParentSessionId: parentId,
    running: true,
    ...overrides,
  });

function renderActivity(
  kind: "project" | "cake-chat",
  sessions: SessionSummaryFixture[] = [],
  splitSessionId?: string,
) {
  const openSession = vi.fn(async () => undefined);
  const ownerId = kind === "cake-chat" ? CAKE_CHAT_SESSION_ID : parentId;
  const fixture = createRendererStoreFixture({
    projects: [projectRecord({ path: "/project", name: "Cake" })],
    sessions: [
      sessionSummary({ sessionId: parentId, title: "Parent review", projectPath: "/project" }),
      ...sessions,
    ],
    client: {
      projectSessions: { open: openSession },
      cakeChats: { open: async () => undefined },
      workspaces: { registerProject: async () => defaultApplicationState() },
    },
  });
  fixture.root.settingsStore.appearance.sessionAvatarsEnabled = false;
  for (const summary of fixture.root.sessionCatalogStore.sessions) {
    const session = fixture.root.sessionRegistry.load(summary.sessionId, summary.workingDirectory);
    applyConversationSnapshot(session.model, snapshot(summary.sessionId));
  }
  applySnapshot(fixture.models.cakeChatCatalog, {
    loaded: true,
    sessions: [{ sessionId: CAKE_CHAT_SESSION_ID, title: "Cake Chat" }],
  });
  const cakeChat = fixture.root.cakeChatCollectionStore.registry.load(CAKE_CHAT_SESSION_ID);
  applyConversationSnapshot(cakeChat.model, snapshot(CAKE_CHAT_SESSION_ID));
  if (kind === "cake-chat") {
    fixture.root.navigationStore.selectCakeChat(CAKE_CHAT_SESSION_ID);
    fixture.root.cakeChatCollectionStore.sessionLayoutStore.showSession(CAKE_CHAT_SESSION_ID);
  } else {
    fixture.root.navigationStore.selectProjectSession(parentId);
    fixture.root.projectWorkbenchStore.showLoadedSession(parentId);
    fixture.root.sessionLayoutStore.showSession(parentId);
    if (splitSessionId) {
      fixture.root.sessionLayoutStore.splitFocused(splitSessionId, "x");
      fixture.root.navigationStore.selectProjectSession(splitSessionId);
    }
  }
  const catalog = fixture.models.subagentCatalog(ownerId);
  const view = render(
    <StoreProvider store={fixture.root}>
      <VirtuosoMockContext.Provider value={{ viewportHeight: 800, itemHeight: 100 }}>
        {kind === "cake-chat" ? (
          <CakeChatSurface />
        ) : (
          <ProjectConversationSurface browserMode={false} />
        )}
      </VirtuosoMockContext.Provider>
    </StoreProvider>,
  );
  let revision = 0;
  const publishWorkers = (activities: SubagentActivity[]) =>
    act(() =>
      applySubagentUpdate(catalog, ownerId, {
        _tag: "Snapshot",
        revision: ++revision,
        parentSessionId: ownerId,
        activities,
        backgroundActive: activities.some((activity) => activity.status === "running"),
      }),
    );
  return {
    fixture,
    openSession,
    user: userEvent.setup(),
    publishWorkers,
    publishWorker(status?: SubagentActivity["status"], released = false) {
      const activity = workerActivity({
        parentSessionId: ownerId,
        status: status ?? "complete",
        streaming: status === "running",
      });
      act(() => {
        applySubagentUpdate(catalog, ownerId, {
          _tag: "Snapshot",
          revision: ++revision,
          parentSessionId: ownerId,
          activities: status ? [activity] : [],
          backgroundActive: status === "running",
        });
        if (released)
          applySubagentUpdate(catalog, ownerId, {
            _tag: "Removed",
            revision: ++revision,
            parentSessionId: ownerId,
            handleId: activity.handleId,
          });
      });
    },
    publishSessions(next: SessionSummaryFixture[]) {
      act(() =>
        applySnapshot(fixture.models.sessionCatalog, {
          sessions: [
            sessionSummary({
              sessionId: parentId,
              title: "Parent review",
              projectPath: "/project",
            }),
            ...next,
          ],
          resolvedHasMoreByProject: {},
        }),
      );
    },
    [Symbol.dispose]() {
      view.unmount();
      fixture[Symbol.dispose]();
    },
  };
}

it.each(["project", "cake-chat"] as const)(
  "%s composer cap shows running but not queued subagents, inspects their chat, and disappears on release",
  async (kind) => {
    using view = renderActivity(kind);
    expect(screen.queryByRole("button", { name: /^Activity ·/ })).toBeNull();
    view.publishWorker("queued");
    expect(screen.queryByRole("button", { name: /^Activity ·/ })).toBeNull();
    view.publishWorker("running");
    const trigger = screen.getByRole("button", { name: "Activity · 1 running" });
    expect(trigger.closest(".workbench-composer")).not.toBeNull();
    expect(trigger.getAttribute("data-slot")).toBe("composer-activity");
    const dock = trigger.closest('[data-slot="composer-dock"]')!;
    const input = dock.querySelector('[data-slot="composer-input"]')!;
    expect(trigger.compareDocumentPosition(input) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await view.user.click(trigger);
    const menu = screen.getByRole("region", { name: "Conversation activity" });
    expect(within(menu).getByRole("img", { name: "Temporary subagent" })).toBeTruthy();
    expect(
      within(menu)
        .getByRole("button", { name: "Inspect subagent: Inspect the boundary" })
        .querySelector(".bg-accent"),
    ).not.toBeNull();
    expect(within(menu).getByText("Running · Temporary subagent")).toBeTruthy();
    await view.user.click(
      within(menu).getByRole("button", { name: "Inspect subagent: Inspect the boundary" }),
    );
    const panel = screen.getByRole("complementary", { name: "Subagent" });
    expect(within(panel).getByText("Inspecting now")).toBeTruthy();
    view.publishWorker("running", true);
    expect(screen.queryByRole("button", { name: /^Activity ·/ })).toBeNull();
    expect(within(panel).getByText("Inspecting now")).toBeTruthy();
  },
);

it.each(["project", "cake-chat"] as const)(
  "%s activity toggles inline from the bar, chevron and keyboard without dismissing on composer input",
  async (kind) => {
    using view = renderActivity(kind);
    view.publishWorker("running");
    const trigger = screen.getByRole("button", { name: "Activity · 1 running" });
    const dock = trigger.closest('[data-slot="composer-dock"]')!;
    const detailsId = trigger.getAttribute("aria-controls")!;
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("region", { name: "Conversation activity" })).toBeNull();

    await view.user.click(trigger.querySelector("svg")!);
    const details = screen.getByRole("region", { name: "Conversation activity" });
    expect(details.id).toBe(detailsId);
    expect(dock.contains(details)).toBe(true);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    const input = within(dock as HTMLElement).getByRole("combobox");
    await view.user.click(input);
    await view.user.type(input, "Keep this draft");
    expect(screen.getByRole("region", { name: "Conversation activity" })).toBe(details);

    await view.user.click(within(trigger).getByText("Activity ·"));
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("region", { name: "Conversation activity" })).toBeNull();
    await view.user.keyboard("{Enter}");
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    await view.user.keyboard(" ");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect((input as HTMLTextAreaElement).value).toBe("Keep this draft");
  },
);

it("keeps worktree tools beneath the activity band when workers appear and finish", async () => {
  using view = renderActivity("project");
  act(() =>
    applySnapshot(view.fixture.models.worktrees, {
      worktrees: [
        {
          projectPath: "/project",
          worktreePath: "/project",
          branch: "agent/activity-bar-above-input",
          baseBranch: "main",
          createdAt: "2026-01-01T00:00:00Z",
          state: "active",
        },
      ],
    }),
  );
  const worktree = screen.getByTestId("worktree-pill");
  expect(within(worktree).getByText("activity-bar-above-input")).toBeTruthy();
  expect(within(worktree).getByRole("button", { name: "Merge" })).toBeTruthy();
  view.publishWorker("running");
  const trigger = within(worktree).getByRole("button", { name: "Activity · 1 running" });
  const tools = screen.getByTestId("worktree-pill-toolbar");
  expect(trigger.compareDocumentPosition(tools) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  await view.user.click(trigger);
  const details = screen.getByRole("region", { name: "Conversation activity" });
  expect(worktree.contains(details)).toBe(true);
  expect(details.compareDocumentPosition(tools) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  await view.user.click(trigger);
  expect(screen.queryByRole("region", { name: "Conversation activity" })).toBeNull();
  expect(within(worktree).getByRole("button", { name: "Merge" })).toBeTruthy();
  await view.user.click(trigger);
  view.publishWorker("complete");
  expect(within(worktree).queryByRole("button", { name: /^Activity ·/ })).toBeNull();
  expect(within(worktree).getByRole("button", { name: "Merge" })).toBeTruthy();
  expect(screen.queryByRole("region", { name: "Conversation activity" })).toBeNull();
});

it("regular sessions show only running direct children and open the selected session", async () => {
  using view = renderActivity("project", [
    child(),
    child({ sessionId: otherId, title: "Idle child", running: false }),
    child({ sessionId: grandchildId, familyParentSessionId: childId, title: "Grandchild" }),
    child({ sessionId: "unrelated", familyParentSessionId: "another-parent", title: "Other work" }),
  ]);
  await view.user.click(screen.getByRole("button", { name: "Activity · 1 running" }));
  const menu = screen.getByRole("region", { name: "Conversation activity" });
  expect(
    within(menu)
      .getAllByRole("button")
      .map((button) => button.getAttribute("aria-label")),
  ).toEqual(["Open session: Activity UI review"]);
  await view.user.click(
    within(menu).getByRole("button", { name: "Open session: Activity UI review" }),
  );
  expect(view.openSession).toHaveBeenCalledWith(
    { sessionId: childId, workingDirectory: "/project" },
    expect.anything(),
  );
  expect(
    document.querySelector(`[data-slot="session-pane"][data-session-id="${childId}"]`),
  ).not.toBeNull();
});

it.each(["project", "cake-chat"] as const)(
  "%s counts only running rows in mixed states and distinguishes work type from status",
  async (kind) => {
    const launch =
      kind === "cake-chat"
        ? {
            requesterSessionId: CAKE_CHAT_SESSION_ID,
            launchedAt: "2026-01-01T00:00:00Z",
          }
        : undefined;
    const running = child({ cakeChatLaunch: launch });
    const nonRunning = (
      ["completed", "stopped", "failed", "interrupted", "blocked", undefined] as const
    ).map((status, index) =>
      child({
        sessionId: `settled-${index}`,
        title: `Non-running session ${index}`,
        running: false,
        cakeChatLaunch: {
          requesterSessionId: CAKE_CHAT_SESSION_ID,
          launchedAt: "2026-01-01T00:00:00Z",
          ...(status
            ? {
                lastReport: {
                  status,
                  summary: "Still unresolved",
                  reportedAt: "2026-01-01T00:01:00Z",
                },
              }
            : {}),
        },
      }),
    );
    using view = renderActivity(kind, [
      running,
      ...nonRunning,
      child({
        sessionId: otherId,
        title: "Outside scope",
        familyParentSessionId: "another-parent",
      }),
    ]);
    const statuses = ["running", "queued", "complete", "aborted", "error"] as const;
    view.publishWorkers(
      statuses.map((status, index) =>
        workerActivity({
          parentSessionId: kind === "cake-chat" ? CAKE_CHAT_SESSION_ID : parentId,
          handleId: SubagentHandleId.make(`20000000-0000-4000-8000-00000000000${index}`),
          task: `Worker ${status}`,
          status,
          streaming: status === "running",
        }),
      ),
    );
    await view.user.click(screen.getByRole("button", { name: "Activity · 2 running" }));
    const menu = screen.getByRole("region", { name: "Conversation activity" });
    const rows = within(menu).getAllByRole("button");
    expect(rows.map((row) => row.getAttribute("aria-label"))).toEqual([
      "Open session: Activity UI review",
      "Inspect subagent: Worker running",
    ]);
    // Type is conveyed without headings and independently of each running status dot.
    expect(within(menu).queryByRole("heading")).toBeNull();
    const sessionIcon = within(rows[0]!).getByRole("img", { name: "Project Session" });
    const workerIcon = within(rows[1]!).getByRole("img", { name: "Temporary subagent" });
    expect(sessionIcon.getAttribute("title")).toBe("Project Session");
    expect(workerIcon.getAttribute("title")).toBe("Temporary subagent");
    expect(sessionIcon.querySelector("path")?.getAttribute("d")).not.toBe(
      workerIcon.querySelector("path")?.getAttribute("d"),
    );
    for (const row of rows) {
      expect(row.lastElementChild?.querySelector(".bg-accent")).not.toBeNull();
      expect(row.firstElementChild?.getAttribute("role")).toBe("img");
      expect(row.textContent).toContain("Running");
      expect(row.getAttribute("aria-description")).toMatch(/Project Session|Temporary subagent/);
    }
    expect(within(rows[1]!).getByText("Inspect")).toBeTruthy();
    view.publishSessions(nonRunning);
    expect(screen.getByRole("button", { name: "Activity · 1 running" })).toBeTruthy();
    expect(within(menu).getAllByRole("button")).toHaveLength(1);
    view.publishWorker("complete");
    expect(screen.queryByRole("button", { name: /^Activity ·/ })).toBeNull();
    expect(screen.queryByRole("region", { name: "Conversation activity" })).toBeNull();
  },
);

it.each(
  (["project", "cake-chat"] as const).flatMap((kind) =>
    (["completed", "stopped", "failed", "interrupted", "blocked"] as const).map((status) => ({
      kind,
      status,
    })),
  ),
)("unresolved $status sessions alone never keep $kind Activity visible", ({ kind, status }) => {
  using view = renderActivity(kind, [
    child({
      running: false,
      cakeChatLaunch: {
        requesterSessionId: CAKE_CHAT_SESSION_ID,
        launchedAt: "2026-01-01T00:00:00Z",
        lastReport: { status, summary: "Still unresolved", reportedAt: "2026-01-01T00:01:00Z" },
      },
    }),
  ]);
  expect(screen.queryByRole("button", { name: /^Activity ·/ })).toBeNull();
  view.publishWorker("running");
  expect(screen.getByRole("button", { name: "Activity · 1 running" })).toBeTruthy();
  view.publishWorker("complete");
  expect(screen.queryByRole("button", { name: /^Activity ·/ })).toBeNull();
});

it.each(["complete", "aborted", "error"] as const)(
  "a %s subagent alone does not keep Activity visible",
  (status) => {
    using view = renderActivity("project");
    view.publishWorker(status);
    expect(screen.queryByRole("button", { name: /^Activity ·/ })).toBeNull();
    view.publishWorker("running");
    expect(screen.getByRole("button", { name: "Activity · 1 running" })).toBeTruthy();
    view.publishWorker(status);
    expect(screen.queryByRole("button", { name: /^Activity ·/ })).toBeNull();
  },
);

it("an idle child alone does not keep Activity visible, and resolving active children removes their activity", async () => {
  using view = renderActivity("project", [child({ running: false })]);
  expect(screen.queryByRole("button", { name: /^Activity ·/ })).toBeNull();
  view.publishSessions([child()]);
  expect(screen.getByRole("button", { name: "Activity · 1 running" })).toBeTruthy();
  view.publishSessions([child({ resolved: true })]);
  expect(screen.queryByRole("button", { name: /^Activity ·/ })).toBeNull();
});

it("activity remains scoped to its pane when another Project Session is focused", async () => {
  using view = renderActivity(
    "project",
    [child({ sessionId: otherId, title: "Second pane", running: false })],
    otherId,
  );
  view.publishWorker("running");
  const parentPane = document.querySelector<HTMLElement>(
    `[data-slot="session-pane"][data-session-id="${parentId}"]`,
  )!;
  const otherPane = document.querySelector<HTMLElement>(
    `[data-slot="session-pane"][data-session-id="${otherId}"]`,
  )!;
  expect(within(otherPane).queryByRole("button", { name: /^Activity ·/ })).toBeNull();
  await view.user.click(within(parentPane).getByRole("button", { name: "Activity · 1 running" }));
  await view.user.click(
    screen.getByRole("button", { name: "Inspect subagent: Inspect the boundary" }),
  );
  expect(within(parentPane).getByRole("complementary", { name: "Subagent" })).toBeTruthy();
  expect(within(otherPane).queryByRole("complementary", { name: "Subagent" })).toBeNull();
});

it("workers belonging to another conversation do not appear in this session's activity", () => {
  using view = renderActivity("project");
  const foreign = workerActivity({ parentSessionId: CAKE_CHAT_SESSION_ID });
  act(() =>
    applySubagentUpdate(
      view.fixture.models.subagentCatalog(CAKE_CHAT_SESSION_ID),
      CAKE_CHAT_SESSION_ID,
      {
        _tag: "Snapshot",
        revision: 1,
        parentSessionId: CAKE_CHAT_SESSION_ID,
        activities: [foreign],
        backgroundActive: true,
      },
    ),
  );
  expect(screen.queryByRole("button", { name: /^Activity ·/ })).toBeNull();
});
