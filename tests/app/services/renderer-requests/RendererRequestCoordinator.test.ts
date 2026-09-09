import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { Context, Effect, Exit, Fiber, Layer, Queue, Stream } from "effect";
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
