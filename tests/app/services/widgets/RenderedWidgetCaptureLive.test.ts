import { it } from "@effect/vitest";
import { Deferred, Effect, Fiber } from "effect";
import { beforeEach, describe, expect, vi } from "vitest";
import { RenderedWidgetCapture } from "../../../../src/services/widgets/RenderedWidgetCapture";
import { RenderedWidgetCaptureLive } from "../../../../src/services/widgets/RenderedWidgetCaptureLive";

const native = vi.hoisted(() => ({
  create: vi.fn(),
  setTitle: vi.fn(),
  destroy: vi.fn(),
  loadURL: vi.fn<() => Promise<void>>(),
  setWindowOpenHandler: vi.fn(),
  executeJavaScript: vi.fn<(script: string, userGesture: boolean) => Promise<unknown>>(),
  capturePage: vi.fn<() => Promise<{ toPNG: () => Buffer }>>(),
}));

vi.mock("electron", () => ({
  BrowserWindow: class {
    constructor(options: unknown) {
      native.create(options);
    }
    setTitle = native.setTitle;
    destroy = native.destroy;
    loadURL = native.loadURL;
    webContents = {
      setWindowOpenHandler: native.setWindowOpenHandler,
      executeJavaScript: native.executeJavaScript,
      capturePage: native.capturePage,
    };
  },
}));

const widget = {
  token: "00000000-0000-4000-8000-000000000001",
  url: "cake-widget://document/00000000-0000-4000-8000-000000000001",
};

beforeEach(() => {
  vi.resetAllMocks();
  native.loadURL.mockResolvedValue(undefined);
  native.executeJavaScript.mockResolvedValue({
    rect: { x: 0, y: 0, width: 560, height: 480 },
    diagnostics: ["viewport=560x480"],
  });
  native.capturePage.mockResolvedValue({ toPNG: () => Buffer.from("png") });
});

describe("RenderedWidgetCaptureLive", () => {
  it.effect("uses the capture contract with a sandboxed window and releases it", () =>
    Effect.gen(function* () {
      const capture = yield* RenderedWidgetCapture;
      const result = yield* capture.capture("session", widget, new AbortController().signal, {
        count: 1,
      });
      expect(result).toEqual({ pngBase64: "cG5n", diagnostics: ["viewport=560x480"] });
      expect(native.create).toHaveBeenCalledWith(
        expect.objectContaining({
          width: 560,
          height: 480,
          show: false,
          webPreferences: expect.objectContaining({
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            offscreen: true,
          }),
        }),
      );
      const script = native.executeJavaScript.mock.calls[0]?.[0];
      expect(script).toContain('frame.sandbox = "allow-scripts"');
      expect(script).toContain('frame.referrerPolicy = "no-referrer"');
      expect(script).toContain("event.source !== frame.contentWindow");
      expect(script).toContain("value.token !== token");
      expect(script).toContain(widget.url);
      expect(script).toContain('pluginState: {"count":1}');
      expect(native.destroy).toHaveBeenCalledOnce();
    }).pipe(Effect.provide(RenderedWidgetCaptureLive)),
  );

  it.effect("does not create a native window for an already cancelled capture", () =>
    Effect.gen(function* () {
      const controller = new AbortController();
      controller.abort();
      const capture = yield* RenderedWidgetCapture;
      const error = yield* Effect.flip(capture.capture("session", widget, controller.signal));
      expect(error.kind).toBe("cancelled");
      expect(native.create).not.toHaveBeenCalled();
    }).pipe(Effect.provide(RenderedWidgetCaptureLive)),
  );

  it.effect(
    "keeps the window and serialization permit until cancelled native capture settles",
    () =>
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        const pixels = yield* Deferred.make<{ toPNG: () => Buffer }>();
        const toPNG = vi.fn(() => Buffer.from("cancelled pixels"));
        let capturing = false;
        native.create.mockImplementation(() => expect(capturing).toBe(false));
        native.destroy.mockImplementation(() => expect(capturing).toBe(false));
        native.capturePage.mockImplementationOnce(() => {
          capturing = true;
          Deferred.doneUnsafe(entered, Effect.void);
          return Effect.runPromise(Deferred.await(pixels));
        });
        const finishPixels = () => {
          capturing = false;
          Deferred.doneUnsafe(pixels, Effect.succeed({ toPNG }));
        };
        const capture = yield* RenderedWidgetCapture;
        const controller = new AbortController();
        const first = yield* capture
          .capture("first", widget, controller.signal)
          .pipe(Effect.flip, Effect.forkChild);
        yield* Effect.gen(function* () {
          yield* Deferred.await(entered);
          controller.abort();
          const second = yield* capture
            .capture("second", widget, new AbortController().signal)
            .pipe(Effect.forkChild({ startImmediately: true }));
          yield* Effect.yieldNow;
          expect(native.create).toHaveBeenCalledOnce();
          expect(native.destroy).not.toHaveBeenCalled();
          finishPixels();
          expect((yield* Fiber.join(first)).kind).toBe("cancelled");
          expect(yield* Fiber.join(second)).toEqual({
            pngBase64: "cG5n",
            diagnostics: ["viewport=560x480"],
          });
          expect(toPNG).not.toHaveBeenCalled();
          expect(native.create).toHaveBeenCalledTimes(2);
          expect(native.destroy).toHaveBeenCalledTimes(2);
        }).pipe(Effect.ensuring(Effect.sync(finishPixels)));
      }).pipe(Effect.provide(RenderedWidgetCaptureLive)),
  );

  it.effect(
    "cancels a queued capture without acquiring a window or disturbing the active capture",
    () =>
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        const pixels = yield* Deferred.make<{ toPNG: () => Buffer }>();
        native.capturePage.mockImplementationOnce(() => {
          Deferred.doneUnsafe(entered, Effect.void);
          return Effect.runPromise(Deferred.await(pixels));
        });
        const capture = yield* RenderedWidgetCapture;
        const first = yield* capture
          .capture("active", widget, new AbortController().signal)
          .pipe(Effect.forkChild);
        const finishPixels = () =>
          Deferred.doneUnsafe(pixels, Effect.succeed({ toPNG: () => Buffer.from("png") }));
        yield* Effect.gen(function* () {
          yield* Deferred.await(entered);
          const controller = new AbortController();
          const queued = yield* capture
            .capture("queued", widget, controller.signal)
            .pipe(Effect.flip, Effect.forkChild({ startImmediately: true }));
          controller.abort();
          expect((yield* Fiber.join(queued)).kind).toBe("cancelled");
          expect(native.create).toHaveBeenCalledOnce();
          expect(native.destroy).not.toHaveBeenCalled();
          finishPixels();
          expect((yield* Fiber.join(first)).pngBase64).toBe("cG5n");
          expect(native.capturePage).toHaveBeenCalledOnce();
          expect(native.destroy).toHaveBeenCalledOnce();
        }).pipe(Effect.ensuring(Effect.sync(finishPixels)));
      }).pipe(Effect.provide(RenderedWidgetCaptureLive)),
  );

  it.effect.each([
    [{ diagnostics: [], runtimeError: "render failed" }, "widget"],
    [{ diagnostics: [], runtimeError: "Widget did not become ready" }, "infrastructure"],
    [{ diagnostics: [] }, "infrastructure"],
    [{ rect: { x: 0, y: 0, width: 1, height: 480 }, diagnostics: [] }, "infrastructure"],
    [{ rect: "untrusted", diagnostics: [] }, "infrastructure"],
  ] as const)(
    "preserves prepared-result validation and error classification %#",
    ([prepared, kind]) =>
      Effect.gen(function* () {
        native.executeJavaScript.mockResolvedValue(prepared);
        const capture = yield* RenderedWidgetCapture;
        const error = yield* Effect.flip(
          capture.capture("session", widget, new AbortController().signal),
        );
        expect(error.kind).toBe(kind);
        expect(native.capturePage).not.toHaveBeenCalled();
        expect(native.destroy).toHaveBeenCalledOnce();
      }).pipe(Effect.provide(RenderedWidgetCaptureLive)),
  );

  it.effect("rejects empty pixels and releases the native window", () =>
    Effect.gen(function* () {
      native.capturePage.mockResolvedValue({ toPNG: () => Buffer.alloc(0) });
      const capture = yield* RenderedWidgetCapture;
      const error = yield* Effect.flip(
        capture.capture("session", widget, new AbortController().signal),
      );
      expect(error.kind).toBe("infrastructure");
      expect(error.message).toBe("Widget preview capture is empty or too large");
      expect(native.destroy).toHaveBeenCalledOnce();
    }).pipe(Effect.provide(RenderedWidgetCaptureLive)),
  );
});
