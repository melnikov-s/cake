/** @vitest-environment jsdom */
import React, { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DialogBackdrop } from "../../../src/renderer/components/ui/dialog";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "../../../src/renderer/components/ui/popover";
import { FullscreenSurface } from "../../../src/renderer/components/fullscreen-surface";
import { FullscreenSurfaceFixture } from "./fullscreen-surface-fixture";

function pressEscape(options?: KeyboardEventInit) {
  const event = new KeyboardEvent("keydown", {
    key: "Escape",
    bubbles: true,
    cancelable: true,
    ...options,
  });
  act(() => (document.activeElement ?? document.body).dispatchEvent(event));
  return event;
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
    else Reflect.deleteProperty(document, "elementFromPoint");
  });

  it("keeps its header clear of the native window controls", () => {
    act(() =>
      root.render(
        <FullscreenSurfaceFixture>
          <FullscreenSurface eyebrow="Image preview" title="Preview" onClose={() => undefined}>
            <p>Preview body</p>
          </FullscreenSurface>
        </FullscreenSurfaceFixture>,
      ),
    );

    expect(document.body.querySelector("header")?.classList).toContain("pl-[84px]");
    const surface = document.body.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(surface.parentElement).toBe(document.body);
    expect(surface.classList.contains("fixed")).toBe(true);
  });

  it("dismisses only the active viewer from a focused input, restores focus, and leaves Escape alone when closed", () => {
    const underlyingEscape = vi.fn();
    const inputEscape = vi.fn();
    function View() {
      const [open, setOpen] = useState(false);
      const [nested, setNested] = useState(false);
      return (
        <div onKeyDown={underlyingEscape}>
          <button id="open-viewer" onClick={() => setOpen(true)}>
            Open viewer
          </button>
          {open && (
            <FullscreenSurface title="Artifact" onClose={() => setOpen(false)}>
              <button id="open-nested" onClick={() => setNested(true)}>
                Open image
              </button>
              {nested && (
                <FullscreenSurface title="Image" onClose={() => setNested(false)}>
                  <input aria-label="Nested input" defaultValue="Draft" onKeyDown={inputEscape} />
                </FullscreenSurface>
              )}
            </FullscreenSurface>
          )}
        </div>
      );
    }
    act(() =>
      root.render(
        <FullscreenSurfaceFixture>
          <View />
        </FullscreenSurfaceFixture>,
      ),
    );
    const opener = document.querySelector<HTMLButtonElement>("#open-viewer")!;
    opener.focus();
    expect(pressEscape().defaultPrevented).toBe(false);
    expect(underlyingEscape).toHaveBeenCalledTimes(1);
    underlyingEscape.mockClear();
    const previousOverflow = document.body.style.overflow;
    for (let cycle = 0; cycle < 2; cycle++) {
      act(() => opener.click());
      const nestedOpener = document.querySelector<HTMLButtonElement>("#open-nested")!;
      nestedOpener.focus();
      act(() => nestedOpener.click());
      const input = document.querySelector<HTMLInputElement>('[aria-label="Nested input"]')!;
      input.focus();
      expect(pressEscape({ isComposing: true }).defaultPrevented).toBe(false);
      expect(pressEscape({ shiftKey: true }).defaultPrevented).toBe(false);
      expect(input.value).toBe("Draft");
      underlyingEscape.mockClear();
      inputEscape.mockClear();

      expect(pressEscape().defaultPrevented).toBe(true);
      expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
      expect(document.activeElement).toBe(nestedOpener);
      expect(document.body.style.overflow).toBe("hidden");
      expect(pressEscape({ repeat: true }).defaultPrevented).toBe(true);
      expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);

      expect(pressEscape().defaultPrevented).toBe(true);
      expect(document.querySelector('[role="dialog"]')).toBeNull();
      expect(document.activeElement).toBe(opener);
      expect(document.body.style.overflow).toBe(previousOverflow);
      expect(pressEscape({ repeat: true }).defaultPrevented).toBe(true);
      expect(underlyingEscape).not.toHaveBeenCalled();
      expect(inputEscape).not.toHaveBeenCalled();
    }
    expect(pressEscape().defaultPrevented).toBe(false);
    expect(underlyingEscape).toHaveBeenCalledTimes(1);
  });

  it("gives a dialog and a small portalled menu Escape before the viewer, even with focus underneath", () => {
    const close = vi.fn();
    function Layers() {
      const [showDialog, setShowDialog] = useState(true);
      return (
        <FullscreenSurface title="Artifact" onClose={close}>
          <Popover defaultOpen>
            <PopoverTrigger id="menu-trigger">Show menu</PopoverTrigger>
            <PopoverContent role="menu" focusOnOpen={false}>
              Menu body
            </PopoverContent>
          </Popover>
          {showDialog && (
            <DialogBackdrop aria-label="Confirmation" onClose={() => setShowDialog(false)}>
              Confirmation body
            </DialogBackdrop>
          )}
        </FullscreenSurface>
      );
    }
    act(() =>
      root.render(
        <FullscreenSurfaceFixture>
          <Layers />
        </FullscreenSurfaceFixture>,
      ),
    );
    expect(pressEscape().defaultPrevented).toBe(true);
    expect(document.querySelector('[aria-label="Confirmation"]')).toBeNull();
    expect(document.querySelector('[role="menu"]')).not.toBeNull();
    expect(close).not.toHaveBeenCalled();

    expect(pressEscape().defaultPrevented).toBe(true);
    expect(document.querySelector('[role="menu"]:not([inert])')).toBeNull();
    expect(document.activeElement?.id).toBe("menu-trigger");
    expect(close).not.toHaveBeenCalled();

    expect(pressEscape().defaultPrevented).toBe(true);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("ignores Escape while a higher non-shared overlay covers the viewer", () => {
    let closed = false;
    act(() =>
      root.render(
        <FullscreenSurfaceFixture>
          <FullscreenSurface
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
