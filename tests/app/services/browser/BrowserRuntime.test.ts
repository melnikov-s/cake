import { afterEach, describe, expect, it, vi } from "vitest";
import { BrowserRuntime } from "../../../../src/services/browser/BrowserRuntime";

const native = vi.hoisted(() => {
  const views: FakeView[] = [];
  class FakeView {
    setVisible = vi.fn();
    setBounds = vi.fn();
    webContents = {
      on: vi.fn(),
      setWindowOpenHandler: vi.fn(),
      loadURL: vi.fn(async () => undefined),
      getURL: () => "http://localhost:3000/",
      getTitle: () => "Fixture",
      isLoading: () => false,
      canGoBack: () => false,
      canGoForward: () => false,
      isDestroyed: () => false,
      close: vi.fn(),
      debugger: { on: vi.fn() },
    };
    constructor() {
      views.push(this);
    }
  }
  return { views, FakeView };
});
vi.mock("electron", () => ({ WebContentsView: native.FakeView }));

const bounds = (sessionId = "one", visible = true) => ({
  sessionId,
  visible,
  x: 80,
  y: 40,
  width: 600,
  height: 400,
});
const windowFixture = () => {
  const children: unknown[] = [];
  return {
    isDestroyed: () => false,
    contentView: {
      children,
      addChildView: (view: unknown) => children.push(view),
      removeChildView: (view: unknown) => children.splice(children.indexOf(view), 1),
    },
  };
};
const fixture = () => {
  const runtime = new BrowserRuntime({ emit: vi.fn() });
  const window = windowFixture();
  return {
    runtime,
    open: (owner = 7, session = "one") => runtime.open(owner, window as never, session),
  };
};
const viewAt = (index = 0) => {
  const view = native.views[index];
  if (!view) throw new Error("Expected a browser view");
  return view;
};

describe("BrowserRuntime fullscreen presentation", () => {
  afterEach(() => {
    native.views.length = 0;
  });

  it("suppresses browser presentation until fullscreen closes without losing current bounds", async () => {
    const { runtime, open } = fixture();
    await open();
    runtime.updateBounds(7, bounds());
    expect(viewAt().setVisible).toHaveBeenLastCalledWith(true);
    runtime.setFullscreenSurfaceOpen(7, true);
    expect(viewAt().setVisible).toHaveBeenLastCalledWith(false);
    runtime.updateBounds(7, { ...bounds(), width: 800 });
    expect(viewAt().setVisible).toHaveBeenLastCalledWith(false);
    runtime.setFullscreenSurfaceOpen(7, false);
    expect(viewAt().setVisible).toHaveBeenLastCalledWith(true);
    expect(viewAt().setBounds).toHaveBeenLastCalledWith({ x: 80, y: 40, width: 800, height: 400 });
    expect(viewAt().webContents.close).not.toHaveBeenCalled();
  });

  it("keeps newly opened and switched sessions hidden and restores only the active one", async () => {
    const { runtime, open } = fixture();
    runtime.setFullscreenSurfaceOpen(7, true);
    await open();
    runtime.updateBounds(7, bounds());
    await open(7, "two");
    runtime.updateBounds(7, bounds("two"));
    expect(viewAt(0).setVisible).toHaveBeenLastCalledWith(false);
    expect(viewAt(1).setVisible).toHaveBeenLastCalledWith(false);
    runtime.setFullscreenSurfaceOpen(7, false);
    expect(viewAt(0).setVisible).toHaveBeenLastCalledWith(false);
    expect(viewAt(1).setVisible).toHaveBeenLastCalledWith(true);
  });

  it("does not restore a browser hidden by a mode change or hide another window", async () => {
    const { runtime, open } = fixture();
    await open();
    runtime.updateBounds(7, bounds());
    await open(8, "two");
    runtime.updateBounds(8, bounds("two"));
    runtime.setFullscreenSurfaceOpen(7, true);
    expect(viewAt(1).setVisible).toHaveBeenLastCalledWith(true);
    runtime.updateBounds(7, bounds("one", false));
    runtime.setFullscreenSurfaceOpen(7, false);
    expect(viewAt(0).setVisible).toHaveBeenLastCalledWith(false);
    expect(viewAt(1).setVisible).toHaveBeenLastCalledWith(true);
  });

  it("clears fullscreen suppression when a window closes", async () => {
    const { runtime, open } = fixture();
    runtime.setFullscreenSurfaceOpen(7, true);
    runtime.closeForWindow(7);
    await open();
    runtime.updateBounds(7, bounds());
    expect(viewAt().setVisible).toHaveBeenLastCalledWith(true);
    runtime.dispose();
    expect(viewAt().webContents.close).toHaveBeenCalledOnce();
  });
});
