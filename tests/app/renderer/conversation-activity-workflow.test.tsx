/** @vitest-environment jsdom */
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { applySnapshot } from "r-state-tree";
import { StoreProvider } from "r-state-tree/react";
import { VirtuosoMockContext } from "react-virtuoso";
import { expect, it, vi } from "vitest";
import { defaultApplicationState } from "../../../src/contracts/application/application-data";
import { CAKE_CHAT_SESSION_ID } from "../../../src/contracts/cake-chats/cake-chat-data";
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
    fixture.root.appShellStore.selectCakeChat(CAKE_CHAT_SESSION_ID);
    fixture.root.cakeChatCollectionStore.sessionLayoutStore.showSession(CAKE_CHAT_SESSION_ID);
  } else {
    fixture.root.appShellStore.selectProjectSession(parentId);
    fixture.root.projectWorkbenchStore.showLoadedSession(parentId);
    fixture.root.sessionLayoutStore.showSession(parentId);
    if (splitSessionId) {
      fixture.root.sessionLayoutStore.splitFocused(splitSessionId, "x");
      fixture.root.appShellStore.selectProjectSession(splitSessionId);
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
  return {
    fixture,
    openSession,
    user: userEvent.setup(),
    publishWorker(status?: "queued" | "running" | "complete", released = false) {
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
  "%s header tracks queued/running subagents, inspects their chat, and disappears on release",
  async (kind) => {
    using view = renderActivity(kind);
    expect(screen.queryByRole("button", { name: /^Activity ·/ })).toBeNull();
    view.publishWorker("queued");
    const trigger = screen.getByRole("button", { name: "Activity · 1 running" });
    expect(trigger.closest('[data-slot="workspace-header"]')).not.toBeNull();
    await view.user.click(trigger);
    const menu = screen.getByRole("dialog", { name: "Conversation activity" });
    expect(within(menu).queryByRole("region", { name: "Sessions" })).toBeNull();
    expect(within(menu).getByText("Queued · Temporary subagent")).toBeTruthy();
    view.publishWorker("running");
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

it("regular sessions show only direct children, keep idle children discoverable while busy, and open the selected session", async () => {
  using view = renderActivity("project", [
    child(),
    child({ sessionId: otherId, title: "Idle child", running: false }),
    child({ sessionId: grandchildId, familyParentSessionId: childId, title: "Grandchild" }),
    child({ sessionId: "unrelated", familyParentSessionId: "another-parent", title: "Other work" }),
  ]);
  await view.user.click(screen.getByRole("button", { name: "Activity · 1 running" }));
  const menu = screen.getByRole("dialog", { name: "Conversation activity" });
  expect(
    within(menu)
      .getAllByRole("button")
      .map((button) => button.getAttribute("aria-label")),
  ).toEqual(["Open session: Activity UI review", "Open session: Idle child"]);
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

it("Cake Chat combines launched sessions and workers, prioritizes attention, and hides when only idle/completed work remains", async () => {
  const launched = child({
    familyParentSessionId: undefined,
    running: false,
    cakeChatLaunch: {
      launchedAt: "2026-01-01T00:00:00Z",
      lastReport: {
        status: "blocked",
        summary: "Choose the activity placement",
        reportedAt: "2026-01-01T00:01:00Z",
      },
    },
  });
  using view = renderActivity("cake-chat", [
    launched,
    child({ sessionId: otherId, title: "Not launched by Cake Chat" }),
  ]);
  view.publishWorker("running");
  await view.user.click(screen.getByRole("button", { name: "Activity · 1 needs attention" }));
  const menu = screen.getByRole("dialog", { name: "Conversation activity" });
  expect(within(menu).getByRole("region", { name: "Sessions" })).toBeTruthy();
  expect(within(menu).getByRole("region", { name: "Subagents for this chat" })).toBeTruthy();
  expect(within(menu).getByText(/Choose the activity placement/)).toBeTruthy();
  expect(within(menu).queryByText("Not launched by Cake Chat")).toBeNull();
  view.publishSessions([{ ...launched, cakeChatLaunch: { launchedAt: "2026-01-01T00:00:00Z" } }]);
  expect(screen.getByRole("button", { name: "Activity · 1 running" })).toBeTruthy();
  view.publishWorker("complete");
  expect(screen.queryByRole("button", { name: /^Activity ·/ })).toBeNull();
  expect(screen.queryByRole("dialog", { name: "Conversation activity" })).toBeNull();
});

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
