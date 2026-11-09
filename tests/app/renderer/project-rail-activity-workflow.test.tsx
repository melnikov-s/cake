/** @vitest-environment jsdom */
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import {
  applyProjectCatalogUpdate,
  applySessionCatalogGroupUpdate,
} from "../../../src/renderer/reducers/CatalogReducer";
import { defaultProjectSettings } from "../../../src/contracts/application/application-data";
import { applySnapshot } from "r-state-tree";
import { CAKE_CHAT_SESSION_ID } from "../../../src/contracts/cake-chats/cake-chat-identity";
import { CakeChatSummary } from "../../../src/renderer/models/CakeChatSummary";
import { Profiler } from "react";
import { StoreProvider } from "r-state-tree/react";
import { ProjectRail } from "../../../src/renderer/components/project-rail";
import { SubagentHandleId } from "../../../src/contracts/subagents/subagent-data";
import { createRendererStoreFixture as createStoreFixture } from "./renderer-store-fixture";
import { projectRecord, sessionSummary } from "./fixtures/catalog-fixtures";

import { applyWorktreeOperationCatalogUpdate } from "../../../src/renderer/reducers/WorktreeOperationReducer";
import { AutoMergeToggle } from "../../../src/renderer/components/auto-merge-toggle";
import { ToastHost } from "../../../src/renderer/components/toast-host";
import { IconSizeProvider, iconSizes } from "../../../src/renderer/components/ui/icon-size";
import { Avatar } from "../../../src/renderer/components/ui/avatar";

afterEach(cleanup);

function createRendererStoreFixture(options: Parameters<typeof createStoreFixture>[0]) {
  const fixture = createStoreFixture(options);
  return {
    ...fixture,
    [Symbol.dispose]() {
      // React must stop observing before the Store tree loses its contexts.
      cleanup();
      fixture[Symbol.dispose]();
    },
  };
}

it.each(Object.keys(iconSizes) as (keyof typeof iconSizes)[])(
  "keeps custom and fallback project thumbnails outside the %s control-icon role",
  (role) => {
    using fixture = createRendererStoreFixture({
      projects: [
        projectRecord({
          path: "/cake",
          name: "Cake",
          settings: {
            ...defaultProjectSettings(),
            icon: { mimeType: "image/png", data: "fixture" },
          },
        }),
        projectRecord({ path: "/fallback", name: "Fallback" }),
      ],
    });
    render(
      <StoreProvider store={fixture.root}>
        <IconSizeProvider size={role}>
          <ProjectRail />
          <Avatar kind="project" seed="Elsewhere" data-testid="other-project-avatar" />
        </IconSizeProvider>
      </StoreProvider>,
    );
    for (const name of ["Cake", "Fallback"]) {
      const button = screen.getByRole("button", { name: `Open Project Chat for ${name}` });
      const thumbnail = button.querySelector('[data-slot="avatar"]')!;
      // Historical rail artwork box, independent of the 24/18/12px control system.
      expect(thumbnail.classList.contains("size-[32.5px]")).toBe(true);
      expect(thumbnail.classList.contains("size-[18px]")).toBe(false);
      expect(thumbnail.querySelector("img")!.classList.contains("size-full")).toBe(true);
      expect(thumbnail.parentElement!.classList.contains("size-9")).toBe(true);
      expect(button.classList.contains("h-9")).toBe(true);
    }
    expect(
      screen.getByRole("button", { name: "Open Project Chat for Cake" }).querySelector("img")!
        .className,
    ).toContain("object-contain");
    expect(screen.getByTestId("other-project-avatar").classList.contains("size-5")).toBe(true);
    expect(
      screen.getByRole("button", { name: "Settings" }).querySelector("svg")!.getAttribute("width"),
    ).toBe(String(iconSizes[role]));
  },
);

it("has no global rail toggle; explicit project controls stay independent across view switches", async () => {
  const setAutoMerge = vi.fn(async (projectPath: string, enabled: boolean) => {
    const projects = fixture.models.worktreeOperations.autoMergeProjects;
    applyWorktreeOperationCatalogUpdate(fixture.models.worktreeOperations, {
      operations: [],
      autoMergeProjects: [
        ...projects.filter((item) => item.projectPath !== projectPath),
        { projectPath, enabled, epoch: "test", status: enabled ? "On" : "Off" },
      ],
    });
  });
  using fixture = createRendererStoreFixture({
    projects: [projectRecord({ path: "/cake" }), projectRecord({ path: "/other" })],
    sessions: [sessionSummary({ sessionId: "owner", projectPath: "/cake" })],
    client: { managedWorktrees: { setAutoMerge } },
  });
  const surface = (projectPath: string | undefined) => (
    <StoreProvider store={fixture.root}>
      <ProjectRail />
      <AutoMergeToggle projectPath={projectPath} />
    </StoreProvider>
  );
  const view = render(surface(undefined));
  expect(screen.queryByRole("button", { name: /Auto-merge/ })).toBeNull();
  view.rerender(surface("/cake"));
  await userEvent.setup().click(screen.getByRole("button", { name: "Auto-merge: off" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Auto-merge: on" })).toBeTruthy());
  view.rerender(surface("/other"));
  expect(screen.getByRole("button", { name: "Auto-merge: off" })).toBeTruthy();
  expect(fixture.root.projectForSession("owner")).toBe("/cake");
  expect(fixture.root.projectForSession(CAKE_CHAT_SESSION_ID)).toBeUndefined();
  view.rerender(surface("/cake"));
  expect(screen.getByRole("button", { name: "Auto-merge: on" })).toBeTruthy();
  view.rerender(surface("/unregistered"));
  expect(screen.queryByRole("button", { name: /Auto-merge/ })).toBeNull();
  expect(setAutoMerge.mock.calls).toEqual([["/cake", true]]);
});

it("hides project Auto-merge live for external workflows without disabling direct projects", async () => {
  const setAutoMerge = vi.fn(async () => undefined);
  using fixture = createRendererStoreFixture({
    projects: [
      projectRecord({ path: "/direct" }),
      projectRecord({
        path: "/external",
        settings: { ...defaultProjectSettings(), worktreeLanding: "pull-request" },
      }),
    ],
    client: { managedWorktrees: { setAutoMerge } },
  });
  applyWorktreeOperationCatalogUpdate(fixture.models.worktreeOperations, {
    operations: [],
    autoMergeProjects: ["/direct", "/external"].map((projectPath) => ({
      projectPath,
      enabled: true,
      epoch: "test",
      status: "On",
    })),
  });
  const view = render(
    <StoreProvider store={fixture.root}>
      <section aria-label="Direct project">
        <AutoMergeToggle projectPath="/direct" />
      </section>
      <section aria-label="External project">
        <AutoMergeToggle projectPath="/external" />
      </section>
    </StoreProvider>,
  );
  expect(
    within(screen.getByRole("region", { name: "Direct project" })).getByRole("button", {
      name: "Auto-merge: on",
    }),
  ).toBeDefined();
  expect(
    within(screen.getByRole("region", { name: "External project" })).queryByRole("button"),
  ).toBeNull();
  await act(async () =>
    applySnapshot(fixture.models.projects, {
      projects: [
        projectRecord({
          path: "/direct",
          settings: { ...defaultProjectSettings(), worktreeLanding: "pull-request" },
        }),
        projectRecord({ path: "/external" }),
      ],
    }),
  );
  expect(
    within(screen.getByRole("region", { name: "Direct project" })).queryByRole("button"),
  ).toBeNull();
  expect(
    within(screen.getByRole("region", { name: "External project" })).getByRole("button", {
      name: "Auto-merge: on",
    }),
  ).toBeDefined();
  expect(fixture.root.autoMergeForProject("/direct")?.enabled).toBe(true);
  expect(fixture.root.autoMergeForProject("/external")?.enabled).toBe(true);
  expect(setAutoMerge).not.toHaveBeenCalled();
  view.unmount();
});

it("keeps the owning project's Auto-merge off when authorization fails", async () => {
  using fixture = createRendererStoreFixture({
    projects: [projectRecord({ path: "/cake" })],
    client: {
      managedWorktrees: {
        setAutoMerge: async () => {
          throw new Error("Connection unavailable");
        },
      },
    },
  });
  render(
    <StoreProvider store={fixture.root}>
      <ProjectRail />
      <AutoMergeToggle projectPath="/cake" />
      <ToastHost store={fixture.root.toastStore} />
    </StoreProvider>,
  );
  await userEvent.setup().click(screen.getByRole("button", { name: "Auto-merge: off" }));
  expect(await screen.findByText("Could not change auto-merge")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Auto-merge: off" }).getAttribute("aria-pressed")).toBe(
    "false",
  );
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
  // Only the permanent startup chat is materialized, never the unselected project descendants.
  expect(fixture.models.discussionCatalogs.map((catalog) => catalog.sessionId)).toEqual([
    CAKE_CHAT_SESSION_ID,
  ]);
  expect(fixture.models.subagentCatalogs.map((catalog) => catalog.sessionId)).toEqual([
    CAKE_CHAT_SESSION_ID,
  ]);
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
])(
  "shows at most one project dot with blue precedence for running=%s and unread=%s",
  (running, unread) => {
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
    expect(Boolean(green)).toBe(!running && unread);
    expect(row.queryAllByRole("img")).toHaveLength(running || unread ? 1 : 0);
    expect(fixture.models.sessionCatalog.find("other-session")!.unread).toBe(unread);
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
  },
);

it.each([false, true])(
  "shows a closed failed session as red with unread=%s, without loading it",
  (unread) => {
    using fixture = createRendererStoreFixture({
      projects: [projectRecord({ path: "/cake", name: "Cake" })],
      sessions: [
        sessionSummary({
          sessionId: "failed",
          projectPath: "/cake",
          unread,
          latestTurnOutcome: "failed",
        }),
      ],
    });
    render(
      <StoreProvider store={fixture.root}>
        <ProjectRail />
      </StoreProvider>,
    );
    expect(screen.getByRole("img", { name: "Error in Cake" }).className).toContain(
      "bg-destructive",
    );
    expect(screen.queryByRole("img", { name: "Unread sessions in Cake" })).toBeNull();
    expect(fixture.models.projectConversations).toHaveLength(0);
    // Other ongoing project work keeps the existing running precedence.
    act(() => {
      fixture.models.projects.runningProjectPaths.push("/cake");
    });
    expect(screen.getByRole("img", { name: "Work running in Cake" })).toBeTruthy();
    expect(screen.queryByRole("img", { name: "Error in Cake" })).toBeNull();
    act(() => {
      fixture.models.projects.runningProjectPaths.splice(0);
    });
    expect(screen.getByRole("img", { name: "Error in Cake" })).toBeTruthy();
    act(() => {
      fixture.models.sessionCatalog.find("failed")!.resolved = true;
    });
    expect(screen.queryByRole("img", { name: "Error in Cake" })).toBeNull();
  },
);

it.each(["child", "nested", "orphan"])(
  "ignores %s unread even when its parent is absent from the active project catalog",
  (unreadId) => {
    using fixture = createRendererStoreFixture({
      projects: [projectRecord({ path: "/cake", name: "Cake" })],
      sessions: [
        sessionSummary({
          sessionId: "owner",
          projectPath: "/cake",
          familyChildSessionIds: ["child"],
        }),
        sessionSummary({
          sessionId: "child",
          projectPath: "/cake",
          familyParentSessionId: "owner",
          familyChildSessionIds: ["nested"],
          unread: unreadId === "child",
        }),
        sessionSummary({
          sessionId: "nested",
          projectPath: "/cake",
          familyParentSessionId: "child",
          unread: unreadId === "nested",
        }),
        sessionSummary({
          sessionId: "orphan",
          projectPath: "/cake",
          familyParentSessionId: "missing-parent",
          unread: unreadId === "orphan",
        }),
      ],
    });
    render(
      <StoreProvider store={fixture.root}>
        <ProjectRail />
      </StoreProvider>,
    );
    expect(screen.queryByRole("img", { name: "Unread sessions in Cake" })).toBeNull();
    expect(fixture.root.conversationNavigatorStore.tree("/cake").unread).toBe(0);
    expect(fixture.models.sessionCatalog.find(unreadId)!.unread).toBe(true);
  },
);

it("preserves top-level unread behind child-only running and ignores child unread after parents are read", () => {
  using fixture = createRendererStoreFixture({
    projects: [projectRecord({ path: "/cake", name: "Cake" })],
    sessions: [
      sessionSummary({
        sessionId: "owner",
        projectPath: "/cake",
        familyChildSessionIds: ["child"],
      }),
      sessionSummary({
        sessionId: "child",
        projectPath: "/cake",
        familyParentSessionId: "owner",
        running: true,
      }),
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
  const update = (sessionId: string, unread: boolean, revision: number, running = false) =>
    act(() =>
      applySessionCatalogGroupUpdate(
        fixture.models.sessionCatalog,
        { projectPath: "/cake", resolved: false },
        {
          _tag: "Event",
          revision,
          event: { _tag: "ActivityChanged", sessionId, running, unread },
        },
      ),
    );
  expect(green()).toBeNull();
  update("child", true, 1, true);
  expect(green()).toBeNull();
  expect(screen.getByRole("img", { name: "Work running in Cake" })).toBeTruthy();
  expect(fixture.models.sessionCatalog.find("child")!.unread).toBe(true);
  expect(fixture.models.sessionCatalog.find("owner")!.unread).toBe(false);
  expect(fixture.root.conversationNavigatorStore.tree("/cake").running).toBe(1);
  update("child", true, 2);
  act(() => fixture.models.projects.runningProjectPaths.splice(0));
  expect(green()).toBeNull();
  expect(screen.queryByRole("img", { name: "Work running in Cake" })).toBeNull();
  update("owner", true, 3);
  update("peer", true, 4);
  expect(green()).toBeTruthy();
  update("owner", false, 5);
  expect(green()).toBeTruthy();
  act(() => fixture.models.projects.runningProjectPaths.push("/cake"));
  expect(green()).toBeNull();
  expect(fixture.models.sessionCatalog.find("peer")!.unread).toBe(true);
  update("peer", false, 6);
  expect(green()).toBeNull();
  expect(screen.getByRole("img", { name: "Work running in Cake" })).toBeTruthy();
  act(() => fixture.models.projects.runningProjectPaths.splice(0));
  expect(green()).toBeNull();
  expect(screen.queryByRole("img", { name: "Work running in Cake" })).toBeNull();
  expect(fixture.models.sessionCatalog.find("child")!.unread).toBe(true);
  expect(fixture.root.conversationNavigatorStore.tree("/cake").unread).toBe(0);
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
