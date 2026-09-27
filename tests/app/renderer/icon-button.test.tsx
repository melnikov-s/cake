/**
 * @vitest-environment jsdom
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createStore, mount } from "r-state-tree";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  IconButton,
  IconButtonHotkeyProvider,
} from "../../../src/renderer/components/ui/icon-button";
import { formatHotkey } from "../../../src/renderer/lib/hotkeys";
import { HotkeySettingsStore } from "../../../src/renderer/stores/HotkeySettingsStore";

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

  it("shows the current binding at the end of the tooltip, but not in the accessible name", () => {
    using hotkeys = mount(createStore(HotkeySettingsStore));
    act(() =>
      root.render(
        <IconButtonHotkeyProvider bindingFor={(id) => hotkeys.bindingFor(id)}>
          <IconButton tooltip="Toggle sidebar" hotkey="toggle-sidebar">
            icon
          </IconButton>
        </IconButtonHotkeyProvider>,
      ),
    );
    const button = container.querySelector("button")!;
    const showTooltip = () => {
      act(() => button.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })));
      act(() => vi.advanceTimersByTime(120));
      return document.querySelector('[role="tooltip"]')?.textContent;
    };

    expect(showTooltip()).toBe(`Toggle sidebar (${formatHotkey("Mod+B")})`);
    expect(button.getAttribute("aria-label")).toBe("Toggle sidebar");

    act(() => hotkeys.assign("toggle-sidebar", "Mod+Shift+B"));
    expect(showTooltip()).toBe(`Toggle sidebar (${formatHotkey("Mod+Shift+B")})`);

    act(() => hotkeys.clear("toggle-sidebar"));
    expect(showTooltip()).toBe("Toggle sidebar");
  });

  it("does not add a shortcut to buttons without a hotkey", () => {
    act(() => root.render(<IconButton tooltip="Close pane">icon</IconButton>));
    const button = container.querySelector("button")!;
    act(() => button.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })));
    act(() => vi.advanceTimersByTime(120));
    expect(document.querySelector('[role="tooltip"]')?.textContent).toBe("Close pane");
  });
});
