/** @vitest-environment jsdom */
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { observer, StoreProvider } from "r-state-tree/react";
import { applySnapshot, toSnapshot, type StoreSnapshot } from "r-state-tree";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultApplicationState } from "../../../src/contracts/application/application-data";
import type { Client } from "../../../src/renderer/client/Client";
import { Chat } from "../../../src/renderer/components/chat";
import { WorkspaceNavigator } from "../../../src/renderer/components/workspace-navigator";
import { ProjectRail } from "../../../src/renderer/components/project-rail";
import { NewSessionDialog } from "../../../src/renderer/components/new-session-dialog";
import { projectRecord } from "./fixtures/catalog-fixtures";
import {
  createRendererStoreFixture,
  type RendererStoreFixtureOptions,
} from "./renderer-store-fixture";

function renderPicker(
  options: Pick<RendererStoreFixtureOptions, "projects" | "snapshot"> = {},
  projectPath?: string,
) {
  const inspect = vi.fn<Client["workspaces"]["inspect"]>(async ({ operationId, path }) => ({
    operationId,
    path,
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
    sessions: projectPath
      ? [
          {
            sessionId: `project-chat:${"a".repeat(64)}`,
            projectPath,
            title: "Project Chat",
            createdAt: "2026-01-01T00:00:00Z",
            modifiedAt: "2026-01-01T00:00:00Z",
            messageCount: 0,
            resolved: false,
            unread: false,
          },
        ]
      : [],
    loaded: true,
    resolvedHasMore: false,
  });
  const root = fixture.root;
  if (projectPath) root.navigationStore.selectCakeChat(`project-chat:${"a".repeat(64)}`);
  root.workspaceNavigatorStore.show("sessions");
  const Surface = observer(function Surface() {
    const selection = root.appShellStore.selection;
    const session =
      selection.kind === "cake-chat"
        ? root.cakeChatCollectionStore.activeSession
        : root.projectWorkbenchStore.activeSession;
    return (
      <>
        <ProjectRail />
        {root.workspaceNavigatorStore.visible && <WorkspaceNavigator />}
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
  const view = render(
    <StoreProvider store={root}>
      <Surface />
    </StoreProvider>,
  );
  return {
    user: userEvent.setup(),
    inspect,
    start,
    snapshot: () => toSnapshot(root),
    models: fixture.models,
    root,
    [Symbol.dispose]() {
      view.unmount();
      fixture[Symbol.dispose]();
    },
  };
}

afterEach(cleanup);

describe("New session destination workflow", () => {
  it.each(["/work/alpha", "/work/beta"])(
    "opens an unsent session directly in %s, ignoring the remembered chooser destination",
    async (projectPath) => {
      using fixture = renderPicker({}, projectPath);
      act(() =>
        fixture.root.newSessionStore.rememberProject(
          projectPath === "/work/alpha" ? "/work/beta" : "/work/alpha",
        ),
      );
      const sessions = () => within(screen.getByRole("region", { name: "Sessions" }));
      await fixture.user.click(
        sessions().getByRole("button", { name: "New session in this project" }),
      );
      expect(screen.queryByRole("dialog")).toBeNull();
      const message = await screen.findByRole("combobox", { name: "Message" });
      expect(fixture.inspect).toHaveBeenCalledWith(
        expect.objectContaining({ path: projectPath }),
        expect.anything(),
      );
      expect(fixture.root.appShellStore.selection.kind).toBe("project-session");
      expect(fixture.root.projectWorkbenchStore.activeSession?.workspacePath).toBe(projectPath);
      expect(fixture.start).not.toHaveBeenCalled();

      await fixture.user.type(message, "Keep this staged draft");
      await fixture.user.click(
        sessions().getByRole("button", { name: "New session in this project" }),
      );
      expect((message as HTMLTextAreaElement).value).toBe("Keep this staged draft");
      expect(fixture.inspect).toHaveBeenCalledOnce();
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(fixture.start).not.toHaveBeenCalled();
    },
  );

  it("keeps the global chooser reachable with Workspace closed, without restoring a rail toggle", async () => {
    using fixture = renderPicker({}, "/work/alpha");
    act(() => fixture.root.workspaceNavigatorStore.close());
    expect(screen.queryByRole("complementary", { name: "Workspace" })).toBeNull();
    const rail = within(screen.getByRole("navigation", { name: "Projects and global utilities" }));
    expect(rail.queryByRole("button", { name: /^(Open|Close) Workspace$/ })).toBeNull();
    await fixture.user.click(rail.getByRole("button", { name: "New session in any project" }));
    expect(screen.getAllByRole("option")).toHaveLength(3);
    expect(fixture.inspect).not.toHaveBeenCalled();
    expect(fixture.start).not.toHaveBeenCalled();
  });

  it("retains the chooser fallback when the Sessions panel has no project context", async () => {
    using fixture = renderPicker();
    const sessions = within(screen.getByRole("region", { name: "Sessions" }));
    await fixture.user.click(
      sessions.getByRole("button", { name: "Choose destination for new session" }),
    );
    expect(screen.getAllByRole("option")).toHaveLength(3);
    expect(fixture.inspect).not.toHaveBeenCalled();
  });

  it("filters registered projects and opens an unsent session in another project from the global plus", async () => {
    using fixture = renderPicker({}, "/work/alpha");
    await fixture.user.click(screen.getByRole("button", { name: "New session in any project" }));
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
    await fixture.user.click(screen.getByRole("button", { name: "New session in any project" }));
    await fixture.user.click(screen.getByRole("option", { name: /Cake Chat/ }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(await screen.findByRole("combobox", { name: "Message Cake Chat" })).toBeDefined();
    expect(fixture.inspect).not.toHaveBeenCalled();
  });

  it("preselects the last new-session project without changing it on cancellation or Cake Chat", async () => {
    using fixture = renderPicker();
    const open = () =>
      fixture.user.click(screen.getByRole("button", { name: "New session in any project" }));
    await open();
    await fixture.user.click(screen.getByRole("option", { name: /Beta/ }));
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
      await fixture.user.click(screen.getByRole("button", { name: "New session in any project" }));
      await fixture.user.click(screen.getByRole("option", { name: /Beta/ }));
      await screen.findByRole("combobox", { name: "Message" });
      snapshot = fixture.snapshot();
    }
    {
      using fixture = renderPicker({ snapshot });
      await fixture.user.click(screen.getByRole("button", { name: "New session in any project" }));
      expect(screen.getByRole("option", { selected: true }).textContent).toContain("Beta");
    }
    {
      using fixture = renderPicker({
        snapshot,
        projects: [projectRecord({ path: "/work/alpha", name: "Alpha" })],
      });
      await fixture.user.click(screen.getByRole("button", { name: "New session in any project" }));
      expect(screen.getByRole("option", { selected: true }).textContent).toContain("Cake Chat");
    }
    {
      using fixture = renderPicker({ snapshot, projects: [] });
      await fixture.user.click(screen.getByRole("button", { name: "New session in any project" }));
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
    const open = () =>
      fixture.user.click(screen.getByRole("button", { name: "New session in any project" }));
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
