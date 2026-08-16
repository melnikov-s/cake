/**
 * @vitest-environment jsdom
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Sidebar } from "../../../src/renderer/app";
import type { ProjectWorkbenchStore } from "../../../src/renderer/stores/ProjectWorkbenchStore";

function sidebarProps(store: ProjectWorkbenchStore) {
  const fixture = store as unknown as Record<string, any>;
  return {
    store: {
      projectSessions: fixture.projectSessions,
      sessionLimit: fixture.sessionLimit,
      showMoreSessions: fixture.showMoreSessions,
      sessionActivity: fixture.sessionActivity,
      sessionDisplayTitle: fixture.sessionDisplayTitle
    } as any,
    projects: {
      recentProjectPaths: fixture.recentProjectPaths,
      projects: fixture.projects,
      nameFromPath: fixture.nameFromPath,
      nameForPath: (path: string) => fixture.projects.find((project: { path: string; name: string }) => project.path === path)?.name ?? fixture.nameFromPath(path)
    } as any,
    chat: store,
    cakeChat: { summaries: [], sessionId: undefined, findSession: vi.fn() } as any,
    reviews: { chatCommentCountForSession: fixture.chatReviewCommentCountForSession } as any,
    onOpenCakeChat: vi.fn(),
    onCreateCakeChat: vi.fn(),
    onOpenSession: fixture.openSession ?? vi.fn(),
    onCreateSession: fixture.startNewSession ?? vi.fn(),
    onStartOneOffChat: fixture.startOneOffChat ?? vi.fn(),
    onChooseProject: fixture.chooseProject ?? vi.fn(),
    selection: { kind: "workbench" } as const
  };
}

describe("Sidebar projects", () => {
  let container: HTMLDivElement;
  let root: Root;
  const sessionDisplayTitle = (title: string) => title.length > 40 ? `${title.slice(0, 39)}…` : title;

  beforeEach(() => {
    Object.assign(globalThis, {
      IS_REACT_ACT_ENVIRONMENT: true,
      requestAnimationFrame: (callback: FrameRequestCallback) => { callback(0); return 1; },
      cancelAnimationFrame: vi.fn()
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
      showMoreSessions: vi.fn()
    } as unknown as ProjectWorkbenchStore;

    act(() => root.render(<Sidebar {...sidebarProps(store)} onOpenSettings={vi.fn()} onToggle={vi.fn()} />));

    const projectToggle = container.querySelector<HTMLButtonElement>('[aria-label="Collapse Cake"]')!;
    expect(projectToggle.getAttribute("aria-expanded")).toBe("true");
    expect(container.textContent).toContain("Add project collapsing");

    act(() => projectToggle.click());
    expect(projectToggle.getAttribute("aria-expanded")).toBe("false");
    expect(projectToggle.getAttribute("aria-label")).toBe("Expand Cake");
    expect(container.textContent).not.toContain("Add project collapsing");

    act(() => projectToggle.click());
    expect(projectToggle.getAttribute("aria-expanded")).toBe("true");
    expect(container.textContent).toContain("Add project collapsing");
  });

  it("offers Pi reload from the Cake menu", () => {
    const reload = vi.fn();
    const store = {
      recentProjectPaths: [], projects: [], session: { sessionId: "session-1", piSettings: { reloadPending: false } },
      projectSessions: vi.fn(() => []), sessionLimit: vi.fn(() => 8), nameFromPath: vi.fn(() => "cake"), sessionActivity: vi.fn(), sessionDisplayTitle,
      chatReviewCommentCountForSession: vi.fn(() => 0), startOneOffChat: vi.fn(), chooseProject: vi.fn(), showMoreSessions: vi.fn()
    } as unknown as ProjectWorkbenchStore;
    act(() => root.render(<Sidebar {...sidebarProps(store)} onOpenSettings={vi.fn()} onToggle={vi.fn()} onReloadPi={reload} />));

    const menu = container.querySelector("details.brand-menu")!;
    act(() => menu.setAttribute("open", ""));
    act(() => container.querySelector<HTMLButtonElement>(".brand-dropdown button")!.click());

    expect(reload).toHaveBeenCalledOnce();
    expect(menu.hasAttribute("open")).toBe(false);
  });

  it("shows running and ready-unread indicators for sessions", () => {
    const store = {
      recentProjectPaths: ["/work/cake"],
      projectPath: "/work/cake",
      projects: [{ path: "/work/cake", name: "Cake" }],
      session: { sessionId: "running" },
      projectSessions: () => [
        { id: "running", title: "Still working" },
        { id: "ready", title: "Finished in background" }
      ],
      sessionLimit: () => 8,
      sessionActivity: (_path: string, id: string) => id === "running" ? "running" : "unread",
      sessionDisplayTitle,
      chatReviewCommentCountForSession: vi.fn(() => 0),
      nameFromPath: () => "cake",
      startOneOffChat: vi.fn(),
      chooseProject: vi.fn(),
      startNewSession: vi.fn(),
      switchProject: vi.fn(),
      openSession: vi.fn(),
      renameSession: vi.fn(),
      showMoreSessions: vi.fn()
    } as unknown as ProjectWorkbenchStore;

    act(() => root.render(<Sidebar {...sidebarProps(store)} onOpenSettings={vi.fn()} onToggle={vi.fn()} />));

    expect(container.querySelector('[data-session-id="running"] [aria-label="Running"]')).not.toBeNull();
    expect(container.querySelector('[data-session-id="ready"] [aria-label="Ready, unread"]')).not.toBeNull();
  });

  it("uses the canonical actionable-comment selector for session badges", () => {
    const store = {
      recentProjectPaths: ["/work/cake"], projectPath: "/work/cake", projects: [{ path: "/work/cake", name: "Cake" }], session: { sessionId: "pending" },
      projectSessions: () => [{ id: "pending", title: "Needs review" }, { id: "answered", title: "Already answered" }], sessionLimit: () => 8,
      sessionActivity: vi.fn(() => undefined), chatReviewCommentCountForSession: (_path: string, id: string) => id === "pending" ? 1 : 0,
      sessionDisplayTitle,
      nameFromPath: () => "cake", startOneOffChat: vi.fn(), chooseProject: vi.fn(), startNewSession: vi.fn(), switchProject: vi.fn(), openSession: vi.fn(), renameSession: vi.fn(), showMoreSessions: vi.fn()
    } as unknown as ProjectWorkbenchStore;

    act(() => root.render(<Sidebar {...sidebarProps(store)} onOpenSettings={vi.fn()} onToggle={vi.fn()} />));

    expect(container.querySelector('[data-session-id="pending"]')?.textContent).toContain("1 comment");
    expect(container.querySelector('[data-session-id="answered"]')?.textContent).not.toContain("comments");
  });

  it("starts a new session with the selected inactive project path", () => {
    const startNewSession = vi.fn();
    const switchProject = vi.fn();
    const store = {
      recentProjectPaths: ["/work/first", "/work/second"], projectPath: "/work/first",
      projects: [{ path: "/work/first", name: "First" }, { path: "/work/second", name: "Second" }], session: { sessionId: "session-1" },
      projectSessions: () => [], sessionLimit: () => 8, sessionActivity: vi.fn(() => undefined), chatReviewCommentCountForSession: vi.fn(() => 0),
      sessionDisplayTitle,
      nameFromPath: (path: string) => path.split("/").at(-1)!, startOneOffChat: vi.fn(), chooseProject: vi.fn(),
      startNewSession, switchProject, openSession: vi.fn(), renameSession: vi.fn(), showMoreSessions: vi.fn()
    } as unknown as ProjectWorkbenchStore;

    act(() => root.render(<Sidebar {...sidebarProps(store)} onOpenSettings={vi.fn()} onToggle={vi.fn()} />));
    act(() => container.querySelector<HTMLButtonElement>('[aria-label="New chat in second"]')!.click());

    expect(startNewSession).toHaveBeenCalledWith("/work/second");
    expect(switchProject).not.toHaveBeenCalled();
  });

  it("lists Cake Chat sessions and creates another without clearing history", () => {
    const store = {
      recentProjectPaths: [], projects: [], projectSessions: vi.fn(() => []), sessionLimit: vi.fn(() => 8),
      sessionActivity: vi.fn(), sessionDisplayTitle, chatReviewCommentCountForSession: vi.fn(() => 0), nameFromPath: vi.fn(() => "cake"),
      startOneOffChat: vi.fn(), chooseProject: vi.fn(), showMoreSessions: vi.fn()
    } as unknown as ProjectWorkbenchStore;
    const props = sidebarProps(store);
    props.cakeChat = { summaries: [{ id: "cake-chat-1", title: "Repair the sidebar" }], sessionId: "cake-chat-1", findSession: vi.fn() } as any;

    act(() => root.render(<Sidebar {...props} selection={{ kind: "cake-chat", sessionId: "cake-chat-1" }} onOpenSettings={vi.fn()} onToggle={vi.fn()} />));
    expect(container.querySelector(".brand-menu summary")?.textContent).toContain("🍰 Cake Chat");
    expect(container.querySelector(".sidebar input")).toBeNull();
    expect(container.textContent).toContain("Repair the sidebar");
    act(() => container.querySelector<HTMLButtonElement>('[aria-label="New Cake Chat"]')!.click());
    expect(props.onCreateCakeChat).toHaveBeenCalledOnce();
  });

  it("derives exactly one active chat from the application selection", () => {
    const store = {
      recentProjectPaths: ["/work/cake"], projectPath: "/work/cake", projects: [{ path: "/work/cake", name: "Cake" }],
      session: { sessionId: "project-session" }, projectSessions: () => [{ id: "project-session", title: "Project work" }], sessionLimit: () => 8,
      sessionActivity: vi.fn(), sessionDisplayTitle, chatReviewCommentCountForSession: vi.fn(() => 0), nameFromPath: vi.fn(() => "cake"),
      startOneOffChat: vi.fn(), chooseProject: vi.fn(), showMoreSessions: vi.fn(), renameSession: vi.fn()
    } as unknown as ProjectWorkbenchStore;
    const props = sidebarProps(store);
    props.cakeChat = { summaries: [{ id: "cake-session", title: "Meta work" }], sessionId: "cake-session", findSession: vi.fn() } as any;

    act(() => root.render(<Sidebar {...props} selection={{ kind: "cake-chat", sessionId: "cake-session" }} onOpenSettings={vi.fn()} onToggle={vi.fn()} />));

    expect(container.querySelectorAll(".session-item.active")).toHaveLength(1);
    expect(container.querySelector('[data-session-id="cake-session"]')?.classList).toContain("active");
    expect(container.querySelector('[data-session-id="project-session"]')?.classList).not.toContain("active");

    act(() => root.render(<Sidebar {...props} selection={{ kind: "project-session", workspacePath: "/work/cake", sessionId: "project-session" }} onOpenSettings={vi.fn()} onToggle={vi.fn()} />));

    expect(container.querySelectorAll(".session-item.active")).toHaveLength(1);
    expect(container.querySelector('[data-session-id="cake-session"]')?.classList).not.toContain("active");
    expect(container.querySelector('[data-session-id="project-session"]')?.classList).toContain("active");
  });

});
