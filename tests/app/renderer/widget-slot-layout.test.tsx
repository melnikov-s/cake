/** @vitest-environment jsdom */
import { useLayoutEffect } from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { allocateWidgetPair } from "../../../src/renderer/lib/widget-slot-sizing";
import {
  WidgetSlotLayout,
  useWidgetSlotLayout,
} from "../../../src/renderer/components/widget-slot-layout";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("allocates overfull opposing requests deterministically, including zero and narrow extents", () => {
  expect(allocateWidgetPair(500, 280, 280)).toEqual([250, 250]);
  expect(allocateWidgetPair(200, 160, 160)).toEqual([100, 100]);
  expect(allocateWidgetPair(0, 280, 280)).toEqual([0, 0]);
  expect(allocateWidgetPair(500, 0, 700)).toEqual([0, 500]);
  for (const extent of [500, 100, 1, 0, 200, 500, 1200]) {
    const allocated = allocateWidgetPair(extent, 800, 600);
    expect(allocated[0] + allocated[1]).toBeLessThanOrEqual(extent);
    for (let iteration = 0; iteration < 20; iteration++)
      expect(allocateWidgetPair(extent, 800, 600)).toEqual(allocated);
  }
});

function Pane({ slot }: { slot: "left" | "right" | "top" | "bottom" }) {
  const layout = useWidgetSlotLayout();
  const { register } = layout;
  useLayoutEffect(() => {
    register(slot, true);
    return () => register(slot, false);
  }, [register, slot]);
  return (
    <>
      <output data-testid={slot}>{layout.sizes[slot]}</output>
      <button
        onClick={() =>
          layout.resize(slot, slot === "left" || slot === "right" ? layout.width : layout.height)
        }
      >
        Maximize {slot}
      </button>
    </>
  );
}

it("measures one container only; repeated observer delivery cannot alternate opposing sizes or recreate observers", () => {
  let width = 500,
    height = 200;
  const deliveries: (() => void)[] = [];
  const observe = vi.fn();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        deliveries.push(callback);
      }
      observe = observe;
      disconnect() {}
    },
  );
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      return DOMRect.fromRect({
        width: this.hasAttribute("data-widget-chat") ? width : 0,
        height: this.hasAttribute("data-widget-chat") ? height : 0,
      });
    },
  );
  render(
    <WidgetSlotLayout>
      {(["left", "right", "top", "bottom"] as const).map((slot) => (
        <Pane key={slot} slot={slot} />
      ))}
    </WidgetSlotLayout>,
  );
  const sizes = () =>
    ["left", "right", "top", "bottom"].map((slot) => Number(screen.getByTestId(slot).textContent));
  expect(sizes()).toEqual([250, 250, 100, 100]);
  for (let iteration = 0; iteration < 20; iteration++) {
    act(() => deliveries[0]!());
    expect(sizes()).toEqual([250, 250, 100, 100]);
  }
  width = 100;
  height = 100;
  act(() => deliveries[0]!());
  expect(sizes()).toEqual([50, 50, 50, 50]);
  width = 500;
  height = 200;
  act(() => deliveries[0]!());
  expect(sizes()).toEqual([250, 250, 100, 100]);
  act(() => screen.getByRole("button", { name: "Maximize left" }).click());
  expect(sizes()).toEqual([500, 0, 100, 100]);
  act(() => screen.getByRole("button", { name: "Maximize bottom" }).click());
  expect(sizes()).toEqual([500, 0, 0, 200]);
  expect(deliveries).toHaveLength(1);
  expect(observe).toHaveBeenCalledTimes(1);
});
