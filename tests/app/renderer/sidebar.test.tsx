/**
 * @vitest-environment jsdom
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Sidebar } from "../../../src/renderer/components/sidebar";
import type { ProjectWorkbenchStore } from "../../../src/renderer/stores/ProjectWorkbenchStore";

function sidebarProps(store: ProjectWorkbenchStore) {
  const fixture = store as unknown as Record<string, any>;
  return {
    store: {
      projectSessions: fixture.projectSessions,
      cakeChatSessions: (resolved = false) =>
        (fixture.cakeChatSummaries ?? []).filter(
          (session: { resolved?: boolean }) => Boolean(session.resolved) === resolved,
        ),
      hasResolvedSessions: fixture.hasResolvedSessions ?? false,
      sessionLimit: fixture.sessionLimit,
      showMoreSessions: fixture.showMoreSessions,
      setSessionResolved: fixture.setSessionResolved ?? vi.fn(),
      setCakeChatSessionResolved: fixture.setCakeChatSessionResolved ?? vi.fn(),
      deleteSession: fixture.deleteSession ?? vi.fn(),
      deleteCakeChatSession: fixture.deleteCakeChatSession ?? vi.fn(),
      setSessionUnread: fixture.setSessionUnread ?? vi.fn(),
      showSessionContextMenu: fixture.showSessionContextMenu ?? vi.fn(),
      resolvedLaneExpanded: fixture.resolvedLaneExpanded ?? true,
      toggleResolvedLane: fixture.toggleResolvedLane ?? vi.fn(),
      isGroupCollapsed: fixture.isGroupCollapsed ?? (() => false),
      toggleGroupCollapsed: fixture.toggleGroupCollapsed ?? vi.fn(),
      sessionActivity: fixture.sessionActivity,
      sessionActivityTime: fixture.sessionActivityTime ?? (() => ""),
    } as any,
    projects: {
      recentProjectPaths: fixture.recentProjectPaths,
      orderedProjectPaths: fixture.orderedProjectPaths ?? fixture.recentProjectPaths,
      projects: fixture.projects,
      nameFromPath: fixture.nameFromPath,
      nameForPath: (path: string) =>
        fixture.projects.find((project: { path: string; name: string }) => project.path === path)
          ?.name ?? fixture.nameFromPath(path),
    } as any,
    chat: store,
    cakeChat: {
      summaries: fixture.cakeChatSummaries ?? [],
      sessionId: undefined,
      findSession: vi.fn(),
      renameSession: fixture.renameCakeChatSession ?? vi.fn(),
    } as any,
    onOpenCakeChat: vi.fn(),
    onCreateCakeChat: vi.fn(),
    onOpenSession: fixture.openSession ?? vi.fn(),
    onCreateSession: fixture.startNewSession ?? vi.fn(),
    onChooseProject: fixture.chooseProject ?? vi.fn(),
    onGoBack: fixture.goBack ?? vi.fn(),
    onGoForward: fixture.goForward ?? vi.fn(),
    shell: { selection: { kind: "workbench" } } as any,
  };
}

describe("Sidebar projects", () => {
  let container: HTMLDivElement;
  let root: Root;
  const sessionDisplayTitle = (title: string) =>
    title.length > 40 ? `${title.slice(0, 39)}…` : title;

  beforeEach(() => {
    Object.assign(globalThis, {
      IS_REACT_ACT_ENVIRONMENT: true,
      requestAnimationFrame: (callback: FrameRequestCallback) => {
        callback(0);
        return 1;
      },
      cancelAnimationFrame: vi.fn(),
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("collapses and expands the sessions beneath an individual project", () => {
    const collapsedGroups = new Set<string>();
    const store = {
      recentProjectPaths: ["/work/cake"],
      projectPath: "/work/cake",
      projects: [{ path: "/work/cake", name: "Cake" }],
      session: { sessionId: "session-1" },
      isStreaming: false,
      sessionActivity: vi.fn(() => undefined),
      sessionDisplayTitle,
      chatReviewCommentCountForSession: vi.fn(() => 0),
      projectSessions: () => [{ id: "session-1", title: "Add project collapsing" }],
      sessionLimit: () => 8,
      nameFromPath: () => "cake",
      startOneOffChat: vi.fn(),
      chooseProject: vi.fn(),
      startNewSession: vi.fn(),
      switchProject: vi.fn(),
      openSession: vi.fn(),
      renameSession: vi.fn(),
      showMoreSessions: vi.fn(),
      isGroupCollapsed: (groupKey: string) => collapsedGroups.has(groupKey),
      toggleGroupCollapsed: (groupKey: string) => {
        if (collapsedGroups.has(groupKey)) collapsedGroups.delete(groupKey);
        else collapsedGroups.add(groupKey);
      },
    } as unknown as ProjectWorkbenchStore;
    const props = () => sidebarProps(store);

    act(() => root.render(<Sidebar {...props()} onOpenSettings={vi.fn()} onToggle={vi.fn()} />));

    const projectToggle = container.querySelector<HTMLButtonElement>(
      '[aria-label="Collapse Cake"]',
    )!;
    expect(projectToggle.getAttribute("aria-expanded")).toBe("true");
    expect(container.textContent).toContain("Add project collapsing");

    act(() => projectToggle.click());
    act(() => root.render(<Sidebar {...props()} onOpenSettings={vi.fn()} onToggle={vi.fn()} />));
    expect(projectToggle.getAttribute("aria-expanded")).toBe("false");
    expect(projectToggle.getAttribute("aria-label")).toBe("Expand Cake");
    expect(container.textContent).not.toContain("Add project collapsing");

    act(() => projectToggle.click());
    act(() => root.render(<Sidebar {...props()} onOpenSettings={vi.fn()} onToggle={vi.fn()} />));
    expect(projectToggle.getAttribute("aria-expanded")).toBe("true");
    expect(container.textContent).toContain("Add project collapsing");
  });

  it("shows running and ready-unread indicators for sessions", () => {
    const store = {
      recentProjectPaths: ["/work/cake"],
      projectPath: "/work/cake",
      projects: [{ path: "/work/cake", name: "Cake" }],
      session: { sessionId: "running" },
      projectSessions: () => [
        { id: "running", title: "Still working" },
        { id: "ready", title: "Finished in background" },
      ],
      sessionLimit: () => 8,
      sessionActivity: (id: string) => (id === "running" ? "running" : "unread"),
      sessionDisplayTitle,
      chatReviewCommentCountForSession: vi.fn(() => 0),
      nameFromPath: () => "cake",
      startOneOffChat: vi.fn(),
      chooseProject: vi.fn(),
      startNewSession: vi.fn(),
      switchProject: vi.fn(),
      openSession: vi.fn(),
      renameSession: vi.fn(),
      showMoreSessions: vi.fn(),
    } as unknown as ProjectWorkbenchStore;

    act(() =>
      root.render(<Sidebar {...sidebarProps(store)} onOpenSettings={vi.fn()} onToggle={vi.fn()} />),
    );

    expect(
      container.querySelector('[data-session-id="running"] [aria-label="Running"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-session-id="ready"] [aria-label="Ready, unread"]'),
    ).not.toBeNull();
  });

  it("hides time and resolve controls while a session is running or unread", () => {
    const modified = new Date(0).toISOString();
    const setSessionResolved = vi.fn();
    const store = {
      recentProjectPaths: ["/work/cake"],
      projects: [{ path: "/work/cake", name: "Cake" }],
      projectSessions: () => [
        { id: "running", title: "Still working", modified },
        { id: "ready", title: "Finished work", modified },
      ],
      sessionLimit: () => 8,
      sessionActivity: (id: string) =>
        id === "running" ? "running" : id === "ready" ? "unread" : undefined,
      sessionActivityTime: vi.fn(() => "Today"),
      nameFromPath: () => "cake",
      startOneOffChat: vi.fn(),
      chooseProject: vi.fn(),
      showMoreSessions: vi.fn(),
      renameSession: vi.fn(),
      setSessionResolved,
    } as unknown as ProjectWorkbenchStore;

    act(() =>
      root.render(
        <Sidebar
          {...sidebarProps(store)}
          shell={
            {
              selection: {
                kind: "project-session",
                workspacePath: "/work/cake",
                sessionId: "ready",
              },
            } as any
          }
          onOpenSettings={vi.fn()}
          onToggle={vi.fn()}
        />,
      ),
    );

    expect(
      container.querySelector('[data-session-id="running"] [aria-label="Running"]'),
    ).not.toBeNull();
    expect(container.querySelector('[data-session-id="running"] .session-time')).toBeNull();
    expect(container.querySelector('[data-session-id="ready"] .session-time')).toBeNull();
    expect(container.querySelector('[data-session-id="ready"] .session-resolve-action')).toBeNull();

    act(() =>
      root.render(
        <Sidebar
          {...sidebarProps(store)}
          shell={
            {
              selection: {
                kind: "project-session",
                workspacePath: "/work/cake",
                sessionId: "running",
              },
            } as any
          }
          onOpenSettings={vi.fn()}
          onToggle={vi.fn()}
        />,
      ),
    );
    expect(
      container.querySelector('[data-session-id="running"] .session-resolve-action'),
    ).toBeNull();
  });

  it("leaves long titles intact for CSS ellipsis and shows relative activity", () => {
    const title =
      "A session title that is deliberately much longer than the old forty character display limit";
    const modified = new Date("2026-08-16T12:00:00.000Z").toISOString();
    const store = {
      recentProjectPaths: ["/work/cake"],
      projects: [{ path: "/work/cake", name: "Cake" }],
      projectSessions: () => [
        {
          id: "session-1",
          title,
          modified,
          managedWorktree: { branch: "agent/feature", baseBranch: "main" },
        },
      ],
      sessionLimit: () => 8,
      sessionActivity: vi.fn(),
      sessionActivityTime: vi.fn(() => "20 min ago"),
      chatReviewCommentCountForSession: vi.fn(() => 0),
      nameFromPath: () => "cake",
      startOneOffChat: vi.fn(),
      chooseProject: vi.fn(),
      showMoreSessions: vi.fn(),
      renameSession: vi.fn(),
    } as unknown as ProjectWorkbenchStore;

    act(() =>
      root.render(<Sidebar {...sidebarProps(store)} onOpenSettings={vi.fn()} onToggle={vi.fn()} />),
    );

    expect(container.querySelector(".session-title")?.textContent).toBe(title);
    expect(container.querySelector(".session-time")?.textContent).toBe("20 min ago");
    expect(container.querySelector(".session-time")?.getAttribute("datetime")).toBe(modified);
    expect(container.querySelector(".session-row")?.textContent).toContain("feature·20 min ago");
    expect(container.querySelector(".session-row")?.textContent).not.toContain("→main");
  });

  it("uses GitHub-style open and merged colors only for managed worktrees", () => {
    const store = {
      recentProjectPaths: ["/work/cake"],
      projects: [{ path: "/work/cake", name: "Cake" }],
      projectSessions: () => [
        {
          id: "open",
          title: "Open worktree",
          modified: "2026-08-16T12:00:00.000Z",
          managedWorktree: { branch: "agent/open", baseBranch: "main", state: "active" },
        },
        {
          id: "merged",
          title: "Merged worktree",
          modified: "2026-08-16T11:00:00.000Z",
          managedWorktree: { branch: "agent/merged", baseBranch: "main", state: "landed" },
        },
        {
          id: "main",
          title: "Main checkout",
          modified: "2026-08-16T10:00:00.000Z",
        },
      ],
      sessionLimit: () => 8,
      sessionActivity: vi.fn(),
      sessionActivityTime: vi.fn(() => "Today"),
      nameFromPath: () => "cake",
      showMoreSessions: vi.fn(),
      renameSession: vi.fn(),
    } as unknown as ProjectWorkbenchStore;

    act(() =>
      root.render(<Sidebar {...sidebarProps(store)} onOpenSettings={vi.fn()} onToggle={vi.fn()} />),
    );

    const openIcon = container.querySelector('[data-worktree-state="active"]');
    const mergedIcon = container.querySelector('[data-worktree-state="landed"]');
    const mainIcon = container.querySelector('[data-session-id="main"] [role="img"]');
    expect(openIcon?.classList.contains("text-worktree-open")).toBe(true);
    expect(openIcon?.getAttribute("aria-label")).toBe("Open worktree");
    expect(mergedIcon?.classList.contains("text-worktree-merged")).toBe(true);
    expect(mergedIcon?.getAttribute("aria-label")).toBe("Merged worktree");
    expect(mainIcon).toBeNull();
  });

  it("does not surface sidecar chat work as parent-session badges", () => {
    const store = {
      recentProjectPaths: ["/work/cake"],
      projectPath: "/work/cake",
      projects: [{ path: "/work/cake", name: "Cake" }],
      session: { sessionId: "pending" },
      projectSessions: () => [
        { id: "pending", title: "Needs review" },
        { id: "answered", title: "Already answered" },
      ],
      sessionLimit: () => 8,
      sessionActivity: vi.fn(() => undefined),
      chatReviewCommentCountForSession: (_path: string, id: string) => (id === "pending" ? 1 : 0),
      sessionDisplayTitle,
      nameFromPath: () => "cake",
      startOneOffChat: vi.fn(),
      chooseProject: vi.fn(),
      startNewSession: vi.fn(),
      switchProject: vi.fn(),
      openSession: vi.fn(),
      renameSession: vi.fn(),
      showMoreSessions: vi.fn(),
    } as unknown as ProjectWorkbenchStore;

    act(() =>
      root.render(<Sidebar {...sidebarProps(store)} onOpenSettings={vi.fn()} onToggle={vi.fn()} />),
    );

    expect(container.querySelector('[data-session-id="pending"]')?.textContent).not.toContain(
      "comment",
    );
    expect(container.querySelector('[data-session-id="answered"]')?.textContent).not.toContain(
      "comments",
    );
  });

  it("starts a new session with the selected inactive project path", () => {
    const startNewSession = vi.fn();
    const switchProject = vi.fn();
    const store = {
      recentProjectPaths: ["/work/first", "/work/second"],
      projectPath: "/work/first",
      projects: [
        { path: "/work/first", name: "First" },
        { path: "/work/second", name: "Second" },
      ],
      session: { sessionId: "session-1" },
      projectSessions: () => [],
      sessionLimit: () => 8,
      sessionActivity: vi.fn(() => undefined),
      chatReviewCommentCountForSession: vi.fn(() => 0),
      sessionDisplayTitle,
      nameFromPath: (path: string) => path.split("/").at(-1)!,
      startOneOffChat: vi.fn(),
      chooseProject: vi.fn(),
      startNewSession,
      switchProject,
      openSession: vi.fn(),
      renameSession: vi.fn(),
      showMoreSessions: vi.fn(),
    } as unknown as ProjectWorkbenchStore;

    act(() =>
      root.render(<Sidebar {...sidebarProps(store)} onOpenSettings={vi.fn()} onToggle={vi.fn()} />),
    );
    act(() =>
      container.querySelector<HTMLButtonElement>('[aria-label="New chat in second"]')!.click(),
    );

    expect(startNewSession).toHaveBeenCalledWith("/work/second");
    expect(switchProject).not.toHaveBeenCalled();
  });

  it("starts the same new session flow from the project folder", () => {
    const startNewSession = vi.fn();
    const store = {
      recentProjectPaths: ["/work/cake"],
      projects: [{ path: "/work/cake", name: "Cake" }],
      projectSessions: () => [],
      sessionLimit: () => 8,
      sessionActivity: vi.fn(),
      nameFromPath: () => "cake",
      startNewSession,
      showMoreSessions: vi.fn(),
    } as unknown as ProjectWorkbenchStore;
    const props = sidebarProps(store);
    act(() => root.render(<Sidebar {...props} onOpenSettings={vi.fn()} onToggle={vi.fn()} />));

    act(() =>
      container.querySelector<HTMLButtonElement>('[aria-label="Start new chat in cake"]')!.click(),
    );

    expect(startNewSession).toHaveBeenCalledWith("/work/cake");
  });

  it("lists Cake Chat sessions and creates another without clearing history", () => {
    const store = {
      recentProjectPaths: [],
      projects: [],
      projectSessions: vi.fn(() => []),
      sessionLimit: vi.fn(() => 8),
      sessionActivity: vi.fn(),
      sessionDisplayTitle,
      chatReviewCommentCountForSession: vi.fn(() => 0),
      nameFromPath: vi.fn(() => "cake"),
      startOneOffChat: vi.fn(),
      chooseProject: vi.fn(),
      showMoreSessions: vi.fn(),
      cakeChatSummaries: [
        {
          id: "cake-chat-1",
          title: "Repair the sidebar",
          modified: new Date(0).toISOString(),
          resolved: false,
        },
      ],
    } as unknown as ProjectWorkbenchStore;
    const props = sidebarProps(store);
    props.cakeChat = {
      summaries: [{ id: "cake-chat-1", title: "Repair the sidebar" }],
      sessionId: "cake-chat-1",
      findSession: vi.fn(),
    } as any;

    act(() =>
      root.render(
        <Sidebar
          {...props}
          shell={{ selection: { kind: "cake-chat", sessionId: "cake-chat-1" } } as any}
          onOpenSettings={vi.fn()}
          onToggle={vi.fn()}
        />,
      ),
    );
    expect(container.querySelector(".sidebar input")).toBeNull();
    expect(container.textContent).toContain("Repair the sidebar");
    act(() => container.querySelector<HTMLButtonElement>('[aria-label="New Cake Chat"]')!.click());
    expect(props.onCreateCakeChat).toHaveBeenCalledOnce();
  });

  it("places Cake Chat above Projects and repeats it in Resolved", () => {
    const store = {
      recentProjectPaths: ["/work/empty"],
      projects: [{ path: "/work/empty", name: "Empty" }],
      projectSessions: (_path: string, resolved = false) =>
        resolved
          ? [
              {
                id: "resolved-project",
                title: "Finished work",
                managedWorktree: { branch: "agent/resolved-feature", baseBranch: "main" },
              },
            ]
          : [],
      sessionLimit: vi.fn(() => 8),
      sessionActivity: vi.fn(),
      sessionActivityTime: vi.fn(() => "Today"),
      nameFromPath: () => "empty",
      showMoreSessions: vi.fn(),
      hasResolvedSessions: true,
      cakeChatSummaries: [
        {
          id: "active-cake",
          title: "Current Cake Chat",
          modified: new Date(0).toISOString(),
          resolved: false,
        },
        {
          id: "resolved-cake",
          title: "Finished Cake Chat",
          modified: new Date(0).toISOString(),
          resolved: true,
        },
      ],
    } as unknown as ProjectWorkbenchStore;
    const props = sidebarProps(store);

    act(() => root.render(<Sidebar {...props} onOpenSettings={vi.fn()} onToggle={vi.fn()} />));

    const activeCakeGroup = container.querySelector<HTMLElement>(
      ".sidebar-scroll > .cake-chat-sessions",
    );
    const projectsHeading = container.querySelector<HTMLElement>(".projects-heading");
    expect(activeCakeGroup?.nextElementSibling).toBe(projectsHeading);
    expect(activeCakeGroup?.querySelector(".project-label")?.textContent).toBe("Cake Chat");
    expect(activeCakeGroup?.querySelector(".project-label svg")?.getAttribute("width")).toBe("16");

    const resolvedCakeGroup = container.querySelector<HTMLElement>(
      ".resolved-lane .cake-chat-sessions",
    );
    expect(resolvedCakeGroup?.querySelector(".project-label")?.textContent).toBe("Cake Chat");
    expect(resolvedCakeGroup?.textContent).toContain("Finished Cake Chat");
    expect(
      container.querySelector('[data-session-id="resolved-project"] .session-row')?.textContent,
    ).toContain("resolved-feature");

    const emptyProject = container.querySelector<HTMLElement>(
      ".project-group:not(.cake-chat-sessions)",
    );
    expect(emptyProject?.classList).toContain("project-group-empty");
    expect(emptyProject?.querySelector(".project-disclosure")?.classList).toContain("no-sessions");
  });

  it("navigates session history from the window tools when steps are available", () => {
    const goBack = vi.fn();
    const goForward = vi.fn();
    const store = {
      recentProjectPaths: ["/work/cake"],
      projects: [{ path: "/work/cake", name: "Cake" }],
      projectSessions: () => [{ id: "session-1", title: "History work" }],
      sessionLimit: () => 8,
      sessionActivity: vi.fn(),
      sessionDisplayTitle,
      nameFromPath: () => "cake",
      showMoreSessions: vi.fn(),
      goBack,
      goForward,
    } as unknown as ProjectWorkbenchStore;
    const props = () =>
      sidebarProps({
        ...store,
        goBack,
        goForward,
      } as unknown as ProjectWorkbenchStore);

    const render = (canGoBack: boolean, canGoForward: boolean) =>
      act(() =>
        root.render(
          <Sidebar
            {...props()}
            shell={
              {
                selection: {
                  kind: "project-session",
                  workspacePath: "/work/cake",
                  sessionId: "session-1",
                },
                canGoBack,
                canGoForward,
              } as any
            }
            onOpenSettings={vi.fn()}
            onToggle={vi.fn()}
          />,
        ),
      );

    render(false, false);
    const back = container.querySelector<HTMLButtonElement>(
      '[aria-label="Go back in session history"]',
    )!;
    const forward = container.querySelector<HTMLButtonElement>(
      '[aria-label="Go forward in session history"]',
    )!;
    expect(back.disabled).toBe(true);
    expect(forward.disabled).toBe(true);

    render(true, true);
    expect(back.disabled).toBe(false);
    expect(forward.disabled).toBe(false);
    act(() => back.click());
    expect(goBack).toHaveBeenCalledOnce();
    act(() => forward.click());
    expect(goForward).toHaveBeenCalledOnce();
  });

  it("derives exactly one active chat from the application selection", () => {
    const store = {
      recentProjectPaths: ["/work/cake"],
      projectPath: "/work/cake",
      projects: [{ path: "/work/cake", name: "Cake" }],
      session: { sessionId: "project-session" },
      projectSessions: () => [{ id: "project-session", title: "Project work" }],
      sessionLimit: () => 8,
      sessionActivity: vi.fn(),
      sessionDisplayTitle,
      chatReviewCommentCountForSession: vi.fn(() => 0),
      nameFromPath: vi.fn(() => "cake"),
      startOneOffChat: vi.fn(),
      chooseProject: vi.fn(),
      showMoreSessions: vi.fn(),
      renameSession: vi.fn(),
      cakeChatSummaries: [
        {
          id: "cake-session",
          title: "Meta work",
          modified: new Date(0).toISOString(),
          resolved: false,
        },
      ],
    } as unknown as ProjectWorkbenchStore;
    const props = sidebarProps(store);
    props.cakeChat = {
      summaries: [{ id: "cake-session", title: "Meta work" }],
      sessionId: "cake-session",
      findSession: vi.fn(),
    } as any;

    act(() =>
      root.render(
        <Sidebar
          {...props}
          shell={{ selection: { kind: "cake-chat", sessionId: "cake-session" } } as any}
          onOpenSettings={vi.fn()}
          onToggle={vi.fn()}
        />,
      ),
    );

    expect(container.querySelectorAll(".session-item.active")).toHaveLength(1);
    expect(container.querySelector('[data-session-id="cake-session"]')?.classList).toContain(
      "active",
    );
    expect(container.querySelector('[data-session-id="project-session"]')?.classList).not.toContain(
      "active",
    );
    expect(container.querySelector('[data-session-id="project-session"]')?.textContent).toContain(
      "main",
    );
    expect(container.querySelector('[data-session-id="cake-session"]')?.textContent).not.toContain(
      "main",
    );

    act(() =>
      root.render(
        <Sidebar
          {...props}
          shell={
            {
              selection: {
                kind: "project-session",
                workspacePath: "/work/cake",
                sessionId: "project-session",
              },
            } as any
          }
          onOpenSettings={vi.fn()}
          onToggle={vi.fn()}
        />,
      ),
    );

    expect(container.querySelectorAll(".session-item.active")).toHaveLength(1);
    expect(container.querySelector('[data-session-id="cake-session"]')?.classList).not.toContain(
      "active",
    );
    expect(container.querySelector('[data-session-id="project-session"]')?.classList).toContain(
      "active",
    );
  });

  it("omits the resolved lane until at least one session is resolved", () => {
    const store = {
      recentProjectPaths: ["/work/cake"],
      projects: [{ path: "/work/cake", name: "Cake" }],
      projectSessions: (_path: string, resolved = false) =>
        resolved
          ? []
          : [{ id: "active", title: "Current work", modified: new Date(0).toISOString() }],
      sessionLimit: () => 8,
      sessionActivity: vi.fn(),
      sessionActivityTime: vi.fn(() => "Today"),
      nameFromPath: () => "cake",
      startOneOffChat: vi.fn(),
      chooseProject: vi.fn(),
      showMoreSessions: vi.fn(),
      renameSession: vi.fn(),
      hasResolvedSessions: false,
    } as unknown as ProjectWorkbenchStore;

    act(() =>
      root.render(<Sidebar {...sidebarProps(store)} onOpenSettings={vi.fn()} onToggle={vi.fn()} />),
    );

    expect(container.querySelector(".resolved-lane")).toBeNull();
    expect(container.textContent).not.toContain("Resolved");
  });

  it("collapses the resolved lane by default and expands it on request", () => {
    let resolvedLaneExpanded = false;
    const toggleResolvedLane = vi.fn(() => {
      resolvedLaneExpanded = !resolvedLaneExpanded;
    });
    const store = {
      recentProjectPaths: ["/work/cake"],
      projects: [{ path: "/work/cake", name: "Cake" }],
      projectSessions: (_path: string, resolved = false) =>
        resolved
          ? [{ id: "resolved", title: "Finished work", modified: new Date(0).toISOString() }]
          : [],
      sessionLimit: () => 8,
      sessionActivity: vi.fn(),
      sessionActivityTime: vi.fn(() => "Today"),
      nameFromPath: () => "cake",
      startOneOffChat: vi.fn(),
      chooseProject: vi.fn(),
      showMoreSessions: vi.fn(),
      renameSession: vi.fn(),
      hasResolvedSessions: true,
      resolvedLaneExpanded,
      toggleResolvedLane,
    } as unknown as ProjectWorkbenchStore;
    const props = () =>
      sidebarProps({
        ...store,
        resolvedLaneExpanded,
        toggleResolvedLane,
      } as unknown as ProjectWorkbenchStore);

    act(() => root.render(<Sidebar {...props()} onOpenSettings={vi.fn()} onToggle={vi.fn()} />));

    expect(container.textContent).not.toContain("Active");
    expect(container.textContent).not.toContain("Cake Chats");
    const toggle = container.querySelector<HTMLButtonElement>('[aria-label="Expand Resolved"]')!;
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector("#resolved-lane-content")).toBeNull();

    act(() => toggle.click());
    expect(toggleResolvedLane).toHaveBeenCalledOnce();
    act(() => root.render(<Sidebar {...props()} onOpenSettings={vi.fn()} onToggle={vi.fn()} />));
    expect(
      container.querySelector('[aria-label="Collapse Resolved"]')?.getAttribute("aria-expanded"),
    ).toBe("true");
    expect(container.querySelector("#resolved-lane-content")).not.toBeNull();
  });

  it("moves the selected project session through resolve and restore actions", () => {
    const setSessionResolved = vi.fn();
    const modified = new Date(0).toISOString();
    const store = {
      recentProjectPaths: ["/work/cake"],
      projects: [{ path: "/work/cake", name: "Cake" }],
      projectSessions: (_path: string, resolved = false) =>
        resolved
          ? [{ id: "resolved", title: "Finished work", modified }]
          : [{ id: "active", title: "Current work", modified }],
      sessionLimit: () => 8,
      sessionActivity: vi.fn(),
      sessionActivityTime: vi.fn(() => "Today"),
      nameFromPath: () => "cake",
      startOneOffChat: vi.fn(),
      chooseProject: vi.fn(),
      showMoreSessions: vi.fn(),
      renameSession: vi.fn(),
      hasResolvedSessions: true,
      setSessionResolved,
    } as unknown as ProjectWorkbenchStore;
    const props = sidebarProps(store);

    act(() =>
      root.render(
        <Sidebar
          {...props}
          shell={
            {
              selection: {
                kind: "project-session",
                workspacePath: "/work/cake",
                sessionId: "active",
              },
            } as any
          }
          onOpenSettings={vi.fn()}
          onToggle={vi.fn()}
        />,
      ),
    );
    const resolve = container.querySelector<HTMLButtonElement>(
      '[aria-label="Resolve Current work"]',
    )!;
    expect(resolve).not.toBeNull();
    expect(container.querySelector('[data-session-id="active"] .session-time')).not.toBeNull();
    act(() => resolve.click());
    expect(setSessionResolved).toHaveBeenCalledWith("active", true);

    act(() =>
      root.render(
        <Sidebar
          {...props}
          shell={
            {
              selection: {
                kind: "project-session",
                workspacePath: "/work/cake",
                sessionId: "resolved",
              },
            } as any
          }
          onOpenSettings={vi.fn()}
          onToggle={vi.fn()}
        />,
      ),
    );
    const restore = container.querySelector<HTMLButtonElement>(
      '[aria-label="Restore Finished work"]',
    )!;
    act(() => restore.click());
    expect(setSessionResolved).toHaveBeenLastCalledWith("resolved", false);
  });

  it("offers resolve on non-selected sessions without opening them", () => {
    const setSessionResolved = vi.fn();
    const openSession = vi.fn();
    const store = {
      recentProjectPaths: ["/work/cake"],
      projects: [{ path: "/work/cake", name: "Cake" }],
      projectSessions: () => [
        { id: "other", title: "Other work" },
        { id: "selected", title: "Current work" },
      ],
      sessionLimit: () => 8,
      sessionActivity: vi.fn(() => undefined),
      sessionActivityTime: vi.fn(() => "Today"),
      chatReviewCommentCountForSession: vi.fn(() => 0),
      nameFromPath: () => "cake",
      startOneOffChat: vi.fn(),
      chooseProject: vi.fn(),
      openSession,
      renameSession: vi.fn(),
      showMoreSessions: vi.fn(),
      setSessionResolved,
    } as unknown as ProjectWorkbenchStore;

    act(() =>
      root.render(
        <Sidebar
          {...sidebarProps(store)}
          shell={
            {
              selection: {
                kind: "project-session",
                workspacePath: "/work/cake",
                sessionId: "selected",
              },
            } as any
          }
          onOpenSettings={vi.fn()}
          onToggle={vi.fn()}
        />,
      ),
    );

    const otherResolve = container.querySelector<HTMLButtonElement>(
      '[data-session-id="other"] .session-resolve-action',
    )!;
    expect(otherResolve).not.toBeNull();
    expect(container.querySelector('[data-session-id="other"] .session-time')).not.toBeNull();
    expect(container.querySelector('[data-session-id="selected"] .session-time')).not.toBeNull();

    act(() => {
      otherResolve.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(setSessionResolved).toHaveBeenCalledWith("other", true);
    expect(openSession).not.toHaveBeenCalled();
  });

  it("opens the native session menu and begins renaming its selected action", async () => {
    const showSessionContextMenu = vi.fn(async () => "rename" as const);
    const store = {
      recentProjectPaths: ["/work/cake"],
      projects: [{ path: "/work/cake", name: "Cake" }],
      projectSessions: () => [
        { id: "session-1", title: "Original title", modified: new Date(0).toISOString() },
      ],
      sessionLimit: () => 8,
      sessionActivity: vi.fn(),
      sessionActivityTime: vi.fn(() => "Today"),
      nameFromPath: () => "cake",
      showMoreSessions: vi.fn(),
      showSessionContextMenu,
    } as unknown as ProjectWorkbenchStore;

    act(() =>
      root.render(<Sidebar {...sidebarProps(store)} onOpenSettings={vi.fn()} onToggle={vi.fn()} />),
    );
    await act(async () => {
      container.querySelector<HTMLButtonElement>(".session-row")!.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          clientX: 12,
          clientY: 34,
        }),
      );
      await Promise.resolve();
    });

    expect(showSessionContextMenu).toHaveBeenCalledWith("session-1", 12, 34, false, false);
    expect(container.querySelector<HTMLInputElement>('[aria-label="Session name"]')?.value).toBe(
      "Original title",
    );
    expect(container.querySelector('[role="menu"]')).toBeNull();
  });

  it("marks a project session unread from the native session menu", async () => {
    const showSessionContextMenu = vi.fn(async () => "mark-unread" as const);
    const setSessionUnread = vi.fn();
    const store = {
      recentProjectPaths: ["/work/cake"],
      projects: [{ path: "/work/cake", name: "Cake" }],
      projectSessions: () => [
        { id: "session-1", title: "Follow up", modified: new Date(0).toISOString() },
      ],
      sessionLimit: () => 8,
      sessionActivity: vi.fn(),
      sessionActivityTime: vi.fn(() => "Today"),
      nameFromPath: () => "cake",
      showMoreSessions: vi.fn(),
      showSessionContextMenu,
      setSessionUnread,
    } as unknown as ProjectWorkbenchStore;

    act(() =>
      root.render(<Sidebar {...sidebarProps(store)} onOpenSettings={vi.fn()} onToggle={vi.fn()} />),
    );
    await act(async () => {
      container.querySelector<HTMLButtonElement>(".session-row")!.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          clientX: 12,
          clientY: 34,
        }),
      );
      await Promise.resolve();
    });

    expect(showSessionContextMenu).toHaveBeenCalledWith("session-1", 12, 34, false, false);
    expect(setSessionUnread).toHaveBeenCalledWith("session-1", true);
  });

  it("does not offer a mark-read action for an unread session", async () => {
    const showSessionContextMenu = vi.fn(async () => undefined);
    const setSessionUnread = vi.fn();
    const store = {
      recentProjectPaths: ["/work/cake"],
      projects: [{ path: "/work/cake", name: "Cake" }],
      projectSessions: () => [
        { id: "session-1", title: "Follow up", modified: new Date(0).toISOString() },
      ],
      sessionLimit: () => 8,
      sessionActivity: vi.fn(() => "unread"),
      sessionActivityTime: vi.fn(() => "Today"),
      nameFromPath: () => "cake",
      showMoreSessions: vi.fn(),
      showSessionContextMenu,
      setSessionUnread,
    } as unknown as ProjectWorkbenchStore;

    act(() =>
      root.render(<Sidebar {...sidebarProps(store)} onOpenSettings={vi.fn()} onToggle={vi.fn()} />),
    );
    await act(async () => {
      container.querySelector<HTMLButtonElement>(".session-row")!.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          clientX: 12,
          clientY: 34,
        }),
      );
      await Promise.resolve();
    });

    expect(showSessionContextMenu).toHaveBeenCalledWith("session-1", 12, 34, false, true);
    expect(setSessionUnread).not.toHaveBeenCalled();
  });

  it("deletes a resolved project session from its native menu", async () => {
    const showSessionContextMenu = vi.fn(async () => "delete" as const);
    const deleteSession = vi.fn();
    const store = {
      recentProjectPaths: ["/work/cake"],
      projects: [{ path: "/work/cake", name: "Cake" }],
      projectSessions: (_path: string, resolved: boolean) =>
        resolved ? [{ id: "session-1", title: "Done", modified: new Date(0).toISOString() }] : [],
      hasResolvedSessions: true,
      sessionLimit: () => 8,
      sessionActivity: vi.fn(),
      sessionActivityTime: vi.fn(() => "Today"),
      nameFromPath: () => "cake",
      showMoreSessions: vi.fn(),
      showSessionContextMenu,
      deleteSession,
    } as unknown as ProjectWorkbenchStore;

    act(() =>
      root.render(<Sidebar {...sidebarProps(store)} onOpenSettings={vi.fn()} onToggle={vi.fn()} />),
    );
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-session-id="session-1"] .session-row')!
        .dispatchEvent(
          new MouseEvent("contextmenu", {
            bubbles: true,
            cancelable: true,
            clientX: 9,
            clientY: 18,
          }),
        );
      await Promise.resolve();
    });

    expect(showSessionContextMenu).toHaveBeenCalledWith("session-1", 9, 18, true, false);
    expect(deleteSession).toHaveBeenCalledWith("session-1");
  });

  it("opens the native session menu and renames a Cake Chat", async () => {
    const showSessionContextMenu = vi.fn(async () => "rename" as const);
    const renameCakeChatSession = vi.fn(async () => true);
    const store = {
      recentProjectPaths: [],
      projects: [],
      projectSessions: vi.fn(() => []),
      sessionLimit: () => 8,
      sessionActivity: vi.fn(),
      sessionActivityTime: vi.fn(() => "Today"),
      nameFromPath: () => "cake",
      showMoreSessions: vi.fn(),
      cakeChatSummaries: [
        {
          id: "cake-chat-1",
          title: "Original Cake Chat",
          modified: new Date(0).toISOString(),
          resolved: false,
        },
      ],
      showSessionContextMenu,
      renameCakeChatSession,
    } as unknown as ProjectWorkbenchStore;

    act(() =>
      root.render(<Sidebar {...sidebarProps(store)} onOpenSettings={vi.fn()} onToggle={vi.fn()} />),
    );
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-session-id="cake-chat-1"] .session-row')!
        .dispatchEvent(
          new MouseEvent("contextmenu", {
            bubbles: true,
            cancelable: true,
            clientX: 21,
            clientY: 43,
          }),
        );
      await Promise.resolve();
    });

    expect(showSessionContextMenu).toHaveBeenCalledWith("cake-chat-1", 21, 43, false, undefined);
    const input = container.querySelector<HTMLInputElement>('[aria-label="Session name"]')!;
    expect(input.value).toBe("Original Cake Chat");
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
        input,
        "Renamed Cake Chat",
      );
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));
    });
    expect(renameCakeChatSession).toHaveBeenCalledWith("cake-chat-1", "Renamed Cake Chat");
  });

  it("does not offer resolve or time for unread completed sessions", () => {
    const setSessionResolved = vi.fn();
    const store = {
      recentProjectPaths: ["/work/cake"],
      projects: [{ path: "/work/cake", name: "Cake" }],
      projectSessions: () => [
        { id: "unread", title: "Finished in background", modified: new Date(0).toISOString() },
      ],
      sessionLimit: () => 8,
      sessionActivity: () => "unread",
      sessionActivityTime: () => "Today",
      nameFromPath: () => "cake",
      showMoreSessions: vi.fn(),
      renameSession: vi.fn(),
      setSessionResolved,
    } as unknown as ProjectWorkbenchStore;

    act(() =>
      root.render(<Sidebar {...sidebarProps(store)} onOpenSettings={vi.fn()} onToggle={vi.fn()} />),
    );

    expect(
      container.querySelector('[data-session-id="unread"] [aria-label="Ready, unread"]'),
    ).not.toBeNull();
    expect(container.querySelector('[data-session-id="unread"] .session-time')).toBeNull();
    expect(
      container.querySelector('[data-session-id="unread"] .session-resolve-action'),
    ).toBeNull();
  });

  it("resolves selected Cake Chat into the shared resolved lane", () => {
    const setCakeChatSessionResolved = vi.fn();
    const modified = new Date(0).toISOString();
    const store = {
      recentProjectPaths: [],
      projects: [],
      projectSessions: vi.fn(() => []),
      sessionLimit: () => 8,
      sessionActivity: vi.fn(),
      sessionActivityTime: vi.fn(() => "Today"),
      nameFromPath: () => "cake",
      startOneOffChat: vi.fn(),
      chooseProject: vi.fn(),
      showMoreSessions: vi.fn(),
      hasResolvedSessions: true,
      cakeChatSummaries: [
        { id: "active-cake", title: "Active Cake Chat", modified, resolved: false },
        { id: "resolved-cake", title: "Resolved Cake Chat", modified, resolved: true },
      ],
      setCakeChatSessionResolved,
    } as unknown as ProjectWorkbenchStore;
    const props = sidebarProps(store);

    act(() =>
      root.render(
        <Sidebar
          {...props}
          shell={{ selection: { kind: "cake-chat", sessionId: "active-cake" } } as any}
          onOpenSettings={vi.fn()}
          onToggle={vi.fn()}
        />,
      ),
    );
    act(() =>
      container
        .querySelector<HTMLButtonElement>('[aria-label="Resolve Active Cake Chat"]')!
        .click(),
    );
    expect(setCakeChatSessionResolved).toHaveBeenCalledWith("active-cake", true);
    expect(container.querySelector(".resolved-lane")?.textContent).toContain("Resolved Cake Chat");
  });
});
