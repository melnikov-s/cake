/** @vitest-environment jsdom */
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StoreProvider } from "r-state-tree/react";
import { effect } from "r-state-tree";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CAKE_CHAT_SESSION_ID } from "../../../src/contracts/cake-chats/cake-chat-identity";
import { WorkspaceNavigator } from "../../../src/renderer/components/workspace-navigator";
import { conversationNavigationKey } from "../../../src/renderer/lib/conversation-navigation-tree";
import { applyConversationSnapshot } from "../../../src/renderer/reducers/ConversationReducer";
import { CakeChatSummary } from "../../../src/renderer/models/CakeChatSummary";
import { Project } from "../../../src/renderer/models/Project";
import { createRendererStoreFixture } from "./renderer-store-fixture";
import { fixtureTimestamp, projectRecord, sessionSummary } from "./fixtures/catalog-fixtures";

const alpha = "/alpha";
const beta = "/beta";
const alphaChat = `project-chat:${"a".repeat(64)}`;
const betaChat = `project-chat:${"b".repeat(64)}`;

function renderSessions(projectPath?: string, many = false) {
  const open = vi.fn(async () => undefined);
  const fixture = createRendererStoreFixture({
    projects: [
      projectRecord({ path: alpha, name: "Alpha" }),
      projectRecord({ path: beta, name: "Beta" }),
    ],
    client: { projectSessions: { open } },
    sessions: [
      sessionSummary({
        sessionId: "alpha-session",
        title: "Shared title",
        projectPath: alpha,
        familyChildSessionIds: ["child"],
      }),
      sessionSummary({
        sessionId: "beta-session",
        title: "Shared title",
        projectPath: beta,
        running: true,
        unread: true,
      }),
      sessionSummary({
        sessionId: "child",
        title: "Nested task",
        projectPath: alpha,
        familyParentSessionId: "alpha-session",
      }),
      sessionSummary({
        sessionId: "alpha-resolved",
        title: "Archived Alpha",
        projectPath: alpha,
        resolved: true,
      }),
      sessionSummary({
        sessionId: "beta-resolved",
        title: "Archived Beta",
        projectPath: beta,
        resolved: true,
      }),
      sessionSummary({
        sessionId: "unregistered",
        title: "Unregistered project",
        projectPath: "/removed",
      }),
      ...(many
        ? Array.from({ length: 21 }, (_, index) =>
            sessionSummary({ sessionId: `extra-${index}`, projectPath: beta }),
          )
        : []),
    ],
  });
  fixture.models.cakeChatCatalog.sessions.push(
    CakeChatSummary.create({
      sessionId: alphaChat,
      projectPath: alpha,
      title: "Alpha / Project Chat",
      createdAt: fixtureTimestamp,
      modifiedAt: fixtureTimestamp,
      messageCount: 1,
    }),
  );
  fixture.root.navigationStore.selectCakeChat(
    projectPath === alpha ? alphaChat : CAKE_CHAT_SESSION_ID,
  );
  fixture.root.workspaceNavigatorStore.show("sessions");
  const view = render(
    <StoreProvider store={fixture.root}>
      <WorkspaceNavigator />
    </StoreProvider>,
  );
  return {
    ...fixture,
    user: userEvent.setup(),
    ids: (selector: string) =>
      [...view.container.querySelectorAll<HTMLElement>('[data-slot="conversation-navigator-row"]')]
        .filter((row) => row.matches(selector))
        .map((row) => row.dataset.sessionId),
    navigator: fixture.root.conversationNavigatorStore,
    row(id: string) {
      const row = view.container.querySelector<HTMLElement>(
        `[data-slot="conversation-navigator-row"][data-session-id="${id}"]`,
      );
      if (!row) throw new Error(`Missing session row: ${id}`);
      return row;
    },
    [Symbol.dispose]() {
      view.unmount();
      fixture[Symbol.dispose]();
    },
  };
}

afterEach(cleanup);

describe("All-project Sessions scope", () => {
  it("shows project identity once under headings, retaining badges for ungrouped projects and aggregate counts", () => {
    using fixture = renderSessions();
    expect(screen.getByText("Cake Chat")).toBeTruthy();
    expect(within(fixture.row(alphaChat)).getByRole("button", { name: "Alpha" })).toBeTruthy();
    expect(screen.getAllByText("Alpha", { exact: true })).toHaveLength(1);
    expect(fixture.row(alphaChat).querySelector('[data-slot="avatar"]')).not.toBeNull();
    for (const id of ["alpha-session", "child"]) {
      expect(fixture.row(id).querySelector('[data-slot="session-source"]')).toBeNull();
      expect(within(fixture.row(id)).queryByTitle("Alpha")).toBeNull();
      const description = fixture.row(id).querySelector('[data-slot="session-description"]')!;
      expect(description.textContent).not.toMatch(/·$/);
    }
    const betaSource = within(fixture.row("beta-session")).getByTitle("Beta");
    expect(betaSource.querySelector('[data-slot="avatar"]')).not.toBeNull();
    expect(fixture.row("alpha-session").querySelector('[data-slot="depth-rails"]')).toBeNull();
    expect(fixture.row("child").dataset.depth).toBe("2");
    expect(fixture.row("child").querySelectorAll('[data-slot="depth-rails"] > span')).toHaveLength(
      1,
    );
    expect(screen.queryByText("Unregistered project")).toBeNull();
    expect(screen.queryByText("Archived Alpha")).toBeNull();
    expect(screen.getByRole("button", { name: "Sessions · 1 running · 1 unread" }).title).toContain(
      "5 total in all projects",
    );
  });

  it("updates row identity when a containing project heading appears or disappears", () => {
    using fixture = renderSessions();
    expect(within(fixture.row("beta-session")).getByTitle("Beta")).toBeTruthy();
    act(() =>
      fixture.models.cakeChatCatalog.sessions.push(
        CakeChatSummary.create({
          sessionId: betaChat,
          projectPath: beta,
          title: "Beta / Project Chat",
          createdAt: fixtureTimestamp,
          modifiedAt: fixtureTimestamp,
          messageCount: 1,
        }),
      ),
    );
    expect(screen.getAllByText("Beta", { exact: true })).toHaveLength(1);
    expect(fixture.row("beta-session").querySelector('[data-slot="session-source"]')).toBeNull();
    expect(fixture.row("beta-session").dataset.depth).toBe("1");
    for (const id of ["alpha-session", "beta-session"]) {
      expect(fixture.row(id).querySelector('[data-slot="depth-rails"]')).toBeNull();
    }
    expect(within(fixture.row("beta-session")).getByRole("img", { name: "Running" })).toBeTruthy();
    act(() => fixture.models.cakeChatCatalog.sessions.pop());
    expect(within(fixture.row("beta-session")).getByTitle("Beta")).toBeTruthy();
    expect(fixture.row("beta-session").dataset.depth).toBe("0");
  });

  it("pins and prioritizes the focused project, switches focus to a collapsed project, and opens a cross-project session", async () => {
    using fixture = renderSessions(alpha);
    const { root, models, user } = fixture;
    act(() => {
      models.cakeChatCatalog.sessions.push(
        CakeChatSummary.create({ sessionId: betaChat, title: "Beta", projectPath: beta }),
      );
      const model = root.sessionRegistry.load("alpha-session", alpha).model;
      applyConversationSnapshot(model, {
        sessionId: "alpha-session",
        sessionFile: "/alpha/session.jsonl",
        parts: [],
        models: [],
        thinkingLevel: "off",
        availableThinkingLevels: [],
        streaming: false,
        diagnostics: [],
        commands: [],
        compatibility: { resources: [], diagnostics: [] },
        extensionUi: { statuses: [] },
        tree: [],
      });
    });
    const homes = () => fixture.ids('[data-relationship="home"]');
    expect(homes()).toEqual([alphaChat, CAKE_CHAT_SESSION_ID, betaChat]);
    expect(screen.queryByRole("button", { name: "Collapse Alpha" })).toBeNull();
    act(() => fixture.navigator.toggleExpanded(alpha, conversationNavigationKey(alphaChat)));
    expect(fixture.row("alpha-session").querySelector('[data-slot="session-source"]')).toBeNull();
    expect(fixture.row("beta-session").querySelector('[data-slot="session-source"]')).toBeNull();
    await user.click(screen.getByRole("button", { name: "Collapse Beta" }));
    expect(fixture.ids('[data-session-id="beta-session"]')).toEqual([]);

    // Change workspace context before selection reveal so the pin itself is exercised.
    act(() => root.workspaceNavigatorStore.show("sessions"));
    expect(fixture.navigator.isExpanded(beta, conversationNavigationKey(betaChat))).toBe(true);
    act(() => root.navigationStore.selectCakeChat(betaChat));
    expect(homes()).toEqual([betaChat, CAKE_CHAT_SESSION_ID, alphaChat]);
    expect(screen.queryByRole("button", { name: "Collapse Beta" })).toBeNull();
    expect(fixture.row("beta-session")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Collapse Alpha" })).toBeTruthy();
    await user.click(
      within(fixture.row("alpha-session")).getByRole("button", { name: /^Shared title/ }),
    );
    await waitFor(() =>
      expect(root.appShellStore.activeConversation?.sessionId).toBe("alpha-session"),
    );
    expect(root.workspaceNavigatorStore.projectPath).toBe(alpha);
    expect(root.workspaceNavigatorStore.companionTab).toBe("chat");
  });

  it("preserves active and resolved filtering, matching ancestors and disclosure when searching globally", () => {
    using fixture = renderSessions();
    const homeKey = conversationNavigationKey(alphaChat);
    act(() => fixture.navigator.toggleExpanded(undefined, homeKey));
    expect(screen.queryByText("Nested task")).toBeNull();
    act(() => fixture.navigator.setQuery(undefined, "Nested task"));
    expect(fixture.row("child")).toBeTruthy();
    expect(fixture.row("alpha-session")).toBeTruthy();
    expect(fixture.row(alphaChat)).toBeTruthy();
    expect(screen.getAllByText("Alpha", { exact: true })).toHaveLength(1);
    expect(fixture.row("child").querySelector('[data-slot="session-source"]')).toBeNull();
    expect(fixture.ids('[data-session-id="beta-session"]')).toEqual([]);
    act(() => fixture.navigator.setQuery(undefined, ""));
    expect(screen.queryByText("Nested task")).toBeNull();
    act(() => fixture.root.sidebarStore.sessionListStore.toggleResolvedGroupExpanded());
    const resolved = within(screen.getByRole("region", { name: "Resolved sessions" }));
    expect(resolved.getByText("Archived Alpha")).toBeTruthy();
    expect(resolved.getByText("Archived Beta")).toBeTruthy();
    for (const [id, name] of [
      ["alpha-resolved", "Alpha"],
      ["beta-resolved", "Beta"],
    ] as const) {
      expect(
        within(fixture.row(id)).getByTitle(name).querySelector('[data-slot="avatar"]'),
      ).not.toBeNull();
    }
    act(() => fixture.navigator.setQuery(undefined, "Archived Beta"));
    expect(resolved.queryByText("Archived Alpha")).toBeNull();
    expect(resolved.getByText("Archived Beta")).toBeTruthy();
    expect(fixture.navigator.query(alpha)).toBe("");
  });

  it("paginates global project roots and resolved history independently and bypasses pagination for search", () => {
    using fixture = renderSessions(undefined, true);
    const betaRows = () =>
      fixture.ids('[data-session-id="beta-session"], [data-session-id^="extra-"]');
    expect(betaRows()).toHaveLength(10);
    expect(fixture.navigator.hasMoreSessions(undefined)).toBe(true);
    act(() => fixture.navigator.showMoreSessions());
    expect(betaRows()).toHaveLength(20);
    act(() => fixture.navigator.setQuery(undefined, "extra-"));
    expect(betaRows()).toHaveLength(21);
    act(() => {
      fixture.navigator.setQuery(undefined, "");
      fixture.navigator.showMoreSessions();
    });
    expect(betaRows()).toHaveLength(22);
    expect(fixture.navigator.hasMoreSessions(undefined)).toBe(false);
    expect(fixture.root.sidebarStore.sessionListStore.sessionLimit(beta, true)).toBe(10);
    act(() => {
      fixture.root.sidebarStore.sessionListStore.toggleResolvedGroupExpanded();
      fixture.models.sessionCatalog.resolvedHasMoreByProject[beta] = true;
    });
    expect(fixture.navigator.hasMoreSessions(undefined, true)).toBe(true);
    act(() => fixture.navigator.showMoreSessions(true));
    expect(fixture.root.sidebarStore.sessionListStore.sessionLimit(beta, true)).toBe(20);
  });

  it("demands all-project metadata and reveals all archives from a project without loading transcripts", () => {
    using fixture = renderSessions(alpha);
    const load = vi.spyOn(fixture.root.sessionRegistry, "load");
    const ids = () => fixture.navigator.metadataTargets().map((target) => target.sessionId);
    expect(ids()).toEqual(
      expect.arrayContaining([
        CAKE_CHAT_SESSION_ID,
        alphaChat,
        "alpha-session",
        "child",
        "beta-session",
      ]),
    );
    expect(ids()).not.toContain("beta-resolved");
    act(() => fixture.root.sidebarStore.sessionListStore.toggleResolvedGroupExpanded());
    expect(ids()).toEqual(expect.arrayContaining(["alpha-resolved", "beta-resolved"]));
    expect(fixture.row("alpha-resolved")).toBeTruthy();
    expect(fixture.row("beta-resolved")).toBeTruthy();
    expect(load).not.toHaveBeenCalled();
    expect(fixture.models.projectConversations).toHaveLength(0);
  });

  it("lets the user close the archive after all projects return an empty history", async () => {
    using fixture = renderSessions(alpha);
    const archive = screen.getByRole("button", { name: "Resolved sessions" });
    await fixture.user.click(archive);
    act(() => {
      for (const path of [alpha, beta])
        fixture.models.sessionCatalog.resolvedTotalByProject[path] = 0;
      const catalog = fixture.models.sessionCatalog;
      for (let index = catalog.sessions.length - 1; index >= 0; index--)
        if (catalog.sessions[index]?.resolved) catalog.sessions.splice(index, 1);
    });
    expect(archive.getAttribute("aria-expanded")).toBe("true");
    await fixture.user.click(archive);
    expect(screen.queryByRole("button", { name: "Resolved sessions" })).toBeNull();
    expect(
      fixture.root.sidebarStore.sessionListStore.projectSessionCatalogQueries.every(
        (query) => !query.resolved,
      ),
    ).toBe(true);
  });

  it("keeps metadata and lineage identities stable for activity but not ownership labels", () => {
    using fixture = renderSessions();
    const metadata: object[] = [];
    const lineages: object[] = [];
    const stopMetadata = effect(() => {
      metadata.push(fixture.navigator.metadataTargets());
    });
    const stopLineage = effect(() => {
      lineages.push(fixture.navigator.lineageFor("alpha-session"));
    });
    try {
      const session = fixture.models.sessionCatalog.find("alpha-session")!;
      act(() => {
        session.running = true;
        session.unread = true;
      });
      expect(metadata).toHaveLength(1);
      expect(lineages).toHaveLength(1);
      act(() => {
        session.title = "Renamed";
      });
      expect(metadata).toHaveLength(1);
      expect(lineages).toHaveLength(2);
      expect(fixture.navigator.lineageFor("alpha-session").at(-1)?.title).toBe("Renamed");
    } finally {
      stopMetadata();
      stopLineage();
    }
  });

  it("reacts to project registration and removal instead of retaining an old scope", () => {
    using fixture = renderSessions();
    act(() =>
      fixture.models.projects.projects.push(
        Project.create(projectRecord({ path: "/removed", name: "New project" })),
      ),
    );
    expect(screen.getByText("Unregistered project")).toBeTruthy();
    act(() =>
      fixture.models.projects.projects.splice(
        fixture.models.projects.projects.findIndex((project) => project.path === beta),
        1,
      ),
    );
    expect(
      fixture.navigator.tree(undefined).byKey.has(conversationNavigationKey("beta-session")),
    ).toBe(false);
    expect(
      fixture.navigator.metadataTargets().some((target) => target.sessionId === "beta-session"),
    ).toBe(false);
  });
});
