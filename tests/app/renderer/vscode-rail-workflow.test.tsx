/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderAppShellNavigation } from "./app-shell-navigation-fixture";

const hoverQuery = "(any-hover: hover) and (any-pointer: fine)";
let hover = true;
const listeners = new Set<() => void>();
function setHover(value: boolean) {
  act(() => {
    hover = value;
    for (const listener of listeners) listener();
  });
}

beforeEach(() => {
  hover = true;
  vi.stubGlobal("PointerEvent", MouseEvent);
  Object.defineProperty(SVGElement.prototype, "getBBox", {
    configurable: true,
    value: () => ({ x: 0, y: 0, width: 24, height: 24 }),
  });
  Object.defineProperty(SVGElement.prototype, "getScreenCTM", {
    configurable: true,
    value: () => null,
  });
  vi.stubGlobal("matchMedia", (query: string): MediaQueryList => ({
    media: query,
    get matches() {
      return query === hoverQuery && hover;
    },
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener(_event: string, listener: EventListenerOrEventListenerObject) {
      if (query === hoverQuery) listeners.add(listener as () => void);
    },
    removeEventListener(_event: string, listener: EventListenerOrEventListenerObject) {
      listeners.delete(listener as () => void);
    },
    dispatchEvent: () => true,
  }));
});
afterEach(() => {
  cleanup();
  listeners.clear();
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

describe("VS Code rail disclosure", () => {
  it.each([false, true])("auto-hides only VS Code with hover capability %s", async (capable) => {
    hover = capable;
    using f = fixture();
    await f.selectSession("alpha");
    await screen.findByRole("combobox", { name: "Message" });
    expect(rail().dataset.autoHide).toBe("false");
    expect(edge()).toBeNull();
    await f.user.click(screen.getByRole("button", { name: "VS Code" }));
    expect(rail().dataset.autoHide).toBe(String(capable));
    expect(Boolean(edge())).toBe(capable);
    await f.user.click(screen.getByRole("button", { name: "Main" }));
    expect(rail().dataset.autoHide).toBe("false");
    expect(edge()).toBeNull();
    act(() => f.root.projectWorkbenchStore.presentationStore.browserStore.showAgentBrowser());
    expect(rail().dataset.autoHide).toBe("false");
    expect(edge()).toBeNull();
  });

  it("reveals the existing navigation at the edge, resets on leave and responds to input changes", async () => {
    using f = fixture();
    await f.selectSession("alpha");
    await screen.findByRole("combobox", { name: "Message" });
    await f.user.click(screen.getByRole("button", { name: "VS Code" }));
    expect(rail().dataset.revealed).toBe("false");
    fireEvent.pointerEnter(edge()!);
    expect(rail().dataset.revealed).toBe("true");
    expect(screen.getByRole("button", { name: "Open Project Chat for beta" })).toBeDefined();
    fireEvent.pointerLeave(rail());
    expect(rail().dataset.revealed).toBe("false");
    setHover(false);
    expect(rail().dataset.autoHide).toBe("false");
    expect(edge()).toBeNull();
    setHover(true);
    expect(rail().dataset.autoHide).toBe("true");
    expect(rail().dataset.revealed).toBe("false");
    fireEvent.pointerEnter(edge()!);
    await f.user.click(screen.getByRole("button", { name: "Open Cake Chat" }));
    await waitFor(() => expect(f.root.workspaceProjectPath).toBeUndefined());
    expect(rail().dataset.autoHide).toBe("false");
  });
});
