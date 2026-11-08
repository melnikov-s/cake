/** @vitest-environment jsdom */
import { act, cleanup, render, screen, within } from "@testing-library/react";
import { StoreProvider } from "r-state-tree/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CAKE_CHAT_SESSION_ID } from "../../../src/contracts/cake-chats/cake-chat-identity";
import { ConversationNavigator } from "../../../src/renderer/components/conversation-navigator";
import { WorkspaceNavigator } from "../../../src/renderer/components/workspace-navigator";
import { conversationNavigationKey } from "../../../src/renderer/lib/conversation-navigation-tree";
import { CakeChatSummary } from "../../../src/renderer/models/CakeChatSummary";
import { Project } from "../../../src/renderer/models/Project";
import { createRendererStoreFixture } from "./renderer-store-fixture";
import { fixtureTimestamp, projectRecord, sessionSummary } from "./fixtures/catalog-fixtures";

const alpha = "/alpha";
const beta = "/beta";
const alphaChat = "project-chat:alpha";

function renderSessions(projectPath?: string, many = false) {
  const fixture = createRendererStoreFixture({
    projects: [
      projectRecord({ path: alpha, name: "Alpha" }),
      projectRecord({ path: beta, name: "Beta" }),
    ],
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
  fixture.root.navigationStore.selectCakeChat(CAKE_CHAT_SESSION_ID);
  fixture.root.workspaceNavigatorStore.show("sessions");
  const view = render(
    <StoreProvider store={fixture.root}>
      {projectPath === undefined ? (
        <WorkspaceNavigator />
      ) : (
        <ConversationNavigator projectPath={projectPath} />
      )}
    </StoreProvider>,
  );
  return {
    ...fixture,
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

describe("Global Cake Sessions scope", () => {
  it("lists every registered project's sessions, including projects without a home chat, with source identity and aggregate counts", () => {
    using fixture = renderSessions();
    expect(screen.getByText("Cake Chat")).toBeTruthy();
    expect(screen.getByText("Alpha", { selector: "span.block" })).toBeTruthy();
    expect(within(fixture.row("alpha-session")).getByTitle("Alpha")).toBeTruthy();
    expect(within(fixture.row("beta-session")).getByTitle("Beta")).toBeTruthy();
    expect(fixture.row("child").dataset.depth).toBe("2");
    expect(screen.queryByText("Unregistered project")).toBeNull();
    expect(screen.queryByText("Archived Alpha")).toBeNull();
    expect(screen.getByRole("button", { name: "Sessions · 1 running · 1 unread" }).title).toContain(
      "5 total in all projects",
    );
  });

  it("keeps Project Chat panels project-scoped and omits redundant source metadata", () => {
    using fixture = renderSessions(alpha);
    expect(fixture.row("alpha-session")).toBeTruthy();
    expect(fixture.row("child")).toBeTruthy();
    expect(screen.queryByText("Cake Chat")).toBeNull();
    expect(fixture.navigator.tree(alpha).byKey.has(conversationNavigationKey("beta-session"))).toBe(
      false,
    );
    expect(within(fixture.row("alpha-session")).queryByTitle("Alpha")).toBeNull();
    act(() => fixture.root.sidebarStore.sessionListStore.toggleResolvedGroupExpanded(alpha));
    expect(screen.getByText("Archived Alpha")).toBeTruthy();
    expect(screen.queryByText("Archived Beta")).toBeNull();
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
    expect(
      fixture.navigator
        .rows(undefined)
        .some(({ node }) => node.target.sessionId === "beta-session"),
    ).toBe(false);
    act(() => fixture.navigator.setQuery(undefined, ""));
    expect(screen.queryByText("Nested task")).toBeNull();
    act(() => fixture.root.sidebarStore.sessionListStore.toggleResolvedGroupExpanded("cake-chat"));
    const resolved = within(screen.getByRole("region", { name: "Resolved sessions" }));
    expect(resolved.getByText("Archived Alpha")).toBeTruthy();
    expect(resolved.getByText("Archived Beta")).toBeTruthy();
    expect(within(fixture.row("alpha-resolved")).getByTitle("Alpha")).toBeTruthy();
    act(() => fixture.navigator.setQuery(undefined, "Archived Beta"));
    expect(resolved.queryByText("Archived Alpha")).toBeNull();
    expect(resolved.getByText("Archived Beta")).toBeTruthy();
    expect(fixture.navigator.query(alpha)).toBe("");
  });

  it("paginates global project roots and resolved history independently and bypasses pagination for search", () => {
    using fixture = renderSessions(undefined, true);
    const betaRows = () =>
      fixture.navigator
        .rows(undefined)
        .filter(
          ({ node }) =>
            node.target.sessionId === "beta-session" || node.target.sessionId.startsWith("extra-"),
        );
    expect(betaRows()).toHaveLength(10);
    expect(fixture.navigator.hasMoreSessions(undefined)).toBe(true);
    act(() => fixture.navigator.showMoreSessions(undefined));
    expect(betaRows()).toHaveLength(20);
    act(() => fixture.navigator.setQuery(undefined, "extra-"));
    expect(betaRows()).toHaveLength(21);
    act(() => {
      fixture.navigator.setQuery(undefined, "");
      fixture.navigator.showMoreSessions(undefined);
    });
    expect(betaRows()).toHaveLength(22);
    expect(fixture.navigator.hasMoreSessions(undefined)).toBe(false);
    expect(fixture.root.sidebarStore.sessionListStore.sessionLimit(beta, true)).toBe(10);
    act(() => {
      fixture.root.sidebarStore.sessionListStore.toggleResolvedGroupExpanded("cake-chat");
      fixture.models.sessionCatalog.resolvedHasMoreByProject[beta] = true;
    });
    expect(fixture.navigator.hasMoreSessions(undefined, true)).toBe(true);
    act(() => fixture.navigator.showMoreSessions(undefined, true));
    expect(fixture.root.sidebarStore.sessionListStore.sessionLimit(beta, true)).toBe(20);
  });

  it("demands all-project metadata without loading transcripts, and resolved metadata follows the current scope's disclosure", () => {
    using fixture = renderSessions();
    const load = vi.spyOn(fixture.root.sessionRegistry, "load");
    const ids = (path?: string) =>
      fixture.navigator.metadataTargets(path).map((target) => target.sessionId);
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
    expect(ids(alpha)).not.toContain("beta-session");
    act(() => fixture.root.sidebarStore.sessionListStore.toggleResolvedGroupExpanded("cake-chat"));
    expect(ids()).toEqual(expect.arrayContaining(["alpha-resolved", "beta-resolved"]));
    expect(ids(alpha)).not.toContain("alpha-resolved");
    expect(load).not.toHaveBeenCalled();
    expect(fixture.models.projectConversations).toHaveLength(0);
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
      fixture.navigator
        .metadataTargets(undefined)
        .some((target) => target.sessionId === "beta-session"),
    ).toBe(false);
  });
});
