/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { NavigationRail } from "../../../src/renderer/components/ui/navigation-rail";
import { IconButton } from "../../../src/renderer/components/ui/icon-button";

let canHover = true;
let mediaChanged: () => void;
beforeEach(() => {
  vi.useFakeTimers();
  canHover = true;
  vi.stubGlobal("matchMedia", () => ({
    get matches() {
      return canHover;
    },
    addEventListener: (_: string, listener: () => void) => {
      mediaChanged = listener;
    },
    removeEventListener() {},
  }));
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function rail(autoHide = false, revealed = false) {
  return (
    <NavigationRail
      label="Navigation"
      autoHide={autoHide}
      revealed={revealed}
      onOverlayRightChange={() => {}}
      header={
        <IconButton tooltip="Cake Chat" label="Cake Chat">
          icon
        </IconButton>
      }
      footer={
        <IconButton tooltip="Settings" label="Settings">
          icon
        </IconButton>
      }
    >
      <IconButton tooltip="Project" label="Project">
        icon
      </IconButton>
      <IconButton tooltip="Unlabeled utility">icon</IconButton>
    </NavigationRail>
  );
}

it("shares actual hover/focus disclosure, retaining expansion between child focus targets", () => {
  render(rail());
  const nav = screen.getByRole("navigation");
  expect(nav.dataset.labelsVisible).toBe("false");
  fireEvent.mouseEnter(nav);
  expect(nav.dataset.labelsVisible).toBe("true");
  fireEvent.focus(screen.getByRole("button", { name: "Cake Chat" }));
  fireEvent.mouseLeave(nav);
  expect(nav.dataset.labelsVisible).toBe("true");
  fireEvent.blur(screen.getByRole("button", { name: "Cake Chat" }), {
    relatedTarget: screen.getByRole("button", { name: "Settings" }),
  });
  expect(nav.dataset.labelsVisible).toBe("true");
  fireEvent.blur(screen.getByRole("button", { name: "Settings" }));
  expect(nav.dataset.labelsVisible).toBe("false");
});

it("keeps icon-only tooltips on non-hover input and cancels them when disclosure changes", () => {
  canHover = false;
  render(rail());
  const nav = screen.getByRole("navigation");
  const project = screen.getByRole("button", { name: "Project" });
  fireEvent.mouseEnter(project);
  act(() => vi.advanceTimersByTime(120));
  expect(nav.dataset.labelsVisible).toBe("false");
  expect(screen.getByRole("tooltip").textContent).toBe("Project");
  act(() => {
    canHover = true;
    mediaChanged();
  });
  expect(nav.dataset.labelsVisible).toBe("true");
  expect(screen.queryByRole("tooltip")).toBeNull();
  fireEvent.mouseEnter(screen.getByRole("button", { name: "Unlabeled utility" }));
  act(() => vi.advanceTimersByTime(120));
  expect(screen.getByRole("tooltip").textContent).toBe("Unlabeled utility");
});

it("recognizes edge-revealed auto-hide rails without any fullscreen dependency", () => {
  const view = render(rail(true));
  expect(screen.getByRole("navigation").dataset.labelsVisible).toBe("false");
  view.rerender(rail(true, true));
  expect(screen.getByRole("navigation").dataset.labelsVisible).toBe("true");
});
