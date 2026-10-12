/** @vitest-environment jsdom */
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Client } from "../../../src/renderer/client/Client";
import { projectRecord } from "./fixtures/catalog-fixtures";
import { renderSidebarNavigation, sidebarSummary } from "./sidebar-navigation-fixture";

beforeEach(() => {
  vi.stubGlobal("PointerEvent", MouseEvent);
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
  Object.defineProperty(SVGElement.prototype, "getBBox", {
    configurable: true,
    value: () => ({ x: 0, y: 0, width: 24, height: 24 }),
  });
});
afterEach(() => {
  cleanup();
  Reflect.deleteProperty(SVGElement.prototype, "getBBox");
  vi.unstubAllGlobals();
});

const projects = [projectRecord({ path: "/cake" }), projectRecord({ path: "/other" })];
const sessions = [
  sidebarSummary("root", 1, {
    title: "Session search",
    familyId: "root",
    familyChildSessionIds: ["child"],
  }),
  sidebarSummary("child", 2, {
    title: "Search dialog keyboard",
    familyId: "root",
    familyParentSessionId: "root",
    familyDepth: 1,
  }),
  sidebarSummary("archive", 3, { title: "Resolved search design", resolved: true }),
  sidebarSummary("other", 4, { title: "Session search elsewhere", projectPath: "/other" }),
];
const searchButton = () => screen.getByRole("button", { name: "Search sessions" });
const dialog = () => within(screen.getByRole("dialog", { name: "Search sessions" }));
const labels = () =>
  dialog()
    .getAllByRole("option")
    .map((option) => option.textContent);

describe("Session search workflow", () => {
  it("searches collapsed families and resolved sessions, ranks titles, and opens the selected conversation", async () => {
    const open = vi.fn<Client["projectSessions"]["open"]>(async () => undefined);
    using fixture = renderSidebarNavigation({
      projects,
      sessions,
      loadedIds: ["child"],
      client: {
        projectSessions: { open },
        workspaces: { loadStagedSlashCommands: async () => [] },
      },
      snapshot: {
        state: {},
        children: {
          sidebarStore: {
            state: {},
            children: {
              sessionListStore: { state: { collapsedFamilies: { root: true } }, children: {} },
            },
          },
        },
      },
    });
    await fixture.user.click(searchButton());
    expect(labels()).toHaveLength(4);
    await fixture.user.type(dialog().getByRole("combobox"), "session search");
    expect(labels()[0]).toContain("Session searchcake");
    await fixture.user.clear(dialog().getByRole("combobox"));
    await fixture.user.type(dialog().getByRole("combobox"), "resolved");
    expect(dialog().getByRole("img", { name: "Resolved session" })).toBeDefined();
    await fixture.user.clear(dialog().getByRole("combobox"));
    await fixture.user.type(dialog().getByRole("combobox"), "srch dlg");
    await fixture.user.click(dialog().getByRole("option", { name: /Search dialog keyboard/ }));
    await waitFor(() =>
      expect(open).toHaveBeenCalledWith(
        { sessionId: "child", workingDirectory: "/cake" },
        expect.anything(),
      ),
    );
    expect(screen.queryByRole("dialog", { name: "Search sessions" })).toBeNull();
  });

  it.each([
    { avatars: true, characters: false },
    { avatars: true, characters: true },
    { avatars: false, characters: false },
  ])(
    "uses shared row metadata and appearance ($avatars avatars, $characters characters)",
    async ({ avatars, characters }) => {
      const labelId = "10000000-0000-4000-8000-000000000001";
      using fixture = renderSidebarNavigation({
        projects: [
          projectRecord({
            path: "/cake",
            workflow: {
              labels: [{ id: labelId, name: "Review", color: "violet" }],
              assignments: [{ sessionId: "root", labelIds: [labelId] }],
              sessionDetails: [],
            },
          }),
        ],
        sessions: [
          sidebarSummary("root", 1, {
            title: "Session search",
            workingDirectory: "/cake-search",
            running: true,
          }),
        ],
        snapshot: {
          state: {},
          children: {
            settingsStore: {
              state: {},
              children: {
                appearance: {
                  state: { sessionAvatarsEnabled: avatars, sidebarCharactersEnabled: characters },
                  children: {},
                },
              },
            },
          },
        },
      });
      await fixture.publishWorktrees([
        {
          projectPath: "/cake",
          worktreePath: "/cake-search",
          branch: "agent/search",
          baseBranch: "agent/release",
          state: "active",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ]);
      const sidebarRow = screen
        .getByRole("button", { name: /^Session search / })
        .closest<HTMLElement>(".session-item")!;
      await fixture.user.click(searchButton());
      const option = dialog().getByRole("option");
      const searchRow = option.closest<HTMLElement>(".session-item")!;
      const searchMetadata = within(searchRow);
      expect(searchMetadata.getByRole("img", { name: "Labels: Review" })).toBeDefined();
      expect(searchMetadata.getByRole("img", { name: "Running" })).toBeDefined();
      expect(searchMetadata.getByRole("img", { name: "Open worktree" })).toBeDefined();
      expect(searchMetadata.getByText("search")).toBeDefined();
      expect(searchMetadata.getByText("release")).toBeDefined();
      expect(searchMetadata.getByText("cake")).toBeDefined();
      expect(searchRow.querySelector("time")?.textContent).toBe(
        sidebarRow.querySelector("time")?.textContent,
      );
      const selector = '[data-slot="session-leading"] [data-slot="avatar"]';
      const avatar = searchRow.querySelector(selector);
      if (avatars)
        expect(avatar?.getAttribute("data-variant")).toBe(characters ? "artwork" : "square");
      else expect(avatar).toBeNull();
      expect(avatar?.getAttribute("data-variant")).toBe(
        sidebarRow.querySelector(selector)?.getAttribute("data-variant"),
      );
      expect(option.getAttribute("tabindex")).toBe("-1");
      expect(option.getAttribute("aria-selected")).toBe("true");
    },
  );

  it("scopes focus-mode search to the project and resets the query on reopening", async () => {
    using fixture = renderSidebarNavigation({ projects, sessions });
    await fixture.user.click(screen.getByRole("button", { name: "Focus on cake" }));
    await fixture.user.click(searchButton());
    expect(dialog().getByText("Search sessions in cake by title.")).toBeDefined();
    expect(labels()).toHaveLength(3);
    await fixture.user.type(dialog().getByRole("combobox"), "elsewhere");
    expect(dialog().getByRole("status").textContent).toBe("No matching sessions.");
    await fixture.user.keyboard("{Enter}");
    expect(dialog().getByRole("combobox")).toBeDefined();
    await fixture.user.click(dialog().getByRole("button", { name: "Close" }));
    await fixture.user.click(screen.getByRole("button", { name: "Exit focus mode for cake" }));
    await fixture.user.click(screen.getByRole("button", { name: "Show activity" }));
    await fixture.user.click(searchButton());
    expect((dialog().getByRole("combobox") as HTMLInputElement).value).toBe("");
    expect(labels()).toHaveLength(4);
    await fixture.publishSessions(
      sessions.map((session) =>
        session.sessionId === "other" ? { ...session, title: "Renamed conversation" } : session,
      ),
    );
    await fixture.user.type(dialog().getByRole("combobox"), "renamed");
    expect(dialog().getByRole("option").textContent).toContain("Renamed conversation");
  });
});
