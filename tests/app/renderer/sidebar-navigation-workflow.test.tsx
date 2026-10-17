/** @vitest-environment jsdom */
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Client } from "../../../src/renderer/client/Client";
import { projectRecord } from "./fixtures/catalog-fixtures";
import {
  renderSidebarNavigation,
  sidebarFamily,
  sidebarSummary,
} from "./sidebar-navigation-fixture";

beforeEach(() => {
  vi.stubGlobal("PointerEvent", MouseEvent);
  Object.defineProperty(SVGElement.prototype, "getBBox", {
    configurable: true,
    value: () => ({ x: 0, y: 0, width: 24, height: 24 }),
  });
  vi.stubGlobal("matchMedia", (query: string): MediaQueryList => ({
    media: query,
    matches: query === "(prefers-reduced-motion: reduce)",
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent: () => true,
  }));
});
afterEach(() => {
  cleanup();
  Reflect.deleteProperty(SVGElement.prototype, "getBBox");
  vi.unstubAllGlobals();
});

const project = projectRecord({ path: "/cake" });
const rowButton = (id: string) => screen.getByRole("button", { name: new RegExp(`^${id}(?: |$)`) });
const row = (id: string) => rowButton(id).closest<HTMLElement>(".session-item")!;
const order = (container: HTMLElement = document.body) =>
  [...container.querySelectorAll<HTMLElement>(".session-item")].map(
    (element) => element.dataset.sessionId,
  );
const projectGroup = (name: string) =>
  screen
    .getByRole("button", { name: `Open Project Chat for ${name}` })
    .closest<HTMLElement>('[data-slot="project-group"]')!;
const resolvedGroup = (name: string) =>
  screen
    .getAllByRole("button", { name: `Collapse ${name} resolved` })[0]!
    .closest<HTMLElement>('[data-slot="project-group"]')!;

describe("Sidebar navigation workflow", () => {
  it("restores window/list preferences and expands a collapsed project when entering focus", async () => {
    const menu = vi.fn<Client["electron"]["showProjectContextMenu"]>(async () => "sort-by-date");
    using fixture = renderSidebarNavigation({
      projects: [project, projectRecord({ path: "/pi" })],
      sessions: [...sidebarFamily, sidebarSummary("standalone", 3)],
      client: { electron: { showProjectContextMenu: menu } },
      snapshot: {
        state: {},
        children: {
          sidebarStore: {
            state: { hidden: true, width: 344, navigationMode: "activity" },
            children: {
              sessionListStore: {
                state: {
                  projectSessionSorts: { "/cake": "label" },
                  expandedActiveGroups: { "cake-chat": true, "/cake": false },
                  collapsedFamilies: { root: true },
                },
                children: {},
              },
            },
          },
        },
      },
    });
    expect(screen.queryByRole("complementary")).toBeNull();
    await fixture.user.click(screen.getAllByRole("button", { name: "Toggle sidebar" })[0]!);
    expect(screen.getByRole("main").style.getPropertyValue("--sidebar-width")).toBe("344px");
    expect(screen.getByRole("button", { name: "Show projects" })).toBeDefined();
    expect(order()).toEqual(["root", "standalone"]);
    await fixture.user.click(screen.getByRole("button", { name: "Show projects" }));
    expect(screen.getByRole("button", { name: "Expand cake" })).toBeDefined();
    expect(screen.queryByRole("button", { name: /^root / })).toBeNull();
    await fixture.user.click(screen.getByRole("button", { name: "Focus on cake" }));
    expect(screen.getByRole("button", { name: "Exit focus mode for cake" })).toBeDefined();
    expect(order()).toEqual(["root", "standalone"]);
    await fixture.user.pointer({
      target: screen.getByRole("button", { name: "Open Project Chat for cake" }),
      keys: "[MouseRight]",
    });
    expect(menu).toHaveBeenCalledWith(
      expect.objectContaining({ path: "/cake", sessionSort: "label" }),
    );
    await fixture.user.click(screen.getByRole("button", { name: "Exit focus mode for cake" }));
    expect(screen.getByRole("button", { name: "Focus on pi" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Collapse cake" })).toBeDefined();
    await fixture.user.click(screen.getByRole("button", { name: "Expand children of root" }));
    expect(order()).toEqual(["root", "planner", "worker", "sibling", "standalone"]);
  });

  it("freezes only active recency through interleaved writes, selection, refresh and mode changes", async () => {
    const sessions = [
      sidebarSummary("newest", 3),
      sidebarSummary("middle", 2),
      sidebarSummary("oldest", 1),
    ];
    using fixture = renderSidebarNavigation({
      projects: [project],
      sessions,
      loadedIds: sessions.map((session) => session.sessionId),
      client: { projectSessions: { open: async () => undefined } },
    });
    expect(row("newest").querySelector("time")).not.toBeNull();
    await fixture.publishStreaming(["newest", "oldest"], true);
    await fixture.user.click(rowButton("oldest"));
    for (const [id, day] of [
      ["oldest", 6],
      ["newest", 8],
      ["oldest", 9],
    ] as const) {
      await fixture.publishSessions(
        sessions.map((session) => (session.sessionId === id ? sidebarSummary(id, day) : session)),
      );
      expect(order()).toEqual(["newest", "middle", "oldest"]);
      expect(row("oldest").dataset.navigationActive).toBe("true");
      for (const active of ["newest", "oldest"]) {
        expect(row(active).querySelector("time")).toBeNull();
        expect(row(active).querySelector(".session-time")).toBeNull();
        expect(within(row(active)).getByRole("img", { name: "Running" })).toBeDefined();
      }
      expect(row("middle").querySelector("time")).not.toBeNull();
      await fixture.publishEvent({
        _tag: "PartUpdated",
        sessionId: id,
        part: {
          id: "tool-read",
          kind: "tool",
          name: "read",
          input: "src/app.ts",
          state: "running",
          output: `bytes ${day}`,
        },
      });
      await fixture.publishEvent({
        _tag: "PartUpdated",
        sessionId: id,
        part: {
          id: "assistant-message",
          kind: "text",
          role: "assistant",
          text: `progress ${day}`,
          status: "streaming",
        },
      });
      expect(order()).toEqual(["newest", "middle", "oldest"]);
    }
    // Inactive rows still move immediately, without changing the active pair's order.
    const refreshed = [
      sidebarSummary("oldest", 9),
      sidebarSummary("middle", 10),
      sidebarSummary("newest", 8),
    ];
    await fixture.publishSessions(refreshed);
    expect(order()).toEqual(["middle", "newest", "oldest"]);
    await fixture.user.click(screen.getByRole("button", { name: "Show activity" }));
    expect(order()).toEqual(["middle", "newest", "oldest"]);
    await fixture.publishSessions([...refreshed].reverse());
    expect(order()).toEqual(["middle", "newest", "oldest"]);
    await fixture.user.click(screen.getByRole("button", { name: "Show projects" }));
    expect(order()).toEqual(["middle", "newest", "oldest"]);
    await fixture.user.click(rowButton("newest"));
    expect(row("newest").dataset.navigationActive).toBe("true");
    expect(order()).toEqual(["middle", "newest", "oldest"]);
  });

  it("rejoins date order on completion and takes a fresh anchor on reactivation", async () => {
    const sessions = ["newest", "middle", "oldest"].map((id, index) =>
      sidebarSummary(id, 3 - index),
    );
    using fixture = renderSidebarNavigation({
      projects: [project],
      sessions,
      loadedIds: ["newest", "middle", "oldest"],
      client: { projectSessions: { open: async () => undefined } },
    });
    await fixture.publishStreaming(["newest", "middle"], true);
    await fixture.publishSessions([
      sidebarSummary("newest", 7),
      sidebarSummary("middle", 8),
      sidebarSummary("oldest", 1),
    ]);
    // Joining work uses its existing date position, not the last writer's position.
    await fixture.publishStreaming(["oldest"], true);
    await fixture.publishSessions([
      sidebarSummary("oldest", 9),
      sidebarSummary("middle", 8),
      sidebarSummary("newest", 7),
    ]);
    expect(order()).toEqual(["newest", "middle", "oldest"]);
    await fixture.user.click(rowButton("middle"));
    await fixture.publishStreaming(["middle"], false);
    expect(order()).toEqual(["middle", "newest", "oldest"]);
    expect(row("middle").querySelector("time")?.dateTime).toBe(
      sidebarSummary("middle", 8).modifiedAt,
    );
    expect(row("middle").dataset.navigationActive).toBe("true");
    await fixture.publishStreaming(["middle"], true);
    await fixture.publishSessions([
      sidebarSummary("middle", 11),
      sidebarSummary("oldest", 9),
      sidebarSummary("newest", 7),
    ]);
    expect(order()).toEqual(["middle", "newest", "oldest"]);
    expect(row("middle").querySelector("time")).toBeNull();
    await fixture.publishStreaming(["newest", "oldest"], false);
    expect(order()).toEqual(["oldest", "middle", "newest"]);
    await fixture.publishStreaming(["middle"], false);
    expect(order()).toEqual(["middle", "oldest", "newest"]);
  });

  it("restores active anchors across window remounts and breaks equal recency ties by identity", async () => {
    const sessions = [
      sidebarSummary("alpha", 2, { running: true }),
      sidebarSummary("beta", 2, { running: true }),
    ];
    const saved = await (async () => {
      using fixture = renderSidebarNavigation({ projects: [project], sessions });
      expect(order()).toEqual(["alpha", "beta"]);
      expect(row("alpha").querySelector("time")).toBeNull();
      await fixture.publishSessions([
        sidebarSummary("beta", 9, { running: true }),
        sidebarSummary("alpha", 8, { running: true }),
      ]);
      expect(order()).toEqual(["alpha", "beta"]);
      return fixture.snapshot();
    })();
    using fixture = renderSidebarNavigation({
      projects: [project],
      snapshot: saved,
      sessions: [
        sidebarSummary("beta", 9, { running: true }),
        sidebarSummary("alpha", 8, { running: true }),
      ],
    });
    expect(order()).toEqual(["alpha", "beta"]);
    await fixture.publishSessions([
      sidebarSummary("beta", 11, { running: true }),
      sidebarSummary("alpha", 10, { running: true }),
    ]);
    expect(order()).toEqual(["alpha", "beta"]);
  });

  it("keeps running Project Chats stable against sessions in the mixed Activity feed", async () => {
    const sessions = [sidebarSummary("newest", 4), sidebarSummary("oldest", 1)];
    using fixture = renderSidebarNavigation({
      projects: [project],
      sessions,
      loadedIds: ["newest", "oldest"],
    });
    const chat = (day: number) => ({
      sessionId: "project-chat",
      title: "Project Chat",
      projectPath: "/cake",
      createdAt: sidebarSummary("unused", 1).modifiedAt,
      modifiedAt: sidebarSummary("unused", day).modifiedAt,
      messageCount: 2,
      resolved: false,
      unread: false,
    });
    await fixture.publishProjectChats([chat(2)]);
    await fixture.publishStreaming(["newest", "oldest"], true);
    await fixture.publishProjectChatStreaming("project-chat", true);
    await fixture.user.click(screen.getByRole("button", { name: "Show activity" }));
    const mixedOrder = () =>
      [...document.querySelectorAll('[data-slot="activity-feed"] [data-session-id]')].map(
        (element) => element.getAttribute("data-session-id"),
      );
    expect(mixedOrder()).toEqual(["newest", "project-chat", "oldest"]);
    const chatRow = document.querySelector('[data-slot="project-chat-item"]')!;
    expect(chatRow.textContent).toBe("Project ChatProject Chat");
    await fixture.publishProjectChats([chat(9)]);
    await fixture.publishSessions([sidebarSummary("oldest", 10), sidebarSummary("newest", 8)]);
    expect(mixedOrder()).toEqual(["newest", "project-chat", "oldest"]);
    await fixture.publishProjectChatStreaming("project-chat", false);
    expect(mixedOrder()).toEqual(["project-chat", "newest", "oldest"]);
    expect(document.querySelector('[data-slot="project-chat-item"]')!.textContent).not.toBe(
      "Project ChatProject Chat",
    );
  });

  it.each(["projects", "activity"] as const)(
    "reorders selected and unselected inactive sessions by activity in %s without changing the open conversation",
    async (mode) => {
      const sessions = [
        sidebarSummary("newest", 3),
        sidebarSummary("middle", 2),
        sidebarSummary("oldest", 1),
      ];
      using fixture = renderSidebarNavigation({
        projects: [project],
        sessions,
        loadedIds: sessions.map((session) => session.sessionId),
        client: { projectSessions: { open: async () => undefined } },
      });
      if (mode === "activity")
        await fixture.user.click(screen.getByRole("button", { name: "Show activity" }));
      await fixture.user.click(rowButton("middle"));
      const pane = document.querySelector('[data-slot="session-pane"]');
      await waitFor(() => expect(pane?.getAttribute("data-session-id")).toBe("middle"));
      const assertSelection = () => {
        expect(
          document
            .querySelector('[data-navigation-active="true"].session-item')
            ?.getAttribute("data-session-id"),
        ).toBe("middle");
        expect(document.querySelector('[data-slot="session-pane"]')).toBe(pane);
        expect(pane?.getAttribute("data-session-id")).toBe("middle");
      };
      expect(order()).toEqual(["newest", "middle", "oldest"]);
      // Selection alone does not pin an inactive row against recency.
      await fixture.publishSessions([sessions[0]!, sidebarSummary("middle", 5), sessions[2]!]);
      expect(order()).toEqual(["middle", "newest", "oldest"]);
      assertSelection();
      // Background activity moves above the selection, but never navigates to it.
      await fixture.publishSessions([
        sessions[0]!,
        sidebarSummary("middle", 5),
        sidebarSummary("oldest", 6),
      ]);
      expect(order()).toEqual(["oldest", "middle", "newest"]);
      assertSelection();
    },
  );

  it("moves a family on selected descendant activity without changing its selected child or open pane", async () => {
    using fixture = renderSidebarNavigation({
      projects: [project],
      sessions: [...sidebarFamily, sidebarSummary("standalone", 31)],
      loadedIds: ["worker"],
      client: { projectSessions: { open: async () => undefined } },
    });
    await fixture.user.click(rowButton("worker"));
    const pane = document.querySelector('[data-slot="session-pane"]');
    await waitFor(() => expect(pane?.getAttribute("data-session-id")).toBe("worker"));
    expect(order()).toEqual(["standalone", "root", "planner", "worker", "sibling"]);
    await fixture.publishSessions([
      ...sidebarFamily.map((session) =>
        session.sessionId === "worker"
          ? { ...session, modifiedAt: "2026-02-01T00:00:00.000Z" }
          : session,
      ),
      sidebarSummary("standalone", 31),
    ]);
    expect(order()).toEqual(["root", "planner", "worker", "sibling", "standalone"]);
    expect(row("worker").getAttribute("data-navigation-active")).toBe("true");
    expect(document.querySelector('[data-slot="session-pane"]')).toBe(pane);
    expect(pane?.getAttribute("data-session-id")).toBe("worker");
  });

  it("flattens nested families parent-first and moves descendant activity onto collapsed ancestors", async () => {
    using fixture = renderSidebarNavigation({
      projects: [project],
      sessions: [...sidebarFamily, sidebarSummary("standalone", 3)],
      loadedIds: ["worker"],
    });
    expect(order()).toEqual(["root", "planner", "worker", "sibling", "standalone"]);
    await fixture.publishStreaming(["worker"], true);
    expect(within(row("root")).queryByRole("img", { name: "Running" })).toBeNull();
    expect(within(row("worker")).getByRole("img", { name: "Running" })).toBeDefined();
    expect(row("worker").querySelector("time")).toBeNull();
    expect(row("root").querySelector("time")).not.toBeNull();
    await fixture.user.click(screen.getByRole("button", { name: "Collapse children of planner" }));
    expect(order()).toEqual(["root", "planner", "sibling", "standalone"]);
    expect(within(row("planner")).getByRole("img", { name: "Running" })).toBeDefined();
    expect(row("planner").querySelector("time")).toBeNull();
    expect(within(row("root")).queryByRole("img", { name: "Running" })).toBeNull();
    await fixture.user.click(screen.getByRole("button", { name: "Collapse children of root" }));
    expect(order()).toEqual(["root", "standalone"]);
    expect(within(row("root")).getByRole("img", { name: "Running" })).toBeDefined();
    expect(row("root").querySelector("time")).toBeNull();
    await fixture.user.click(screen.getByRole("button", { name: "Show activity" }));
    // The root's own timestamp is older: hidden descendants still determine family recency.
    expect(order()).toEqual(["root", "standalone"]);
    await fixture.user.click(screen.getByRole("button", { name: "Show projects" }));
    await fixture.user.click(screen.getByRole("button", { name: "Expand children of root" }));
    expect(order()).toEqual(["root", "planner", "sibling", "standalone"]);
    expect(within(row("root")).queryByRole("img", { name: "Running" })).toBeNull();
    await fixture.user.click(screen.getByRole("button", { name: "Expand children of planner" }));
    expect(order()).toEqual(["root", "planner", "worker", "sibling", "standalone"]);
  });

  it("keeps project and worktree details visible in Activity through mode and lifecycle changes", async () => {
    using fixture = renderSidebarNavigation({
      projects: [project],
      sessions: [
        sidebarSummary("feature", 3, { workingDirectory: "/cake-feature" }),
        sidebarSummary("checkout", 2),
        sidebarSummary("draft", 1, { workingDirectory: "/cake-feature", draft: true }),
      ],
    });
    const worktree = {
      projectPath: "/cake",
      worktreePath: "/cake-feature",
      branch: "agent/feature-branch",
      baseBranch: "agent/release",
      state: "active" as const,
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    await fixture.publishWorktrees([worktree]);
    const assertWorktree = (state: "Open worktree" | "Merged worktree") => {
      expect(within(row("feature")).getByText("feature-branch")).toBeDefined();
      expect(within(row("feature")).getByText("release")).toBeDefined();
      expect(within(row("feature")).getByRole("img", { name: state })).toBeDefined();
      expect(row("feature").querySelector("time")?.textContent).toBeTruthy();
      expect(row("checkout").querySelector("[data-worktree-state]")).toBeNull();
      expect(row("draft").querySelector("[data-worktree-state]")).toBeNull();
      expect(within(row("draft")).queryByText("feature-branch")).toBeNull();
    };
    assertWorktree("Open worktree");
    await fixture.user.click(screen.getByRole("button", { name: "Show activity" }));
    assertWorktree("Open worktree");
    for (const id of ["feature", "checkout", "draft"]) {
      expect(within(row(id)).getByText("cake")).toBeDefined();
    }
    await fixture.publishWorktrees([{ ...worktree, state: "landed" }]);
    assertWorktree("Merged worktree");
    await fixture.user.click(screen.getByRole("button", { name: "Show projects" }));
    assertWorktree("Merged worktree");
    await fixture.user.click(screen.getByRole("button", { name: "Show activity" }));
    assertWorktree("Merged worktree");
    expect(within(row("feature")).getByText("cake")).toBeDefined();
  });

  it("reveals ten roots per click without charging family children or sharing limits across projects and lanes", async () => {
    const singles = Array.from({ length: 20 }, (_, index) =>
      sidebarSummary(`single-${index}`, 20 - index),
    );
    const piSessions = Array.from({ length: 11 }, (_, index) =>
      sidebarSummary(`pi-${index}`, 20 - index, { projectPath: "/pi" }),
    );
    const archives = Array.from({ length: 21 }, (_, index) =>
      sidebarSummary(`archive-${index}`, 25 - index, { resolved: true }),
    );
    using fixture = renderSidebarNavigation({
      projects: [project, projectRecord({ path: "/pi" })],
      sessions: [...sidebarFamily, ...singles, ...piSessions, ...archives],
    });
    expect(order(projectGroup("cake"))).toEqual([
      "root",
      "planner",
      "worker",
      "sibling",
      ...singles.slice(0, 9).map((session) => session.sessionId),
    ]);
    expect(order(projectGroup("pi"))).toHaveLength(10);
    await fixture.user.click(
      within(projectGroup("cake")).getByRole("button", { name: "Show more" }),
    );
    expect(order(projectGroup("cake"))).toHaveLength(23);
    expect(within(projectGroup("cake")).queryByRole("button", { name: /^single-19 / })).toBeNull();
    expect(order(projectGroup("pi"))).toHaveLength(10);
    await fixture.user.click(screen.getByRole("button", { name: "Expand Resolved" }));
    await fixture.user.click(screen.getAllByRole("button", { name: "Expand cake resolved" })[0]!);
    expect(order(resolvedGroup("cake"))).toHaveLength(10);
    await fixture.user.click(
      within(resolvedGroup("cake")).getByRole("button", { name: "Show more" }),
    );
    expect(order(resolvedGroup("cake"))).toHaveLength(20);
    expect(order(projectGroup("cake"))).toHaveLength(23);
    expect(order(projectGroup("pi"))).toHaveLength(10);
    await fixture.user.click(
      within(projectGroup("cake")).getByRole("button", { name: "Show more" }),
    );
    expect(order(projectGroup("cake"))).toHaveLength(24);
    expect(within(projectGroup("cake")).queryByRole("button", { name: "Show more" })).toBeNull();
    expect(order(resolvedGroup("cake"))).toHaveLength(20);
  });

  it("shows queued landing as running only while it waits, not when landing work starts", async () => {
    using fixture = renderSidebarNavigation({
      projects: [project],
      sessions: [
        sidebarSummary("queued", 1, { workingDirectory: "/cake-worktree" }),
        sidebarSummary("landing", 2, { workingDirectory: "/other-worktree" }),
      ],
    });
    const queued = {
      operationId: "merge-1",
      workspacePath: "/cake-worktree",
      sessionId: "queued",
      kind: "landing" as const,
      phase: "waiting" as const,
      allowDirtyTarget: false,
    };
    const landing = {
      operationId: "merge-2",
      workspacePath: "/other-worktree",
      sessionId: "landing",
      kind: "landing" as const,
      phase: "landing" as const,
      allowDirtyTarget: false,
    };
    await fixture.publishWorktreeOperations([queued, landing]);
    expect(within(row("queued")).getByRole("img", { name: "Running" })).toBeDefined();
    expect(within(row("landing")).queryByRole("img", { name: "Running" })).toBeNull();
    await fixture.publishWorktreeOperations([{ ...queued, phase: "landing" }, landing]);
    expect(within(row("queued")).queryByRole("img", { name: "Running" })).toBeNull();
    expect(within(row("landing")).queryByRole("img", { name: "Running" })).toBeNull();
  });
});
