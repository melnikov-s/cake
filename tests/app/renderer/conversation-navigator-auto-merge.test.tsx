/** @vitest-environment jsdom */
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { applySnapshot } from "r-state-tree";
import { StoreProvider } from "r-state-tree/react";
import { afterEach, expect, it, vi } from "vitest";
import { defaultProjectSettings } from "../../../src/contracts/application/application-data";
import { CAKE_CHAT_SESSION_ID } from "../../../src/contracts/cake-chats/cake-chat-identity";
import { SubagentHandleId } from "../../../src/contracts/subagents/subagent-data";
import { ConversationActivity } from "../../../src/renderer/components/conversation-activity";
import { WorkspaceNavigatorContent } from "../../../src/renderer/components/workspace-navigator-content";
import { applySubagentUpdate } from "../../../src/renderer/reducers/SubagentReducer";
import { applyWorktreeOperationCatalogUpdate } from "../../../src/renderer/reducers/WorktreeOperationReducer";
import { fixtureTimestamp, projectRecord, sessionSummary } from "./fixtures/catalog-fixtures";
import { createRendererStoreFixture } from "./renderer-store-fixture";
import { workerActivity } from "./subagent-activity-workflow-fixture";

const cake = "/cake";
const other = "/other";
const cakeChat = `project-chat:${"a".repeat(64)}`;
const otherChat = `project-chat:${"b".repeat(64)}`;
const projects = [projectRecord({ path: cake, name: "Cake" }), projectRecord({ path: other })];
const sessions = [
  sessionSummary({ sessionId: "my-session", projectPath: cake, purpose: "user" }),
  sessionSummary({ sessionId: "worker", projectPath: cake, purpose: "delegated" }),
  sessionSummary({ sessionId: "my-other-session", projectPath: other, purpose: "user" }),
];

function setup() {
  const setAutoMerge = vi.fn(async (projectPath: string, enabled: boolean) => {
    act(() =>
      publish(
        fixture.models.worktreeOperations.autoMergeProjects.map((item) =>
          item.projectPath === projectPath ? { ...item, enabled } : item,
        ),
      ),
    );
  });
  const fixture = createRendererStoreFixture({
    projects,
    sessions,
    client: { managedWorktrees: { setAutoMerge } },
  });
  const publish = (autoMergeProjects: typeof fixture.models.worktreeOperations.autoMergeProjects) =>
    applyWorktreeOperationCatalogUpdate(fixture.models.worktreeOperations, {
      operations: [],
      autoMergeProjects,
    });
  publish([
    { projectPath: cake, enabled: true, epoch: "one", status: "On" },
    { projectPath: other, enabled: false, epoch: "two", status: "Off" },
  ]);
  applySnapshot(fixture.models.cakeChatCatalog, {
    loaded: true,
    sessions: [
      { sessionId: CAKE_CHAT_SESSION_ID, title: "Cake Chat" },
      ...[
        [cakeChat, cake],
        [otherChat, other],
      ].map(([sessionId, projectPath]) => ({
        sessionId,
        projectPath,
        title: "Project Chat",
        createdAt: fixtureTimestamp,
        modifiedAt: fixtureTimestamp,
        messageCount: 1,
        resolved: false,
        unread: false,
      })),
    ],
  });
  fixture.root.workspaceNavigatorStore.show("sessions");
  fixture.root.navigationStore.selectCakeChat(cakeChat);
  return {
    ...fixture,
    setAutoMerge,
    user: userEvent.setup(),
    select: (sessionId: string) =>
      act(() => fixture.root.navigationStore.selectCakeChat(sessionId)),
    [Symbol.dispose]() {
      cleanup();
      fixture[Symbol.dispose]();
    },
  };
}

function delegated(path: string) {
  const navigator = within(screen.getByRole("region", { name: "Sessions" }));
  return within(
    navigator
      .getAllByRole("region", { name: "Delegated" })
      .find((el) => el.dataset.projectPath === path)!,
  );
}

afterEach(cleanup);

it("shows the switch only in the selected project's Delegated header, never in session rows", async () => {
  using fixture = setup();
  render(
    <StoreProvider store={fixture.root}>
      <WorkspaceNavigatorContent />
    </StoreProvider>,
  );
  const disclosure = delegated(cake).getByRole("button", { name: "Delegated" });
  const toggle = delegated(cake).getByRole("switch", { name: "Auto-merge: on" });
  expect(screen.getAllByRole("switch")).toEqual([toggle]);
  expect(delegated(other).getByText("0 delegated · 0 running")).toBeTruthy();
  expect(toggle.parentElement?.closest("button, [role=button]")).toBeNull();

  await fixture.user.click(delegated(cake).getByText("Auto-merge", { exact: true }));
  await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("false"));
  expect(disclosure.getAttribute("aria-expanded")).toBe("false");
  expect(fixture.root.appShellStore.activeConversation?.sessionId).toBe(cakeChat);
  await fixture.user.click(disclosure);
  expect(delegated(cake).getByText("worker", { exact: true })).toBeTruthy();
  expect(screen.getAllByRole("switch")).toEqual([toggle]);

  fixture.select(otherChat);
  expect(delegated(cake).queryByRole("switch")).toBeNull();
  const peer = delegated(other).getByRole("switch", { name: "Auto-merge: off" });
  expect(screen.getAllByRole("switch")).toEqual([peer]);
  await fixture.user.click(peer);
  await waitFor(() => expect(peer.getAttribute("aria-checked")).toBe("true"));

  fixture.select(CAKE_CHAT_SESSION_ID);
  expect(screen.queryByRole("switch")).toBeNull();
  fixture.select(cakeChat);
  expect(delegated(cake).getByRole("switch", { name: "Auto-merge: off" })).toBeTruthy();
  expect(fixture.setAutoMerge.mock.calls).toEqual([
    [cake, false],
    [other, true],
  ]);
});

it("keeps composer Activity controls with their owning pane as selection and running work change", async () => {
  using fixture = setup();
  const cakeSession = fixture.root.sessionRegistry.load("my-session", cake);
  const otherSession = fixture.root.sessionRegistry.load("my-other-session", other);
  const globalChat = fixture.root.cakeChatCollectionStore.registry.load(CAKE_CHAT_SESSION_ID);
  const owners = [cakeSession.sessionId, otherSession.sessionId, globalChat.sessionId];
  let revision = 0;
  const publishWorker = (sessionId: string, status: "running" | "complete") =>
    act(() =>
      applySubagentUpdate(fixture.models.subagentCatalog(sessionId), sessionId, {
        _tag: "Snapshot",
        revision: ++revision,
        parentSessionId: sessionId,
        backgroundActive: status === "running",
        activities: [
          workerActivity({
            parentSessionId: sessionId,
            handleId: SubagentHandleId.make(
              `10000000-0000-4000-8000-00000000000${owners.indexOf(sessionId) + 1}`,
            ),
            status,
            streaming: status === "running",
          }),
        ],
      }),
    );
  render(
    <StoreProvider store={fixture.root}>
      <WorkspaceNavigatorContent />
      <section aria-label="Cake pane">
        <ConversationActivity
          sessionId={cakeSession.sessionId}
          placement="strip"
          subagents={cakeSession.subagentActivityStore}
          sideChat={cakeSession.conversationSessionStore.sideChatStore}
          composerSections={[
            {
              id: "attention",
              label: "Needs attention",
              count: 1,
              icon: null,
              summary: "to-do",
              accessibleLabel: "Needs attention",
              regionLabel: "Needs attention",
              renderContent: () => "Review the work",
            },
          ]}
        />
      </section>
      <section aria-label="Other pane">
        <ConversationActivity
          sessionId={otherSession.sessionId}
          placement="composer"
          subagents={otherSession.subagentActivityStore}
          sideChat={otherSession.conversationSessionStore.sideChatStore}
        />
      </section>
      <section aria-label="Global pane">
        <ConversationActivity
          sessionId={globalChat.sessionId}
          placement="composer"
          subagents={globalChat.subagentActivityStore}
          sideChat={globalChat.conversationSessionStore.sideChatStore}
        />
      </section>
      <section aria-label="Cake header without composer">
        <ConversationActivity
          sessionId={cakeSession.sessionId}
          subagents={cakeSession.subagentActivityStore}
          sideChat={cakeSession.conversationSessionStore.sideChatStore}
        />
      </section>
    </StoreProvider>,
  );
  const pane = (name: string) => within(screen.getByRole("region", { name }));
  const cakePane = pane("Cake pane");
  const otherPane = pane("Other pane");
  const globalPane = pane("Global pane");
  expect(cakePane.getByRole("button", { name: "Needs attention" })).toBeTruthy();
  expect(cakePane.queryByRole("switch")).toBeNull();
  for (const owner of owners) publishWorker(owner, "running");
  for (const scope of [cakePane, otherPane, globalPane, pane("Cake header without composer")]) {
    await fixture.user.click(scope.getByRole("button", { name: "Activity · 1 running" }));
  }
  const cakeSwitch = within(
    cakePane.getByRole("region", { name: "Conversation activity" }),
  ).getByRole("switch", { name: "Auto-merge: on" });
  expect(otherPane.queryByRole("switch")).toBeNull();
  expect(globalPane.queryByRole("switch")).toBeNull();
  expect(pane("Cake header without composer").queryByRole("switch")).toBeNull();
  cakeSwitch.focus();
  await fixture.user.keyboard(" ");
  await waitFor(() =>
    expect(delegated(cake).getByRole("switch", { name: "Auto-merge: off" })).toBeTruthy(),
  );

  fixture.select(otherChat);
  expect(cakePane.getByRole("region", { name: "Conversation activity" })).toBeTruthy();
  expect(cakePane.queryByRole("switch")).toBeNull();
  const otherSwitch = otherPane.getByRole("switch", { name: "Auto-merge: off" });
  await fixture.user.click(delegated(other).getByRole("switch"));
  await waitFor(() => expect(otherSwitch.getAttribute("aria-checked")).toBe("true"));

  fixture.select(CAKE_CHAT_SESSION_ID);
  expect(screen.queryByRole("switch")).toBeNull();
  fixture.select(otherChat);
  act(() =>
    applySnapshot(fixture.models.projects, {
      projects: [
        projects[0]!,
        projectRecord({
          path: other,
          settings: { ...defaultProjectSettings(), worktreeLanding: "pull-request" },
        }),
      ],
    }),
  );
  expect(screen.queryByRole("switch")).toBeNull();
  expect(fixture.root.autoMergeStore.forProject(other)?.enabled).toBe(true);
  fixture.select(cakeChat);
  expect(cakePane.getByRole("switch", { name: "Auto-merge: off" })).toBeTruthy();
  publishWorker(cakeSession.sessionId, "complete");
  await fixture.user.click(cakePane.getByRole("button", { name: "Needs attention" }));
  expect(cakePane.getByRole("region", { name: "Needs attention" }).textContent).toContain(
    "Review the work",
  );
  expect(cakePane.queryByRole("switch")).toBeNull();
  expect(fixture.setAutoMerge.mock.calls).toEqual([
    [cake, false],
    [other, true],
  ]);
});
