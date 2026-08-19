/** @vitest-environment jsdom */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
  calculatePopoverPosition,
} from "../../../src/renderer/components/ui/popover";

describe("Cake Popover", () => {
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

  it("portals intentional overlap and dismisses it with Escape", () => {
    act(() =>
      root.render(
        <Popover>
          <PopoverTrigger>Environment</PopoverTrigger>
          <PopoverContent aria-label="Environment details">
            <button>Refresh</button>
          </PopoverContent>
        </Popover>,
      ),
    );
    const trigger = container.querySelector<HTMLButtonElement>("button")!;

    act(() => trigger.dispatchEvent(new MouseEvent("click", { bubbles: true })));

    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(document.body.querySelector('[aria-label="Environment details"]')).not.toBeNull();
    act(() =>
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
    );
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(document.body.querySelector('[aria-label="Environment details"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("flips and clamps a surface that would overflow the viewport", () => {
    const position = calculatePopoverPosition(
      { top: 170, right: 190, bottom: 190, left: 150, width: 40, height: 20 },
      { width: 120, height: 100 },
      { width: 200, height: 200 },
      "bottom",
      "end",
      8,
    );

    expect(position).toEqual({ left: 70, top: 62 });
  });
});
