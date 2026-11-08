/**
 * @vitest-environment jsdom
 */
import React, { act, useState } from "react";
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
    vi.restoreAllMocks();
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
      const event = new MouseEvent(type, { bubbles: true, button: 0, buttons: 1, clientX });
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

  function pointer(type: string, clientX: number, pointerId = 7, buttons = 1) {
    const event = new MouseEvent(type, { bubbles: true, button: 0, buttons, clientX });
    Object.defineProperty(event, "pointerId", { value: pointerId });
    return event;
  }

  function renderDragHandle(preview = true) {
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
    const onStart = vi.fn();
    const onEnd = vi.fn();
    function Harness() {
      const [value, setValue] = useState(292);
      const [resizing, setResizing] = useState(false);
      return (
        <main className={resizing ? "select-none" : ""}>
          <ResizeHandle
            label="Resize Workspace"
            value={value}
            min={240}
            max={520}
            edge="right"
            onChange={(next) => {
              onChange(next);
              setValue(next);
            }}
            onDrag={preview ? onDrag : undefined}
            onResizeStart={() => {
              onStart();
              setResizing(true);
            }}
            onResizeEnd={() => {
              onEnd();
              setResizing(false);
            }}
          />
        </main>
      );
    }
    act(() => root.render(<Harness />));
    const handle = container.querySelector<HTMLElement>('[role="separator"]')!;
    return { handle, frames, onChange, onDrag, onStart, onEnd };
  }

  it.each([
    "outside release",
    "cancel",
    "capture loss",
    "window blur",
    "hidden document",
    "missed release",
    "unmount",
  ])("ends and commits a pending preview exactly once on %s", (exit) => {
    const { handle, frames, onChange, onDrag, onStart, onEnd } = renderDragHandle();
    handle.setPointerCapture = vi.fn();
    handle.hasPointerCapture = vi.fn(() => true);
    handle.releasePointerCapture = vi.fn(() => {
      handle.dispatchEvent(pointer("lostpointercapture", 0));
    });
    act(() => handle.dispatchEvent(pointer("pointerdown", 100)));
    act(() => handle.dispatchEvent(pointer("pointermove", 80)));
    expect(container.querySelector("main")!.classList.contains("select-none")).toBe(true);
    expect(onChange).not.toHaveBeenCalled();
    expect(frames.size).toBe(1);

    act(() => {
      if (exit === "outside release") document.body.dispatchEvent(pointer("pointerup", 80));
      else if (exit === "cancel") window.dispatchEvent(pointer("pointercancel", 80));
      else if (exit === "capture loss") handle.dispatchEvent(pointer("lostpointercapture", 80));
      else if (exit === "window blur") window.dispatchEvent(new Event("blur"));
      else if (exit === "hidden document") {
        vi.spyOn(document, "hidden", "get").mockReturnValue(true);
        document.dispatchEvent(new Event("visibilitychange"));
      } else if (exit === "missed release") window.dispatchEvent(pointer("pointermove", 70, 7, 0));
      else root.render(null);
    });

    expect(onDrag).toHaveBeenCalledExactlyOnceWith(312);
    expect(onChange).toHaveBeenCalledExactlyOnceWith(312);
    expect(onStart).toHaveBeenCalledOnce();
    expect(onEnd).toHaveBeenCalledOnce();
    expect(frames.size).toBe(0);
    expect(handle.releasePointerCapture).toHaveBeenCalledExactlyOnceWith(7);
    expect(container.querySelector(".select-none")).toBeNull();
    act(() => {
      window.dispatchEvent(pointer("pointermove", 50));
      window.dispatchEvent(pointer("pointerup", 50));
      handle.dispatchEvent(pointer("lostpointercapture", 50));
      window.dispatchEvent(new Event("blur"));
    });
    expect(onChange).toHaveBeenCalledOnce();
    expect(onEnd).toHaveBeenCalledOnce();
  });

  it("ignores other pointers and duplicate starts, clamps sizes, and can drag again", () => {
    const { handle, onChange, onStart, onEnd } = renderDragHandle();
    act(() => handle.dispatchEvent(pointer("pointerdown", 100)));
    act(() => {
      handle.dispatchEvent(pointer("pointerdown", 110, 8));
      window.dispatchEvent(pointer("pointermove", 0, 8));
      window.dispatchEvent(pointer("pointerup", 0, 8));
      handle.dispatchEvent(pointer("lostpointercapture", 0, 8));
    });
    expect(onStart).toHaveBeenCalledOnce();
    expect(onChange).not.toHaveBeenCalled();
    expect(onEnd).not.toHaveBeenCalled();
    act(() => window.dispatchEvent(pointer("pointermove", -1000)));
    act(() => document.body.dispatchEvent(pointer("pointerup", -1000)));
    expect(onChange).toHaveBeenLastCalledWith(520);
    act(() => handle.dispatchEvent(pointer("pointerdown", 100)));
    act(() => window.dispatchEvent(pointer("pointermove", 1000)));
    act(() => document.body.dispatchEvent(pointer("pointerup", 1000)));
    expect(onChange).toHaveBeenLastCalledWith(240);
    expect(onStart).toHaveBeenCalledTimes(2);
    expect(onEnd).toHaveBeenCalledTimes(2);
  });

  it("keeps immediate updates without a preview and does not commit an unmoved gesture", () => {
    const { handle, onChange, onEnd } = renderDragHandle(false);
    act(() => handle.dispatchEvent(pointer("pointerdown", 100)));
    act(() => document.body.dispatchEvent(pointer("pointerup", 100)));
    expect(onChange).not.toHaveBeenCalled();
    expect(onEnd).toHaveBeenCalledOnce();
    act(() => handle.dispatchEvent(pointer("pointerdown", 100)));
    act(() => window.dispatchEvent(pointer("pointermove", 80)));
    expect(onChange).toHaveBeenCalledExactlyOnceWith(312);
    act(() => window.dispatchEvent(new Event("blur")));
    expect(onChange).toHaveBeenCalledOnce();
    expect(onEnd).toHaveBeenCalledTimes(2);
  });

  it("uses updated constraints and callbacks without restarting an active gesture", () => {
    const originalChange = vi.fn();
    const originalEnd = vi.fn();
    const updatedChange = vi.fn();
    const updatedEnd = vi.fn();
    const render = (max: number, onChange: (value: number) => void, onEnd: () => void) => {
      act(() =>
        root.render(
          <ResizeHandle
            label="Resize sidebar"
            value={292}
            min={240}
            max={max}
            edge="right"
            onChange={onChange}
            onResizeEnd={onEnd}
          />,
        ),
      );
    };
    render(520, originalChange, originalEnd);
    const handle = container.querySelector<HTMLElement>('[role="separator"]')!;
    act(() => handle.dispatchEvent(pointer("pointerdown", 100)));
    render(300, updatedChange, updatedEnd);
    act(() => window.dispatchEvent(pointer("pointermove", 60)));
    act(() => window.dispatchEvent(pointer("pointerup", 60)));
    expect(originalChange).not.toHaveBeenCalled();
    expect(originalEnd).not.toHaveBeenCalled();
    expect(updatedChange).toHaveBeenCalledExactlyOnceWith(300);
    expect(updatedEnd).toHaveBeenCalledOnce();
  });

  it.each([
    ["left", 312],
    ["right", 272],
    ["top", 312],
    ["bottom", 272],
  ] as const)("preserves pointer sizing direction for the %s edge", (edge, expected) => {
    const onChange = vi.fn();
    act(() =>
      root.render(
        <ResizeHandle
          label="Resize pane"
          value={292}
          min={240}
          max={520}
          edge={edge}
          onChange={onChange}
        />,
      ),
    );
    const handle = container.querySelector<HTMLElement>('[role="separator"]')!;
    const dispatch = (target: EventTarget, type: string, coordinate: number) => {
      const event = new MouseEvent(type, {
        bubbles: true,
        buttons: 1,
        clientX: coordinate,
        clientY: coordinate,
      });
      Object.defineProperty(event, "pointerId", { value: 7 });
      act(() => target.dispatchEvent(event));
    };
    dispatch(handle, "pointerdown", 100);
    dispatch(window, "pointermove", 120);
    dispatch(window, "pointerup", 120);
    expect(onChange).toHaveBeenCalledExactlyOnceWith(expected);
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
