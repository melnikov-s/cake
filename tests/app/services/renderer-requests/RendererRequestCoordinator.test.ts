import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { Context, Deferred, Effect, Exit, Fiber, Layer, Option, Queue, Stream } from "effect";
import * as TestClock from "effect/testing/TestClock";
import { describe, expect, vi } from "vitest";
import type { CakeEvent } from "../../../../src/ipc/cake-rpc-contract";
import {
  RendererRequestCoordinator,
  RendererRequestCoordinatorLive,
} from "../../../../src/services/renderer-requests/RendererRequestCoordinator";
import { Electron, type ElectronService } from "../../../../src/services/electron/Electron";

const makeFixture = Effect.gen(function* () {
  const events = yield* Queue.unbounded<CakeEvent>();
  const electron = Layer.mock(Electron, {
    sendTo: (_target, event) => Queue.offerUnsafe(events, event),
    broadcast: () => {},
    requireRendererConnection: vi.fn<ElectronService["requireRendererConnection"]>(),
    workspaceForConnection: () => undefined,
    associateWorkspace: () => {},
    forgetWorkspace: () => {},
    windowsForWorkspace: () => [],
    centerTrafficLights: () => {},
  });
  const context = yield* Layer.build(RendererRequestCoordinatorLive.pipe(Layer.provide(electron)));
  return { coordinator: Context.get(context, RendererRequestCoordinator), events };
});

const createDraft = {
  _tag: "CreateDraft" as const,
  name: "Focused request",
  initialPrompt: "Implement the focused request.",
};

describe("RendererRequestCoordinator", () => {
  it.effect("publishes and completes a correlated Project Session request", () =>
    Effect.gen(function* () {
      const { coordinator, events } = yield* makeFixture;
      yield* coordinator.registerProjectSession("project-1", "/projects/cake");
      yield* coordinator.bind({ _tag: "ProjectSession", sessionId: "project-1" }, 11);

      const fiber = yield* coordinator
        .requestProjectControl("project-1", createDraft, new AbortController().signal)
        .pipe(Effect.forkChild);
      const event = yield* Queue.take(events);
      assert.equal(event.type, "project-session-control-requested");
      assert.equal(event.sessionId, "project-1");

      yield* coordinator.respondProjectControl(11, "project-1", event.controlRequestId, {
        ok: true,
        sessionId: "draft-1",
      });
      expect(yield* Fiber.join(fiber)).toEqual({ ok: true, sessionId: "draft-1" });
    }),
  );

  it.effect("returns renderer rejection results and settles abort cancellation", () =>
    Effect.gen(function* () {
      const { coordinator } = yield* makeFixture;
      yield* coordinator.bind({ _tag: "CakeChatSession", sessionId: "chat-1" }, 21);
      const observed = yield* coordinator
        .cakeChatControlRequests(21)
        .pipe(Stream.take(1), Stream.runHead, Effect.forkChild);
      const rejected = yield* coordinator
        .requestCakeChatControl(
          "chat-1",
          { name: "projects.open", arguments: {} },
          new AbortController().signal,
        )
        .pipe(Effect.forkChild);
      const request = yield* Fiber.join(observed);
      assert.equal(request._tag, "Some");
      yield* coordinator.respondCakeChatControl(21, request.value.controlRequestId, {
        ok: false,
        error: "Not allowed",
      });
      expect(yield* Fiber.join(rejected)).toEqual({ ok: false, error: "Not allowed" });

      const controller = new AbortController();
      const cancelled = yield* coordinator
        .requestCakeChatControl(
          "chat-1",
          { name: "projects.open", arguments: {} },
          controller.signal,
        )
        .pipe(Effect.forkChild);
      controller.abort();
      expect(yield* Fiber.join(cancelled)).toEqual({
        ok: false,
        name: "projects.open",
        error: "The Cake Chat request was cancelled.",
      });

      yield* coordinator.registerProjectSession("project-1", "/projects/cake");
      yield* coordinator.bind({ _tag: "ProjectSession", sessionId: "project-1" }, 22);
      const projectController = new AbortController();
      const projectCancelled = yield* coordinator
        .requestProjectControl("project-1", createDraft, projectController.signal)
        .pipe(Effect.forkChild);
      projectController.abort();
      expect(yield* Fiber.join(projectCancelled)).toEqual({
        ok: false,
        error: "The request was cancelled.",
      });
    }),
  );

  it.effect("rejects wrong renderer and session responses without settling the request", () =>
    Effect.gen(function* () {
      const { coordinator, events } = yield* makeFixture;
      yield* coordinator.registerProjectSession("project-1", "/projects/cake");
      yield* coordinator.bind({ _tag: "ProjectSession", sessionId: "project-1" }, 31);
      const fiber = yield* coordinator
        .requestUi("project-1", {
          kind: "text",
          title: "Answer",
          message: "Provide a value",
          signal: new AbortController().signal,
        })
        .pipe(Effect.forkChild);
      const event = yield* Queue.take(events);
      assert.equal(event.type, "ui-request");

      const wrongRenderer = yield* coordinator
        .respondUi(32, "project-1", {
          sessionId: "project-1",
          requestId: event.requestId,
          uiRequestId: event.uiRequestId,
          cancelled: false,
          value: "wrong renderer",
        })
        .pipe(Effect.exit);
      expect(Exit.isFailure(wrongRenderer)).toBe(true);

      const wrongSession = yield* coordinator
        .respondUi(31, "project-2", {
          sessionId: "project-2",
          requestId: event.requestId,
          uiRequestId: event.uiRequestId,
          cancelled: false,
          value: "wrong session",
        })
        .pipe(Effect.exit);
      expect(Exit.isFailure(wrongSession)).toBe(true);

      const wrongCorrelation = yield* coordinator
        .respondUi(31, "project-1", {
          sessionId: "project-1",
          requestId: crypto.randomUUID(),
          uiRequestId: event.uiRequestId,
          cancelled: false,
          value: "wrong correlation",
        })
        .pipe(Effect.exit);
      expect(Exit.isFailure(wrongCorrelation)).toBe(true);

      yield* coordinator.respondUi(31, "project-1", {
        sessionId: "project-1",
        requestId: event.requestId,
        uiRequestId: event.uiRequestId,
        cancelled: false,
        value: "accepted",
      });
      expect(yield* Fiber.join(fiber)).toBe("accepted");
    }),
  );

  it.effect("correlates widget preview responses by renderer, operation, and token", () =>
    Effect.gen(function* () {
      const { coordinator, events } = yield* makeFixture;
      yield* coordinator.registerProjectSession("project-1", "/projects/cake");
      yield* coordinator.bind({ _tag: "ProjectSession", sessionId: "project-1" }, 31);
      const token = "00000000-0000-4000-8000-000000000001";
      const pending = yield* coordinator
        .withWidgetPreview(
          "project-1",
          { token, url: `cake-widget://document/${token}` },
          new AbortController().signal,
          Effect.succeed,
        )
        .pipe(Effect.forkChild);
      const event = yield* Queue.take(events);
      assert.equal(event.type, "widget-preview-requested");
      const stale = yield* coordinator
        .respondWidgetPreview(31, "project-1", {
          requestId: event.requestId,
          previewRequestId: event.previewRequestId,
          sessionId: "project-1",
          token: "00000000-0000-4000-8000-000000000002",
          cancelled: false,
          rect: { x: 10, y: 20, width: 560, height: 480 },
          diagnostics: [],
        })
        .pipe(Effect.exit);
      expect(Exit.isFailure(stale)).toBe(true);
      yield* coordinator.respondWidgetPreview(31, "project-1", {
        requestId: event.requestId,
        previewRequestId: event.previewRequestId,
        sessionId: "project-1",
        token,
        cancelled: false,
        rect: { x: 10, y: 20, width: 560, height: 480 },
        diagnostics: ["widget=560x480"],
      });
      expect(yield* Fiber.join(pending)).toEqual({
        connectionId: 31,
        rect: { x: 10, y: 20, width: 560, height: 480 },
        diagnostics: ["widget=560x480"],
      });
    }),
  );

  it.effect(
    "dismisses only the mounted token on abort before readiness and releases the lease",
    () =>
      Effect.gen(function* () {
        const { coordinator, events } = yield* makeFixture;
        yield* coordinator.registerProjectSession("project-1", "/projects/cake");
        yield* coordinator.bind({ _tag: "ProjectSession", sessionId: "project-1" }, 45);
        const controller = new AbortController();
        const token = "00000000-0000-4000-8000-000000000021";
        const aborted = yield* coordinator
          .withWidgetPreview(
            "project-1",
            { token, url: `cake-widget://document/${token}` },
            controller.signal,
            Effect.succeed,
          )
          .pipe(Effect.forkChild);
        const requested = yield* Queue.take(events);
        assert.equal(requested.type, "widget-preview-requested");
        controller.abort();
        expect(Exit.isFailure(yield* Fiber.await(aborted))).toBe(true);
        expect(yield* Queue.take(events)).toEqual({ type: "widget-preview-dismissed", token });

        const nextToken = "00000000-0000-4000-8000-000000000022";
        const next = yield* coordinator
          .withWidgetPreview(
            "project-1",
            { token: nextToken, url: `cake-widget://document/${nextToken}` },
            new AbortController().signal,
            () => Effect.succeed("next"),
          )
          .pipe(Effect.forkChild);
        const nextRequest = yield* Queue.take(events);
        assert.equal(nextRequest.type, "widget-preview-requested");
        yield* coordinator.respondWidgetPreview(45, "project-1", {
          requestId: nextRequest.requestId,
          previewRequestId: nextRequest.previewRequestId,
          sessionId: "project-1",
          token: nextToken,
          cancelled: false,
          rect: { x: 1, y: 1, width: 100, height: 100 },
          diagnostics: [],
        });
        expect(yield* Fiber.join(next)).toBe("next");
      }),
  );

  it.effect("dismisses and releases the lease when readiness times out", () =>
    Effect.gen(function* () {
      const { coordinator, events } = yield* makeFixture;
      yield* coordinator.registerProjectSession("project-1", "/projects/cake");
      yield* coordinator.bind({ _tag: "ProjectSession", sessionId: "project-1" }, 46);
      const token = "00000000-0000-4000-8000-000000000023";
      const timedOut = yield* coordinator
        .withWidgetPreview(
          "project-1",
          { token, url: `cake-widget://document/${token}` },
          new AbortController().signal,
          Effect.succeed,
        )
        .pipe(Effect.forkChild);
      const requested = yield* Queue.take(events);
      assert.equal(requested.type, "widget-preview-requested");
      yield* TestClock.adjust("15 seconds");
      expect(Exit.isFailure(yield* Fiber.await(timedOut))).toBe(true);
      expect(yield* Queue.take(events)).toEqual({ type: "widget-preview-dismissed", token });
    }),
  );

  it.effect(
    "holds the renderer lease through late native capture settlement after cancellation",
    () =>
      Effect.gen(function* () {
        const { coordinator, events } = yield* makeFixture;
        yield* coordinator.registerProjectSession("project-a", "/projects/cake");
        yield* coordinator.registerProjectSession("project-b", "/projects/cake");
        yield* coordinator.bind({ _tag: "ProjectSession", sessionId: "project-a" }, 51);
        yield* coordinator.bind({ _tag: "ProjectSession", sessionId: "project-b" }, 51);
        const nativeCapture = yield* Deferred.make<void>();
        const captureStarted = yield* Deferred.make<void>();
        const controller = new AbortController();
        const tokenA = "00000000-0000-4000-8000-000000000011";
        const tokenB = "00000000-0000-4000-8000-000000000012";
        const first = yield* coordinator
          .withWidgetPreview(
            "project-a",
            { token: tokenA, url: `cake-widget://document/${tokenA}` },
            controller.signal,
            () =>
              Deferred.succeed(captureStarted, undefined).pipe(
                Effect.andThen(Effect.uninterruptible(Deferred.await(nativeCapture))),
                Effect.andThen(
                  Effect.suspend(() =>
                    controller.signal.aborted
                      ? Effect.fail("cancelled after native settlement")
                      : Effect.succeed("a"),
                  ),
                ),
              ),
          )
          .pipe(Effect.forkChild);
        const requestA = yield* Queue.take(events);
        assert.equal(requestA.type, "widget-preview-requested");
        yield* coordinator.respondWidgetPreview(51, "project-a", {
          requestId: requestA.requestId,
          previewRequestId: requestA.previewRequestId,
          sessionId: "project-a",
          token: tokenA,
          cancelled: false,
          rect: { x: 1, y: 1, width: 100, height: 100 },
          diagnostics: ["candidate=a"],
        });
        yield* Deferred.await(captureStarted);
        const waitingController = new AbortController();
        const waiting = yield* coordinator
          .withWidgetPreview(
            "project-b",
            { token: tokenB, url: `cake-widget://document/${tokenB}` },
            waitingController.signal,
            () => Effect.succeed("must not run"),
          )
          .pipe(Effect.forkChild);
        waitingController.abort();
        expect(Exit.isFailure(yield* Fiber.await(waiting))).toBe(true);
        expect(Option.isNone(yield* Queue.poll(events))).toBe(true);

        controller.abort();
        const second = yield* coordinator
          .withWidgetPreview(
            "project-b",
            { token: tokenB, url: `cake-widget://document/${tokenB}` },
            new AbortController().signal,
            () => Effect.succeed("b"),
          )
          .pipe(Effect.forkChild);
        expect(Option.isNone(yield* Queue.poll(events))).toBe(true);
        yield* Deferred.succeed(nativeCapture, undefined);
        expect(Exit.isFailure(yield* Fiber.await(first))).toBe(true);
        const dismissedA = yield* Queue.take(events);
        expect(dismissedA).toEqual({ type: "widget-preview-dismissed", token: tokenA });
        const requestB = yield* Queue.take(events);
        assert.equal(requestB.type, "widget-preview-requested");
        yield* coordinator.respondWidgetPreview(51, "project-b", {
          requestId: requestB.requestId,
          previewRequestId: requestB.previewRequestId,
          sessionId: "project-b",
          token: tokenB,
          cancelled: false,
          rect: { x: 1, y: 1, width: 100, height: 100 },
          diagnostics: ["candidate=b"],
        });
        expect(yield* Fiber.join(second)).toBe("b");
      }),
  );

  it.effect("cleans pending requests and bindings on connection and session release", () =>
    Effect.gen(function* () {
      const { coordinator, events } = yield* makeFixture;
      yield* coordinator.registerProjectSession("project-1", "/projects/cake");
      yield* coordinator.bind({ _tag: "ProjectSession", sessionId: "project-1" }, 41);
      const disconnected = yield* coordinator
        .requestProjectControl("project-1", createDraft, new AbortController().signal)
        .pipe(Effect.forkChild);
      yield* Queue.take(events);
      yield* coordinator.releaseConnection(41);
      expect(yield* Fiber.join(disconnected)).toEqual({
        ok: false,
        error: "The Project Session request was cancelled.",
      });

      const unbound = yield* coordinator
        .requestProjectControl("project-1", createDraft, new AbortController().signal)
        .pipe(Effect.exit);
      expect(Exit.isFailure(unbound)).toBe(true);

      yield* coordinator.bind({ _tag: "ProjectSession", sessionId: "project-1" }, 42);
      const stopped = yield* coordinator
        .requestProjectControl("project-1", createDraft, new AbortController().signal)
        .pipe(Effect.forkChild);
      yield* Queue.take(events);
      yield* coordinator.releaseSession({ _tag: "ProjectSession", sessionId: "project-1" });
      expect(yield* Fiber.join(stopped)).toEqual({
        ok: false,
        error: "The Project Session stopped.",
      });
    }),
  );
});
