/** @vitest-environment jsdom */
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import {
  applyProjectCatalogUpdate,
  applySessionCatalogGroupUpdate,
} from "../../../src/renderer/reducers/CatalogReducer";
import { CAKE_CHAT_SESSION_ID } from "../../../src/contracts/cake-chats/cake-chat-identity";
import { CakeChatSummary } from "../../../src/renderer/models/CakeChatSummary";
import { Profiler } from "react";
import { StoreProvider } from "r-state-tree/react";
import { ProjectRail } from "../../../src/renderer/components/project-rail";
import { SubagentHandleId } from "../../../src/contracts/subagents/subagent-data";
import { createRendererStoreFixture } from "./renderer-store-fixture";
import { projectRecord, sessionSummary } from "./fixtures/catalog-fixtures";

import { applyWorktreeOperationCatalogUpdate } from "../../../src/renderer/reducers/WorktreeOperationReducer";
import { AutoMergeToggle } from "../../../src/renderer/components/auto-merge-toggle";
import { ToastHost } from "../../../src/renderer/components/toast-host";

afterEach(cleanup);

it("exposes default-off Auto-merge in the activity rail and follows authoritative on/off updates", async () => {
  const setAutoMerge = vi.fn(async (enabled: boolean) => {
    applyWorktreeOperationCatalogUpdate(fixture.models.worktreeOperations, {
      operations: [],
      autoMergeEnabled: enabled,
      autoMergeStatus: enabled ? "Waiting for fresh validated completion" : "Off",
    });
  });
  using fixture = createRendererStoreFixture({ client: { managedWorktrees: { setAutoMerge } } });
  const view = render(
    <StoreProvider store={fixture.root}>
      <ProjectRail />
    </StoreProvider>,
  );
  const user = userEvent.setup();
  expect(screen.getByRole("button", { name: "Auto-merge: off" }).getAttribute("aria-pressed")).toBe(
    "false",
  );
  await user.click(screen.getByRole("button", { name: "Auto-merge: off" }));
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Auto-merge: on" }).getAttribute("aria-pressed"),
    ).toBe("true"),
  );
  await user.click(screen.getByRole("button", { name: "Auto-merge: on" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Auto-merge: off" })).toBeTruthy());
  expect(setAutoMerge.mock.calls).toEqual([[true], [false]]);
  // A second surface consumes the same authoritative opt-in, never local settings.
  view.rerender(
    <StoreProvider store={fixture.root}>
      <AutoMergeToggle />
    </StoreProvider>,
  );
  await user.click(screen.getByRole("button", { name: "Auto-merge: off" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Auto-merge: on" })).toBeTruthy());
  act(() =>
    applyWorktreeOperationCatalogUpdate(fixture.models.worktreeOperations, {
      operations: [],
      autoMergeEnabled: true,
      autoMergeRequests: [
        {
          id: "ready-task",
          sessionId: "owner",
          workspacePath: "/tree",
          epoch: "enabled",
          runId: "run",
          commit: "a".repeat(40),
          readyToMerge: true,
          state: "failed",
          message: "Target dirty",
        },
      ],
    }),
  );
  expect(fixture.root.autoMergeRequests[0]?.message).toBe("Target dirty");
  view.unmount();
});

it("keeps Auto-merge off and shows a failed authorization update", async () => {
  using fixture = createRendererStoreFixture({
    client: {
      managedWorktrees: {
        setAutoMerge: async () => {
          throw new Error("Connection unavailable");
        },
      },
    },
  });
  const view = render(
    <StoreProvider store={fixture.root}>
      <ProjectRail />
      <ToastHost store={fixture.root.toastStore} />
    </StoreProvider>,
  );
  await userEvent.setup().click(screen.getByRole("button", { name: "Auto-merge: off" }));
  expect(await screen.findByText("Could not change auto-merge")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Auto-merge: off" }).getAttribute("aria-pressed")).toBe(
    "false",
  );
  view.unmount();
});

it("shows unselected-project activity from the project catalog without discovering descendants", () => {
  using fixture = createRendererStoreFixture({
    projects: [
      projectRecord({ path: "/cake", name: "Cake" }),
      projectRecord({ path: "/other", name: "Other" }),
    ],
    sessions: [sessionSummary({ sessionId: "other-session", projectPath: "/other" })],
  });
  render(
    <StoreProvider store={fixture.root}>
      <ProjectRail />
    </StoreProvider>,
  );
  expect(screen.queryByRole("img", { name: "Work running in Other" })).toBeNull();
  act(() =>
    applyProjectCatalogUpdate(fixture.models.projects, {
      _tag: "Event",
      revision: 1,
      event: { _tag: "ActivityChanged", runningProjectPaths: ["/other"] },
    }),
  );
  expect(screen.getByRole("img", { name: "Work running in Other" })).toBeTruthy();
  expect(fixture.models.discussionCatalogs).toHaveLength(0);
  expect(fixture.models.subagentCatalogs).toHaveLength(0);
  act(() =>
    applyProjectCatalogUpdate(fixture.models.projects, {
      _tag: "Event",
      revision: 2,
      event: { _tag: "ActivityChanged", runningProjectPaths: [] },
    }),
  );
  expect(screen.queryByRole("img", { name: "Work running in Other" })).toBeNull();
});

it.each([
  [false, false],
  [false, true],
  [true, false],
  [true, true],
])("shows project running=%s and unread=%s independently", (running, unread) => {
  using fixture = createRendererStoreFixture({
    projects: [projectRecord({ path: "/other", name: "Other" })],
    sessions: [
      sessionSummary({ sessionId: "other-session", projectPath: "/other", running, unread }),
    ],
  });
  if (running) fixture.models.projects.runningProjectPaths.push("/other");
  const discussionCatalogs = [...fixture.models.discussionCatalogs];
  const subagentCatalogs = [...fixture.models.subagentCatalogs];
  render(
    <StoreProvider store={fixture.root}>
      <ProjectRail />
    </StoreProvider>,
  );
  const row = within(screen.getByRole("button", { name: "Open Project Chat for Other" }));
  const blue = row.queryByRole("img", { name: "Work running in Other" });
  const green = row.queryByRole("img", { name: "Unread sessions in Other" });
  expect(Boolean(blue)).toBe(running);
  expect(Boolean(green)).toBe(unread);
  if (blue) {
    expect(blue.className).toContain("bg-accent");
    expect(blue.className).toContain("right-0.5");
  }
  if (green) {
    expect(green.className).toContain("bg-success");
    expect(green.className).toContain("left-0.5");
    expect(green.className).not.toContain("animate-pulse");
  }
  expect(fixture.models.projectConversations).toHaveLength(0);
  expect([...fixture.models.discussionCatalogs]).toEqual(discussionCatalogs);
  expect([...fixture.models.subagentCatalogs]).toEqual(subagentCatalogs);
});

it("clears green only after the last own-unread session is read, without clearing blue", () => {
  using fixture = createRendererStoreFixture({
    projects: [projectRecord({ path: "/cake", name: "Cake" })],
    sessions: [
      sessionSummary({
        sessionId: "owner",
        projectPath: "/cake",
        familyChildSessionIds: ["child"],
      }),
      sessionSummary({ sessionId: "child", projectPath: "/cake", familyParentSessionId: "owner" }),
      sessionSummary({ sessionId: "peer", projectPath: "/cake" }),
      sessionSummary({ sessionId: "elsewhere", projectPath: "/other", unread: true }),
      sessionSummary({ sessionId: "archived", projectPath: "/cake", resolved: true, unread: true }),
    ],
  });
  fixture.models.projects.runningProjectPaths.push("/cake");
  fixture.root.sidebarStore.sessionListStore.toggleFamilyCollapsed("owner");
  fixture.root.conversationNavigatorStore.setQuery("/cake", "no match");
  const load = vi.spyOn(fixture.root.sessionRegistry, "load");
  const discussionCatalogs = [...fixture.models.discussionCatalogs];
  const subagentCatalogs = [...fixture.models.subagentCatalogs];
  render(
    <StoreProvider store={fixture.root}>
      <ProjectRail />
    </StoreProvider>,
  );
  const green = () => screen.queryByRole("img", { name: "Unread sessions in Cake" });
  const update = (sessionId: string, unread: boolean, revision: number) =>
    act(() =>
      applySessionCatalogGroupUpdate(
        fixture.models.sessionCatalog,
        { projectPath: "/cake", resolved: false },
        {
          _tag: "Event",
          revision,
          event: { _tag: "ActivityChanged", sessionId, running: false, unread },
        },
      ),
    );
  expect(green()).toBeNull();
  update("child", true, 1);
  expect(green()).toBeTruthy();
  expect(fixture.models.sessionCatalog.find("owner")!.unread).toBe(false);
  update("peer", true, 2);
  update("child", false, 3);
  expect(green()).toBeTruthy();
  update("peer", false, 4);
  expect(green()).toBeNull();
  expect(screen.getByRole("img", { name: "Work running in Cake" })).toBeTruthy();
  expect(load).not.toHaveBeenCalled();
  expect(fixture.models.projectConversations).toHaveLength(0);
  expect([...fixture.models.discussionCatalogs]).toEqual(discussionCatalogs);
  expect([...fixture.models.subagentCatalogs]).toEqual(subagentCatalogs);
});

it("includes Project Chat's own unread flag but not global or other-project chats", () => {
  using fixture = createRendererStoreFixture({
    projects: [projectRecord({ path: "/cake", name: "Cake" })],
  });
  const home = CakeChatSummary.create({
    sessionId: `project-chat:${"a".repeat(64)}`,
    projectPath: "/cake",
  });
  fixture.models.cakeChatCatalog.sessions.push(
    home,
    CakeChatSummary.create({ sessionId: CAKE_CHAT_SESSION_ID, unread: true }),
    CakeChatSummary.create({
      sessionId: `project-chat:${"b".repeat(64)}`,
      projectPath: "/other",
      unread: true,
    }),
  );
  render(
    <StoreProvider store={fixture.root}>
      <ProjectRail />
    </StoreProvider>,
  );
  const green = () => screen.queryByRole("img", { name: "Unread sessions in Cake" });
  expect(green()).toBeNull();
  act(() => {
    home.unread = true;
  });
  expect(green()).toBeTruthy();
  act(() => {
    home.unread = false;
  });
  expect(green()).toBeNull();
});

it("keeps the project rail idle when worker snapshots change without changing project activity", () => {
  using fixture = createRendererStoreFixture({
    projects: [projectRecord({ path: "/cake", name: "Cake" })],
    sessions: [sessionSummary({ sessionId: "owner", projectPath: "/cake" })],
  });
  const workers = fixture.models.subagentCatalog("owner");
  workers.metadataLoaded = true;
  const worker = {
    parentSessionId: "owner",
    handleId: SubagentHandleId.make("10000000-0000-4000-8000-000000000001"),
    anchorPartId: "spawn",
    task: "Running worker",
    status: "running" as const,
    streaming: true,
    released: false,
    resolved: false,
  };
  workers.metadata.push(worker);
  fixture.models.projects.runningProjectPaths.push("/cake");
  const committed = vi.fn();
  const view = render(
    <StoreProvider store={fixture.root}>
      <Profiler id="project-rail" onRender={committed}>
        <ProjectRail />
      </Profiler>
    </StoreProvider>,
  );
  expect(screen.getByRole("img", { name: "Work running in Cake" })).toBeTruthy();
  committed.mockClear();
  for (let revision = 0; revision < 5; revision += 1) {
    act(() => workers.metadata.splice(0, 1, { ...worker }));
  }
  expect(committed).not.toHaveBeenCalled();
  act(() => {
    workers.metadata.splice(0, 1, { ...worker, streaming: false, status: "complete" });
    fixture.models.projects.runningProjectPaths.splice(0);
  });
  expect(screen.queryByRole("img", { name: "Work running in Cake" })).toBeNull();
  view.unmount();
});
