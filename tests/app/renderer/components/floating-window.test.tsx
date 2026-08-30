/**
 * @vitest-environment jsdom
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clampFloatingWindowGeometry,
  FloatingWindow,
  type FloatingWindowGeometry,
  type FloatingWindowProps,
  maximizedFloatingWindowGeometry,
} from "../../../../src/renderer/components/ui/floating-window";

describe("FloatingWindow", () => {
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

  type WindowProps = Omit<FloatingWindowProps, "children" | "surfaceRef"> & {
    surfaceRef: React.RefObject<HTMLDivElement | null>;
  };

  const renderWindow = (overrides: Partial<WindowProps> = {}) => {
    const onClose = vi.fn<() => void>();
    const onToggleMaximize = vi.fn<() => void>();
    const onGeometryChange = vi.fn<(geometry: FloatingWindowGeometry) => void>();
    const props: WindowProps = {
      surfaceRef: React.createRef<HTMLDivElement | null>(),
      geometry: { left: 40, top: 40, width: 416, height: "auto" },
      maximized: false,
      title: "Test chat",
      onClose,
      onToggleMaximize,
      onGeometryChange,
      ...overrides,
    };
    act(() => {
      root.render(
        <FloatingWindow {...props}>
          <div>body</div>
        </FloatingWindow>,
      );
    });
    return { onClose, onToggleMaximize, onGeometryChange };
  };

  const dialog = () => document.querySelector('[role="dialog"][aria-label="Test chat"]')!;
  const button = (label: string) =>
    document.body.querySelector(`button[aria-label="${label}"]`) as HTMLButtonElement;

  it("renders the title bar, traffic lights, and resize edges", () => {
    renderWindow();
    expect(dialog().querySelector("strong")?.textContent).toBe("Test chat");
    expect(button("Close test chat")).toBeTruthy();
    expect(button("Maximize test chat")).toBeTruthy();
    expect(
      dialog().querySelectorAll(".cursor-e-resize, .cursor-n-resize, .cursor-se-resize").length,
    ).toBe(3);
  });

  it("closes through the red traffic light", () => {
    const props = renderWindow();
    act(() => {
      button("Close test chat").click();
    });
    expect(props.onClose).toHaveBeenCalledTimes(1);
    expect(props.onToggleMaximize).not.toHaveBeenCalled();
  });

  it("toggles maximize through the traffic light and the header double-click", () => {
    const props = renderWindow();
    const light = button("Maximize test chat");
    act(() => light.click());
    expect(props.onToggleMaximize).toHaveBeenCalledTimes(1);

    act(() => {
      dialog()
        .querySelector("header")!
        .dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    });
    expect(props.onToggleMaximize).toHaveBeenCalledTimes(2);
  });

  it("ignores header double-clicks that start on the traffic lights", () => {
    const props = renderWindow();
    act(() => {
      button("Close test chat").dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    });
    expect(props.onToggleMaximize).not.toHaveBeenCalled();
  });

  it("hides resize edges while maximized and swaps the green light to restore", () => {
    renderWindow({ maximized: true });
    expect(dialog().querySelector(".cursor-se-resize")).toBeNull();
    expect(button("Restore test chat")).toBeTruthy();
    expect(button("Maximize test chat")).toBeNull();
  });

  it("preserves content-sized height while dragging the title bar", () => {
    const props = renderWindow();
    const surface = dialog() as HTMLDivElement;
    vi.spyOn(surface, "getBoundingClientRect").mockReturnValue({
      left: 40,
      top: 40,
      right: 456,
      bottom: 340,
      width: 416,
      height: 300,
      x: 40,
      y: 40,
      toJSON: () => ({}),
    });
    const header = surface.querySelector("header")!;
    Object.assign(header, { setPointerCapture: vi.fn() });

    act(() => {
      header.dispatchEvent(
        new MouseEvent("pointerdown", { bubbles: true, button: 0, clientX: 100, clientY: 100 }),
      );
      document.dispatchEvent(
        new MouseEvent("pointermove", { bubbles: true, clientX: 120, clientY: 130 }),
      );
      document.dispatchEvent(new MouseEvent("pointerup", { bubbles: true }));
    });

    expect(props.onGeometryChange).toHaveBeenLastCalledWith({
      left: 60,
      top: 70,
      width: 416,
      height: "auto",
    });
  });

  it("applies the auto-height cap class only while the height is content-sized", () => {
    renderWindow({ autoHeightClassName: "max-h-40" });
    expect(dialog().className).toContain("max-h-40");
    renderWindow({
      autoHeightClassName: "max-h-40",
      geometry: { left: 0, top: 0, width: 400, height: 300 },
    });
    expect(dialog().className).not.toContain("max-h-40");
  });
});

describe("floating window geometry helpers", () => {
  it("clamps geometry into the viewport and enforces the minimum size", () => {
    const clamped = clampFloatingWindowGeometry({ left: -50, top: 5000, width: 100, height: 100 });
    expect(clamped.left).toBe(12);
    expect(clamped.width).toBe(320);
    expect(clamped.height).toBe(240);
    expect(clamped.top).toBe(window.innerHeight - 240 - 12);
  });

  it("keeps content-sized heights and valid positions while clamping the rest", () => {
    const clamped = clampFloatingWindowGeometry(
      { left: 12, top: 5000, width: 9000, height: "auto" },
      300,
    );
    expect(clamped.width).toBe(window.innerWidth - 24);
    expect(clamped.height).toBe("auto");
    expect(clamped.top).toBe(window.innerHeight - 300 - 12);

    const restored = clampFloatingWindowGeometry({
      left: 40,
      top: 40,
      width: 416,
      height: "auto",
    });
    expect(restored.top).toBe(40);
  });

  it("fills the window when maximized", () => {
    expect(maximizedFloatingWindowGeometry()).toEqual({
      left: 0,
      top: 0,
      width: window.innerWidth,
      height: window.innerHeight,
    });
  });
});
