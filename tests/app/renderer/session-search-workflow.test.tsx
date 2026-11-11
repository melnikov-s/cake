/** @vitest-environment jsdom */
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Client } from "../../../src/renderer/client/Client";
import { projectRecord } from "./fixtures/catalog-fixtures";
import { renderSidebarNavigation, sidebarSummary } from "./sidebar-navigation-fixture";
import { openSessionFromSearch, showSessions } from "./workspace-navigation-actions";

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
  it("defaults to unresolved, includes resolved on request, ranks collapsed families, and opens the selected conversation", async () => {
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
    expect(labels()).toHaveLength(3);
    for (const [title, project] of [
      ["Session search", "cake"],
      ["Session search elsewhere", "other"],
    ] as const) {
      const option = dialog().getByTitle(title).closest<HTMLElement>('[role="option"]')!;
      const source = within(option).getByTitle(project);
      expect(source.querySelector('[data-slot="avatar"]')).not.toBeNull();
    }
    expect(
      dialog().getByRole("switch", { name: "Include resolved" }).getAttribute("aria-checked"),
    ).toBe("false");
    await fixture.user.type(dialog().getByRole("combobox"), "session search");
    await waitFor(() => expect(labels()[0]).toMatch(/^Session search.*cake$/));
    await fixture.user.clear(dialog().getByRole("combobox"));
    await fixture.user.type(dialog().getByRole("combobox"), "resolved");
    await waitFor(() =>
      expect(dialog().getByRole("status").textContent).toBe("No matching sessions."),
    );
    await fixture.user.click(dialog().getByRole("switch", { name: "Include resolved" }));
    expect(dialog().getByRole("img", { name: "Resolved session" })).toBeDefined();
    await fixture.user.click(dialog().getByRole("switch", { name: "Include resolved" }));
    expect(dialog().getByRole("status").textContent).toBe("No matching sessions.");
    await fixture.user.clear(dialog().getByRole("combobox"));
    await fixture.user.type(dialog().getByRole("combobox"), "srch dlg");
    await fixture.user.click(
      await dialog().findByRole("option", { name: /Search dialog keyboard/ }),
    );
    await waitFor(() =>
      expect(open).toHaveBeenCalledWith(
        { sessionId: "child", workingDirectory: "/cake" },
        expect.anything(),
      ),
    );
    expect(screen.queryByRole("dialog", { name: "Search sessions" })).toBeNull();
  });

  it("keeps a thousand-session catalog bounded without losing matches outside the initial page", async () => {
    const catalog = Array.from({ length: 1250 }, (_, index) =>
      sidebarSummary(`session-${index}`, 1, {
        title: index === 0 ? "Needle in catalog" : `Task ${index}`,
        modifiedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
      }),
    );
    using fixture = renderSidebarNavigation({ projects: [projects[0]!], sessions: catalog });
    await fixture.user.click(searchButton());
    expect(labels()).toHaveLength(25);
    expect(dialog().getByText("1–25 of 1250")).toBeDefined();
    await fixture.user.click(dialog().getByRole("button", { name: "Next results" }));
    expect(labels()).toHaveLength(25);
    expect(dialog().getByText("26–50 of 1250")).toBeDefined();
    await fixture.user.type(dialog().getByRole("combobox"), "needle in catalog");
    await waitFor(() => {
      expect(labels()).toHaveLength(1);
      expect(labels()[0]).toContain("Needle in catalog");
    });
  });

  it("keeps one fixed dialog frame while typing changes the number of matches", async () => {
    const catalog = Array.from({ length: 20 }, (_, index) =>
      sidebarSummary(`session-${index}`, 1, {
        title:
          index === 0 ? "Needle in catalog" : index <= 5 ? `Release ${index}` : `Task ${index}`,
        modifiedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
      }),
    );
    using fixture = renderSidebarNavigation({ projects: [projects[0]!], sessions: catalog });
    await fixture.user.click(searchButton());
    const frame = () => {
      const listbox = dialog().getByRole("listbox", { name: "Sessions" });
      return {
        content: screen.getByRole("dialog", { name: "Search sessions" }).firstElementChild!
          .className,
        body: listbox.parentElement!.className,
        listbox: listbox.className,
      };
    };
    const initial = frame();
    expect(initial.content).toContain("h-[min(28rem,75vh)]");
    expect(initial.body).toContain("flex-1");
    expect(initial.listbox).toContain("overflow-y-auto");
    expect(initial.listbox).not.toContain("max-h-");
    const input = dialog().getByRole("combobox");
    for (const [query, count] of [
      ["release", 5],
      ["needle", 1],
      ["missing", 0],
      ["", 20],
    ] as const) {
      await fixture.user.clear(input);
      if (query) await fixture.user.type(input, query);
      await waitFor(() => expect(dialog().queryAllByRole("option")).toHaveLength(count));
      expect(frame()).toEqual(initial);
    }
    await fixture.user.type(input, "missing");
    await waitFor(() => expect(dialog().getByRole("status")).toBeDefined());
    await fixture.user.click(dialog().getByRole("switch", { name: "Include resolved" }));
    expect(frame()).toEqual(initial);
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
        loadedIds: ["root"],
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
        client: {
          projectSessions: { open: async () => undefined },
          workspaces: { loadStagedSlashCommands: async () => [] },
        },
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
      await openSessionFromSearch(fixture.user, /^Session search /);
      await showSessions(fixture.user);
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
});
