/**
 * @vitest-environment jsdom
 */
import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  IconButton,
  IconButtonHotkeyProvider,
} from "../../../src/renderer/components/ui/icon-button";
import { NavigationRailLabelsContext } from "../../../src/renderer/components/ui/navigation-rail-labels";

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
    vi.restoreAllMocks();
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

  it.each(["hover", "focus"] as const)(
    "suppresses duplicate %s tooltips only for disclosed rail labels",
    (interaction) => {
      const render = (expanded: boolean, labeled = true) =>
        act(() =>
          root.render(
            <NavigationRailLabelsContext.Provider value={expanded}>
              <IconButton tooltip="Automations" label={labeled ? "Automations" : undefined}>
                icon
              </IconButton>
            </NavigationRailLabelsContext.Provider>,
          ),
        );
      const reveal = () => {
        const button = container.querySelector("button")!;
        vi.spyOn(button, "matches").mockReturnValue(true);
        act(() =>
          button.dispatchEvent(
            interaction === "hover"
              ? new MouseEvent("mouseover", { bubbles: true })
              : new FocusEvent("focusin", { bubbles: true }),
          ),
        );
        act(() => vi.advanceTimersByTime(120));
      };
      render(false);
      reveal();
      expect(document.querySelector('[role="tooltip"]')?.textContent).toBe("Automations");
      render(true);
      expect(document.querySelector('[role="tooltip"]')).toBeNull();
      reveal();
      expect(document.querySelector('[role="tooltip"]')).toBeNull();
      render(false);
      // Collapsing does not resurrect the old bubble.
      expect(document.querySelector('[role="tooltip"]')).toBeNull();
      reveal();
      expect(document.querySelector('[role="tooltip"]')?.textContent).toBe("Automations");
      render(true, false);
      reveal();
      expect(document.querySelector('[role="tooltip"]')?.textContent).toBe("Automations");
    },
  );

  it("cancels pending tooltips when labels become visible", () => {
    const render = (expanded: boolean) =>
      act(() =>
        root.render(
          <NavigationRailLabelsContext.Provider value={expanded}>
            <IconButton tooltip="Project" label="Project">
              icon
            </IconButton>
          </NavigationRailLabelsContext.Provider>,
        ),
      );
    render(false);
    act(() =>
      container
        .querySelector("button")!
        .dispatchEvent(new MouseEvent("mouseover", { bubbles: true })),
    );
    render(true);
    act(() => vi.advanceTimersByTime(120));
    render(false);
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
  });

  it("preserves names, shortcut descriptions, refs, actions and disabled state", () => {
    const ref = createRef<HTMLButtonElement>();
    const clicked = vi.fn();
    const render = (disabled = false) =>
      act(() =>
        root.render(
          <IconButtonHotkeyProvider bindingFor={() => "mod+n"}>
            <NavigationRailLabelsContext.Provider value={true}>
              <IconButton
                ref={ref}
                tooltip="New session"
                ariaLabel="Create session"
                label="New session"
                hotkey="new-session"
                aria-describedby="existing"
                onClick={clicked}
                disabled={disabled}
              >
                icon
              </IconButton>
            </NavigationRailLabelsContext.Provider>
          </IconButtonHotkeyProvider>,
        ),
      );
    render();
    const button = container.querySelector("button")!;
    expect(ref.current).toBe(button);
    expect(button.getAttribute("aria-label")).toBe("Create session");
    const ids = button.getAttribute("aria-describedby")!.split(" ");
    expect(ids[0]).toBe("existing");
    expect(document.getElementById(ids[1]!)?.textContent).toBeTruthy();
    expect(
      container
        .querySelector('[data-slot="icon-button-label"]')
        ?.classList.contains("font-semibold"),
    ).toBe(true);
    act(() => button.click());
    expect(clicked).toHaveBeenCalledTimes(1);
    render(true);
    act(() => button.click());
    expect(button.disabled).toBe(true);
    expect(clicked).toHaveBeenCalledTimes(1);
  });

  it("does not style ordinary labeled buttons as primary navigation", () => {
    act(() =>
      root.render(
        <IconButton tooltip="Other" label="Other">
          icon
        </IconButton>,
      ),
    );
    expect(
      container
        .querySelector('[data-slot="icon-button-label"]')
        ?.classList.contains("font-semibold"),
    ).toBe(false);
  });

  it("does not add a shortcut to buttons without a hotkey", () => {
    act(() => root.render(<IconButton tooltip="Close pane">icon</IconButton>));
    const button = container.querySelector("button")!;
    act(() => button.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })));
    act(() => vi.advanceTimersByTime(120));
    expect(document.querySelector('[role="tooltip"]')?.textContent).toBe("Close pane");
  });
});
