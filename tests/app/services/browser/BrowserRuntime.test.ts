import { afterEach, describe, expect, it, vi } from "vitest";
import { BrowserRuntime } from "../../../../src/services/browser/BrowserRuntime";

const native = await vi.hoisted(async () => {
  const { EventEmitter } = await import("node:events");
  const views: FakeView[] = [];
  const config = { hangLoad: false };
  class FakeView {
    setVisible = vi.fn();
    setBounds = vi.fn();
    url = "";
    attached = false;
    webContents = Object.assign(new EventEmitter(), {
      setWindowOpenHandler: vi.fn(),
      loadURL: vi.fn(async (url: string) => {
        if (config.hangLoad) await new Promise(() => {});
        this.url = url;
      }),
      getURL: () => this.url,
      getTitle: () => "Fixture",
      isLoading: () => false,
      canGoBack: () => false,
      canGoForward: () => false,
      isDestroyed: () => false,
      close: vi.fn(() => this.webContents.emit("destroyed")),
      stop: vi.fn(),
      executeJavaScript: vi.fn(() => new Promise(() => {})),
      debugger: Object.assign(new EventEmitter(), {
        isAttached: () => this.attached,
        attach: vi.fn(() => {
          this.attached = true;
        }),
        detach: vi.fn(() => {
          this.attached = false;
          this.webContents.debugger.emit("detach", {}, "target closed");
        }),
        sendCommand: vi.fn<(method: string, params: unknown) => Promise<unknown>>(async () => ({
          data: "pixels",
        })),
      }),
    });
    constructor() {
      views.push(this);
    }
  }
  return { views, FakeView, config };
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

describe("BrowserRuntime native deadlines", () => {
  afterEach(() => {
    vi.useRealTimers();
    native.config.hangLoad = false;
    native.views.length = 0;
  });

  const expectClean = () => {
    const contents = viewAt().webContents;
    expect(contents.listenerCount("destroyed")).toBe(0);
    expect(contents.debugger.listenerCount("detach")).toBe(0);
    // The persistent state listener is not owned by the command.
    expect(contents.listenerCount("render-process-gone")).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  };

  it.each(["Page.captureScreenshot", "Runtime.evaluate"])(
    "bounds a never-resolving %s, detaches pending commands, and accepts a fresh command without replay",
    async (method) => {
      vi.useFakeTimers();
      const { runtime, open } = fixture();
      await open();
      const contents = viewAt().webContents;
      contents.debugger.sendCommand.mockImplementationOnce(() => new Promise(() => {}));
      const pending = runtime.sendCdp("one", method, {});
      const failed = expect(pending).rejects.toThrow(
        `CDP ${method} timed out after 30000ms (deadline 30000ms); outcome unknown`,
      );
      await vi.advanceTimersByTimeAsync(30_000);
      await failed;
      expect(contents.debugger.detach).toHaveBeenCalledOnce();
      expect(contents.debugger.sendCommand).toHaveBeenCalledTimes(1);
      expectClean();
      expect(await runtime.sendCdp("one", "Page.captureScreenshot", {})).toEqual({
        data: "pixels",
      });
      expect(contents.debugger.attach).toHaveBeenCalledTimes(2);
      expectClean();
    },
  );

  it("preserves shorter and explicit long deadlines, and ignores late results", async () => {
    vi.useFakeTimers();
    const { runtime, open } = fixture();
    await open();
    let resolve: (value: unknown) => void = () => {};
    viewAt().webContents.debugger.sendCommand.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const long = runtime.sendCdp(
      "one",
      "Runtime.evaluate",
      { awaitPromise: true },
      undefined,
      120_000,
    );
    await vi.advanceTimersByTimeAsync(60_000);
    expect(viewAt().webContents.debugger.detach).not.toHaveBeenCalled();
    resolve({ result: "done" });
    expect(await long).toEqual({ result: "done" });
    viewAt().webContents.debugger.sendCommand.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const short = runtime.sendCdp("one", "Page.captureScreenshot", {}, undefined, 100);
    const failure = expect(short).rejects.toThrow("deadline 100ms");
    await vi.advanceTimersByTimeAsync(100);
    await failure;
    resolve({ data: "late pixels" });
    await Promise.resolve();
    expectClean();
  });

  it.each(["abort", "detach", "destroyed", "render-process-gone", "close"])(
    "releases a pending command on %s before its deadline",
    async (event) => {
      vi.useFakeTimers();
      const { runtime, open } = fixture();
      await open();
      const contents = viewAt().webContents;
      const controller = new AbortController();
      const remove = vi.spyOn(controller.signal, "removeEventListener");
      contents.debugger.sendCommand.mockImplementation(() => new Promise(() => {}));
      const pending = runtime.sendCdp("one", "Page.captureScreenshot", {}, controller.signal);
      const failure = expect(pending).rejects.toThrow(
        event === "abort" ? "aborted after 0ms" : "disconnected after 0ms",
      );
      if (event === "abort") controller.abort();
      else if (event === "detach") contents.debugger.detach();
      else if (event === "close") runtime.closeForWindow(7);
      else contents.emit(event);
      await failure;
      expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
      expectClean();
    },
  );

  it("pre-abort sends nothing; abort detaches and fails concurrent commands without retries", async () => {
    vi.useFakeTimers();
    const { runtime, open } = fixture();
    await open();
    const contents = viewAt().webContents;
    const controller = new AbortController();
    controller.abort();
    await expect(
      runtime.sendCdp("one", "Page.captureScreenshot", {}, controller.signal),
    ).rejects.toThrow();
    expect(contents.debugger.attach).not.toHaveBeenCalled();
    expect(contents.debugger.sendCommand).not.toHaveBeenCalled();
    contents.debugger.sendCommand.mockImplementation(() => new Promise(() => {}));
    const cancel = new AbortController();
    const first = runtime.sendCdp("one", "Page.captureScreenshot", {}, cancel.signal);
    const second = runtime.sendCdp("one", "Runtime.evaluate", {});
    const failures = [
      expect(first).rejects.toMatchObject({ name: "AbortError" }),
      expect(second).rejects.toThrow("disconnected"),
    ];
    cancel.abort();
    await Promise.all(failures);
    expect(contents.debugger.detach).toHaveBeenCalledOnce();
    expect(contents.debugger.sendCommand).toHaveBeenCalledTimes(2);
    expectClean();
  });

  it.each(["attach", "command"])("cleans up on native %s failure", async (failure) => {
    vi.useFakeTimers();
    const { runtime, open } = fixture();
    await open();
    const contents = viewAt().webContents;
    if (failure === "attach")
      contents.debugger.attach.mockImplementationOnce(() => {
        throw new Error("attach failed");
      });
    else contents.debugger.sendCommand.mockRejectedValueOnce(new Error("command failed"));
    await expect(runtime.sendCdp("one", "Page.captureScreenshot", {})).rejects.toThrow(
      `${failure} failed`,
    );
    expect(contents.debugger.detach).not.toHaveBeenCalled();
    expectClean();
  });

  it.each(["startup", "navigate"])(
    "stops a never-resolving %s navigation on deadline",
    async (operation) => {
      vi.useFakeTimers();
      const { runtime, open } = fixture();
      if (operation === "navigate") await open();
      native.config.hangLoad = true;
      const pending =
        operation === "startup" ? open() : runtime.navigate(7, "one", "https://slow.example/");
      const failure = expect(pending).rejects.toThrow("Browser navigation timed out after 60000ms");
      await vi.advanceTimersByTimeAsync(60_000);
      await failure;
      expect(viewAt().webContents.stop).toHaveBeenCalledOnce();
      expectClean();
    },
  );

  it("stops navigation on caller abort but leaves intentional element selection waiting", async () => {
    vi.useFakeTimers();
    const { runtime, open } = fixture();
    await open();
    const contents = viewAt().webContents;
    const controller = new AbortController();
    contents.loadURL.mockImplementationOnce(() => new Promise(() => {}));
    const pending = runtime.navigate(7, "one", "https://slow.example/", controller.signal);
    const failure = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    controller.abort();
    await failure;
    expect(contents.stop).toHaveBeenCalledOnce();
    await runtime.inspect(7, "one");
    await vi.advanceTimersByTimeAsync(3 * 60 * 60_000);
    expect(runtime.state("one").inspecting).toBe(true);
    expect(contents.debugger.detach).not.toHaveBeenCalled();
    expectClean();
  });
});

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
