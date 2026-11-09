/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultApplicationState } from "../../../src/contracts/application/application-data";
import { renderAppShellNavigation } from "./app-shell-navigation-fixture";

beforeEach(() => {
  vi.stubGlobal("PointerEvent", MouseEvent);
  Object.defineProperty(SVGElement.prototype, "getBBox", {
    configurable: true,
    value: () => ({ x: 0, y: 0, width: 24, height: 24 }),
  });
  Object.defineProperty(SVGElement.prototype, "getScreenCTM", {
    configurable: true,
    value: () => null,
  });
});
afterEach(() => {
  cleanup();
  Reflect.deleteProperty(SVGElement.prototype, "getBBox");
  Reflect.deleteProperty(SVGElement.prototype, "getScreenCTM");
  vi.unstubAllGlobals();
});
const rail = () => screen.getByRole("navigation", { name: "Projects and global utilities" });
const edge = () => document.querySelector('[data-slot="project-rail-edge"]');
const fixture = () =>
  renderAppShellNavigation({
    vscode: {
      open: async () => undefined,
      updateBounds: async () => undefined,
      setTheme: async () => undefined,
      updateAnnotations: async () => undefined,
      updateSelectionHighlights: async () => undefined,
    },
  });

describe("VS Code honors the shared left toolbar preference", () => {
  it.each([false, true])(
    "keeps Auto-hide %s across chat, editor and browser modes",
    async (autoHide) => {
      using f = fixture();
      act(() =>
        f.root.settingsStore.applyApplicationState(1, {
          ...defaultApplicationState(),
          leftToolbar: { autoHide, layout: autoHide ? "full" : "dynamic" },
        }),
      );
      await f.selectSession("alpha");
      await screen.findByRole("combobox", { name: "Message" });
      expect(rail().dataset.autoHide).toBe(String(autoHide));
      await f.user.click(screen.getByRole("button", { name: "VS Code" }));
      expect(rail().dataset.autoHide).toBe(String(autoHide));
      expect(Boolean(edge())).toBe(autoHide);
      if (autoHide) {
        fireEvent.pointerEnter(edge()!);
        expect(rail().dataset.revealed).toBe("true");
        fireEvent.pointerLeave(rail());
        expect(rail().dataset.revealed).toBe("false");
      }
      await f.user.click(screen.getByRole("button", { name: "Main" }));
      expect(rail().dataset.autoHide).toBe(String(autoHide));
      act(() => f.root.projectWorkbenchStore.presentationStore.browserStore.showAgentBrowser());
      expect(rail().dataset.autoHide).toBe(String(autoHide));
    },
  );
});
