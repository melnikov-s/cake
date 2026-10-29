/**
 * @vitest-environment jsdom
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IconButton } from "../../../src/renderer/components/ui/icon-button";

// Real Root/RendererRoot binding updates through Settings and toolbar tooltip
// rendering live in hint-overlay-finish-workflow.test.tsx. Keep pure primitive
// pressed appearance and the no-hotkey tooltip case here.

describe("IconButton shortcut labels", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.useFakeTimers();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  it("supports a tint-only pressed treatment without changing the default solid treatment", () => {
    act(() =>
      root.render(
        <IconButton tooltip="Listening" aria-pressed pressedAppearance="subtle">
          ear
        </IconButton>,
      ),
    );
    const button = container.querySelector("button")!;
    expect(button.getAttribute("aria-pressed")).toBe("true");
    expect(button.classList.contains("aria-pressed:text-accent")).toBe(true);
    act(() =>
      root.render(
        <IconButton tooltip="Selected" aria-pressed>
          icon
        </IconButton>,
      ),
    );
    expect(button.classList.contains("aria-pressed:bg-primary")).toBe(true);
  });

  it("does not add a shortcut to buttons without a hotkey", () => {
    act(() => root.render(<IconButton tooltip="Close pane">icon</IconButton>));
    const button = container.querySelector("button")!;
    act(() => button.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })));
    act(() => vi.advanceTimersByTime(120));
    expect(document.querySelector('[role="tooltip"]')?.textContent).toBe("Close pane");
  });
});
