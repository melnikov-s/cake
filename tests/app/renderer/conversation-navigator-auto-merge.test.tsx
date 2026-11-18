/** @vitest-environment jsdom */
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { applySnapshot } from "r-state-tree";
import { StoreProvider } from "r-state-tree/react";
import { afterEach, expect, it, vi } from "vitest";
import { defaultProjectSettings } from "../../../src/contracts/application/application-data";
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
  "puts Auto-merge on project headers independently of disclosure and navigation (global=%s)",
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
    const view = render(
      <StoreProvider store={fixture.root}>
        <ConversationNavigator projectPath={global ? undefined : "/project"} />
      </StoreProvider>,
    );
    const user = userEvent.setup();
    const navigator = within(screen.getByRole("region", { name: "Sessions" }));
    const row = (sessionId: string) =>
      within(
        navigator
          .getByRole("button", { name: sessionId })
          .closest<HTMLElement>('[data-slot="conversation-navigator-row"]')!,
      );
    const project = row("project");
    const other = global ? row("other") : undefined;
    const toggle = project.getByRole("switch");
    const collapse = project.getByRole("button", { name: "Collapse project" });
    expect(navigator.getAllByRole("switch")).toHaveLength(global ? 2 : 1);
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect(other?.getByRole("switch").getAttribute("aria-checked")).toBe(
      global ? "false" : undefined,
    );
    expect(toggle.parentElement?.closest("button, [role=button]")).toBeNull();
    expect(setAutoMerge).not.toHaveBeenCalled();

    await user.click(project.getByText("Auto-merge", { exact: true }));
    await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("false"));
    expect(collapse.getAttribute("aria-expanded")).toBe("true");
    expect(navigator.getByText("/project-delegated")).toBeTruthy();

    await user.click(collapse);
    expect(collapse.getAttribute("aria-expanded")).toBe("false");
    expect(navigator.queryByText("/project-delegated")).toBeNull();
    const title = project.getByRole("button", { name: "project" });
    title.focus();
    await user.tab();
    expect(document.activeElement).toBe(toggle);
    await user.keyboard(" ");
    await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("true"));
    expect(collapse.getAttribute("aria-expanded")).toBe("false");
    expect(other?.getByRole("switch").getAttribute("aria-checked")).toBe(
      global ? "false" : undefined,
    );
    expect(setAutoMerge.mock.calls).toEqual([
      ["/project", false],
      ["/project", true],
    ]);
    act(() =>
      applySnapshot(fixture.models.projects, {
        projects: [
          projectRecord({
            path: "/project",
            settings: { ...defaultProjectSettings(), worktreeLanding: "pull-request" },
          }),
          projectRecord({ path: "/other" }),
        ],
      }),
    );
    expect(project.queryByRole("switch")).toBeNull();
    expect(collapse.getAttribute("aria-expanded")).toBe("false");
    expect(fixture.root.autoMergeStore.forProject("/project")?.enabled).toBe(true);
    expect(setAutoMerge).toHaveBeenCalledTimes(2);
    view.unmount();
  },
);
