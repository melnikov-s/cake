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
  const animate = vi.fn(() => ({ cancel: vi.fn() }) as unknown as Animation);
  const itemTops = new Map<string, number>();

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
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function (this: HTMLElement) {
        const top = itemTops.get(this.dataset.animatedListKey ?? "") ?? 0;
        return new DOMRect(0, top, 100, 20);
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
});
