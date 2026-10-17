import { it } from "@effect/vitest";
import { Context, Effect, Exit, Fiber, Layer, Queue, Stream } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect } from "vitest";
import { CAKE_CHAT_SESSION_ID } from "../../../../src/contracts/cake-chats/cake-chat-identity";
import type { CakeEvent } from "../../../../src/contracts/application/cake-rpc-contract";
import { ClientConnectionsLive } from "../../../../src/services/clients/ClientConnections";
import { ClientEvents } from "../../../../src/services/clients/ClientEvents";
import { ClientEventsLive } from "../../../../src/services/clients/ClientEventsLive";
import {
  RendererRequestCoordinator,
  RendererRequestCoordinatorLive,
} from "../../../../src/services/renderer-requests/RendererRequestCoordinator";

const fixture = Effect.gen(function* () {
  const context = yield* Layer.build(
    RendererRequestCoordinatorLive.pipe(
      Layer.provideMerge(Layer.merge(ClientConnectionsLive, ClientEventsLive)),
    ),
  );
  const events = yield* Queue.unbounded<CakeEvent>();
  yield* Context.get(context, ClientEvents)
    .application(11)
    .pipe(
      Stream.runForEach((event) => Queue.offer(events, event)),
      Effect.forkScoped,
    );
  expect((yield* Queue.take(events)).type).toBe("renderer-events-ready");
  const coordinator = Context.get(context, RendererRequestCoordinator);
  yield* coordinator.bind({ _tag: "ProjectSession", sessionId: "session" }, 11);
  return { coordinator, events };
});
const widget = { token: "token", url: "cake-widget://token" };

describe("native request correlation and deadlines", () => {
  it.effect.each([CAKE_CHAT_SESSION_ID, `project-chat:${"a".repeat(64)}`])(
    "routes Browser control for permanent chat %s through its own desktop binding",
    (sessionId) =>
      Effect.gen(function* () {
        const { coordinator, events } = yield* fixture;
        yield* coordinator.bind({ _tag: "CakeChatSession", sessionId }, 11);
        yield* coordinator.requireDesktopConnection(sessionId, 11);
        const pending = yield* coordinator
          .requestBrowserNative(
            sessionId,
            { operation: "enter", workspacePath: "/project" },
            new AbortController().signal,
          )
          .pipe(Effect.forkChild({ startImmediately: true }));
        const event = yield* Queue.take(events);
        if (event.type !== "browser-native-requested") throw new Error("Expected Browser request");
        expect(event.sessionId).toBe(sessionId);
        expect(
          Exit.isFailure(
            yield* coordinator
              .respondBrowserNative(11, "other-chat", event.requestId, {
                status: "completed",
                value: null,
              })
              .pipe(Effect.exit),
          ),
        ).toBe(true);
        yield* coordinator.respondBrowserNative(11, sessionId, event.requestId, {
          status: "completed",
          value: null,
        });
        expect(yield* Fiber.join(pending)).toEqual({ status: "completed", value: null });
      }),
  );
  it.effect(
    "rejects widget replies from the wrong recipient/session and duplicate or cancelled replies",
    () =>
      Effect.gen(function* () {
        const { coordinator, events } = yield* fixture;
        const controller = new AbortController();
        const start = () =>
          coordinator.requestWidgetCapture("session", widget, controller.signal, { version: 4 });
        const pending = yield* start().pipe(Effect.forkChild({ startImmediately: true }));
        const event = yield* Queue.take(events);
        if (event.type !== "widget-capture-requested") throw new Error("Expected widget capture");
        expect(event.pluginState).toEqual({ version: 4 });
        const result = { ok: true as const, pngBase64: "png", diagnostics: ["ready"] };
        expect(
          Exit.isFailure(
            yield* coordinator
              .respondWidgetCapture(22, "session", event.requestId, result)
              .pipe(Effect.exit),
          ),
        ).toBe(true);
        expect(
          Exit.isFailure(
            yield* coordinator
              .respondWidgetCapture(11, "other-session", event.requestId, result)
              .pipe(Effect.exit),
          ),
        ).toBe(true);
        yield* coordinator.respondWidgetCapture(11, "session", event.requestId, result);
        expect(yield* Fiber.join(pending)).toEqual({ pngBase64: "png", diagnostics: ["ready"] });
        // Completed widget requests deliberately acknowledge late receipts as no-ops.
        yield* coordinator.respondWidgetCapture(11, "session", event.requestId, {
          ...result,
          pngBase64: "duplicate",
        });
        expect(yield* Fiber.join(pending)).toEqual({ pngBase64: "png", diagnostics: ["ready"] });
        const cancelled = yield* start().pipe(Effect.forkChild({ startImmediately: true }));
        const second = yield* Queue.take(events);
        if (second.type !== "widget-capture-requested") throw new Error("Expected widget capture");
        controller.abort();
        expect(Exit.isFailure(yield* Fiber.await(cancelled))).toBe(true);
        yield* coordinator.respondWidgetCapture(11, "session", second.requestId, result);
        expect(Exit.isFailure(yield* Fiber.await(cancelled))).toBe(true);
      }),
  );

  it.effect(
    "keeps backend native deadlines and rejects results after timeout without replaying requests",
    () =>
      Effect.gen(function* () {
        const { coordinator, events } = yield* fixture;
        const signal = new AbortController().signal;
        const browser = yield* coordinator
          .requestBrowserNative(
            "session",
            { operation: "enter", workspacePath: "/project" },
            signal,
          )
          .pipe(Effect.forkChild({ startImmediately: true }));
        const browserEvent = yield* Queue.take(events);
        if (browserEvent.type !== "browser-native-requested")
          throw new Error("Expected browser request");
        yield* TestClock.adjust(15_000);
        expect(Exit.isFailure(yield* Fiber.await(browser))).toBe(true);
        expect(
          Exit.isFailure(
            yield* coordinator
              .respondBrowserNative(11, "session", browserEvent.requestId, {
                status: "completed",
                value: null,
              })
              .pipe(Effect.exit),
          ),
        ).toBe(true);
        const capture = yield* coordinator
          .requestWidgetCapture("session", widget, signal)
          .pipe(Effect.forkChild({ startImmediately: true }));
        const captureEvent = yield* Queue.take(events);
        if (captureEvent.type !== "widget-capture-requested")
          throw new Error("Expected widget capture");
        yield* TestClock.adjust(25_000);
        expect(Exit.isFailure(yield* Fiber.await(capture))).toBe(true);
        yield* coordinator.respondWidgetCapture(11, "session", captureEvent.requestId, {
          ok: true,
          pngBase64: "late",
          diagnostics: [],
        });
        expect(Exit.isFailure(yield* Fiber.await(capture))).toBe(true);
        expect(Queue.takeUnsafe(events)).toBeUndefined();
      }),
  );
});
