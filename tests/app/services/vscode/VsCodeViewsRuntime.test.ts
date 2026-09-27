import { afterEach, describe, expect, it, vi } from "vitest";
import { VsCodeViewsRuntime } from "../../../../src/services/vscode/VsCodeViewsRuntime";

const fakeElectron = vi.hoisted(() => {
  let loadURL: () => Promise<void> = async () => undefined;
  const windows: Array<{
    webContents: { id: number };
    isDestroyed(): boolean;
    contentView: { removeChildView: ReturnType<typeof vi.fn> };
  }> = [];
  class FakeView {
    setBackgroundColor = vi.fn();
    setVisible = vi.fn();
    setBounds = vi.fn();
    webContents = {
      on: vi.fn(),
      loadURL: vi.fn(() => loadURL()),
      executeJavaScript: vi.fn(async () => undefined),
      isDestroyed: vi.fn(() => false),
      close: vi.fn(),
      setWindowOpenHandler: vi.fn(),
    };
    constructor() {
      views.push(this);
    }
  }
  const views: FakeView[] = [];
  return {
    views,
    windows,
    FakeView,
    setLoadURL(next: () => Promise<void>) {
      loadURL = next;
    },
  };
});
vi.mock("electron", () => ({
  WebContentsView: fakeElectron.FakeView,
  BrowserWindow: { getAllWindows: () => fakeElectron.windows },
}));
const shownBounds = {
  visible: true,
  x: 292,
  y: 0,
  width: 480,
  height: 820,
  projectSidebarWidth: 292,
};
const hiddenBounds = { ...shownBounds, visible: false };
const unmountedBounds = { ...hiddenBounds, x: 0, y: 0, width: 0, height: 0 };
const endpoint = {
  workspacePath: "/server/project",
  url: "http://127.0.0.1:4321/",
  theme: "dark" as const,
};
const controller = () => new AbortController();
const firstView = () => {
  const view = fakeElectron.views[0];
  if (!view) throw new Error("Expected a native view");
  return view;
};
const fixture = () => {
  const send = vi.fn();
  const runtime = new VsCodeViewsRuntime(send);
  const window = {
    webContents: { id: 7 },
    isDestroyed: () => false,
    contentView: { addChildView: vi.fn(), removeChildView: vi.fn() },
  };
  fakeElectron.windows.push(window);
  return {
    runtime,
    window,
    send,
    open: (signal = controller().signal) => runtime.open(7, window as never, endpoint, signal),
  };
};

describe("VsCodeViewsRuntime native presentation", () => {
  afterEach(() => {
    fakeElectron.views.length = 0;
    fakeElectron.windows.length = 0;
    fakeElectron.setLoadURL(async () => undefined);
  });

  it("loads the server endpoint hidden at its final size and shows it without resizing", async () => {
    const { runtime, open } = fixture();
    runtime.updateBounds(7, hiddenBounds);
    await open();
    const view = firstView();
    expect(view.webContents.loadURL).toHaveBeenCalledWith(endpoint.url);
    expect(view.setVisible).toHaveBeenLastCalledWith(false);
    expect(view.setBounds).toHaveBeenLastCalledWith({ x: 292, y: 0, width: 480, height: 820 });
    runtime.updateBounds(7, shownBounds);
    expect(view.setVisible).toHaveBeenLastCalledWith(true);
    expect(view.setBackgroundColor).toHaveBeenCalledWith("#121519");
    expect(view.webContents.executeJavaScript.mock.calls.flat().join("\n")).toContain(
      "Back to Agent",
    );
  });

  it("retains geometry across unmounts and suppresses presentation under fullscreen surfaces", async () => {
    const { runtime, open } = fixture();
    runtime.updateBounds(7, shownBounds);
    await open();
    const view = firstView();
    runtime.setFullscreenSurfaceOpen(7, true);
    expect(view.setVisible).toHaveBeenLastCalledWith(false);
    runtime.updateBounds(7, unmountedBounds);
    expect(runtime["requestedBounds"].get(7)).toEqual({ ...shownBounds, visible: false });
    runtime.updateBounds(7, shownBounds);
    expect(view.setVisible).toHaveBeenLastCalledWith(false);
    runtime.setFullscreenSurfaceOpen(7, false);
    expect(view.setVisible).toHaveBeenLastCalledWith(true);
  });

  it("routes Back to Agent only to the native owner", async () => {
    const { runtime, open, send } = fixture();
    runtime.updateBounds(7, shownBounds);
    await open();
    expect(runtime.backToAgentForWindow(8)).toBe(false);
    expect(runtime.backToAgentForWindow(7)).toBe(true);
    expect(send).toHaveBeenCalledWith(7, {
      type: "embedded-editor-back-to-agent",
      workspacePath: endpoint.workspacePath,
    });
    expect(runtime.backToAgentForWindow(7)).toBe(false);
  });

  it("closes WebContents as well as detaching views, including a pending load", async () => {
    let finishLoad!: () => void;
    fakeElectron.setLoadURL(
      () =>
        new Promise<void>((resolve) => {
          finishLoad = resolve;
        }),
    );
    const { runtime, open, window } = fixture();
    const abort = controller();
    const opening = open(abort.signal);
    abort.abort();
    finishLoad();
    await expect(opening).rejects.toBeDefined();
    expect(firstView().webContents.close).toHaveBeenCalledOnce();
    expect(window.contentView.addChildView).not.toHaveBeenCalled();
    expect(runtime["views"].size).toBe(0);
  });

  it("reuses an existing endpoint and closes all views on disposal", async () => {
    const { runtime, open, window } = fixture();
    await open();
    await open();
    expect(fakeElectron.views).toHaveLength(1);
    runtime.disposeAll();
    expect(window.contentView.removeChildView).toHaveBeenCalledWith(fakeElectron.views[0]);
    expect(firstView().webContents.close).toHaveBeenCalledOnce();
    await expect(open()).rejects.toThrow("no longer available");
  });
});
