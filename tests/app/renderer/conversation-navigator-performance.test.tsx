/** @vitest-environment jsdom */
import { Profiler, StrictMode } from "react";
import { flushSync } from "react-dom";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { batch, effect } from "r-state-tree";
import { StoreProvider } from "r-state-tree/react";
import { afterEach, expect, it, vi } from "vitest";
import { ConversationNavigatorRow } from "../../../src/renderer/components/conversation-navigator-row";
import { ConversationNavigator } from "../../../src/renderer/components/conversation-navigator";
import { conversationNavigationKey } from "../../../src/renderer/lib/conversation-navigation-tree";
import { ConversationBreadcrumb } from "../../../src/renderer/components/conversation-breadcrumb";
import { conversationNavigationLineage } from "../../../src/renderer/lib/conversation-navigation-tree";
import { ReviewThread } from "../../../src/renderer/models/ReviewThread";
import { createRendererStoreFixture } from "./renderer-store-fixture";
import { projectRecord, sessionSummary } from "./fixtures/catalog-fixtures";
import {
  navigatorProjectPath,
  navigatorSessions,
  populateConversationNavigationFixture,
} from "./fixtures/conversation-navigation-fixtures";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it("echoes Sessions search input before recursive filtering and only publishes the latest draft", () => {
  using fixture = createRendererStoreFixture({
    projects: [projectRecord({ path: "/project" })],
    sessions: Array.from({ length: 1000 }, (_, index) =>
      sessionSummary({ sessionId: `session-${index}`, projectPath: "/project" }),
    ),
  });
  const store = fixture.root.conversationNavigatorStore;
  const rows = vi.spyOn(store, "rows");
  const publish = vi.spyOn(store, "setQuery");
  render(
    <StrictMode>
      <StoreProvider store={fixture.root}>
        <ConversationNavigator projectPath="/project" />
      </StoreProvider>
    </StrictMode>,
  );
  const input = screen.getByRole<HTMLInputElement>("searchbox", { name: "Search sessions" });
  const initialRows = store.rows("/project").map(({ node }) => node.key);
  rows.mockClear();

  act(() => {
    for (const query of ["session-1", "no match", "session-999"]) {
      flushSync(() => fireEvent.change(input, { target: { value: query } }));
      expect(input.value).toBe(query);
      expect(store.query("/project")).toBe("");
      expect(rows).not.toHaveBeenCalled();
      expect(publish).not.toHaveBeenCalled();
    }
  });
  expect(publish.mock.calls).toEqual([["/project", "session-999"]]);
  expect(screen.getByRole("button", { name: /^session-999/ })).toBeTruthy();
  expect(screen.queryByRole("button", { name: /^session-998/ })).toBeNull();

  rows.mockClear();
  publish.mockClear();
  act(() => {
    flushSync(() => fireEvent.change(input, { target: { value: "obsolete" } }));
    flushSync(() => fireEvent.click(screen.getByRole("button", { name: "Clear search sessions" })));
    expect(input.value).toBe("");
    expect(document.activeElement).toBe(input);
    expect(rows).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });
  expect(publish.mock.calls).toEqual([["/project", ""]]);
  expect(store.query("/project")).toBe("");
  expect(store.rows("/project").map(({ node }) => node.key)).toEqual(initialRows);
});

it("cancels an uncommitted search draft on scope change and restores each scope's applied query", () => {
  using fixture = createRendererStoreFixture({
    projects: [projectRecord({ path: "/project" }), projectRecord({ path: "/other" })],
  });
  const store = fixture.root.conversationNavigatorStore;
  store.setQuery("/project", "remembered");
  store.setQuery("/other", "other query");
  const publish = vi.spyOn(store, "setQuery");
  const view = (projectPath: string | undefined) => (
    <StoreProvider store={fixture.root}>
      <ConversationNavigator projectPath={projectPath} />
    </StoreProvider>
  );
  const { rerender } = render(view("/project"));
  const input = () => screen.getByRole<HTMLInputElement>("searchbox", { name: "Search sessions" });
  expect(input().value).toBe("remembered");
  act(() => {
    flushSync(() => fireEvent.change(input(), { target: { value: "uncommitted" } }));
    flushSync(() => rerender(view("/other")));
  });
  expect(input().value).toBe("other query");
  expect(publish).not.toHaveBeenCalled();
  rerender(view("/project"));
  expect(input().value).toBe("remembered");
  rerender(view(undefined));
  expect(input().value).toBe("");
});

it("renders a title in a large retained catalog without building trees or rerendering for activity", () => {
  const projects = Array.from({ length: 20 }, (_, i) => projectRecord({ path: `/p${i}` }));
  const sessions = projects.flatMap((project, i) =>
    Array.from({ length: 50 }, (_, j) =>
      sessionSummary({ sessionId: `s${i}-${j}`, projectPath: project.path }),
    ),
  );
  using fixture = createRendererStoreFixture({ projects, sessions });
  batch(() => {
    for (const session of sessions)
      fixture.models.projectConversation(session.sessionId, session.projectPath);
  });
  const unrelated = ReviewThread.create({
    id: "unrelated",
    parentSessionId: "s0-0",
    sidecarSessionId: "unrelated-chat",
    status: "open",
    workingDirectory: "/p0",
  });
  fixture.models.discussionCatalog("s0-0").threads.push(unrelated);
  const navigator = fixture.root.conversationNavigatorStore;
  const tree = vi.spyOn(navigator, "tree");
  let commits = 0;
  const view = render(
    <StoreProvider store={fixture.root}>
      <Profiler id="breadcrumb" onRender={() => commits++}>
        <ConversationBreadcrumb sessionId="s19-49" />
      </Profiler>
    </StoreProvider>,
  );
  try {
    expect(screen.getByRole("button", { name: "s19-49" })).toBeTruthy();
    const before = commits;
    act(() => {
      unrelated.updatedAt = "2026-11-06T12:00:00.000Z";
      fixture.models.projectConversation("s19-49", "/p19").streaming = true;
      fixture.models.projectConversation("s0-0", "/p0").activeTurnIds.push("turn");
      fixture.models.sessionCatalog.find("s19-49")!.running = true;
    });
    expect(commits).toBe(before);
    expect(tree).not.toHaveBeenCalled();
    act(() => {
      fixture.models.sessionCatalog.find("s19-49")!.title = "Renamed session";
    });
    expect(screen.getByRole("button", { name: "Renamed session" })).toBeTruthy();
    expect(commits).toBeGreaterThan(before);
    expect(tree).not.toHaveBeenCalled();
  } finally {
    view.unmount();
    tree.mockRestore();
  }
});

it("reuses scoped trees and updates their activity without invalidating ownership labels", () => {
  using fixture = createRendererStoreFixture({
    projects: [projectRecord({ path: navigatorProjectPath }), projectRecord({ path: "/other" })],
    sessions: navigatorSessions,
  });
  populateConversationNavigationFixture(fixture.models);
  const unrelated = ReviewThread.create({
    id: "other-discussion",
    parentSessionId: "elsewhere",
    sidecarSessionId: "other-chat",
    status: "open",
    workingDirectory: "/other",
  });
  fixture.models.discussionCatalog("elsewhere").threads.push(unrelated);
  const navigator = fixture.root.conversationNavigatorStore;
  const tree = navigator.tree(navigatorProjectPath);
  expect(navigator.tree(navigatorProjectPath)).toBe(tree);
  unrelated.updatedAt = "later";
  fixture.models.subagentCatalog("elsewhere").activities[0]!.status = "complete";
  expect(navigator.tree(navigatorProjectPath)).toBe(tree);

  let labelUpdates = 0;
  const stop = effect(() => {
    navigator.lineageFor("deep-discussion-chat");
    labelUpdates++;
  });
  try {
    const worker = fixture.models.subagentCatalog("focus-chat").activities[0]!;
    batch(() => {
      worker.streaming = false;
      worker.status = "complete";
    });
    const updated = navigator.tree(navigatorProjectPath);
    expect(updated).toBe(tree);
    expect(navigator.ownedConversations("focus-chat")[1]?.running).toBe(false);
    expect(navigator.tree(navigatorProjectPath)).toBe(updated);
    expect(labelUpdates).toBe(1);
    fixture.models.discussionCatalog("focus-chat").threads[0]!.anchor = {
      ...fixture.models.discussionCatalog("focus-chat").threads[0]!.anchor,
      selectedText: "Renamed nested discussion",
    };
    expect(navigator.lineageFor("deep-discussion-chat").at(-1)?.title).toBe(
      "Renamed nested discussion",
    );
    expect(labelUpdates).toBe(2);
  } finally {
    stop();
  }
});

// Deterministic ownership parity protects the cheaper lookup across every supported node kind.
it("preserves home, family, nested discussion and worker ancestry as catalogs change", () => {
  using fixture = createRendererStoreFixture({
    projects: [projectRecord({ path: navigatorProjectPath }), projectRecord({ path: "/other" })],
    sessions: navigatorSessions,
  });
  populateConversationNavigationFixture(fixture.models);
  const navigator = fixture.root.conversationNavigatorStore;
  const assertAncestry = () => {
    for (const project of [undefined, navigatorProjectPath, "/other"]) {
      const tree = navigator.tree(project);
      for (const node of tree.byKey.values())
        expect(navigator.lineageForTarget(node.target)).toEqual(
          conversationNavigationLineage(tree, node.key).map(
            ({ key, title, relationship, target }) => ({ key, title, relationship, target }),
          ),
        );
    }
  };
  assertAncestry();
  const catalog = fixture.models.discussionCatalog("layout");
  const thread = catalog.threads[0]!;
  batch(() => {
    catalog.metadata.push({
      id: thread.id,
      parentSessionId: thread.parentSessionId,
      sidecarSessionId: thread.sidecarSessionId,
      workingDirectory: thread.workingDirectory,
      title: "Cold discussion title",
      running: false,
      status: "open",
      createdAt: thread.createdAt,
      updatedAt: thread.updatedAt,
    });
    catalog.metadataLoaded = true;
    catalog.threads.splice(0, catalog.threads.length);
    fixture.models
      .subagentCatalog("layout")
      .releasedHandleIds.push(fixture.models.subagentCatalog("layout").activities[0]!.handleId);
  });
  assertAncestry();
  const prior = navigator.lineageFor("widths-chat");
  let labels = 0;
  const stop = effect(() => {
    navigator.lineageFor("widths-chat");
    labels++;
  });
  try {
    catalog.metadata.splice(0, catalog.metadata.length, {
      ...catalog.metadata[0]!,
      running: true,
      updatedAt: "later",
    });
    expect(navigator.lineageFor("widths-chat")).toBe(prior);
    expect(labels).toBe(1);
    catalog.metadata.splice(0, catalog.metadata.length, {
      ...catalog.metadata[0]!,
      title: "Updated cold title",
    });
    expect(navigator.lineageFor("widths-chat").at(-1)?.title).toBe("Updated cold title");
    expect(labels).toBe(2);
  } finally {
    stop();
  }
  fixture.models.sessionCatalog.find("keyboard")!.familyParentSessionId = "icons";
  assertAncestry();
  fixture.models.sessionCatalog.find("icons")!.resolved = true;
  assertAncestry();
});

it("renders and updates a session row without flattening its project's session roster", () => {
  using fixture = createRendererStoreFixture({
    projects: [projectRecord({ path: "/project" })],
    sessions: Array.from({ length: 30 }, (_, index) =>
      sessionSummary({
        sessionId: `session-${index}`,
        projectPath: "/project",
      }),
    ),
  });
  const node = fixture.root.conversationNavigatorStore
    .tree("/project")
    .byKey.get(conversationNavigationKey("session-29"))!;
  const traverse = vi.spyOn(fixture.root.sidebarStore.sessionListStore, "projectSessions");
  const view = render(
    <StoreProvider store={fixture.root}>
      <ConversationNavigatorRow node={node} depth={1} projectPath="/project" />
    </StoreProvider>,
  );
  try {
    expect(screen.getByText("session-29", { exact: true })).toBeTruthy();
    expect(traverse).not.toHaveBeenCalled();
    act(() => {
      fixture.models.sessionCatalog.find("session-29")!.title = "Renamed row";
    });
    expect(screen.getByText("Renamed row", { exact: true })).toBeTruthy();
    expect(traverse).not.toHaveBeenCalled();
  } finally {
    view.unmount();
  }
});
