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
import { applySessionSignalsUpdate } from "../../../src/renderer/reducers/SessionSignalsReducer";
import { CakeChatSummary } from "../../../src/renderer/models/CakeChatSummary";
import { Project } from "../../../src/renderer/models/Project";
import { createRendererStoreFixture } from "./renderer-store-fixture";
import { fixtureTimestamp, projectRecord, sessionSummary } from "./fixtures/catalog-fixtures";

const alpha = "/alpha";
const beta = "/beta";
const alphaChat = `project-chat:${"a".repeat(64)}`;
const betaChat = `project-chat:${"b".repeat(64)}`;
const delegatedPath = "/delegated";
const archivePath = "/history";
const delegatedChat = `project-chat:${"d".repeat(64)}`;
const archiveChat = `project-chat:${"c".repeat(64)}`;

function renderSessions(projectPath?: string, many = false, mixed = false) {
  const open = vi.fn(async () => undefined);
  const fixture = createRendererStoreFixture({
    projects: [
      projectRecord({ path: alpha, name: "Alpha" }),
      projectRecord({ path: beta, name: "Beta" }),
      ...(mixed
        ? [
            projectRecord({ path: delegatedPath, name: "Delegated project" }),
            projectRecord({ path: archivePath, name: "History only" }),
          ]
        : []),
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
      ...(mixed
        ? [
            sessionSummary({
              sessionId: "delegated-lead",
              title: "Worker lead",
              projectPath: delegatedPath,
              purpose: "delegated",
              familyChildSessionIds: ["delegated-child"],
              cakeChatLaunch: { requesterSessionId: CAKE_CHAT_SESSION_ID },
            }),
            sessionSummary({
              sessionId: "delegated-child",
              title: "Worker child",
              projectPath: delegatedPath,
              purpose: "delegated",
              familyParentSessionId: "delegated-lead",
            }),
            ...Array.from({ length: 14 }, (_, index) =>
              sessionSummary({
                sessionId: `history-${String(index).padStart(2, "0")}`,
                projectPath: archivePath,
                resolved: true,
              }),
            ),
          ]
        : []),
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
  if (mixed) {
    fixture.models.cakeChatCatalog.sessions.push(
      CakeChatSummary.create({ sessionId: betaChat, projectPath: beta, title: "Beta" }),
      CakeChatSummary.create({
        sessionId: delegatedChat,
        projectPath: delegatedPath,
        title: "Delegated project",
      }),
      CakeChatSummary.create({
        sessionId: archiveChat,
        projectPath: archivePath,
        title: "History only",
      }),
    );
  }
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
    expect(screen.queryByText("Cake Chat", { exact: true })).toBeNull();
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
      "4 total in all projects",
    );
  });

  it.each([undefined, alpha])(
    "excludes the permanent Cake Chat from search with focus %s",
    (projectPath) => {
      using fixture = renderSessions(projectPath, false, true);
      expect(fixture.ids(`[data-session-id="${CAKE_CHAT_SESSION_ID}"]`)).toEqual([]);
      act(() => fixture.navigator.setQuery(projectPath, "Cake Chat"));
      expect(screen.getByText("No matching conversations")).toBeTruthy();
      act(() => fixture.navigator.setQuery(projectPath, "Worker child"));
      expect(fixture.row("delegated-child")).toBeTruthy();
      expect(fixture.row("delegated-lead")).toBeTruthy();
      act(() => fixture.navigator.setQuery(projectPath, ""));
      expect(screen.queryByText("Worker child")).toBeNull();
    },
  );

  it("uses background user ownership even if the user-owned row is not loaded", () => {
    using fixture = renderSessions(undefined, false, true);
    const region = within(screen.getByRole("region", { name: "Delegated project" }));
    expect(region.getByRole("button", { name: "Expand Delegated project" })).toBeTruthy();
    const signal = {
      sessionId: "cold-mine",
      purpose: "user" as const,
      projectPath: delegatedPath,
      workingDirectory: delegatedPath,
      running: false,
      unread: false,
    };
    act(() =>
      applySessionSignalsUpdate(fixture.models.sessionCatalog, {
        _tag: "Snapshot",
        sessions: [signal],
      }),
    );
    expect(region.getByRole("button", { name: "Collapse Delegated project" })).toBeTruthy();
    expect(region.getByRole("button", { name: "Delegated" }).getAttribute("aria-expanded")).toBe(
      "false",
    );
    act(() =>
      applySessionSignalsUpdate(fixture.models.sessionCatalog, {
        _tag: "Resolved",
        sessionId: signal.sessionId,
      }),
    );
    expect(region.getByRole("button", { name: "Expand Delegated project" })).toBeTruthy();
  });

  it("keeps project and kind disclosures independent and reveals a selected delegated descendant", async () => {
    using fixture = renderSessions(alpha, false, true);
    const project = within(screen.getByRole("region", { name: "Delegated project" }));
    const betaRegion = within(screen.getByRole("region", { name: "Beta" }));
    expect(betaRegion.getByRole("button", { name: "Collapse Beta" })).toBeTruthy();
    expect(project.queryByRole("button", { name: "Delegated" })).toBeNull();
    await fixture.user.click(project.getByRole("button", { name: "Expand Delegated project" }));
    const delegated = project.getByRole("button", { name: "Delegated" });
    expect(delegated.getAttribute("aria-expanded")).toBe("false");
    await fixture.user.click(delegated);
    await fixture.user.click(project.getByRole("button", { name: "Collapse Worker lead" }));
    await fixture.user.click(project.getByRole("button", { name: "Collapse Delegated project" }));
    expect(screen.queryByText("Worker lead")).toBeNull();
    act(() => fixture.root.navigationStore.selectProjectSession("delegated-child"));
    expect(fixture.row("delegated-child").dataset.navigationActive).toBe("true");
    expect(fixture.root.workspaceNavigatorStore.projectPath).toBe(delegatedPath);
    act(() => fixture.root.navigationStore.selectCakeChat(alphaChat));
    expect(project.getByRole("button", { name: "Expand Delegated project" })).toBeTruthy();
    await fixture.user.click(project.getByRole("button", { name: "Expand Delegated project" }));
    expect(project.getByRole("button", { name: "Delegated" }).getAttribute("aria-expanded")).toBe(
      "true",
    );
  });

  it("nests and pages archives independently, including an archive-only project", async () => {
    using fixture = renderSessions(alpha, false, true);
    const alphaRegion = within(screen.getByRole("region", { name: "Alpha" }));
    const history = within(screen.getByRole("region", { name: "History only" }));
    const archiveButton = (project: ReturnType<typeof within>) =>
      project.getByRole("button", { name: "Resolved sessions" });
    expect(history.queryByRole("button", { name: "Resolved sessions" })).toBeNull();
    act(() => {
      fixture.models.sessionCatalog.resolvedTotalByProject[archivePath] = 14;
      fixture.models.sessionCatalog.resolvedTotalByProject[alpha] = 1;
    });
    // Selecting an archive-only project's paged-out row reveals that project and archive.
    act(() => fixture.root.navigationStore.selectProjectSession("history-13"));
    expect(fixture.row("history-13").dataset.navigationActive).toBe("true");
    expect(
      alphaRegion.getAllByRole("heading").map((heading) => heading.getAttribute("aria-label")),
    ).toEqual(["My sessions", "Delegated", "Resolved sessions"]);
    expect(archiveButton(alphaRegion).getAttribute("aria-expanded")).toBe("false");
    expect(archiveButton(alphaRegion).querySelector('[data-slot="group-count"]')?.textContent).toBe(
      "1",
    );
    expect(archiveButton(history).getAttribute("aria-expanded")).toBe("true");
    expect(archiveButton(history).querySelector('[data-slot="group-count"]')?.textContent).toBe(
      "14",
    );
    expect(history.queryByRole("heading", { name: "My sessions" })).toBeNull();
    expect(history.queryByText("history-12")).toBeNull();
    await fixture.user.click(archiveButton(alphaRegion));
    await fixture.user.click(history.getByRole("button", { name: "Show more" }));
    expect(history.getByText("history-12")).toBeTruthy();
    const list = fixture.root.sidebarStore.sessionListStore;
    expect(list.projectSessionCatalogQueries.filter(({ resolved }) => resolved)).toEqual(
      expect.arrayContaining([
        { projectPath: archivePath, resolved: true, limit: 20 },
        { projectPath: alpha, resolved: true, limit: 10 },
      ]),
    );
    expect(list.projectSessionCatalogQueries.filter(({ resolved }) => resolved)).toHaveLength(2);
    act(() => fixture.navigator.setQuery(archivePath, "history-12"));
    expect(history.getByText("history-12")).toBeTruthy();
    expect(screen.queryByText("Archived Alpha")).toBeNull();
    act(() => fixture.navigator.setQuery(archivePath, ""));
    await fixture.user.click(archiveButton(history));
    expect(archiveButton(alphaRegion).getAttribute("aria-expanded")).toBe("true");
    expect(history.queryByText("history-13")).toBeNull();
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
    expect(homes()).toEqual([alphaChat, betaChat]);
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
    expect(homes()).toEqual([betaChat, alphaChat]);
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
    const list = fixture.root.sidebarStore.sessionListStore;
    act(() => {
      fixture.navigator.toggleExpanded(undefined, homeKey);
      list.setArchiveExpanded(alpha, true);
      list.setArchiveExpanded(beta, true);
    });
    expect(
      within(screen.getByRole("region", { name: "Alpha" })).getByText("Archived Alpha"),
    ).toBeTruthy();
    expect(
      within(screen.getByRole("region", { name: "Beta" })).getByText("Archived Beta"),
    ).toBeTruthy();
    act(() => fixture.navigator.setQuery(undefined, "Archived Beta"));
    expect(screen.queryByText("Archived Alpha")).toBeNull();
    expect(screen.getByRole("region", { name: "Resolved sessions" }).textContent).toContain(
      "Archived Beta",
    );
    expect(fixture.navigator.query(alpha)).toBe("");
  });

  it("reveals an externally selected active root outside the current page without advancing it", () => {
    using fixture = renderSessions(undefined, true);
    const id = fixture.navigator.tree(beta).roots.at(-1)!.target.sessionId;
    expect(fixture.ids(`[data-session-id="${id}"]`)).toEqual([]);
    act(() => fixture.root.navigationStore.selectProjectSession(id));
    expect(fixture.row(id).dataset.navigationActive).toBe("true");
    expect(fixture.root.sidebarStore.sessionListStore.sessionLimit(beta)).toBe(10);
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
    const list = fixture.root.sidebarStore.sessionListStore;
    act(() => {
      list.setArchiveExpanded(beta, true);
      fixture.models.sessionCatalog.resolvedHasMoreByProject[beta] = true;
    });
    act(() => list.showMoreSessions(beta, true));
    expect(list.sessionLimit(beta, true)).toBe(20);
    expect(list.sessionLimit(alpha, true)).toBe(10);
  });

  it("demands all-project active metadata and only the expanded project's archive without loading transcripts", () => {
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
    act(() => fixture.root.sidebarStore.sessionListStore.setArchiveExpanded(alpha, true));
    expect(ids()).toContain("alpha-resolved");
    expect(ids()).not.toContain("beta-resolved");
    expect(fixture.row("alpha-resolved")).toBeTruthy();
    expect(fixture.ids('[data-session-id="beta-resolved"]')).toEqual([]);
    expect(load).not.toHaveBeenCalled();
    expect(fixture.models.projectConversations).toHaveLength(0);
  });

  it("lets the user close the archive after all projects return an empty history", async () => {
    using fixture = renderSessions(alpha);
    const archive = within(screen.getByRole("region", { name: "Alpha" })).getByRole("button", {
      name: "Resolved sessions",
    });
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
