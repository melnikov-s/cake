/**
 * @vitest-environment jsdom
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ResizeHandle } from "../../../../src/renderer/components/ui/resize-handle";

describe("ResizeHandle", () => {
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
    vi.unstubAllGlobals();
  });

  it("resizes from the keyboard and exposes separator values", () => {
    const onChange = vi.fn();
    act(() =>
      root.render(
        <ResizeHandle
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

  it("coalesces drag previews by frame and commits only on pointer release", () => {
    const frames = new Map<number, FrameRequestCallback>();
    let nextFrame = 1;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      const id = nextFrame++;
      frames.set(id, callback);
      return id;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
    const onChange = vi.fn();
    const onDrag = vi.fn();
    act(() =>
      root.render(
        <ResizeHandle
          label="Resize sidebar"
          value={292}
          min={220}
          max={500}
          edge="left"
          onChange={onChange}
          onDrag={onDrag}
        />,
      ),
    );
    const handle = container.querySelector<HTMLElement>('[role="separator"]')!;
    const pointerEvent = (type: string, clientX: number) => {
      const event = new MouseEvent(type, { bubbles: true, button: 0, clientX });
      Object.defineProperty(event, "pointerId", { value: 7 });
      return event;
    };

    act(() => handle.dispatchEvent(pointerEvent("pointerdown", 100)));
    act(() => {
      handle.dispatchEvent(pointerEvent("pointermove", 110));
      handle.dispatchEvent(pointerEvent("pointermove", 124));
    });

    expect(onDrag).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
    expect(frames.size).toBe(1);

    act(() => frames.values().next().value!(0));
    expect(onDrag).toHaveBeenCalledOnce();
    expect(onDrag).toHaveBeenLastCalledWith(316);
    expect(onChange).not.toHaveBeenCalled();

    act(() => handle.dispatchEvent(pointerEvent("pointerup", 124)));
    expect(onDrag).toHaveBeenCalledOnce();
    expect(onChange).toHaveBeenCalledOnce();
    expect(onChange).toHaveBeenCalledWith(316);
  });

  it("reverses horizontal movement for a panel attached to the right edge", () => {
    const onChange = vi.fn();
    act(() =>
      root.render(
        <ResizeHandle
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
        <ResizeHandle
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
