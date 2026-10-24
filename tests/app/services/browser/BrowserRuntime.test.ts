import { afterEach, describe, expect, it, vi } from "vitest";
import { BrowserRuntime } from "../../../../src/services/browser/BrowserRuntime";

const native = vi.hoisted(() => {
  const views: FakeView[] = [];
  class FakeView {
    setVisible = vi.fn();
    setBounds = vi.fn();
    url = "";
    webContents = {
      on: vi.fn(),
      setWindowOpenHandler: vi.fn(),
      loadURL: vi.fn(async (url: string) => {
        this.url = url;
      }),
      getURL: () => this.url,
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
    open: (owner = 7, session = "one", startupUrl?: string, url?: string) =>
      runtime.open(owner, window as never, session, url, undefined, startupUrl),
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

  it.each([undefined, "", "   "])(
    "uses Google for an unset or cleared startup URL (%j)",
    async (url) => {
      const { open } = fixture();
      const state = await open(7, "one", url);
      expect(state.url).toBe("https://www.google.com/");
      expect(viewAt().webContents.loadURL).toHaveBeenCalledExactlyOnceWith(
        "https://www.google.com/",
      );
    },
  );

  it("keeps startup locations isolated and preserves navigation across mode/session/window switches", async () => {
    const { runtime, open } = fixture();
    expect((await open(7, "one", "http://localhost:5173/start")).url).toBe(
      "http://localhost:5173/start",
    );
    await runtime.navigate(7, "one", "http://localhost:5173/current");
    runtime.updateBounds(7, bounds("one", false));
    expect((await open(7, "two", "https://example.com/")).url).toBe("https://example.com/");
    expect((await open(7, "one", "https://changed.example/")).url).toBe(
      "http://localhost:5173/current",
    );
    expect((await open(8, "one", "https://changed.example/")).url).toBe(
      "http://localhost:5173/current",
    );
    expect(viewAt().webContents.loadURL).toHaveBeenCalledTimes(2);
    // Explicit navigation retains its original meaning; it is not a default.
    expect(
      (await open(8, "one", "https://ignored.example/", "https://explicit.example/")).url,
    ).toBe("https://explicit.example/");
  });

  it("fills a view without a location but preserves an intentional blank page", async () => {
    const { runtime, open } = fixture();
    await open();
    viewAt().url = "";
    expect((await open(7, "one", "https://example.com/")).url).toBe("https://example.com/");
    await runtime.navigate(7, "one", "about:blank");
    expect((await open(7, "one", "https://changed.example/")).url).toBe("about:blank");
  });

  it("prefers an explicit URL to a configured startup URL for a new browser", async () => {
    const { open } = fixture();
    expect(
      (await open(7, "one", "https://default.example/", "https://explicit.example/")).url,
    ).toBe("https://explicit.example/");
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
