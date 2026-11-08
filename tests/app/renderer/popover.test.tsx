/** @vitest-environment jsdom */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  Popover,
  PopoverBoundaryContext,
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
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
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

  it("sizes a toolbar popup to its supplied Cake pane and follows split resizing", () => {
    const pane = document.createElement("aside");
    container.append(pane);
    let left = 680;
    vi.spyOn(pane, "getBoundingClientRect").mockImplementation(
      () => ({ left, top: 45, right: 1000, bottom: 700 }) as DOMRect,
    );
    const observed: Element[] = [];
    let resize = () => {};
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: () => void) {
          resize = callback;
        }
        observe(element: Element) {
          observed.push(element);
        }
        disconnect() {}
      },
    );
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(
      function (this: HTMLElement) {
        const cap = Number.parseFloat(this.style.maxWidth.replace("min(", ""));
        return Math.min(352, Number.isFinite(cap) ? cap : 352);
      },
    );
    act(() =>
      root.render(
        <PopoverBoundaryContext.Provider value={{ current: pane }}>
          <Popover defaultOpen>
            <PopoverTrigger>Side chats</PopoverTrigger>
            <PopoverContent boundary="nearest-ancestor" align="end" aria-label="Picker">
              <button>A readable label</button>
            </PopoverContent>
          </Popover>
        </PopoverBoundaryContext.Provider>,
      ),
    );
    const popup = document.querySelector<HTMLElement>('[aria-label="Picker"]')!;
    expect(popup.style.maxWidth).toContain("304px");
    expect(popup.style.maxHeight).toContain("639px");
    expect(popup.style.left).toBe("688px");
    expect(observed).toContain(pane);
    // The toolbar trigger has not resized: only the companion's left edge moved.
    left = 580;
    act(() => resize());
    expect(popup.style.maxWidth).toContain("404px");
    expect(popup.style.left).toBe("588px");
  });

  it("leaves viewport popovers unconstrained even when a pane is supplied", () => {
    const pane = document.createElement("aside");
    act(() =>
      root.render(
        <PopoverBoundaryContext.Provider value={{ current: pane }}>
          <Popover defaultOpen>
            <PopoverTrigger>Details</PopoverTrigger>
            <PopoverContent aria-label="Unbounded">Details</PopoverContent>
          </Popover>
        </PopoverBoundaryContext.Provider>,
      ),
    );
    const popup = document.querySelector<HTMLElement>('[aria-label="Unbounded"]')!;
    expect(popup.style.maxWidth).toBe("");
    expect(popup.style.maxHeight).toBe("");
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
