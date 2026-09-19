/**
 * @vitest-environment jsdom
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DrawBoardToolbar } from "../../../src/renderer/components/draw-board-toolbar";
import type { DrawStore } from "../../../src/renderer/stores/DrawStore";

const store = {
  loading: false,
  saving: false,
  error: undefined,
} as unknown as DrawStore;

describe("DrawBoardToolbar", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("returns to the agent from the labeled toolbar action", () => {
    const onBackToAgent = vi.fn();
    act(() =>
      root.render(
        <DrawBoardToolbar
          store={store}
          sidebarCollapsed={false}
          canGoBack={false}
          canGoForward={false}
          onBackToAgent={onBackToAgent}
          onToggleSidebar={vi.fn()}
          onGoBack={vi.fn()}
          onGoForward={vi.fn()}
        />,
      ),
    );

    const backToAgent = [...container.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Back to agent",
    )!;
    act(() => backToAgent.click());

    expect(onBackToAgent).toHaveBeenCalledOnce();
  });

  it("keeps sidebar and session-history controls clear of the traffic lights when collapsed", () => {
    const onToggleSidebar = vi.fn();
    const onGoBack = vi.fn();
    const onGoForward = vi.fn();
    act(() =>
      root.render(
        <DrawBoardToolbar
          store={store}
          sidebarCollapsed
          canGoBack
          canGoForward
          onBackToAgent={vi.fn()}
          onToggleSidebar={onToggleSidebar}
          onGoBack={onGoBack}
          onGoForward={onGoForward}
        />,
      ),
    );

    expect(container.querySelector("header")?.className).toContain("pl-[103px]");
    act(() => container.querySelector<HTMLButtonElement>('[aria-label="Toggle sidebar"]')!.click());
    act(() =>
      container
        .querySelector<HTMLButtonElement>('[aria-label="Go back in session history"]')!
        .click(),
    );
    act(() =>
      container
        .querySelector<HTMLButtonElement>('[aria-label="Go forward in session history"]')!
        .click(),
    );

    expect(onToggleSidebar).toHaveBeenCalledOnce();
    expect(onGoBack).toHaveBeenCalledOnce();
    expect(onGoForward).toHaveBeenCalledOnce();
  });
});
