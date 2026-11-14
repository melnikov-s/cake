/** @vitest-environment jsdom */
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StoreProvider } from "r-state-tree/react";
import { applySnapshot } from "r-state-tree";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProjectWorkflow } from "../../../src/contracts/application/application-data";
import type { SavedDraft } from "../../../src/contracts/project-sessions/saved-draft-data";
import { TurnId } from "../../../src/contracts/conversations/conversation-data";
import { ClientError, type Client } from "../../../src/renderer/client/Client";
import {
  ResolutionRejected,
  ResolutionCleanupFailed,
} from "../../../src/contracts/project-sessions/project-session-resolution";
import { WorkbenchErrorNotice } from "./workbench-error-notice";
import { applyConversationUpdate } from "../../../src/renderer/reducers/ConversationReducer";
import { Chat } from "../../../src/renderer/components/chat";
import { ConversationNavigator } from "../../../src/renderer/components/conversation-navigator";
import {
  fixtureTimestamp,
  projectRecord,
  sessionSummary,
  type SessionSummaryFixture,
} from "./fixtures/catalog-fixtures";
import { fakeSavedDrafts } from "./fakes/saved-drafts";
import { createRendererStoreFixture } from "./renderer-store-fixture";
import type { TestClientOverrides } from "./test-client";

const projectPath = "/work/cake";
const labelId = "b925b5dd-9661-4f1a-9f40-406be3c96c27";
const workflow: ProjectWorkflow = {
  labels: [{ id: labelId, name: "Feature", color: "blue" }],
  assignments: [],
  sessionDetails: [],
};
function projectSession(sessionId: string, overrides: Partial<SessionSummaryFixture> = {}) {
  return sessionSummary({ sessionId, projectPath, projectName: "Cake", ...overrides });
}
function deferred<Value>() {
  let resolve!: (value: Value) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<Value>((complete, fail) => {
    resolve = complete;
    reject = fail;
  });
  return { promise, resolve, reject };
}
async function renderManagement(
  options: {
    client?: TestClientOverrides;
    sessions?: SessionSummaryFixture[];
    pendingSessionId?: string;
    history?: string[];
    flushWindowState?: () => Promise<void>;
  } = {},
) {
  const fixture = createRendererStoreFixture({
    ...options,
    client: {
      ...options.client,
      projectSessions: { open: async () => undefined, ...options.client?.projectSessions },
      workspaces: { generateSessionTitle: async () => undefined, ...options.client?.workspaces },
    },
    projects: [projectRecord({ path: projectPath, name: "Cake", workflow })],
  });
  const { root } = fixture;
  applySnapshot(fixture.models.cakeChatCatalog, {
    loaded: true,
    sessions: [
      {
        sessionId: `project-chat:${"c".repeat(64)}`,
        title: "Project Chat",
        projectPath: projectPath,
      },
    ],
  });
  root.sidebarStore.sessionListStore.toggleResolvedGroupExpanded(projectPath);
  await root.sessionRegistry.pendingSessions.refreshSavedDrafts();
  const pending = options.pendingSessionId
    ? root.sessionRegistry.pendingSessions.prepare(projectPath, options.pendingSessionId)
    : undefined;
  if (pending) root.navigationStore.selectProjectSession(pending.sessionId);
  for (const id of options.history ?? []) {
    root.sessionRegistry.load(id, projectPath);
    applyConversationUpdate(fixture.models.projectConversation(id, projectPath), {
      _tag: "Snapshot",
      revision: 1,
      snapshot: {
        sessionId: id,
        sessionFile: `/sessions/${id}.jsonl`,
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
    root.navigationStore.selectProjectSession(id);
    root.projectWorkbenchStore.showLoadedSession(id);
    root.sessionLayoutStore.ensureSession(id);
  }
  const view = render(
    <StoreProvider store={root}>
      <ConversationNavigator projectPath={projectPath} />
      {pending && <Chat store={pending.conversationSessionStore.chatStore} />}
      <WorkbenchErrorNotice store={root.projectWorkbenchStore} />
    </StoreProvider>,
  );
  return {
    root,
    user: userEvent.setup(),
    async publishSessions(sessions: SessionSummaryFixture[]) {
      await act(async () =>
        applySnapshot(fixture.models.sessionCatalog, {
          sessions,
          resolvedHasMoreByProject: {},
        }),
      );
    },
    async publishWorkflow(next: ProjectWorkflow) {
      await act(async () =>
        applySnapshot(fixture.models.projects, {
          projects: [projectRecord({ path: projectPath, name: "Cake", workflow: next })],
        }),
      );
    },
    [Symbol.dispose]() {
      view.unmount();
      fixture[Symbol.dispose]();
    },
  };
}
function region(resolved = false) {
  return within(
    screen.getByRole("region", { name: resolved ? "Resolved sessions" : "Active sessions" }),
  );
}
afterEach(cleanup);

describe("Session management workflow", () => {
  it.each([
    ["move-to-user", "delegated", "user"],
    ["move-to-delegated", "user", "delegated"],
  ] as const)(
    "%s switches purpose through one backend call without resolving, reopening or changing focused context",
    async (action, from, purpose) => {
      const setPurpose = vi.fn<Client["projectSessions"]["setPurpose"]>(async () => undefined);
      const resolve = vi.fn<Client["projectSessions"]["resolve"]>(async () => undefined);
      const menu = vi.fn<Client["electron"]["showSessionContextMenu"]>(async () => ({ action }));
      using fixture = await renderManagement({
        client: {
          projectSessions: { setPurpose, resolve },
          electron: { showSessionContextMenu: menu },
        },
        sessions: [
          projectSession("focused", { title: "My discussion" }),
          { ...projectSession("assigned", { title: "Assigned work" }), purpose: from },
        ],
        history: ["focused"],
      });
      const selection = fixture.root.appShellStore.activeConversation;
      await fixture.user.pointer({
        target: region().getByRole("button", { name: /^Assigned work/ }),
        keys: "[MouseRight]",
      });
      await waitFor(() => expect(setPurpose).toHaveBeenCalledOnce());
      expect(menu.mock.calls[0]?.[0]).toMatchObject({
        sessionId: "assigned",
        delegated: from === "delegated",
      });
      expect(setPurpose).toHaveBeenCalledWith(
        { sessionId: "assigned", purpose },
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
      expect(resolve).not.toHaveBeenCalled();
      expect(fixture.root.appShellStore.activeConversation).toEqual(selection);
    },
  );

  it("renames an unselected session through the sidebar without changing the focused conversation", async () => {
    const rename = vi.fn<Client["projectSessions"]["rename"]>(async () => undefined);
    const menu = vi.fn<Client["electron"]["showSessionContextMenu"]>(async () => ({
      action: "rename",
    }));
    const sessions = [
      projectSession("background", { title: "Background session" }),
      projectSession("focused", { title: "Focused session" }),
    ];
    using fixture = await renderManagement({
      client: { projectSessions: { rename }, electron: { showSessionContextMenu: menu } },
      sessions,
      history: ["focused"],
    });
    await fixture.user.pointer({
      target: region().getByRole("button", { name: /^Background session/ }),
      keys: "[MouseRight]",
    });
    const input = await screen.findByRole("textbox", { name: "Session name" });
    await fixture.user.clear(input);
    await fixture.user.type(input, "Renamed background{Enter}");
    await waitFor(() => expect(rename).toHaveBeenCalledOnce());
    expect(rename).toHaveBeenCalledWith(
      { sessionId: "background", name: "Renamed background" },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    await fixture.publishSessions([{ ...sessions[0]!, title: "Renamed background" }, sessions[1]!]);
    expect(region().getByText("Renamed background")).toBeDefined();
    expect(
      region()
        .getByRole("button", { name: /^Focused session/ })
        .getAttribute("aria-current"),
    ).toBe("page");
  });

  it("retires authoritative family IDs and shows cleanup details before the projection arrives", async () => {
    const pending = deferred<void>();
    const resolve = vi.fn<Client["projectSessions"]["resolve"]>(() => pending.promise);
    const sessions = [projectSession("other"), projectSession("parent"), projectSession("child")];
    using fixture = await renderManagement({
      client: { projectSessions: { resolve } },
      sessions,
      history: ["other", "child"],
    });
    await fixture.user.click(region().getByRole("button", { name: "Resolve parent" }));
    const failure = new ResolutionCleanupFailed({
      operation: "resolve",
      resolvedSessionIds: ["parent", "child"],
      cleanupFailures: [{ workingDirectory: "/child-tree", message: "Checkout busy" }],
      message: "Resolution committed",
    });
    await act(async () =>
      pending.reject(
        new ClientError("rejected", "projectSessions.resolve", failure.message, failure.message, {
          domainFailure: failure,
        }),
      ),
    );
    await waitFor(() =>
      expect(fixture.root.appShellStore.activeConversation).toEqual({
        kind: "cake-chat",
        sessionId: `project-chat:${"c".repeat(64)}`,
      }),
    );
    expect(fixture.root.sessionRegistry.findSession("child")).toBeUndefined();
    expect(
      await screen.findByText("Sessions resolved; cleanup failed for /child-tree: Checkout busy", {
        selector: "span",
      }),
    ).toBeDefined();
    // The delayed catalog is still authoritative: retirement must not forge its resolution state.
    expect(region().getByText("parent")).toBeDefined();
    expect(region().getByText("child")).toBeDefined();
    await fixture.publishSessions(
      sessions.map((session) => ({ ...session, resolved: session.sessionId !== "other" })),
    );
    expect(region(true).getByText("child")).toBeDefined();
    expect(resolve).toHaveBeenCalledOnce();
  });

  it.each(["rejected", "transport"] as const)(
    "keeps the session open on %s resolution failure",
    async (kind) => {
      const refusal = new ResolutionRejected({
        operation: "resolve",
        sessionIds: ["current"],
        message: "Turn still active",
      });
      const failure =
        kind === "rejected"
          ? new ClientError(kind, "projectSessions.resolve", refusal.message, refusal.message, {
              domainFailure: refusal,
            })
          : new ClientError(
              kind,
              "projectSessions.resolve",
              "Connection lost; outcome unknown",
              "Disconnected",
            );
      const resolve = vi.fn<Client["projectSessions"]["resolve"]>(async () => {
        throw failure;
      });
      using fixture = await renderManagement({
        client: { projectSessions: { resolve } },
        sessions: [projectSession("other"), projectSession("current")],
        history: ["other", "current"],
      });
      await fixture.user.click(region().getByRole("button", { name: "Resolve current" }));
      expect(await screen.findByText(failure.message)).toBeDefined();
      expect(
        region()
          .getByText("current")
          .closest("[data-session-id]")
          ?.getAttribute("data-navigation-active"),
      ).toBe("true");
      expect(resolve).toHaveBeenCalledOnce();
    },
  );

  it("does not navigate after a disposed workflow receives committed cleanup failure", async () => {
    const pending = deferred<void>();
    const open = vi.fn<Client["projectSessions"]["open"]>(async () => undefined);
    const fixture = await renderManagement({
      client: { projectSessions: { resolve: () => pending.promise, open } },
      sessions: [projectSession("other"), projectSession("current")],
      history: ["other", "current"],
    });
    await fixture.user.click(region().getByRole("button", { name: "Resolve current" }));
    fixture[Symbol.dispose]();
    const failure = new ResolutionCleanupFailed({
      operation: "resolve",
      resolvedSessionIds: ["current"],
      cleanupFailures: [{ workingDirectory: projectPath, message: "Checkout busy" }],
      message: "Resolution committed",
    });
    await act(async () =>
      pending.reject(
        new ClientError("rejected", "projectSessions.resolve", failure.message, failure.message, {
          domainFailure: failure,
        }),
      ),
    );
    expect(open).not.toHaveBeenCalled();
  });

  it("deletes a saved draft through its native menu without deleting a Project Session", async () => {
    const savedDrafts = fakeSavedDrafts();
    const draft: SavedDraft = {
      sessionId: "10000000-0000-4000-8000-000000000001",
      projectPath,
      workingDirectory: projectPath,
      title: "Saved draft",
      text: "Saved work",
      attachments: [],
      labelIds: [],
      resolved: false,
      createdAt: fixtureTimestamp,
      modifiedAt: fixtureTimestamp,
      revision: 1,
      status: "saved",
    };
    savedDrafts.records.set(draft.sessionId, draft);
    const menu = vi.fn<Client["electron"]["showSessionContextMenu"]>(async () => ({
      action: "delete",
    }));
    const deleteSession = vi.fn<Client["workspaces"]["deleteSession"]>();
    using fixture = await renderManagement({
      client: {
        savedDrafts: savedDrafts.client,
        electron: { showSessionContextMenu: menu },
        workspaces: { deleteSession },
      },
    });
    expect(region().getByText("Draft")).toBeDefined();
    await fixture.user.pointer({
      target: region().getByText(draft.title),
      keys: "[MouseRight]",
    });
    await waitFor(() => expect(region().queryByText(draft.title)).toBeNull());
    expect(menu).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: draft.sessionId, draft: true, resolved: false }),
    );
    expect(savedDrafts.records.has(draft.sessionId)).toBe(false);
    expect(deleteSession).not.toHaveBeenCalled();
  });

  it.each(["button", "former-resolve"] as const)(
    "deletes a selected draft via %s without resolving real sessions or redirecting agent commands",
    async (action) => {
      const drafts = fakeSavedDrafts();
      const id = "10000000-0000-4000-8000-000000000001";
      drafts.records.set(id, {
        sessionId: id,
        projectPath,
        workingDirectory: projectPath,
        title: "Unsent plan",
        text: "Keep this unsent",
        attachments: [],
        labelIds: [],
        resolved: false,
        createdAt: fixtureTimestamp,
        modifiedAt: fixtureTimestamp,
        revision: 1,
        status: "saved",
      });
      const remove = vi.fn(drafts.client.remove);
      const resolve = vi.fn<Client["projectSessions"]["resolve"]>();
      const deleteSession = vi.fn<Client["workspaces"]["deleteSession"]>();
      using fixture = await renderManagement({
        client: {
          savedDrafts: { ...drafts.client, remove },
          projectSessions: { resolve },
          workspaces: { deleteSession },
        },
        history: [id],
      });
      expect(region().queryByRole("button", { name: "Resolve Unsent plan" })).toBeNull();
      if (action === "button") {
        await fixture.user.click(region().getByRole("button", { name: "Delete Unsent plan" }));
      } else {
        await act(async () => {
          expect(
            await fixture.root.sessionRetirementStore.setProjectSessionsResolved(
              [id],
              true,
              "agent",
            ),
          ).toBe(1);
        });
      }
      await waitFor(() => expect(region().queryByText("Unsent plan")).toBeNull());
      expect(region(true).queryByText("Unsent plan")).toBeNull();
      expect(drafts.records.has(id)).toBe(false);
      expect(remove).toHaveBeenCalledExactlyOnceWith(
        id,
        1,
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
      expect(resolve).not.toHaveBeenCalled();
      expect(deleteSession).not.toHaveBeenCalled();
      if (action === "button") {
        expect(fixture.root.sessionRegistry.findSession(id)).toBeUndefined();
        expect(fixture.root.appShellStore.activeConversation).toEqual({
          kind: "cake-chat",
          sessionId: `project-chat:${"c".repeat(64)}`,
        });
        expect(fixture.root.sessionLayoutStore.history).not.toContain(id);
      } else {
        expect(fixture.root.sessionRegistry.findSession(id)).toBeUndefined();
        expect(fixture.root.appShellStore.activeConversation).toEqual({
          kind: "project-session",
          sessionId: id,
        });
        expect(fixture.root.sessionLayoutStore.history).toContain(id);
      }
    },
  );

  it("excludes historical resolved drafts without deleting their saved content", async () => {
    const drafts = fakeSavedDrafts();
    const id = "10000000-0000-4000-8000-000000000001";
    const record: SavedDraft = {
      sessionId: id,
      projectPath,
      workingDirectory: projectPath,
      title: "Old resolved draft",
      text: "Historical content",
      attachments: [],
      labelIds: [],
      resolved: true,
      createdAt: fixtureTimestamp,
      modifiedAt: fixtureTimestamp,
      revision: 4,
      status: "saved",
    };
    drafts.records.set(id, record);
    const remove = vi.fn(drafts.client.remove);
    using fixture = await renderManagement({
      client: { savedDrafts: { ...drafts.client, remove } },
      sessions: [projectSession("real-resolved", { title: "Real history", resolved: true })],
    });
    expect(region(true).getByText("Real history")).toBeDefined();
    expect(screen.queryByText(record.title)).toBeNull();
    expect(drafts.records.get(id)).toEqual(record);
    expect(remove).not.toHaveBeenCalled();
    expect(fixture.root.sessionRegistry.pendingSessions.savedRecord(id)).toEqual(record);
  });

  it("refreshes a stale delete and leaves a draft available for an explicit retry", async () => {
    const drafts = fakeSavedDrafts();
    const id = "10000000-0000-4000-8000-000000000001";
    const record: SavedDraft = {
      sessionId: id,
      projectPath,
      workingDirectory: projectPath,
      title: "Unsent plan",
      text: "Original",
      attachments: [],
      labelIds: [],
      resolved: false,
      createdAt: fixtureTimestamp,
      modifiedAt: fixtureTimestamp,
      revision: 1,
      status: "saved",
    };
    drafts.records.set(id, record);
    const remove = vi.fn(drafts.client.remove);
    using fixture = await renderManagement({
      client: { savedDrafts: { ...drafts.client, remove } },
    });
    drafts.records.set(id, {
      ...record,
      text: "New remote content",
      title: "Remote plan",
      revision: 2,
    });
    await fixture.user.click(region().getByRole("button", { name: "Delete Unsent plan" }));
    await region().findByText("Remote plan");
    expect(await screen.findByText("Saved Draft revision conflict (remove)")).toBeDefined();
    expect(drafts.records.get(id)?.text).toBe("New remote content");
    await fixture.user.click(region().getByRole("button", { name: "Delete Remote plan" }));
    await waitFor(() => expect(region().queryByText("Remote plan")).toBeNull());
    expect(drafts.records.has(id)).toBe(false);
    expect(remove).toHaveBeenLastCalledWith(
      id,
      2,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("resolves and restores a family through its parent, keeping child lifecycle controls unavailable", async () => {
    const pending = deferred<void>();
    const resolve = vi.fn<Client["projectSessions"]["resolve"]>(() => pending.promise);
    const restore = vi.fn<Client["projectSessions"]["restore"]>(async () => undefined);
    const family = [
      projectSession("parent", {
        title: "Family parent",
        familyId: "10000000-0000-4000-8000-000000000003",
        familyParentSessionId: "parent",
        familyChildSessionIds: ["child"],
      }),
      projectSession("child", {
        title: "Family child",
        familyId: "10000000-0000-4000-8000-000000000003",
        familyParentSessionId: "parent",
        familyChildOrder: 1,
        familyDepth: 1,
      }),
    ];
    using fixture = await renderManagement({
      client: { projectSessions: { resolve, restore } },
      sessions: family,
    });
    expect(region().getByText("Family child")).toBeDefined();
    expect(region().queryByRole("button", { name: "Resolve Family child" })).toBeNull();
    await fixture.user.click(region().getByRole("button", { name: "Resolve Family parent" }));
    await fixture.user.click(region().getByRole("button", { name: "Resolve Family parent" }));
    expect(resolve).toHaveBeenCalledOnce();
    expect(resolve).toHaveBeenCalledWith(
      { sessionId: "parent", workingDirectory: projectPath, userInitiated: true },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    await fixture.publishSessions(family.map((session) => ({ ...session, resolved: true })));
    await act(async () => pending.resolve());
    expect(region().queryByText("Family parent")).toBeNull();
    expect(region(true).getByText("Family child")).toBeDefined();
    expect(region(true).queryByRole("button", { name: "Restore Family child" })).toBeNull();
    await fixture.user.click(region(true).getByRole("button", { name: "Restore Family parent" }));
    await waitFor(() => expect(restore).toHaveBeenCalledOnce());
    expect(restore).toHaveBeenCalledWith(
      { sessionId: "parent", workingDirectory: projectPath, userInitiated: true },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    await fixture.publishSessions(family);
    expect(region().getByText("Family child")).toBeDefined();
    expect(region(true).queryByText("Family parent")).toBeNull();
  });

  it("retains pending labels through a failed start and retry, then persists edits to the materialized session", async () => {
    const failedStart = deferred<Awaited<ReturnType<Client["projectSessions"]["start"]>>>();
    const started = deferred<Awaited<ReturnType<Client["projectSessions"]["start"]>>>();
    const start = vi
      .fn<Client["projectSessions"]["start"]>()
      .mockReturnValueOnce(failedStart.promise)
      .mockReturnValueOnce(started.promise);
    const setSessionLabels = vi.fn<Client["projectWorkflow"]["setSessionLabels"]>(
      async () => workflow,
    );
    const flushWindowState = vi.fn(async () => undefined);
    using fixture = await renderManagement({
      client: { projectSessions: { start }, projectWorkflow: { setSessionLabels } },
      pendingSessionId: "session-1",
      flushWindowState,
    });
    await fixture.user.type(screen.getByRole("combobox", { name: "Message" }), "Build the feature");
    await fixture.user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(start).toHaveBeenCalledOnce());
    await fixture.user.click(region().getByRole("button", { name: /Change session labels/ }));
    await fixture.user.click(screen.getByRole("checkbox", { name: "Feature" }));
    await waitFor(() =>
      expect(screen.getByRole("checkbox", { name: "Feature", checked: true })).toBeDefined(),
    );
    expect(flushWindowState).toHaveBeenCalled();
    expect(setSessionLabels).not.toHaveBeenCalled();
    await fixture.user.keyboard("{Escape}");
    await act(async () => failedStart.reject(new Error("Could not start session")));
    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: "Message" }).getAttribute("aria-busy")).toBe(
        "false",
      ),
    );
    expect(screen.getByRole("combobox", { name: "Message" })).toHaveProperty(
      "value",
      "Build the feature",
    );
    await fixture.user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(start).toHaveBeenCalledTimes(2));
    expect(start).toHaveBeenLastCalledWith(
      expect.objectContaining({
        sessionId: "session-1",
        text: "Build the feature",
        labelIds: [labelId],
      }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(region().getByRole("button", { name: /Current labels: Feature/ })).toBeDefined();
    await act(async () => started.resolve(TurnId.make("10000000-0000-4000-8000-000000000002")));
    await fixture.publishSessions([projectSession("session-1", { title: "Build the feature" })]);
    await fixture.publishWorkflow({
      ...workflow,
      assignments: [{ sessionId: "session-1", labelIds: [labelId] }],
    });
    await fixture.user.click(region().getByRole("button", { name: /Current labels: Feature/ }));
    await fixture.user.click(screen.getByRole("button", { name: "Clear" }));
    await waitFor(() =>
      expect(setSessionLabels).toHaveBeenCalledWith(
        {
          projectPath,
          sessionId: "session-1",
          workingDirectory: projectPath,
          labelIds: [],
        },
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      ),
    );
    await fixture.publishWorkflow(workflow);
    expect(screen.getByRole("checkbox", { name: "Feature", checked: false })).toBeDefined();
  });
});
