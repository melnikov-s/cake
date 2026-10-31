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
    const content = document.body.querySelector('[aria-label="Environment details"]');
    expect(content).not.toBeNull();
    expect(document.activeElement).toBe(content?.querySelector("button"));
    act(() =>
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
    );
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(document.body.querySelector('[aria-label="Environment details"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("focuses the preferred input only on opening, not content updates", () => {
    const renderContent = (reply: string) => (
      <Popover>
        <PopoverTrigger>Companion</PopoverTrigger>
        <PopoverContent initialFocusSelector="textarea" aria-label="Companion">
          <button>Close</button>
          <textarea aria-label="Ask" />
          <p>{reply}</p>
        </PopoverContent>
      </Popover>
    );
    act(() => root.render(renderContent("First words")));
    const trigger = container.querySelector<HTMLButtonElement>("button")!;
    act(() => trigger.click());
    const content = document.body.querySelector('[aria-label="Companion"]')!;
    const input = content.querySelector("textarea")!;
    const close = content.querySelector("button")!;
    expect(document.activeElement).toBe(input);
    act(() => close.focus());
    act(() => root.render(renderContent("More streamed words")));
    expect(document.activeElement).toBe(close);
    act(() => trigger.click());
    act(() => trigger.click());
    expect(document.activeElement).toBe(document.body.querySelector("textarea"));
  });

  it("can dismiss before an input consumes Escape", () => {
    act(() =>
      root.render(
        <Popover>
          <PopoverTrigger>Companion</PopoverTrigger>
          <PopoverContent dismissOnEscapeCapture initialFocusSelector="textarea">
            <textarea onKeyDown={(event) => event.stopPropagation()} />
          </PopoverContent>
        </Popover>,
      ),
    );
    const trigger = container.querySelector<HTMLButtonElement>("button")!;
    act(() => trigger.click());
    const input = document.body.querySelector("textarea")!;
    act(() => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
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

  it("keeps a surface inside an offset ancestor boundary", () => {
    const position = calculatePopoverPosition(
      { top: 140, right: 460, bottom: 180, left: 420, width: 40, height: 40 },
      { width: 240, height: 80 },
      { left: 400, top: 32, right: 800, bottom: 600 },
      "left",
      "center",
      12,
    );

    expect(position).toEqual({ left: 472, top: 120 });
  });
});
