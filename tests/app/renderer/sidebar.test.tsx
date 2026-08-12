/**
 * @vitest-environment jsdom
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Sidebar } from "../../../src/renderer/app";
import type { WindowStore } from "../../../src/renderer/stores/window-store";

describe("Sidebar projects", () => {
  let container: HTMLDivElement;
  let root: Root;

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
    } as unknown as WindowStore;

    act(() => root.render(<Sidebar store={store} onOpenSettings={vi.fn()} onOpenChat={vi.fn()} onToggle={vi.fn()} settingsOpen={false} />));

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
      nameFromPath: () => "cake",
      setSessionSearch: vi.fn(),
      startOneOffChat: vi.fn(),
      chooseProject: vi.fn(),
      startNewSession: vi.fn(),
      switchProject: vi.fn(),
      openSession: vi.fn(),
      renameSession: vi.fn(),
      showMoreSessions: vi.fn()
    } as unknown as WindowStore;

    act(() => root.render(<Sidebar store={store} onOpenSettings={vi.fn()} onOpenChat={vi.fn()} onToggle={vi.fn()} settingsOpen={false} />));

    expect(container.querySelector('[data-session-id="running"] [aria-label="Running"]')).not.toBeNull();
    expect(container.querySelector('[data-session-id="ready"] [aria-label="Ready, unread"]')).not.toBeNull();
  });
});
