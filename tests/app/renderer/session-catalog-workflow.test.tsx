/** @vitest-environment jsdom */
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { applySnapshot } from "r-state-tree";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TurnId } from "../../../src/domain/conversations/conversation-data";
import type { SavedDraft } from "../../../src/domain/project-sessions/saved-draft-data";
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
          onCreateSession={(path) => void root.createSession(path)}
          onOpenSession={(id) => void root.openSession(id)}
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
    user: userEvent.setup(),
    async publish(sessions: SessionSummaryFixture[]) {
      await act(async () =>
        applySnapshot(fixture.models.sessionCatalog, { sessions, resolvedHasMoreByProject: {} }),
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
