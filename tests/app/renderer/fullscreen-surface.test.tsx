/** @vitest-environment jsdom */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FullscreenSurface } from "../../../src/renderer/components/fullscreen-surface";
import { FullscreenSurfaceFixture } from "./fullscreen-surface-fixture";

function pressEscape() {
  act(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
}

describe("FullscreenSurface", () => {
  let container: HTMLDivElement;
  let root: Root;
  let elementFromPoint: ((x: number, y: number) => Element | null) | undefined;

  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    elementFromPoint = document.elementFromPoint;
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    if (elementFromPoint) document.elementFromPoint = elementFromPoint;
    else delete (document as Partial<Document>).elementFromPoint;
  });

  it("dismisses on Escape when no layer is stacked above", () => {
    let closed = false;
    act(() =>
      root.render(
        <FullscreenSurfaceFixture>
          <FullscreenSurface
            eyebrow="Full response"
            title="Cake"
            onClose={() => {
              closed = true;
            }}
          >
            <p>Response body</p>
          </FullscreenSurface>
        </FullscreenSurfaceFixture>,
      ),
    );
    expect(document.body.querySelector('[role="dialog"]')).not.toBeNull();

    // Without layout (jsdom) the surface is treated as topmost.
    pressEscape();
    expect(closed).toBe(true);
  });

  it("ignores Escape while a higher overlay owns the viewport center", () => {
    let closed = false;
    act(() =>
      root.render(
        <FullscreenSurfaceFixture>
          <FullscreenSurface
            eyebrow="Full response"
            title="Cake"
            onClose={() => {
              closed = true;
            }}
          >
            <p>Response body</p>
          </FullscreenSurface>
        </FullscreenSurfaceFixture>,
      ),
    );
    const surface = document.body.querySelector<HTMLElement>('[role="dialog"]')!;
    const higherOverlay = document.createElement("div");
    document.body.appendChild(higherOverlay);
    document.elementFromPoint = () => higherOverlay;

    pressEscape();
    expect(closed).toBe(false);
    expect(surface.isConnected).toBe(true);

    // Once the higher layer closes, the surface owns the viewport center again.
    higherOverlay.remove();
    document.elementFromPoint = () => surface;
    pressEscape();
    expect(closed).toBe(true);
  });
});
