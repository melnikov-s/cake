/**
 * @vitest-environment jsdom
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Sidebar } from "../../../src/renderer/app";
import type { MainChatStore } from "../../../src/renderer/stores/MainChatStore";

function sidebarProps(store: MainChatStore) {
  const legacy = store as unknown as Record<string, any>;
  return {
    store: {
      get search() { return legacy.sessionSearch; },
      set search(value) { legacy.sessionSearch = value; },
      recentProjectPaths: legacy.recentProjectPaths,
      projects: legacy.projects,
      searchedSessions: legacy.searchedSessions,
      projectSessions: legacy.projectSessions,
      sessionLimit: legacy.sessionLimit,
      showMoreSessions: legacy.showMoreSessions,
      nameFromPath: legacy.nameFromPath,
      sessionActivity: legacy.sessionActivity,
      sessionDisplayTitle: legacy.sessionDisplayTitle
    } as any,
    chat: store,
    reviews: { chatCommentCountForSession: legacy.chatReviewCommentCountForSession } as any
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
      sessionSearch: "",
      recentProjectPaths: ["/work/cake"],
      projectPath: "/work/cake",
      projects: [{ path: "/work/cake", name: "Cake" }],
      session: { sessionId: "session-1" },
      isStreaming: false,
      sessionActivity: vi.fn(() => undefined),
      sessionDisplayTitle,
      chatReviewCommentCountForSession: vi.fn(() => 0),
      searchedSessions: [],
      projectSessions: () => [{ id: "session-1", title: "Add project collapsing" }],
      sessionLimit: () => 8,
      nameFromPath: () => "cake",
      setSessionSearch: vi.fn(),
      startOneOffChat: vi.fn(),
      chooseProject: vi.fn(),
      startNewSession: vi.fn(),
      switchProject: vi.fn(),
      openSession: vi.fn(),
      renameSession: vi.fn(),
      showMoreSessions: vi.fn()
    } as unknown as MainChatStore;

    act(() => root.render(<Sidebar {...sidebarProps(store)} onOpenSettings={vi.fn()} onOpenChat={vi.fn()} onToggle={vi.fn()} settingsOpen={false} />));

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

  it("shows running and ready-unread indicators for sessions", () => {
    const store = {
      sessionSearch: "",
      recentProjectPaths: ["/work/cake"],
      projectPath: "/work/cake",
      projects: [{ path: "/work/cake", name: "Cake" }],
      session: { sessionId: "running" },
      searchedSessions: [],
      projectSessions: () => [
        { id: "running", title: "Still working" },
        { id: "ready", title: "Finished in background" }
      ],
      sessionLimit: () => 8,
      sessionActivity: (_path: string, id: string) => id === "running" ? "running" : "unread",
      sessionDisplayTitle,
      chatReviewCommentCountForSession: vi.fn(() => 0),
      nameFromPath: () => "cake",
      setSessionSearch: vi.fn(),
      startOneOffChat: vi.fn(),
      chooseProject: vi.fn(),
      startNewSession: vi.fn(),
      switchProject: vi.fn(),
      openSession: vi.fn(),
      renameSession: vi.fn(),
      showMoreSessions: vi.fn()
    } as unknown as MainChatStore;

    act(() => root.render(<Sidebar {...sidebarProps(store)} onOpenSettings={vi.fn()} onOpenChat={vi.fn()} onToggle={vi.fn()} settingsOpen={false} />));

    expect(container.querySelector('[data-session-id="running"] [aria-label="Running"]')).not.toBeNull();
    expect(container.querySelector('[data-session-id="ready"] [aria-label="Ready, unread"]')).not.toBeNull();
  });

  it("uses the canonical actionable-comment selector for session badges", () => {
    const store = {
      sessionSearch: "", recentProjectPaths: ["/work/cake"], projectPath: "/work/cake", projects: [{ path: "/work/cake", name: "Cake" }], session: { sessionId: "pending" }, searchedSessions: [],
      projectSessions: () => [{ id: "pending", title: "Needs review" }, { id: "answered", title: "Already answered" }], sessionLimit: () => 8,
      sessionActivity: vi.fn(() => undefined), chatReviewCommentCountForSession: (_path: string, id: string) => id === "pending" ? 1 : 0,
      sessionDisplayTitle,
      nameFromPath: () => "cake", setSessionSearch: vi.fn(), startOneOffChat: vi.fn(), chooseProject: vi.fn(), startNewSession: vi.fn(), switchProject: vi.fn(), openSession: vi.fn(), renameSession: vi.fn(), showMoreSessions: vi.fn()
    } as unknown as MainChatStore;

    act(() => root.render(<Sidebar {...sidebarProps(store)} onOpenSettings={vi.fn()} onOpenChat={vi.fn()} onToggle={vi.fn()} settingsOpen={false} />));

    expect(container.querySelector('[data-session-id="pending"]')?.textContent).toContain("1 comment");
    expect(container.querySelector('[data-session-id="answered"]')?.textContent).not.toContain("comments");
  });

  it("starts a new session with the selected inactive project path", () => {
    const startNewSession = vi.fn();
    const switchProject = vi.fn();
    const store = {
      sessionSearch: "", recentProjectPaths: ["/work/first", "/work/second"], projectPath: "/work/first",
      projects: [{ path: "/work/first", name: "First" }, { path: "/work/second", name: "Second" }], session: { sessionId: "session-1" }, searchedSessions: [],
      projectSessions: () => [], sessionLimit: () => 8, sessionActivity: vi.fn(() => undefined), chatReviewCommentCountForSession: vi.fn(() => 0),
      sessionDisplayTitle,
      nameFromPath: (path: string) => path.split("/").at(-1)!, setSessionSearch: vi.fn(), startOneOffChat: vi.fn(), chooseProject: vi.fn(),
      startNewSession, switchProject, openSession: vi.fn(), renameSession: vi.fn(), showMoreSessions: vi.fn()
    } as unknown as MainChatStore;

    act(() => root.render(<Sidebar {...sidebarProps(store)} onOpenSettings={vi.fn()} onOpenChat={vi.fn()} onToggle={vi.fn()} settingsOpen={false} />));
    act(() => container.querySelector<HTMLButtonElement>('[aria-label="New chat in second"]')!.click());

    expect(startNewSession).toHaveBeenCalledWith("/work/second");
    expect(switchProject).not.toHaveBeenCalled();
  });
});
