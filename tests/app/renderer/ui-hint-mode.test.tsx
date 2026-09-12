/**
 * @vitest-environment jsdom
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createStore, mount } from "r-state-tree";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UiHintMode } from "../../../src/renderer/components/ui/ui-hint-mode";
import { UiHintModeStore } from "../../../src/renderer/stores/UiHintModeStore";

describe("UiHintMode", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      x: 20,
      y: 20,
      top: 20,
      right: 120,
      bottom: 50,
      left: 20,
      width: 100,
      height: 30,
      toJSON: () => ({}),
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  it("labels visible controls and naturally activates the selected target", () => {
    using store = mount(createStore(UiHintModeStore));
    const clicked = vi.fn();
    act(() =>
      root.render(
        <>
          <button type="button" onClick={clicked}>
            Open project
          </button>
          <input aria-label="Project name" />
          <UiHintMode store={store} />
        </>,
      ),
    );

    act(() => store.open());
    const button = container.querySelector("button")!;
    expect(document.querySelectorAll('[data-slot="ui-hint"]')).toHaveLength(2);
    expect(button.getAttribute("data-cake-hint-target")).toBe("true");
    const buttonHint = button.getAttribute("data-cake-hint-label")!;

    act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: buttonHint })));
    expect(clicked).toHaveBeenCalledOnce();
    expect(store.active).toBe(false);
    expect(document.querySelector('[data-slot="ui-hint-overlay"]')).toBeNull();
    expect(button.hasAttribute("data-cake-hint-target")).toBe(false);

    act(() => store.open());
    const input = container.querySelector("input")!;
    const inputHint = input.getAttribute("data-cake-hint-label")!;
    act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: inputHint })));
    expect(document.activeElement).toBe(input);
  });

  it("omits hidden and explicitly excluded controls", () => {
    using store = mount(createStore(UiHintModeStore));
    act(() =>
      root.render(
        <>
          <button type="button">Included</button>
          <button type="button" style={{ opacity: 0 }}>
            Visually hidden
          </button>
          <div data-cake-hint="off">
            <button type="button">Low-value action</button>
          </div>
          <UiHintMode store={store} />
        </>,
      ),
    );

    act(() => store.open());
    expect(document.querySelectorAll('[data-slot="ui-hint"]')).toHaveLength(1);
  });

  it("narrows targets and highlights the entered prefix", () => {
    using store = mount(createStore(UiHintModeStore));
    act(() =>
      root.render(
        <>
          {Array.from({ length: 28 }, (_, index) => (
            <button key={index} type="button">
              Target {index}
            </button>
          ))}
          <UiHintMode store={store} />
        </>,
      ),
    );

    act(() => store.open());
    expect(document.querySelectorAll('[data-slot="ui-hint"]')).toHaveLength(28);
    act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "s" })));

    const hints = [...document.querySelectorAll<HTMLElement>('[data-slot="ui-hint"]')];
    expect(hints).toHaveLength(2);
    expect(hints.every((hint) => hint.dataset.hintLabel?.startsWith("s"))).toBe(true);
    expect(
      hints.every(
        (hint) => hint.querySelector('[data-slot="ui-hint-prefix"]')?.textContent === "S",
      ),
    ).toBe(true);
    expect(document.querySelectorAll('[data-cake-hint-target="true"]')).toHaveLength(2);
  });

  it("cancels hint mode with Escape", () => {
    using store = mount(createStore(UiHintModeStore));
    act(() =>
      root.render(
        <>
          <button type="button">Target</button>
          <UiHintMode store={store} />
        </>,
      ),
    );
    act(() => store.open());
    act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
    expect(store.active).toBe(false);
  });
});
