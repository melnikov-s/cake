/**
 * @vitest-environment jsdom
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DrawBoardToolbar } from "../../../src/renderer/components/draw-board-toolbar";
import type { DrawStore } from "../../../src/renderer/stores/DrawStore";

const exportBoard = vi.fn();
const store = {
  loading: false,
  saving: false,
  documentLoaded: true,
  exportingFormat: undefined,
  exportMessage: undefined,
  error: undefined,
  exportBoard,
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
    exportBoard.mockReset();
  });

  it("offers only the three deliberate board export formats", () => {
    act(() =>
      root.render(
        <DrawBoardToolbar
          store={store}
          sidebarCollapsed={false}
          canGoBack={false}
          canGoForward={false}
          onToggleSidebar={vi.fn()}
          onGoBack={vi.fn()}
          onGoForward={vi.fn()}
        />,
      ),
    );

    act(() =>
      container.querySelector<HTMLButtonElement>('[aria-label="Export Cake Draw board"]')!.click(),
    );
    const menu = document.body.querySelector('[role="menu"]')!;
    expect(menu.textContent).toContain("PNG image");
    expect(menu.textContent).toContain("SVG image");
    expect(menu.textContent).toContain("Editable Excalidraw");
    expect(menu.querySelectorAll('[role="menuitem"]')).toHaveLength(3);

    const editable = [...menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(
      (button) => button.textContent?.includes("Editable Excalidraw"),
    )!;
    act(() => editable.click());
    expect(exportBoard).toHaveBeenCalledWith("excalidraw");
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
