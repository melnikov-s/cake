/**
 * @vitest-environment jsdom
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UiHintMode } from "../../../src/renderer/components/ui/ui-hint-mode";
import { createRendererStoreFixture } from "./renderer-store-fixture";

// Component policy boundary: browser rectangles and delivered key events are
// controlled, not native geometry/input proof. Full Root/static-target behavior
// lives in hint-overlay-finish-workflow; native activation/focus is in
// electron/hotkeys.smoke.spec.ts.
describe("UiHintMode", () => {
  let container: HTMLDivElement;
  let root: Root;
  let fixture: ReturnType<typeof createRendererStoreFixture>;

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
    fixture = createRendererStoreFixture();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    fixture[Symbol.dispose]();
    vi.restoreAllMocks();
  });

  it("omits hidden and explicitly excluded controls", () => {
    const store = fixture.root.uiHintModeStore;
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
    const store = fixture.root.uiHintModeStore;
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
    const store = fixture.root.uiHintModeStore;
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
    expect(document.querySelector('[data-slot="ui-hint-overlay"]')).toBeNull();
  });
});
