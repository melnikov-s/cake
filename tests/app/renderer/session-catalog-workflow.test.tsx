/** @vitest-environment jsdom */
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { applySnapshot } from "r-state-tree";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TurnId } from "../../../src/contracts/conversations/conversation-data";
import type { SavedDraft } from "../../../src/contracts/project-sessions/saved-draft-data";
import type { SessionCatalogUpdate } from "../../../src/contracts/application/catalog-data";
import { applySessionCatalogGroupUpdate } from "../../../src/renderer/reducers/CatalogReducer";
import type { Client } from "../../../src/renderer/client/Client";
import { Chat } from "../../../src/renderer/components/chat";
import { SidebarProjectGroup } from "../../../src/renderer/components/sidebar-project-group";
import { fakeSavedDrafts } from "./fakes/saved-drafts";
import {
  fixtureTimestamp,
  projectRecord,
  sessionSummary,
  type SessionSummaryFixture,
} from "./fixtures/catalog-fixtures";
import { createRendererStoreFixture } from "./renderer-store-fixture";
import type { TestClientOverrides } from "./test-client";

const projectPath = "/project";
const sessionId = "10000000-0000-4000-8000-000000000001";
function summary(id: string, overrides: Partial<SessionSummaryFixture> = {}) {
  return sessionSummary({ sessionId: id, projectPath, projectName: "Project", ...overrides });
}
function deferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}
async function renderCatalog(
  options: {
    sessions?: SessionSummaryFixture[];
    client?: TestClientOverrides;
    drafts?: SavedDraft[];
  } = {},
) {
  const drafts = fakeSavedDrafts();
  for (const draft of options.drafts ?? []) drafts.records.set(draft.sessionId, draft);
  const fixture = createRendererStoreFixture({
    projects: [projectRecord({ path: projectPath, name: "Project" })],
    sessions: options.sessions,
    client: {
      ...options.client,
      savedDrafts: drafts.client,
      workspaces: {
        loadStagedSlashCommands: async () => [],
        generateSessionTitle: async () => undefined,
        ...options.client?.workspaces,
      },
    },
  });
  const { root } = fixture;
  await root.sessionRegistry.pendingSessions.refreshSavedDrafts();
  const staged = root.sessionRegistry.pendingSessions.prepareStaged(projectPath, sessionId);
  root.appShellStore.selectProjectSession(sessionId);
  root.sessionLayoutStore.ensureSession(sessionId);
  root.projectWorkbenchStore.showLoadedSession(sessionId);
  const view = render(
    <>
      <aside aria-label="Project sessions">
        <SidebarProjectGroup
          store={root.sidebarStore}
          sessionList={root.sidebarStore.sessionListStore}
          sessionMetadata={root.sessionMetadataStore}
          projects={root.projectCatalogStore}
          chat={root.projectWorkbenchStore}
          shell={root.appShellStore}
          appearance={root.settingsStore.appearance}
          path={projectPath}
          resolved={false}
          flattenSessions
          onCreateSession={(path) => void root.navigationStore.createSession(path)}
          onOpenSession={(id) => void root.navigationStore.openSession(id)}
          onRemoveProject={(path, deleteSessions) =>
            root.projectRemovalStore.remove(path, deleteSessions)
          }
          onOpenSettings={(path) => root.projectSettingsStore.open(path)}
        />
      </aside>
      <Chat store={staged.conversationSessionStore.chatStore} composerFocusEnabled={false} />
    </>,
  );
  return {
    root,
    user: userEvent.setup(),
    async publish(sessions: SessionSummaryFixture[]) {
      await act(async () =>
        applySnapshot(fixture.models.sessionCatalog, { sessions, resolvedHasMoreByProject: {} }),
      );
    },
    async publishUpdate(update: SessionCatalogUpdate) {
      await act(async () =>
        applySessionCatalogGroupUpdate(
          fixture.models.sessionCatalog,
          { projectPath, resolved: false },
          update,
        ),
      );
    },
    [Symbol.dispose]() {
      view.unmount();
      fixture[Symbol.dispose]();
    },
  };
}
function sidebar() {
  return within(screen.getByRole("complementary", { name: "Project sessions" }));
}
afterEach(cleanup);

describe("Session catalog lifecycle workflows", () => {
  it("shows a finished background turn as unread but clears it for the selected session", async () => {
    const setSessionUnread = vi.fn<Client["workspaces"]["setSessionUnread"]>(
      async () => ({}) as never,
    );
    using fixture = await renderCatalog({
      sessions: [
        summary(sessionId, { title: "Selected" }),
        summary("background", { title: "Background" }),
      ],
      client: { workspaces: { setSessionUnread } },
    });
    const row = (name: RegExp) =>
      sidebar().getByRole("button", { name }).closest<HTMLElement>(".session-item")!;
    const finished = (revision: number, id: string) =>
      fixture.publishUpdate({
        _tag: "Event",
        revision,
        event: { _tag: "ActivityChanged", sessionId: id, running: false, unread: true },
      });
    await finished(2, "background");
    expect(within(row(/^Background /)).getByRole("img", { name: "Ready, unread" })).toBeTruthy();
    expect(setSessionUnread).not.toHaveBeenCalled();
    // The user watched the selected session finish, so its backend mark is cleared.
    await finished(3, sessionId);
    expect(setSessionUnread).toHaveBeenCalledExactlyOnceWith(sessionId, false, expect.anything());
  });

  it("keeps a reminder the user set on the selected session", async () => {
    const setSessionUnread = vi.fn<Client["workspaces"]["setSessionUnread"]>(
      async () => ({}) as never,
    );
    using fixture = await renderCatalog({
      sessions: [summary(sessionId, { title: "Selected" })],
      client: { workspaces: { setSessionUnread } },
    });
    await act(() => fixture.root.sidebarStore.setSessionUnread(sessionId, true));
    await fixture.publishUpdate({
      _tag: "Event",
      revision: 2,
      event: { _tag: "StatusChanged", sessionId, resolved: false, unread: true },
    });
    expect(setSessionUnread.mock.calls.map(([, unread]) => unread)).toEqual([true]);
  });

  it("moves an unopened session up when its background turn settles, ignoring stale times", async () => {
    using fixture = await renderCatalog({
      sessions: [
        summary("newer", { title: "Newer", modifiedAt: "2026-01-02T00:00:00.000Z" }),
        summary("background", { title: "Background", modifiedAt: "2026-01-01T00:00:00.000Z" }),
      ],
    });
    const order = () =>
      sidebar()
        .getAllByRole("button", { name: /^(Newer|Background) / })
        .map((button) => button.closest(".session-item")?.getAttribute("data-session-id"));
    expect(order()).toEqual(["newer", "background"]);
    const settled = (revision: number, modifiedAt: string) =>
      fixture.publishUpdate({
        _tag: "Event",
        revision,
        event: { _tag: "ActivityChanged", sessionId: "background", running: false, modifiedAt },
      });
    // The settle event alone carries the new transcript time; no Upsert or open is needed.
    await settled(2, "2026-01-03T00:00:00.000Z");
    expect(order()).toEqual(["background", "newer"]);
    // A late event observed before a newer write must not move the row back.
    await settled(3, "2026-01-01T12:00:00.000Z");
    expect(order()).toEqual(["background", "newer"]);
  });

  it("shows background child activity without opening it, then clears it on settlement", async () => {
    const child = summary("child", {
      title: "Background worker",
      familyId: "family",
      familyParentSessionId: "parent",
      familyDepth: 1,
    });
    const parent = summary("parent", {
      title: "Parent",
      familyId: "family",
      familyParentSessionId: "parent",
      familyChildSessionIds: ["child"],
      familyDepth: 0,
    });
    using fixture = await renderCatalog({ sessions: [parent] });
    // The child arrives after the sidebar is mounted, already accepted by the backend.
    await fixture.publishUpdate({
      _tag: "Event",
      revision: 2,
      event: {
        _tag: "UpsertedBatch",
        sessions: [parent, { ...child, running: true }],
      },
    });
    const row = () =>
      sidebar()
        .getByRole("button", { name: /^Background worker / })
        .closest<HTMLElement>(".session-item")!;
    expect(within(row()).getByRole("img", { name: "Running" })).toBeTruthy();
    expect(
      within(
        sidebar()
          .getByRole("button", { name: /^Parent / })
          .closest<HTMLElement>(".session-item")!,
      ).queryByRole("img", {
        name: "Running",
      }),
    ).toBeNull();
    await fixture.publishUpdate({
      _tag: "Event",
      revision: 3,
      event: {
        _tag: "ActivityChanged",
        sessionId: "child",
        running: false,
      },
    });
    expect(within(row()).queryByRole("img", { name: "Running" })).toBeNull();
    await fixture.publishUpdate({
      _tag: "Event",
      revision: 4,
      event: {
        _tag: "StatusChanged",
        sessionId: "child",
        resolved: false,
        unread: true,
      },
    });
    expect(within(row()).getByRole("img", { name: "Ready, unread" })).toBeTruthy();
    await fixture.publishUpdate({
      _tag: "Event",
      revision: 5,
      event: {
        _tag: "ActivityChanged",
        sessionId: "child",
        running: true,
      },
    });
    expect(within(row()).getByRole("img", { name: "Running" })).toBeTruthy();
  });

  it.each(["before", "after"] as const)(
    "replaces the submitted title with authority arriving %s start completes, without resurrecting it on removal",
    async (timing) => {
      const started = deferred<Awaited<ReturnType<Client["projectSessions"]["start"]>>>();
      const start = vi.fn<Client["projectSessions"]["start"]>(() => started.promise);
      using fixture = await renderCatalog({ client: { projectSessions: { start } } });
      await fixture.user.type(
        screen.getByRole("combobox", { name: "Message" }),
        "Build the catalog",
      );
      await fixture.user.click(screen.getByRole("button", { name: "Send" }));
      await waitFor(() => expect(start).toHaveBeenCalledOnce());
      expect(sidebar().getAllByRole("button", { name: /^Build the catalog / })).toHaveLength(1);
      const authoritative = [summary(sessionId, { title: "Authoritative title", messageCount: 1 })];
      const finish = async () =>
        act(async () => started.resolve(TurnId.make("20000000-0000-4000-8000-000000000001")));
      if (timing === "before") {
        await fixture.publish(authoritative);
        await finish();
      } else {
        await finish();
        await fixture.publish(authoritative);
      }
      expect(sidebar().getAllByRole("button", { name: /^Authoritative title / })).toHaveLength(1);
      expect(sidebar().queryByRole("button", { name: /^Build the catalog / })).toBeNull();
      expect(start).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId,
          workingDirectory: projectPath,
          text: "Build the catalog",
        }),
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
      await fixture.publish([]);
      expect(sidebar().queryByRole("button", { name: /^Authoritative title / })).toBeNull();
      expect(sidebar().queryByRole("button", { name: /^Build the catalog / })).toBeNull();
    },
  );

  it("pins saved drafts above newer sessions but keeps zero-message Pi sessions in activity order", async () => {
    const draft: SavedDraft = {
      sessionId: "draft",
      projectPath,
      workingDirectory: projectPath,
      title: "Saved plan",
      text: "Implement later",
      attachments: [],
      labelIds: [],
      resolved: false,
      createdAt: fixtureTimestamp,
      modifiedAt: fixtureTimestamp,
      revision: 1,
      status: "saved",
    };
    using fixture = await renderCatalog({
      drafts: [draft],
      sessions: [
        summary("empty-pi", {
          title: "Empty Pi session",
          messageCount: 0,
          modifiedAt: "2026-02-01T00:00:00.000Z",
        }),
        summary("recent", { title: "Recent conversation", modifiedAt: "2026-03-01T00:00:00.000Z" }),
      ],
    });
    const rows = () =>
      sidebar().getAllByRole("button", {
        name: /^(Saved plan|Empty Pi session|Recent conversation) /,
      });
    expect(rows().map((row) => row.textContent)).toEqual([
      expect.stringContaining("Saved plan"),
      expect.stringContaining("Recent conversation"),
      expect.stringContaining("Empty Pi session"),
    ]);
    await fixture.publish([
      summary("empty-pi", {
        title: "Empty Pi session",
        messageCount: 0,
        modifiedAt: "2026-04-01T00:00:00.000Z",
      }),
      summary("recent", { title: "Recent conversation", modifiedAt: "2026-03-01T00:00:00.000Z" }),
    ]);
    expect(rows().map((row) => row.textContent)).toEqual([
      expect.stringContaining("Saved plan"),
      expect.stringContaining("Empty Pi session"),
      expect.stringContaining("Recent conversation"),
    ]);
  });
});
