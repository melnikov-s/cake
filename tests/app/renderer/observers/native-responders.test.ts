import { it } from "@effect/vitest";
import { Deferred, Effect, Exit, Queue } from "effect";
import { describe, expect, vi } from "vitest";
import type { CakeEvent } from "../../../../src/contracts/application/cake-rpc-contract";
import { BrowserError } from "../../../../src/contracts/browser/browser-errors";
import { RenderedWidgetCaptureError } from "../../../../src/contracts/widgets/rendered-widget-capture-errors";
import { CakeIpcClient, type CakeIpcClientService } from "../../../../src/ipc/client/CakeIpcClient";
import { respondBrowserNative } from "../../../../src/renderer/observers/browser-native-responder";
import { respondWidgetCapture } from "../../../../src/renderer/observers/widget-capture-responder";
import { createNativeRequestDispatch } from "../../../../src/renderer/observers/native-request-dispatch";
import type { Runtime } from "../../../../src/renderer/runtime";

// Typed, fail-on-unconfigured service boundary; no Store or domain policy is mocked.
function clientFor(overrides: {
  [Group in keyof CakeIpcClientService]?: Partial<CakeIpcClientService[Group]>;
}): CakeIpcClientService {
  return new Proxy(Object.create(null) as CakeIpcClientService, {
    get(_target, group: keyof CakeIpcClientService) {
      return new Proxy(overrides[group] ?? {}, {
        get(service, operation) {
          if (Reflect.has(service, operation)) return Reflect.get(service, operation);
          return () => {
            throw new Error(`Unexpected native request: ${String(group)}.${String(operation)}`);
          };
        },
      });
    },
  });
}

const browserRequest: Extract<CakeEvent, { type: "browser-native-requested" }> = {
  type: "browser-native-requested",
  requestId: "browser-request",
  sessionId: "session",
  workspacePath: "/project",
  operation: "enter",
};
const captureRequest: Extract<CakeEvent, { type: "widget-capture-requested" }> = {
  type: "widget-capture-requested",
  requestId: "capture-request",
  sessionId: "session",
  widget: { token: "token", url: "cake-widget://token" },
  pluginState: { version: 7 },
};

describe("native responders", () => {
  it.effect(
    "preserves enter, CDP and event-read payloads and correlation without retrying mutations",
    () =>
      Effect.gen(function* () {
        const enter = vi.fn<CakeIpcClientService["browser"]["native-browser-enter"]>(() =>
          Effect.succeed({}),
        );
        const cdp = vi.fn<CakeIpcClientService["browser"]["native-browser-cdp"]>(() =>
          Effect.succeed({ status: "completed", value: { answer: 42 } }),
        );
        const events = vi.fn<CakeIpcClientService["browser"]["native-browser-events"]>(() =>
          Effect.succeed({ status: "completed", value: [] }),
        );
        const reply = vi.fn<CakeIpcClientService["browser"]["respond-browser-native"]>(() =>
          Effect.succeed({}),
        );
        const client = clientFor({
          browser: {
            "native-browser-enter": enter,
            "native-browser-cdp": cdp,
            "native-browser-events": events,
            "respond-browser-native": reply,
          },
        });
        yield* respondBrowserNative(browserRequest, "desktop").pipe(
          Effect.provideService(CakeIpcClient, client),
        );
        yield* respondBrowserNative(
          {
            ...browserRequest,
            operation: "cdp",
            method: "Runtime.evaluate",
            params: { expression: "42" },
          },
          "desktop",
        ).pipe(Effect.provideService(CakeIpcClient, client));
        yield* respondBrowserNative({ ...browserRequest, operation: "events" }, "desktop").pipe(
          Effect.provideService(CakeIpcClient, client),
        );
        expect(enter).toHaveBeenCalledExactlyOnceWith({
          sessionId: "session",
          workspacePath: "/project",
        });
        expect(cdp).toHaveBeenCalledExactlyOnceWith({
          sessionId: "session",
          method: "Runtime.evaluate",
          params: { expression: "42" },
        });
        expect(events).toHaveBeenCalledExactlyOnceWith({
          sessionId: "session",
          methods: [],
          limit: 100,
          clear: true,
        });
        expect(reply.mock.calls.map(([input]) => input)).toEqual([
          {
            requestId: "browser-request",
            sessionId: "session",
            result: { status: "completed", value: null },
          },
          {
            requestId: "browser-request",
            sessionId: "session",
            result: { status: "completed", value: { answer: 42 } },
          },
          {
            requestId: "browser-request",
            sessionId: "session",
            result: { status: "completed", value: [] },
          },
        ]);
      }),
  );

  it.effect(
    "replies once for native failures, browser-host denial and incomplete CDP; rejected late replies never replay native work",
    () =>
      Effect.gen(function* () {
        const enter = vi.fn<CakeIpcClientService["browser"]["native-browser-enter"]>(() =>
          Effect.fail(new BrowserError({ operation: "enter", message: "x".repeat(2500) })),
        );
        const reply = vi.fn<CakeIpcClientService["browser"]["respond-browser-native"]>(() =>
          Effect.succeed({}),
        );
        const client = clientFor({
          browser: { "native-browser-enter": enter, "respond-browser-native": reply },
        });
        yield* respondBrowserNative(browserRequest, "desktop").pipe(
          Effect.provideService(CakeIpcClient, client),
        );
        expect(reply.mock.calls[0]![0].result).toEqual({
          status: "failed",
          message: "x".repeat(2000),
        });
        yield* respondBrowserNative(browserRequest, "browser").pipe(
          Effect.provideService(CakeIpcClient, client),
        );
        yield* respondBrowserNative({ ...browserRequest, operation: "cdp" }, "desktop").pipe(
          Effect.provideService(CakeIpcClient, client),
        );
        expect(reply.mock.calls[1]![0].result).toEqual({
          status: "failed",
          message: "Native Browser Mode is unavailable in this browser",
        });
        expect(reply.mock.calls[2]![0].result).toEqual({
          status: "failed",
          message: "Incomplete CDP request",
        });
        reply.mockImplementation(() =>
          Effect.fail(
            new BrowserError({ operation: "respond", message: "Request is no longer pending" }),
          ),
        );
        const rejected = yield* respondBrowserNative(browserRequest, "desktop").pipe(
          Effect.provideService(CakeIpcClient, client),
          Effect.exit,
        );
        expect(Exit.isFailure(rejected)).toBe(true);
        expect(enter).toHaveBeenCalledTimes(2);
        expect(reply).toHaveBeenCalledTimes(4);
      }),
  );

  it.effect(
    "preserves widget state, success diagnostics and capture failure categories; browser hosts cannot capture",
    () =>
      Effect.gen(function* () {
        const capture = vi.fn<CakeIpcClientService["widgets"]["capture-native-widget"]>(() =>
          Effect.succeed({ pngBase64: "png", diagnostics: ["ready"] }),
        );
        const reply = vi.fn<CakeIpcClientService["widgets"]["respond-widget-capture"]>(() =>
          Effect.succeed({}),
        );
        const client = clientFor({
          widgets: { "capture-native-widget": capture, "respond-widget-capture": reply },
        });
        yield* respondWidgetCapture(captureRequest, "desktop").pipe(
          Effect.provideService(CakeIpcClient, client),
        );
        expect(capture).toHaveBeenCalledExactlyOnceWith({
          sessionId: "session",
          widget: captureRequest.widget,
          pluginState: { version: 7 },
        });
        expect(reply.mock.calls[0]![0]).toEqual({
          requestId: "capture-request",
          sessionId: "session",
          result: { ok: true, pngBase64: "png", diagnostics: ["ready"] },
        });
        capture.mockImplementation(() =>
          Effect.fail(
            new RenderedWidgetCaptureError({ kind: "cancelled", message: "Capture cancelled" }),
          ),
        );
        yield* respondWidgetCapture(captureRequest, "desktop").pipe(
          Effect.provideService(CakeIpcClient, client),
        );
        expect(reply.mock.calls[1]![0].result).toEqual({
          ok: false,
          kind: "cancelled",
          message: "Capture cancelled",
        });
        yield* respondWidgetCapture(captureRequest, "browser").pipe(
          Effect.provideService(CakeIpcClient, client),
        );
        expect(reply.mock.calls[2]![0].result).toEqual({
          ok: false,
          kind: "infrastructure",
          message: "Native widget capture is unavailable in this browser",
        });
        expect(capture).toHaveBeenCalledTimes(2);
      }),
  );

  it.effect(
    "owns in-flight work until disposal and suppresses duplicate receipts before and after completion",
    () =>
      Effect.gen(function* () {
        const started = yield* Queue.unbounded<void>();
        const finished = yield* Queue.unbounded<void>();
        const release = yield* Deferred.make<void>();
        const exits = yield* Queue.unbounded<Exit.Exit<unknown, unknown>>();
        const client = clientFor({});
        const execute: Runtime["execute"] = (effect, signal) =>
          Effect.runPromise(
            effect.pipe(
              Effect.provideService(CakeIpcClient, client),
              Effect.onExit((exit) => Queue.offer(exits, exit)),
            ),
            signal ? { signal } : undefined,
          );
        const runtime: Runtime = {
          execute,
          observe: () => () => undefined,
          dispose: async () => undefined,
        };
        const report = vi.fn();
        const dispatch = createNativeRequestDispatch(runtime, report);
        const work = Effect.gen(function* () {
          yield* Queue.offer(started, undefined);
          yield* Deferred.await(release);
          yield* Queue.offer(finished, undefined);
        });
        dispatch.dispatch("one", work, "native");
        yield* Queue.take(started);
        dispatch.dispatch("one", work, "native");
        yield* Deferred.succeed(release, undefined);
        yield* Queue.take(finished);
        yield* Queue.take(exits);
        dispatch.dispatch("one", work, "native");
        expect(Queue.takeUnsafe(started)).toBeUndefined();
        dispatch.dispatch(
          "two",
          Effect.gen(function* () {
            yield* Queue.offer(started, undefined);
            yield* Effect.never;
          }),
          "native",
        );
        yield* Queue.take(started);
        dispatch.dispose();
        expect(Exit.isFailure(yield* Queue.take(exits))).toBe(true);
        dispatch.dispatch("three", work, "native");
        expect(Queue.takeUnsafe(started)).toBeUndefined();
        expect(report).not.toHaveBeenCalled();
      }),
  );
});
