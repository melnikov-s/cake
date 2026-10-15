import { EventEmitter } from "node:events";
import type { BrowserWindowConstructorOptions } from "electron";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CakeChatOverlayShownContext } from "../../../../src/contracts/desktop/cake-chat-overlay-data";
import { CakeChatOverlayWindow } from "../../../../src/services/electron/CakeChatOverlayWindow";
import {
  overlayBounds,
  overlayShortcutActive,
  type CakeWindowFocus,
} from "../../../../src/services/electron/cake-chat-overlay-policy";

const native = vi.hoisted(() => ({
  windows: [] as unknown[],
  windowOptions: [] as BrowserWindowConstructorOptions[],
  registered: new Map<string, () => void>(),
  blocked: new Set<string>(),
}));
vi.mock("electron", () => ({
  BrowserWindow: class extends EventEmitter {
    destroyed = false;
    webContents = new EventEmitter();
    setAlwaysOnTop = vi.fn();
    setVisibleOnAllWorkspaces = vi.fn();
    setBounds = vi.fn();
    show = vi.fn();
    focus = vi.fn();
    hide = vi.fn();
    loadFile = vi.fn(async () => undefined);
    loadURL = vi.fn(async () => undefined);
    constructor(options: BrowserWindowConstructorOptions) {
      super();
      native.windowOptions.push(options);
      native.windows.push(this);
    }
    isDestroyed() {
      return this.destroyed;
    }
    destroy() {
      this.destroyed = true;
      this.emit("closed");
    }
  },
  screen: {
    getCursorScreenPoint: () => ({ x: 2000, y: 10 }),
    getDisplayNearestPoint: () => ({
      workArea: { x: 1440, y: 25, width: 2000, height: 1100 },
    }),
  },
  globalShortcut: {
    register: (key: string, action: () => void) => {
      if (native.blocked.has(key) || native.registered.has(key)) return false;
      native.registered.set(key, action);
      return true;
    },
    unregister: (key: string) => {
      native.registered.delete(key);
    },
  },
}));

beforeEach(() => {
  native.windows.splice(0);
  native.windowOptions.splice(0);
  native.registered.clear();
  native.blocked.clear();
});

function fixture(focus: CakeWindowFocus = "none", { hidden = false } = {}) {
  const state = { focus };
  const prepareWindow = vi.fn();
  const onShown = vi.fn();
  const readContext = vi.fn(async (): Promise<CakeChatOverlayShownContext> => ({}));
  const reportShortcutError = vi.fn();
  const overlay = new CakeChatOverlayWindow({
    preloadPath: "/preload",
    rendererPath: "/renderer/index.html",
    hidden,
    registerShortcuts: true,
    focus: () => state.focus,
    prepareWindow,
    onShown,
    readContext,
    reportShortcutError,
  });
  const press = (key = "CommandOrControl+`") => {
    const action = native.registered.get(key);
    if (!action) throw new Error(`${key} is not registered`);
    action();
  };
  const focusOn = (next: CakeWindowFocus) => {
    state.focus = next;
    overlay.sync();
  };
  return { overlay, press, focusOn, prepareWindow, onShown, readContext, reportShortcutError };
}

type FakeWindow = {
  show: ReturnType<typeof vi.fn>;
  hide: ReturnType<typeof vi.fn>;
  focus: ReturnType<typeof vi.fn>;
  setBounds: ReturnType<typeof vi.fn>;
  setAlwaysOnTop: ReturnType<typeof vi.fn>;
  setVisibleOnAllWorkspaces: ReturnType<typeof vi.fn>;
  loadFile: ReturnType<typeof vi.fn>;
  destroy(): void;
};
const overlayWindow = () => native.windows.at(-1) as FakeWindow;

describe("Drop-down Cake Chat shortcut routing", () => {
  it("gives the shortcut to the system everywhere except a focused main Cake window", () => {
    expect(overlayShortcutActive("CommandOrControl+`", "none")).toBe(true);
    expect(overlayShortcutActive("CommandOrControl+`", "overlay")).toBe(true);
    expect(overlayShortcutActive("CommandOrControl+`", "other")).toBe(true);
    expect(overlayShortcutActive("CommandOrControl+`", "main")).toBe(false);
    expect(overlayShortcutActive("", "none")).toBe(false);
  });

  it("releases the keys to the in-app terminal toggle while a main window is focused", () => {
    const { overlay, focusOn } = fixture("main");
    overlay.configure({ shortcut: "Mod+`", captureSelectedText: true });
    // Validated against the system, then released because the main window owns the keys.
    expect(native.registered.size).toBe(0);
    focusOn("none");
    expect([...native.registered.keys()]).toEqual(["CommandOrControl+`"]);
    focusOn("overlay");
    expect([...native.registered.keys()]).toEqual(["CommandOrControl+`"]);
    focusOn("main");
    expect(native.registered.size).toBe(0);
    overlay.stop();
  });

  it("reports a conflict without disabling the working shortcut, and can be turned off", () => {
    const { overlay } = fixture();
    overlay.configure({ shortcut: "Mod+`", captureSelectedText: true });
    native.blocked.add("CommandOrControl+Shift+K");
    expect(() => overlay.configure({ shortcut: "Mod+Shift+K", captureSelectedText: true })).toThrow(
      "CommandOrControl+Shift+K is already used",
    );
    expect([...native.registered.keys()]).toEqual(["CommandOrControl+`"]);
    overlay.configure({ shortcut: "Mod+Shift+J", captureSelectedText: true });
    expect([...native.registered.keys()]).toEqual(["CommandOrControl+Shift+J"]);
    overlay.configure({ shortcut: "", captureSelectedText: true });
    expect(native.registered.size).toBe(0);
    overlay.stop();
  });

  it("reports when another app claimed the keys while Cake had focus", () => {
    const { overlay, focusOn, reportShortcutError } = fixture("main");
    overlay.configure({ shortcut: "Mod+`", captureSelectedText: true });
    native.blocked.add("CommandOrControl+`");
    focusOn("none");
    expect(reportShortcutError).toHaveBeenCalledWith(
      expect.stringContaining("CommandOrControl+` is already used"),
    );
    native.blocked.clear();
    focusOn("other");
    expect([...native.registered.keys()]).toEqual(["CommandOrControl+`"]);
    overlay.stop();
  });
});

describe("Drop-down Cake Chat window", () => {
  it("drops one reused window down on the pointer's display and toggles it away", async () => {
    const { overlay, press, prepareWindow, onShown } = fixture();
    overlay.configure({ shortcut: "Mod+`", captureSelectedText: true });
    press();
    await vi.waitFor(() => expect(native.windows).toHaveLength(1));
    const window = overlayWindow();
    expect(native.windowOptions[0]).toMatchObject({
      show: false,
      frame: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      movable: false,
    });
    expect(native.windowOptions[0]!.type).toBe(process.platform === "darwin" ? "panel" : undefined);
    expect(window.setAlwaysOnTop).toHaveBeenCalledWith(true, "floating");
    expect(window.setVisibleOnAllWorkspaces).toHaveBeenCalledWith(true, {
      visibleOnFullScreen: true,
      skipTransformProcessType: true,
    });
    expect(window.loadFile).toHaveBeenCalledWith("/renderer/index.html", {
      query: { cakeChatOverlay: "1" },
    });
    expect(prepareWindow).toHaveBeenCalledWith(window);
    expect(window.setBounds).toHaveBeenCalledWith({ x: 1640, y: 25, width: 1600, height: 495 });
    expect(window.show).toHaveBeenCalledTimes(1);
    expect(window.focus).toHaveBeenCalledTimes(1);
    expect(onShown).toHaveBeenCalledWith(window, {});
    expect(overlay.isVisible).toBe(true);

    press();
    expect(window.hide).toHaveBeenCalledTimes(1);
    expect(overlay.isVisible).toBe(false);

    press();
    await vi.waitFor(() => expect(window.show).toHaveBeenCalledTimes(2));
    expect(native.windows).toHaveLength(1);
    overlay.stop();
    expect(native.registered.size).toBe(0);
  });

  it("reads the other app's selection before taking focus, and only from the shortcut", async () => {
    const { overlay, press, readContext, onShown } = fixture("other");
    const selection = Promise.withResolvers<CakeChatOverlayShownContext>();
    readContext.mockReturnValueOnce(selection.promise);
    overlay.configure({ shortcut: "Mod+`", captureSelectedText: true });
    press();
    // A second press while the selection is still being read must not start another read.
    press();
    expect(readContext).toHaveBeenCalledTimes(1);
    expect(native.windows).toHaveLength(0);
    selection.resolve({ selectedText: { text: "quoted", application: "Safari" } });
    await vi.waitFor(() => expect(overlayWindow()?.focus).toHaveBeenCalledTimes(1));
    expect(onShown).toHaveBeenLastCalledWith(overlayWindow(), {
      selectedText: { text: "quoted", application: "Safari" },
    });

    overlay.hide();
    overlay.toggle("menu");
    expect(readContext).toHaveBeenCalledTimes(1);
    expect(onShown).toHaveBeenLastCalledWith(overlayWindow(), {});
    overlay.hide();

    // A failed read still drops the overlay down, without context.
    readContext.mockRejectedValueOnce(new Error("osascript timed out"));
    press();
    await vi.waitFor(() => expect(overlay.isVisible).toBe(true));
    expect(onShown).toHaveBeenLastCalledWith(overlayWindow(), {});
    overlay.hide();

    overlay.configure({ shortcut: "Mod+`", captureSelectedText: false });
    press();
    expect(readContext).toHaveBeenCalledTimes(2);
    expect(overlay.isVisible).toBe(true);
    overlay.stop();
  });

  it("recreates the renderer after the window is closed and never presents it in tests", () => {
    const { overlay } = fixture("none", { hidden: true });
    overlay.show();
    const first = overlayWindow();
    expect(first.show).not.toHaveBeenCalled();
    first.destroy();
    expect(overlay.isVisible).toBe(false);
    overlay.toggle();
    expect(native.windows).toHaveLength(2);
    expect(overlay.isVisible).toBe(true);
    overlay.stop();
  });

  it("uses a wide strip about 45% of the work-area height, within small displays", () => {
    expect(overlayBounds({ x: 0, y: 25, width: 1440, height: 875 })).toEqual({
      x: 144,
      y: 25,
      width: 1152,
      height: 394,
    });
    expect(overlayBounds({ x: 0, y: 0, width: 700, height: 300 })).toEqual({
      x: 0,
      y: 0,
      width: 700,
      height: 300,
    });
  });
});
