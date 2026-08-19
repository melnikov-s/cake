/**
 * @vitest-environment jsdom
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PanelResizeHandle } from "../../../src/renderer/components/panel-resize-handle";

describe("PanelResizeHandle", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("resizes from the keyboard and exposes separator values", () => {
    const onChange = vi.fn();
    act(() =>
      root.render(
        <PanelResizeHandle
          label="Resize sidebar"
          value={292}
          min={220}
          max={500}
          edge="left"
          onChange={onChange}
        />,
      ),
    );
    const handle = container.querySelector<HTMLElement>('[role="separator"]')!;

    expect(handle.getAttribute("aria-valuenow")).toBe("292");
    act(() =>
      handle.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })),
    );
    act(() => handle.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true })));

    expect(onChange).toHaveBeenNthCalledWith(1, 308);
    expect(onChange).toHaveBeenNthCalledWith(2, 220);
  });

  it("reverses horizontal movement for a panel attached to the right edge", () => {
    const onChange = vi.fn();
    act(() =>
      root.render(
        <PanelResizeHandle
          label="Resize details"
          value={320}
          min={240}
          max={500}
          edge="right"
          onChange={onChange}
        />,
      ),
    );
    const handle = container.querySelector<HTMLElement>('[role="separator"]')!;

    act(() =>
      handle.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true })),
    );

    expect(onChange).toHaveBeenCalledWith(336);
  });

  it("resizes a bottom panel vertically and exposes a horizontal separator", () => {
    const onChange = vi.fn();
    act(() =>
      root.render(
        <PanelResizeHandle
          label="Resize comments"
          value={120}
          min={76}
          max={500}
          edge="bottom"
          onChange={onChange}
        />,
      ),
    );
    const handle = container.querySelector<HTMLElement>('[role="separator"]')!;

    expect(handle.getAttribute("aria-orientation")).toBe("horizontal");
    act(() =>
      handle.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true })),
    );
    act(() =>
      handle.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowDown", shiftKey: true, bubbles: true }),
      ),
    );

    expect(onChange).toHaveBeenNthCalledWith(1, 136);
    expect(onChange).toHaveBeenNthCalledWith(2, 76);
  });
});
