/** @vitest-environment jsdom */
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { applySnapshot } from "r-state-tree";
import { StoreProvider } from "r-state-tree/react";
import { afterEach, expect, it, vi } from "vitest";
import { defaultProjectSettings } from "../../../src/contracts/application/application-data";
import { CAKE_CHAT_SESSION_ID } from "../../../src/contracts/cake-chats/cake-chat-identity";
import { ConversationActivity } from "../../../src/renderer/components/conversation-activity";
import { ConversationNavigator } from "../../../src/renderer/components/conversation-navigator";
import { applySubagentUpdate } from "../../../src/renderer/reducers/SubagentReducer";
import { applyWorktreeOperationCatalogUpdate } from "../../../src/renderer/reducers/WorktreeOperationReducer";
import { fixtureTimestamp, projectRecord, sessionSummary } from "./fixtures/catalog-fixtures";
import { createRendererStoreFixture } from "./renderer-store-fixture";
import { workerActivity } from "./subagent-activity-workflow-fixture";

const project = "/project";
const other = "/other";
const projectChat = `project-chat:${"a".repeat(64)}`;
const otherChat = `project-chat:${"b".repeat(64)}`;

const projects = [projectRecord({ path: project }), projectRecord({ path: other })];
const sessions = [
  sessionSummary({ sessionId: "my-session", projectPath: project, purpose: "user" }),
  sessionSummary({ sessionId: "worker", projectPath: project, purpose: "delegated" }),
  sessionSummary({ sessionId: "my-other-session", projectPath: other, purpose: "user" }),
];

afterEach(cleanup);

it.each([false, true])(
  "keeps independent project switches in Delegated and synchronizes the owning Activity switch (global=%s)",
  async (global) => {
    const setAutoMerge = vi.fn(async (projectPath: string, enabled: boolean) => {
      act(() =>
        publish(
          fixture.models.worktreeOperations.autoMergeProjects.map((item) =>
            item.projectPath === projectPath ? { ...item, enabled } : item,
          ),
        ),
      );
    });
    using fixture = createRendererStoreFixture({
      projects,
      sessions,
      client: { managedWorktrees: { setAutoMerge } },
    });
    const publish = (
      autoMergeProjects: typeof fixture.models.worktreeOperations.autoMergeProjects,
    ) =>
      applyWorktreeOperationCatalogUpdate(fixture.models.worktreeOperations, {
        operations: [],
        autoMergeProjects,
      });
    applySnapshot(fixture.models.cakeChatCatalog, {
      loaded: true,
      sessions: [
        [projectChat, project],
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
    });
    const otherSession = fixture.root.sessionRegistry.load("my-other-session", other);
    applySubagentUpdate(fixture.models.subagentCatalog("my-other-session"), "my-other-session", {
      _tag: "Snapshot",
      revision: 1,
      parentSessionId: "my-other-session",
      backgroundActive: true,
      activities: [
        workerActivity({ parentSessionId: "my-other-session", status: "running", streaming: true }),
      ],
    });
    publish([
      { projectPath: project, enabled: true, epoch: "one", status: "On" },
      { projectPath: other, enabled: false, epoch: "two", status: "Off" },
    ]);
    const selected = global ? CAKE_CHAT_SESSION_ID : projectChat;
    fixture.root.navigationStore.selectCakeChat(selected);
    const view = render(
      <StoreProvider store={fixture.root}>
        <ConversationNavigator projectPath={global ? undefined : project} />
        <ConversationActivity
          sessionId="my-other-session"
          placement="strip"
          subagents={otherSession.subagentActivityStore}
          sideChat={otherSession.conversationSessionStore.sideChatStore}
        />
      </StoreProvider>,
    );
    const user = userEvent.setup();
    const navigator = within(screen.getByRole("region", { name: "Sessions" }));
    const group = (path: string) =>
      within(
        navigator
          .getAllByRole("region", { name: "Delegated" })
          .find((element) => element.dataset.projectPath === path)!,
      );
    const disclosure = group(project).getByRole("button", { name: "Delegated" });
    const toggle = group(project).getByRole("switch");
    const peer = group(other).getByRole("switch");
    const activity = screen.getByRole("button", { name: "Activity · 1 running" });
    const activitySwitch = screen
      .getAllByRole("switch")
      .find((element) => element !== toggle && element !== peer)!;
    expect(navigator.getAllByRole("switch")).toHaveLength(2);
    expect(
      within(navigator.getByRole("region", { name: "My sessions" })).queryByRole("switch"),
    ).toBeNull();
    expect(navigator.getByText("0 delegated · 0 running")).toBeTruthy();
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect(peer.getAttribute("aria-checked")).toBe("false");
    expect(toggle.parentElement?.closest("button, [role=button]")).toBeNull();
    expect(disclosure.getAttribute("aria-expanded")).toBe("false");
    expect(setAutoMerge).not.toHaveBeenCalled();

    await user.click(group(project).getByText("Auto-merge", { exact: true }));
    await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("false"));
    expect(disclosure.getAttribute("aria-expanded")).toBe("false");
    expect(navigator.queryByText("worker")).toBeNull();
    expect(fixture.root.appShellStore.activeConversation?.sessionId).toBe(selected);

    activitySwitch.focus();
    await user.keyboard(" ");
    await waitFor(() => expect(peer.getAttribute("aria-checked")).toBe("true"));
    expect(activitySwitch.getAttribute("aria-checked")).toBe("true");
    expect(activity.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("region", { name: "Conversation activity" })).toBeNull();
    await user.click(peer);
    await waitFor(() => expect(activitySwitch.getAttribute("aria-checked")).toBe("false"));
    expect(activity.getAttribute("aria-expanded")).toBe("false");
    expect(setAutoMerge.mock.calls).toEqual([
      [project, false],
      [other, true],
      [other, false],
    ]);
    expect(fixture.root.appShellStore.activeConversation?.sessionId).toBe(selected);

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
    expect(screen.getAllByRole("switch")).toEqual([toggle]);
    expect(fixture.root.autoMergeStore.forProject(other)?.enabled).toBe(false);
    expect(setAutoMerge).toHaveBeenCalledTimes(3);
    view.unmount();
  },
);
