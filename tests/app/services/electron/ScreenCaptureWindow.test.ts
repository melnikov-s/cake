import { EventEmitter } from "node:events";
import type { BrowserWindow } from "electron";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ScreenCaptureWindow } from "../../../../src/services/electron/ScreenCaptureWindow";
import {
  captureAccelerator,
  captureOutputSize,
  captureRect,
} from "../../../../src/domain/screen-capture/screen-capture-data";

const native = vi.hoisted(() => ({
  windows: [] as unknown[],
  onWindow: undefined as ((window: unknown) => void) | undefined,
  registered: new Map<string, () => void>(),
  permission: "granted",
  blocked: "",
  sources: vi.fn(),
  output: { width: 2400, height: 1200 },
}));
vi.mock("electron", () => ({
  BrowserWindow: class extends EventEmitter {
    id = native.windows.length + 10;
    destroyed = false;
    webContents = Object.assign(new EventEmitter(), {
      id: this.id * 10,
      setWindowOpenHandler: vi.fn(),
    });
    setAlwaysOnTop = vi.fn();
    setVisibleOnAllWorkspaces = vi.fn();
    show = vi.fn();
    focus = vi.fn();
    hide = vi.fn();
    constructor() {
      super();
      native.windows.push(this);
      const created = native.onWindow;
      native.onWindow = undefined;
      created?.(this);
    }
    async loadFile() {}
    async loadURL() {}
    isDestroyed() {
      return this.destroyed;
    }
    destroy() {
      this.destroyed = true;
      this.emit("closed");
    }
  },
  desktopCapturer: { getSources: native.sources },
  screen: {
    getCursorScreenPoint: () => ({ x: -100, y: 10 }),
    getDisplayNearestPoint: () => ({
      id: 2,
      bounds: { x: -1200, y: 0, width: 1200, height: 600 },
      size: { width: 1200, height: 600 },
      scaleFactor: 2,
    }),
  },
  systemPreferences: { getMediaAccessStatus: () => native.permission },
  dialog: { showErrorBox: vi.fn() },
  globalShortcut: {
    register: (key: string, action: () => void) => {
      if (key === native.blocked) return false;
      native.registered.set(key, action);
      return true;
    },
    unregister: (key: string) => {
      native.registered.delete(key);
    },
  },
  nativeImage: {
    createFromDataURL: () => ({
      isEmpty: () => false,
      getSize: () => native.output,
      resize: (size: { width: number; height: number }) => {
        native.output = size;
        return { toPNG: () => Buffer.from("resized") };
      },
      toPNG: () => Buffer.from("original"),
    }),
  },
}));

import { BrowserWindow as NativeWindow } from "electron";

beforeEach(() => {
  native.windows.splice(0);
  native.onWindow = undefined;
  native.registered.clear();
  native.blocked = "";
  native.permission = "granted";
  native.output = { width: 2400, height: 1200 };
  native.sources.mockReset();
  native.sources.mockResolvedValue([
    {
      display_id: "2",
      thumbnail: {
        isEmpty: () => false,
        getSize: () => ({ width: 2400, height: 1200 }),
        toDataURL: () => "data:image/png;base64,still",
      },
    },
  ]);
});
function fixture() {
  const owner = new NativeWindow({ show: false });
  const requestCapture = vi.fn();
  const capture = new ScreenCaptureWindow({
    preloadPath: "/preload",
    rendererPath: "/renderer",
    hidden: true,
    targetWindow: () => owner,
    requestCapture,
  });
  capture.configure(owner, { shortcut: "Mod+Shift+6", maxDimension: 1024 });
  return { owner, capture, requestCapture };
}
function startOverlay(
  capture: ScreenCaptureWindow,
  owner: BrowserWindow,
  signal = new AbortController().signal,
) {
  const created = new Promise<BrowserWindow>((resolve) => {
    native.onWindow = (window) => {
      if (!(window instanceof NativeWindow)) throw new Error("Missing overlay");
      resolve(window);
    };
  });
  const running = capture.start(owner, signal);
  return { created, running };
}

describe("Native screen capture lifetime", () => {
  it("selects the pointer's Retina display and exposes pixels only to the overlay owner", async () => {
    const { owner, capture } = fixture();
    const { running, created } = startOverlay(capture, owner);
    const window = await created;
    expect(native.sources).toHaveBeenCalledWith({
      types: ["screen"],
      thumbnailSize: { width: 2400, height: 1200 },
      fetchWindowIcons: false,
    });
    expect(() => capture.state(owner.webContents.id)).toThrow("does not own");
    expect(capture.state(window.webContents.id)).toMatchObject({
      width: 2400,
      height: 1200,
      maxDimension: 1024,
    });
    capture.finish(window.webContents.id, "data:image/png;base64,composed");
    expect(await running).toEqual({ data: Buffer.from("resized").toString("base64") });
    expect(native.output).toMatchObject({ width: 1024, height: 512 });
    expect(window.isDestroyed()).toBe(true);
    capture.stop();
  });
  it("rejects concurrent activation, tears down on cancellation, and permits another capture", async () => {
    const { owner, capture } = fixture();
    const controller = new AbortController();
    const { running, created } = startOverlay(capture, owner, controller.signal);
    const window = await created;
    await expect(capture.start(owner, new AbortController().signal)).rejects.toThrow(
      "already open",
    );
    controller.abort();
    expect(await running).toEqual({});
    expect(window.isDestroyed()).toBe(true);
    const retry = startOverlay(capture, owner);
    const next = await retry.created;
    capture.finish(next.webContents.id);
    expect(await retry.running).toEqual({});
    capture.stop();
  });
  it("creates no overlay when cancelled during screen acquisition", async () => {
    let resolve!: (sources: unknown[]) => void;
    native.sources.mockImplementation(
      () =>
        new Promise((complete) => {
          resolve = complete;
        }),
    );
    const { owner, capture } = fixture();
    const controller = new AbortController();
    const running = capture.start(owner, controller.signal);
    controller.abort();
    resolve([]);
    expect(await running).toEqual({});
    expect(native.windows).toHaveLength(1);
    capture.stop();
  });
  it("cancels when the overlay closes and unregisters only its own shortcut on shutdown", async () => {
    const { owner, capture, requestCapture } = fixture();
    native.registered.get("CommandOrControl+Shift+6")?.();
    expect(requestCapture).toHaveBeenCalledWith(owner);
    const { running, created } = startOverlay(capture, owner);
    (await created).destroy();
    expect(await running).toEqual({});
    native.registered.set("OtherShortcut", () => {});
    capture.stop();
    expect([...native.registered.keys()]).toEqual(["OtherShortcut"]);
  });
  it("does not open a late overlay after shutdown during screen acquisition", async () => {
    let resolve!: (sources: unknown[]) => void;
    native.sources.mockImplementation(
      () =>
        new Promise((complete) => {
          resolve = complete;
        }),
    );
    const { owner, capture } = fixture();
    const running = capture.start(owner, new AbortController().signal);
    capture.stop();
    resolve([]);
    expect(await running).toEqual({});
    expect(native.windows).toHaveLength(1);
  });
  it("keeps the working shortcut when a replacement is unavailable", () => {
    const { owner, capture } = fixture();
    native.blocked = "CommandOrControl+Shift+7";
    expect(() => capture.configure(owner, { shortcut: "Mod+Shift+7", maxDimension: 1024 })).toThrow(
      "unavailable",
    );
    expect(native.registered.has("CommandOrControl+Shift+6")).toBe(true);
    capture.configure(owner, { shortcut: "", maxDimension: 1024 });
    expect(native.registered.size).toBe(0);
    capture.stop();
  });
});

describe("Capture geometry", () => {
  it("normalizes reverse-direction crops", () =>
    expect(captureRect({ x: 80, y: 90 }, { x: 10, y: 20 })).toEqual({
      x: 10,
      y: 20,
      width: 70,
      height: 70,
    }));
  it("caps the longest edge without enlarging small captures", () => {
    expect(captureOutputSize(4000, 2000, 1024)).toEqual({ width: 1024, height: 512 });
    expect(captureOutputSize(300, 600, 1024)).toEqual({ width: 300, height: 600 });
  });
  it("converts recorded shortcuts into native accelerators", () => {
    expect(captureAccelerator("Mod+Shift+6")).toBe("CommandOrControl+Shift+6");
    expect(captureAccelerator("Ctrl+Alt+ArrowUp")).toBe("Control+Alt+Up");
    expect(captureAccelerator("")).toBe("");
  });
});
