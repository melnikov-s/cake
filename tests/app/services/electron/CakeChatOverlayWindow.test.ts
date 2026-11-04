import { EventEmitter } from "node:events";
import { CAKE_CHAT_SESSION_ID } from "../../../../src/contracts/cake-chats/cake-chat-identity";
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
  workArea: { x: 1440, y: 25, width: 2000, height: 1100 },
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
      workArea: native.workArea,
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
  native.workArea = { x: 1440, y: 25, width: 2000, height: 1100 };
  native.windows.splice(0);
  native.windowOptions.splice(0);
  native.registered.clear();
  native.blocked.clear();
});

function fixture(focus: CakeWindowFocus = "none", { hidden = false } = {}) {
  const state = { focus };
  const requestFromMain = vi.fn(() => false);
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
    requestFromMain,
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
  return {
    overlay,
    press,
    focusOn,
    prepareWindow,
    onShown,
    readContext,
    reportShortcutError,
    requestFromMain,
  };
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
  emit(event: string): boolean;
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

  it("releases the keys to the native quick-chat menu accelerator while a main window is focused", () => {
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

  it("asks the focused main renderer for its destination without reading selected text", () => {
    const { overlay, requestFromMain, readContext } = fixture("main");
    requestFromMain.mockReturnValue(true);
    overlay.configure({ shortcut: "Mod+`", captureSelectedText: true });
    overlay.invoke();
    expect(requestFromMain).toHaveBeenCalledOnce();
    expect(readContext).not.toHaveBeenCalled();
    expect(native.windows).toHaveLength(0);
    overlay.show({ sessionId: "project-chat:fixture" });
    expect(overlay.isVisible).toBe(true);
    overlay.stop();
  });

  it("toggles only once when global and local shortcut handlers receive the same press", () => {
    const { overlay, press, focusOn, onShown } = fixture("main");
    overlay.configure({ shortcut: "Mod+`", captureSelectedText: false });
    overlay.invokeLocalShortcut();
    expect(overlay.isVisible).toBe(true);
    focusOn("overlay");
    // The panel is non-activating: keep the system-wide registration while typing into it.
    // Local menu/input delivery is ignored regardless of which handler receives the key first.
    overlay.invokeLocalShortcut();
    press();
    overlay.invokeLocalShortcut();
    expect(overlay.isVisible).toBe(false);
    expect(overlayWindow().hide).toHaveBeenCalledOnce();
    expect(onShown).toHaveBeenCalledOnce();
    overlay.stop();
  });

  it("keeps a custom shortcut global so it can also close a focused overlay", () => {
    const { overlay, press, focusOn } = fixture();
    overlay.configure({ shortcut: "Mod+Shift+J", captureSelectedText: false });
    press("CommandOrControl+Shift+J");
    expect(overlay.isVisible).toBe(true);
    focusOn("overlay");
    press("CommandOrControl+Shift+J");
    expect(overlay.isVisible).toBe(false);
    expect(overlayWindow().hide).toHaveBeenCalledOnce();
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
  it("toggles one reused window without re-routing when closing", async () => {
    const { overlay, press, focusOn, prepareWindow, onShown } = fixture();
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
    expect(window.setBounds).toHaveBeenCalledWith({ x: 1440, y: 25, width: 2000, height: 495 });
    expect(window.show).toHaveBeenCalledTimes(1);
    expect(window.focus).toHaveBeenCalledTimes(1);
    expect(onShown).toHaveBeenCalledWith(window, { sessionId: CAKE_CHAT_SESSION_ID });
    expect(overlay.isVisible).toBe(true);

    focusOn("overlay");
    press();
    expect(window.show).toHaveBeenCalledTimes(1);
    expect(window.focus).toHaveBeenCalledTimes(1);
    expect(onShown).toHaveBeenCalledTimes(1);
    expect(overlay.isVisible).toBe(false);
    expect(window.hide).toHaveBeenCalledTimes(1);
    focusOn("none");

    native.workArea = { x: -1280, y: 0, width: 1280, height: 800 };
    press();
    await vi.waitFor(() => expect(window.show).toHaveBeenCalledTimes(2));
    expect(window.setBounds).toHaveBeenLastCalledWith({ x: -1280, y: 0, width: 1280, height: 360 });
    expect(native.windows).toHaveLength(1);
    overlay.stop();
    expect(native.registered.size).toBe(0);
  });

  it.each(["main", "other", "none"] as const)(
    "closes a visible overlay before requesting routing or selected text with %s focused",
    (focus) => {
      const { overlay, requestFromMain, readContext, onShown } = fixture(focus);
      requestFromMain.mockReturnValue(true);
      overlay.show({ sessionId: "project-chat:fixture" });
      overlay.invoke("shortcut");
      expect(overlay.isVisible).toBe(false);
      expect(overlayWindow().hide).toHaveBeenCalledOnce();
      expect(requestFromMain).not.toHaveBeenCalled();
      expect(readContext).not.toHaveBeenCalled();
      expect(onShown).toHaveBeenCalledOnce();
      overlay.stop();
    },
  );

  it("dismisses on native window blur and reuses the renderer on reopen", () => {
    const { overlay } = fixture();
    overlay.show({ sessionId: "project-chat:fixture" });
    const window = overlayWindow();
    window.emit("blur");
    expect(overlay.isVisible).toBe(false);
    expect(window.hide).toHaveBeenCalledOnce();
    overlay.show({ sessionId: "project-chat:fixture" });
    expect(overlay.isVisible).toBe(true);
    expect(native.windows).toHaveLength(1);
    overlay.stop();
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
      sessionId: CAKE_CHAT_SESSION_ID,
      selectedText: { text: "quoted", application: "Safari" },
    });

    overlay.hide();
    overlay.invoke("menu");
    expect(readContext).toHaveBeenCalledTimes(1);
    expect(onShown).toHaveBeenLastCalledWith(overlayWindow(), { sessionId: CAKE_CHAT_SESSION_ID });
    overlay.hide();

    // A failed read still drops the overlay down, without context.
    readContext.mockRejectedValueOnce(new Error("osascript timed out"));
    press();
    await vi.waitFor(() => expect(overlay.isVisible).toBe(true));
    expect(onShown).toHaveBeenLastCalledWith(overlayWindow(), { sessionId: CAKE_CHAT_SESSION_ID });
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
    overlay.invoke();
    expect(native.windows).toHaveLength(2);
    expect(overlay.isVisible).toBe(true);
    overlay.stop();
  });

  it("spans the full work-area width and preserves height, including small displays", () => {
    expect(overlayBounds({ x: 0, y: 25, width: 1440, height: 875 })).toEqual({
      x: 0,
      y: 25,
      width: 1440,
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
