/** @vitest-environment jsdom */
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { applySnapshot } from "r-state-tree";
import { StoreProvider } from "r-state-tree/react";
import { afterEach, expect, it, vi } from "vitest";
import { AutoMergeToggle } from "../../../src/renderer/components/auto-merge-toggle";
import { ConversationNavigator } from "../../../src/renderer/components/conversation-navigator";
import { applyWorktreeOperationCatalogUpdate } from "../../../src/renderer/reducers/WorktreeOperationReducer";
import { fixtureTimestamp, projectRecord, sessionSummary } from "./fixtures/catalog-fixtures";
import { createRendererStoreFixture } from "./renderer-store-fixture";

const sessions = ["/project", "/other"].flatMap((projectPath) =>
  (["user", "delegated"] as const).map((purpose) =>
    sessionSummary({ sessionId: `${projectPath}-${purpose}`, projectPath, purpose }),
  ),
);

afterEach(cleanup);

it.each([false, true])(
  "omits header Auto-merge controls without changing project authorization or collapse behavior (global=%s)",
  async (global) => {
    const setAutoMerge = vi.fn(async (projectPath: string, enabled: boolean) => {
      act(() =>
        applyWorktreeOperationCatalogUpdate(fixture.models.worktreeOperations, {
          operations: [],
          autoMergeProjects: fixture.models.worktreeOperations.autoMergeProjects.map((project) =>
            project.projectPath === projectPath ? { ...project, enabled } : project,
          ),
        }),
      );
    });
    using fixture = createRendererStoreFixture({
      projects: [projectRecord({ path: "/project" }), projectRecord({ path: "/other" })],
      sessions,
      client: { managedWorktrees: { setAutoMerge } },
    });
    applySnapshot(fixture.models.cakeChatCatalog, {
      loaded: true,
      sessions: ["/project", "/other"].map((projectPath) => ({
        sessionId: `${projectPath}-chat`,
        projectPath,
        title: "Project Chat",
        createdAt: fixtureTimestamp,
        modifiedAt: fixtureTimestamp,
        messageCount: 1,
        resolved: false,
        unread: false,
      })),
    });
    act(() =>
      applyWorktreeOperationCatalogUpdate(fixture.models.worktreeOperations, {
        operations: [],
        autoMergeProjects: [
          { projectPath: "/project", enabled: true, epoch: "one", status: "On" },
          { projectPath: "/other", enabled: false, epoch: "two", status: "Off" },
        ],
      }),
    );
    const surface = () => (
      <StoreProvider store={fixture.root}>
        <ConversationNavigator projectPath={global ? undefined : "/project"} />
        <section aria-label="Existing control">
          <AutoMergeToggle projectPath="/project" />
        </section>
      </StoreProvider>
    );
    const view = render(surface());
    const user = userEvent.setup();
    const groups = screen.getAllByRole("region", { name: "Delegated" });
    expect(groups).toHaveLength(global ? 2 : 1);
    const navigator = within(screen.getByRole("region", { name: "Sessions" }));
    expect(navigator.queryByRole("switch")).toBeNull();
    expect(navigator.queryByText("Auto-merge", { exact: true })).toBeNull();
    const delegated = groups.find((group) => within(group).queryByText("/project-delegated"))!;
    const group = within(delegated);
    const collapse = group.getByRole("button", { name: "Delegated" });
    const existing = within(screen.getByRole("region", { name: "Existing control" }));
    expect(existing.getByRole("switch", { name: "Auto-merge: on" })).toBeTruthy();
    expect(setAutoMerge).not.toHaveBeenCalled();

    await user.click(collapse);
    expect(collapse.getAttribute("aria-expanded")).toBe("false");
    expect(group.queryByText("/project-delegated")).toBeNull();
    expect(setAutoMerge).not.toHaveBeenCalled();
    await user.click(existing.getByRole("switch", { name: "Auto-merge: on" }));
    await waitFor(() =>
      expect(existing.getByRole("switch", { name: "Auto-merge: off" })).toBeTruthy(),
    );
    expect(collapse.getAttribute("aria-expanded")).toBe("false");
    await user.click(collapse);
    expect(collapse.getAttribute("aria-expanded")).toBe("true");
    expect(group.getByText("/project-delegated")).toBeTruthy();
    await user.click(existing.getByText("Auto-merge", { exact: true }));
    await waitFor(() =>
      expect(existing.getByRole("switch", { name: "Auto-merge: on" })).toBeTruthy(),
    );
    expect(setAutoMerge.mock.calls).toEqual([
      ["/project", false],
      ["/project", true],
    ]);
    expect(fixture.root.autoMergeForProject("/other")?.enabled).toBe(false);
    expect(navigator.queryByRole("switch")).toBeNull();
    view.unmount();
    const remounted = render(surface());
    expect(
      within(screen.getByRole("region", { name: "Sessions" })).queryByRole("switch"),
    ).toBeNull();
    expect(screen.getByRole("switch", { name: "Auto-merge: on" })).toBeTruthy();
    expect(setAutoMerge).toHaveBeenCalledTimes(2);
    remounted.unmount();
  },
);
