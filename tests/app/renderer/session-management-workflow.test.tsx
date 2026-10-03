/** @vitest-environment jsdom */
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { applySnapshot } from "r-state-tree";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProjectWorkflow } from "../../../src/domain/application/application-data";
import type { SavedDraft } from "../../../src/domain/project-sessions/saved-draft-data";
import { TurnId } from "../../../src/domain/conversations/conversation-data";
import type { Client } from "../../../src/renderer/client/Client";
import { Chat } from "../../../src/renderer/components/chat";
import { SidebarProjectGroup } from "../../../src/renderer/components/sidebar-project-group";
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
    flushWindowState?: () => Promise<void>;
  } = {},
) {
  const fixture = createRendererStoreFixture({
    ...options,
    client: {
      ...options.client,
      workspaces: { generateSessionTitle: async () => undefined, ...options.client?.workspaces },
    },
    projects: [projectRecord({ path: projectPath, name: "Cake", workflow })],
  });
  const { root } = fixture;
  await root.sessionRegistry.pendingSessions.refreshSavedDrafts();
  const pending = options.pendingSessionId
    ? root.sessionRegistry.pendingSessions.prepare(projectPath, options.pendingSessionId)
    : undefined;
  if (pending) root.appShellStore.selectProjectSession(pending.sessionId);
  const view = render(
    <>
      {[false, true].map((resolved) => (
        <section
          key={String(resolved)}
          aria-label={resolved ? "Resolved sessions" : "Active sessions"}
        >
          <SidebarProjectGroup
            store={root.sidebarStore}
            sessionList={root.sidebarStore.sessionListStore}
            sessionMetadata={root.sessionMetadataStore}
            projects={root.projectCatalogStore}
            chat={root.projectWorkbenchStore}
            shell={root.appShellStore}
            appearance={root.settingsStore.appearance}
            path={projectPath}
            resolved={resolved}
            flattenSessions
            onCreateSession={(path) => void root.createSession(path)}
            onOpenSession={(id) => void root.openSession(id)}
            onRemoveProject={(path, deleteSessions) =>
              root.projectRemovalStore.remove(path, deleteSessions)
            }
            onOpenSettings={(path) => root.projectSettingsStore.open(path)}
          />
        </section>
      ))}
      {pending && <Chat store={pending.conversationSessionStore.chatStore} />}
    </>,
  );
  return {
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
  it("deletes a resolved saved draft through its native menu without deleting a Project Session", async () => {
    const savedDrafts = fakeSavedDrafts();
    const draft: SavedDraft = {
      sessionId: "10000000-0000-4000-8000-000000000001",
      projectPath,
      workingDirectory: projectPath,
      title: "Resolved draft",
      text: "Saved work",
      attachments: [],
      labelIds: [],
      resolved: true,
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
    expect(region(true).getByText("Draft")).toBeDefined();
    await fixture.user.pointer({
      target: region(true).getByText(draft.title),
      keys: "[MouseRight]",
    });
    await waitFor(() => expect(region(true).queryByText(draft.title)).toBeNull());
    expect(menu).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: draft.sessionId, draft: true, resolved: true }),
    );
    expect(savedDrafts.records.has(draft.sessionId)).toBe(false);
    expect(deleteSession).not.toHaveBeenCalled();
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
      { sessionId: "parent", workingDirectory: projectPath },
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
      { sessionId: "parent", workingDirectory: projectPath },
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
