/**
 * @vitest-environment jsdom
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AnimatedList } from "../../../../src/renderer/components/ui/animated-list";

describe("AnimatedList", () => {
  let container: HTMLDivElement;
  let root: Root;
  const operations: string[] = [];
  const animate = vi.fn(function (this: HTMLElement) {
    const key = this.dataset.animatedListKey;
    operations.push(`animate:${key}`);
    return { cancel: vi.fn(() => operations.push(`cancel:${key}`)) } as unknown as Animation;
  });
  const itemTops = new Map<string, number>();

  function renderItems(keys: string[]) {
    act(() => {
      root.render(
        <AnimatedList>
          {keys.map((key) => (
            <div key={key} data-animated-list-key={key} />
          ))}
        </AnimatedList>,
      );
    });
  }

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({ matches: false })),
    );
    Object.defineProperty(HTMLElement.prototype, "animate", {
      configurable: true,
      value: animate,
    });
    vi.spyOn(HTMLElement.prototype, "offsetTop", "get").mockImplementation(
      function (this: HTMLElement) {
        operations.push(`measure:${this.dataset.animatedListKey}`);
        return itemTops.get(this.dataset.animatedListKey ?? "") ?? 0;
      },
    );
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    animate.mockClear();
    itemTops.clear();
    operations.length = 0;
  });

  it("quickly animates retained items from their previous vertical positions", () => {
    itemTops.set("first", 0);
    itemTops.set("second", 20);

    act(() => {
      root.render(
        <AnimatedList>
          <div key="first" data-animated-list-key="first" />
          <div key="second" data-animated-list-key="second" />
        </AnimatedList>,
      );
    });
    expect(animate).not.toHaveBeenCalled();

    itemTops.set("first", 20);
    itemTops.set("second", 0);
    act(() => {
      root.render(
        <AnimatedList>
          <div key="second" data-animated-list-key="second" />
          <div key="first" data-animated-list-key="first" />
        </AnimatedList>,
      );
    });

    expect(animate).toHaveBeenCalledTimes(2);
    expect(animate).toHaveBeenCalledWith(
      [{ translate: "0 -20px" }, { translate: "none" }],
      expect.objectContaining({ duration: 160 }),
    );
    expect(animate).toHaveBeenCalledWith(
      [{ translate: "0 20px" }, { translate: "none" }],
      expect.objectContaining({ duration: 160 }),
    );
  });

  it("measures all retained rows before animating after a removal", () => {
    itemTops.set("first", 0);
    itemTops.set("second", 20);
    itemTops.set("third", 40);
    renderItems(["first", "second", "third"]);
    operations.length = 0;

    itemTops.set("second", 0);
    itemTops.set("third", 20);
    renderItems(["second", "third"]);

    expect(operations).toEqual([
      "measure:second",
      "measure:third",
      "animate:second",
      "animate:third",
    ]);
    expect(animate).toHaveBeenNthCalledWith(
      1,
      [{ translate: "0 20px" }, { translate: "none" }],
      expect.objectContaining({ duration: 160 }),
    );
    expect(animate).toHaveBeenNthCalledWith(
      2,
      [{ translate: "0 20px" }, { translate: "none" }],
      expect.objectContaining({ duration: 160 }),
    );

    // A new destination interrupts the affected animation; removed rows clean up too.
    operations.length = 0;
    itemTops.set("third", 0);
    renderItems(["third"]);
    expect(operations).toEqual(["measure:third", "cancel:second", "cancel:third", "animate:third"]);
    const lastAnimation = animate.mock.results.at(-1)!.value;
    act(() => root.render(null));
    expect(lastAnimation.cancel).toHaveBeenCalledOnce();
  });

  it("does not animate unchanged positions or rows present at mount", () => {
    itemTops.set("first", 0);
    itemTops.set("second", 20);
    renderItems(["first", "second"]);
    renderItems(["first", "second"]);
    expect(animate).not.toHaveBeenCalled();
  });

  it("preserves an in-flight reorder across repeated content updates and scrolling", () => {
    itemTops.set("first", 0);
    itemTops.set("second", 20);
    renderItems(["first", "second"]);
    itemTops.set("first", 20);
    itemTops.set("second", 0);
    renderItems(["second", "first"]);
    const animations = animate.mock.results.map((result) => result.value);
    // Screen positions can change through scrolling or animation, not layout.
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
      new DOMRect(0, -100, 100, 20),
    );
    for (let update = 0; update < 5; update++) renderItems(["second", "first"]);
    expect(animate).toHaveBeenCalledTimes(2);
    for (const animation of animations) expect(animation.cancel).not.toHaveBeenCalled();
  });

  it("lets rows inserted into a rendered list enter, without restarting on re-render", () => {
    itemTops.set("first", 0);
    renderItems(["first"]);
    itemTops.set("second", 20);
    renderItems(["first", "second"]);
    expect(operations).toEqual([
      "measure:first",
      "measure:first",
      "measure:second",
      "animate:second",
    ]);
    expect(animate).toHaveBeenCalledWith(
      [
        { opacity: 0, transform: "translateY(-4px) scale(0.97)" },
        { opacity: 1, transform: "none" },
      ],
      expect.objectContaining({ duration: 260 }),
    );

    // Measuring layout coordinates does not disturb the entering row's transform.
    operations.length = 0;
    renderItems(["first", "second"]);
    expect(operations).toEqual(["measure:first", "measure:second"]);
  });

  it("treats a bulk insertion as a load rather than an arrival", () => {
    renderItems(["first"]);
    renderItems(["first", "a", "b", "c", "d", "e"]);
    expect(animate).not.toHaveBeenCalled();
  });

  it("updates measured positions without animation when reduced motion is requested", () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({ matches: true })),
    );
    itemTops.set("first", 0);
    itemTops.set("second", 20);
    renderItems(["first", "second"]);
    itemTops.set("second", 0);
    renderItems(["second"]);
    expect(animate).not.toHaveBeenCalled();

    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({ matches: false })),
    );
    renderItems(["second"]);
    expect(animate).not.toHaveBeenCalled();
  });
});
