/** @vitest-environment jsdom */
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { applySnapshot } from "r-state-tree";
import { StoreProvider } from "r-state-tree/react";
import { afterEach, expect, it, vi } from "vitest";
import { AutoMergeToggle } from "../../../src/renderer/components/auto-merge-toggle";
import { ConversationNavigator } from "../../../src/renderer/components/conversation-navigator";
import { applyWorktreeOperationCatalogUpdate } from "../../../src/renderer/reducers/WorktreeOperationReducer";
import { defaultProjectSettings } from "../../../src/contracts/application/application-data";
import { fixtureTimestamp, projectRecord, sessionSummary } from "./fixtures/catalog-fixtures";
import { createRendererStoreFixture } from "./renderer-store-fixture";

const sessions = ["/project", "/other"].flatMap((projectPath) =>
  (["user", "delegated"] as const).map((purpose) =>
    sessionSummary({ sessionId: `${projectPath}-${purpose}`, projectPath, purpose }),
  ),
);

afterEach(cleanup);

it.each([false, true])(
  "shares the owning project's authorization with the existing control without collapsing Delegated (global=%s)",
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
    let view = render(surface());
    const user = userEvent.setup();
    const groups = screen.getAllByRole("region", { name: "Delegated" });
    expect(groups).toHaveLength(global ? 2 : 1);
    for (const mine of screen.getAllByRole("region", { name: "My sessions" }))
      expect(within(mine).queryByRole("switch")).toBeNull();
    const delegated = groups.find((group) => within(group).queryByText("/project-delegated"))!;
    const group = within(delegated);
    const collapse = group.getByRole("button", { name: "Delegated" });
    const toggle = group.getByRole("switch", { name: "Auto-merge: on" });
    const existing = within(screen.getByRole("region", { name: "Existing control" }));
    expect(toggle.getAttribute("aria-description")).toContain("Never My sessions");
    expect(collapse.contains(toggle)).toBe(false);
    expect(setAutoMerge).not.toHaveBeenCalled();

    await user.click(toggle);
    await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("false"));
    expect(existing.getByRole("switch", { name: "Auto-merge: off" })).toBeTruthy();
    expect(collapse.getAttribute("aria-expanded")).toBe("true");
    await user.click(group.getByText("Auto-merge", { exact: true }));
    await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("true"));
    expect(collapse.getAttribute("aria-expanded")).toBe("true");

    await user.click(collapse);
    expect(collapse.getAttribute("aria-expanded")).toBe("false");
    expect(group.queryByText("/project-delegated")).toBeNull();
    await user.click(existing.getByRole("switch", { name: "Auto-merge: on" }));
    await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("false"));
    expect(collapse.getAttribute("aria-expanded")).toBe("false");
    expect(setAutoMerge.mock.calls).toEqual([
      ["/project", false],
      ["/project", true],
      ["/project", false],
    ]);
    if (global) {
      const other = groups.find((group) => group !== delegated)!;
      expect(within(other).getByRole("switch", { name: "Auto-merge: off" })).toBeTruthy();
      await user.click(within(other).getByRole("switch"));
      await waitFor(() =>
        expect(within(other).getByRole("switch", { name: "Auto-merge: on" })).toBeTruthy(),
      );
      expect(setAutoMerge).toHaveBeenLastCalledWith("/other", true);
      expect(toggle.getAttribute("aria-checked")).toBe("false");
    }
    view.unmount();
    view = render(surface());
    expect(
      within(screen.getAllByRole("region", { name: "Delegated" })[0]!).getByRole("switch", {
        name: "Auto-merge: off",
      }),
    ).toBeTruthy();
    view.unmount();
  },
);

it("preserves the external-workflow exclusion on the Delegated header", () => {
  using fixture = createRendererStoreFixture({
    projects: [
      projectRecord({
        path: "/project",
        settings: { ...defaultProjectSettings(), worktreeLanding: "pull-request" },
      }),
    ],
    sessions: sessions.filter((session) => session.projectPath === "/project"),
  });
  const view = render(
    <StoreProvider store={fixture.root}>
      <ConversationNavigator projectPath="/project" />
    </StoreProvider>,
  );
  expect(screen.getByRole("button", { name: "Delegated" })).toBeTruthy();
  expect(screen.queryByRole("switch")).toBeNull();
  view.unmount();
});
