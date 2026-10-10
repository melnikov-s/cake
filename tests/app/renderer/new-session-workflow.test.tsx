/** @vitest-environment jsdom */
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { observer } from "r-state-tree/react";
import { applySnapshot, toSnapshot, type StoreSnapshot } from "r-state-tree";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultApplicationState } from "../../../src/services/storage/application-data";
import type { Client } from "../../../src/renderer/client/Client";
import { Chat } from "../../../src/renderer/components/chat";
import { Sidebar } from "../../../src/renderer/components/sidebar";
import { NewSessionDialog } from "../../../src/renderer/components/new-session-dialog";
import { projectRecord } from "./fixtures/catalog-fixtures";
import {
  createRendererStoreFixture,
  type RendererStoreFixtureOptions,
} from "./renderer-store-fixture";

function renderPicker(options: Pick<RendererStoreFixtureOptions, "projects" | "snapshot"> = {}) {
  const inspect = vi.fn<Client["workspaces"]["inspect"]>(async ({ operationId, path }) => ({
    operationId,
    path,
    trustRequired: false,
  }));
  const start = vi.fn<Client["projectSessions"]["start"]>();
  const fixture = createRendererStoreFixture({
    projects: [
      projectRecord({ path: "/work/alpha", name: "Alpha" }),
      projectRecord({ path: "/work/beta", name: "Beta" }),
    ],
    ...options,
    client: {
      workspaces: {
        inspect,
        registerProject: async () => defaultApplicationState(),
        loadStagedSlashCommands: async () => [],
      },
      projectSessions: { start },
    },
  });
  applySnapshot(fixture.models.cakeChatCatalog, {
    sessions: [],
    loaded: true,
    resolvedHasMore: false,
  });
  const root = fixture.root;
  const Surface = observer(function Surface() {
    const selection = root.appShellStore.selection;
    const session =
      selection.kind === "cake-chat"
        ? root.cakeChatCollectionStore.activeSession
        : root.projectWorkbenchStore.activeSession;
    return (
      <>
        <Sidebar
          store={root.sidebarStore}
          sessionList={root.sidebarStore.sessionListStore}
          sessionMetadata={root.sessionMetadataStore}
          projects={root.projectCatalogStore}
          chat={root.projectWorkbenchStore}
          cakeChat={root.cakeChatCollectionStore}
          shell={root.appShellStore}
          projectSettings={root.projectSettingsStore}
          appearance={root.settingsStore.appearance}
          onOpenSettings={() => root.showSettings()}
          onOpenCakeChat={(id) => {
            void root.openCakeChat(id);
          }}
          onNewSession={() => root.newSessionStore.show()}
          onOpenSession={(id) => {
            void root.openSession(id);
          }}
          onCreateSession={(path) => {
            void root.createSession(path);
          }}
          onRemoveProject={(path, deleteSessions) =>
            root.projectRemovalStore.remove(path, deleteSessions)
          }
          onChooseProject={() => {
            void root.chooseProject();
          }}
          onGoBack={() => root.navigateBack()}
          onGoForward={() => root.navigateForward()}
          onToggle={() => root.sidebarStore.toggle()}
        />
        <NewSessionDialog store={root.newSessionStore} />
        {session && (
          <Chat
            key={session.sessionId}
            store={session.conversationSessionStore.chatStore}
            embedded
          />
        )}
      </>
    );
  });
  const view = render(<Surface />);
  return {
    user: userEvent.setup(),
    inspect,
    start,
    snapshot: () => toSnapshot(root),
    models: fixture.models,
    [Symbol.dispose]() {
      view.unmount();
      fixture[Symbol.dispose]();
    },
  };
}

afterEach(cleanup);

describe("New session destination workflow", () => {
  it("filters registered projects and opens an unsent session in the selected project", async () => {
    using fixture = renderPicker();
    await fixture.user.click(screen.getByRole("button", { name: "New session" }));
    expect(screen.getAllByRole("option")).toHaveLength(3);
    await fixture.user.type(screen.getByRole("combobox", { name: "Filter projects" }), "BETA");
    expect(screen.getAllByRole("option")).toHaveLength(1);
    await fixture.user.click(screen.getByRole("option", { name: /Beta/ }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(await screen.findByRole("combobox", { name: "Message" })).toBeDefined();
    expect(fixture.inspect).toHaveBeenCalledWith(
      expect.objectContaining({ path: "/work/beta" }),
      expect.anything(),
    );
    expect(fixture.start).not.toHaveBeenCalled();
  });

  it("opens Cake Chat without inspecting a project", async () => {
    using fixture = renderPicker();
    await fixture.user.click(screen.getByRole("button", { name: "New session" }));
    await fixture.user.click(screen.getByRole("option", { name: /Cake Chat/ }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(await screen.findByRole("combobox", { name: "Message Cake Chat" })).toBeDefined();
    expect(fixture.inspect).not.toHaveBeenCalled();
  });

  it("preselects the last new-session project, including sidebar creation, without changing it on cancellation or Cake Chat", async () => {
    using fixture = renderPicker();
    const open = () => fixture.user.click(screen.getByRole("button", { name: "New session" }));
    await fixture.user.click(screen.getByRole("button", { name: "New chat in beta" }));
    await screen.findByRole("combobox", { name: "Message" });
    await open();
    expect(screen.getByRole("option", { selected: true }).textContent).toContain("Beta");
    await fixture.user.type(screen.getByRole("combobox", { name: "Filter projects" }), "Alpha");
    expect(screen.getByRole("option", { selected: true }).textContent).toContain("Alpha");
    await fixture.user.click(screen.getByRole("button", { name: "Close" }));
    await open();
    expect(screen.getByRole("option", { selected: true }).textContent).toContain("Beta");
    await fixture.user.click(screen.getByRole("option", { name: /Cake Chat/ }));
    await screen.findByRole("combobox", { name: "Message Cake Chat" });
    await open();
    expect(screen.getByRole("option", { selected: true }).textContent).toContain("Beta");
    await fixture.user.click(screen.getByRole("option", { name: /Alpha/ }));
    await screen.findByRole("combobox", { name: "Message" });
    await open();
    expect(screen.getByRole("option", { selected: true }).textContent).toContain("Alpha");
  });

  it("restores the remembered project from the window snapshot and falls back when it is no longer registered", async () => {
    let snapshot: StoreSnapshot;
    {
      using fixture = renderPicker();
      await fixture.user.click(screen.getByRole("button", { name: "New session" }));
      await fixture.user.click(screen.getByRole("option", { name: /Beta/ }));
      await screen.findByRole("combobox", { name: "Message" });
      snapshot = fixture.snapshot();
    }
    {
      using fixture = renderPicker({ snapshot });
      await fixture.user.click(screen.getByRole("button", { name: "New session" }));
      expect(screen.getByRole("option", { selected: true }).textContent).toContain("Beta");
    }
    {
      using fixture = renderPicker({
        snapshot,
        projects: [projectRecord({ path: "/work/alpha", name: "Alpha" })],
      });
      await fixture.user.click(screen.getByRole("button", { name: "New session" }));
      expect(screen.getByRole("option", { selected: true }).textContent).toContain("Cake Chat");
    }
    {
      using fixture = renderPicker({ snapshot, projects: [] });
      await fixture.user.click(screen.getByRole("button", { name: "New session" }));
      expect(screen.getByRole("option", { selected: true }).textContent).toContain("Cake Chat");
      act(() =>
        applySnapshot(fixture.models.projects, {
          projects: [projectRecord({ path: "/work/beta", name: "Beta" })],
        }),
      );
      expect(screen.getByRole("option", { selected: true }).textContent).toContain("Beta");
    }
  });

  it("shows no matches, supports clearing the filter, and resets on cancellation", async () => {
    using fixture = renderPicker();
    const open = () => fixture.user.click(screen.getByRole("button", { name: "New session" }));
    await open();
    await fixture.user.type(screen.getByRole("combobox", { name: "Filter projects" }), "missing");
    expect(screen.getByRole("status").textContent).toContain("No matching");
    expect(screen.queryAllByRole("option")).toHaveLength(0);
    await fixture.user.clear(screen.getByRole("combobox", { name: "Filter projects" }));
    expect(screen.getAllByRole("option")).toHaveLength(3);
    await fixture.user.type(screen.getByRole("combobox", { name: "Filter projects" }), "Alpha");
    await fixture.user.click(screen.getByRole("button", { name: "Close" }));
    await open();
    expect(screen.getAllByRole("option")).toHaveLength(3);
    expect(fixture.inspect).not.toHaveBeenCalled();
  });
});
