import {
  ClientConnections,
  ClientConnectionsLive,
} from "../../../../src/services/clients/ClientConnections";
import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { Context, Effect, Exit, Fiber, Layer, Queue, References, Schema, Stream } from "effect";
import { describe, expect } from "vitest";
import { observeControls } from "../../../../src/domain/cake-chats/cakeChatOperations";
import {
  artifactEventSchema,
  type CakeEvent,
} from "../../../../src/contracts/application/cake-rpc-contract";
import {
  RendererRequestCoordinator,
  RendererRequestCoordinatorLive,
} from "../../../../src/services/renderer-requests/RendererRequestCoordinator";
import { ClientEvents } from "../../../../src/services/clients/ClientEvents";
import { ClientEventsLive } from "../../../../src/services/clients/ClientEventsLive";

const makeFixture = Effect.gen(function* () {
  const events = yield* Queue.unbounded<CakeEvent>();
  const context = yield* Layer.build(
    RendererRequestCoordinatorLive.pipe(
      Layer.provideMerge(Layer.merge(ClientConnectionsLive, ClientEventsLive)),
    ),
  );
  const clientEvents = Context.get(context, ClientEvents);
  const ready = yield* Queue.unbounded<void>();
  for (const connectionId of [11, 22, 31, 32, 35, 37, 41, 42]) {
    for (const stream of [
      clientEvents.application(connectionId),
      clientEvents.artifacts(connectionId),
    ]) {
      yield* stream.pipe(
        Stream.runForEach((event: CakeEvent) =>
          event.type === "renderer-events-ready"
            ? Queue.offer(ready, undefined)
            : Queue.offer(events, event),
        ),
        Effect.forkScoped,
      );
      yield* Queue.take(ready);
    }
  }
  return {
    coordinator: Context.get(context, RendererRequestCoordinator),
    clients: Context.get(context, ClientConnections),
    clientEvents,
    events,
  };
});

const createDraft = {
  _tag: "CreateDraft" as const,
  name: "Focused request",
  initialPrompt: "Implement the focused request.",
};

describe("RendererRequestCoordinator", () => {
  it.effect("publishes and settles ordinary UI requests without a workflow key", () =>
    Effect.gen(function* () {
      const { coordinator, events } = yield* makeFixture;
      yield* coordinator.registerProjectSession("session", "/projects/cake");
      yield* coordinator.bind({ _tag: "ProjectSession", sessionId: "session" }, 11);
      const pending = yield* coordinator
        .requestUi("session", { kind: "text", title: "Answer", message: "Provide a value" })
        .pipe(Effect.forkChild);
      const event = yield* Queue.take(events);
      assert.equal(event.type, "ui-request");
      yield* Schema.decodeUnknownEffect(artifactEventSchema)(event);
      expect(event).not.toHaveProperty("workflow");
      yield* coordinator.respondUi(11, "session", {
        sessionId: "session",
        requestId: event.requestId,
        uiRequestId: event.uiRequestId,
        cancelled: false,
        value: "accepted",
      });
      expect(yield* Fiber.join(pending)).toBe("accepted");
    }),
  );

  it.effect("publishes and settles workflow choices with their frozen proposal", () =>
    Effect.gen(function* () {
      const { coordinator, events } = yield* makeFixture;
      yield* coordinator.registerProjectSession("session", "/projects/cake");
      yield* coordinator.bind({ _tag: "ProjectSession", sessionId: "session" }, 11);
      const workflow = {
        ownerSessionId: "session",
        program: {
          meta: { name: "focused-workflow", description: "Focused request", phases: ["Verify"] },
          source: "export default async function () {}",
          sourcePath: "/projects/cake/verify.ts",
          args: { verify: true },
        },
      };
      const pending = yield* coordinator
        .requestUi("session", {
          kind: "workflow-choice",
          title: "Run workflow?",
          message: "Choose execution",
          workflow,
        })
        .pipe(Effect.forkChild);
      const event = yield* Queue.take(events);
      assert.equal(event.type, "ui-request");
      yield* Schema.decodeUnknownEffect(artifactEventSchema)(event);
      expect(event.kind).toBe("workflow-choice");
      expect(event.workflow).toEqual(workflow);
      yield* coordinator.respondUi(11, "session", {
        sessionId: "session",
        requestId: event.requestId,
        uiRequestId: event.uiRequestId,
        cancelled: false,
        value: "workflow",
      });
      expect(yield* Fiber.join(pending)).toBe("workflow");
    }),
  );

  it.effect(
    "validates an interview answer before settling and rejects foreign or duplicate responses",
    () =>
      Effect.gen(function* () {
        const { coordinator, events } = yield* makeFixture;
        yield* coordinator.registerProjectSession("session", "/projects/cake");
        yield* coordinator.bind({ _tag: "ProjectSession", sessionId: "session" }, 11);
        const record = {
          id: "call-1",
          sessionId: "session",
          request: {
            protocol: "cake.request/v1" as const,
            id: "choice",
            title: "Choose",
            responseSchema: {
              type: "object" as const,
              properties: { answer: { type: "boolean" as const } },
            },
            view: {
              type: "form" as const,
              fields: [{ id: "answer", label: "Answer", type: "checkbox" as const }],
            },
            fallback: { markdown: "Choose" },
          },
        };
        const pending = yield* coordinator
          .requestInterview("session", record, new AbortController().signal)
          .pipe(Effect.forkChild);
        const event = yield* Queue.take(events);
        assert.equal(event.type, "interview-requested");
        const response = {
          requestId: event.requestId,
          interviewRequestId: event.interviewRequestId,
          sessionId: "session",
          cancelled: false,
          value: { answer: true },
        };
        for (const [connection, session, value] of [
          [22, "session", { answer: true }],
          [11, "wrong-session", { answer: true }],
          [11, "session", { answer: "invalid" }],
        ] as const) {
          expect(
            (yield* coordinator
              .respondInterview(connection, session, { ...response, value })
              .pipe(Effect.exit))._tag,
          ).toBe("Failure");
        }
        expect(
          (yield* coordinator
            .respondInterview(11, "session", {
              ...response,
              interviewRequestId: "wrong-correlation",
            })
            .pipe(Effect.exit))._tag,
        ).toBe("Failure");
        yield* coordinator.respondInterview(11, "session", response);
        expect(yield* Fiber.join(pending)).toEqual({ answer: true });
        expect(
          (yield* coordinator.respondInterview(11, "session", response).pipe(Effect.exit))._tag,
        ).toBe("Failure");
      }),
  );

  it.effect("settles interview cancellation and removes aborted or released correlations", () =>
    Effect.gen(function* () {
      const { coordinator, events } = yield* makeFixture;
      yield* coordinator.registerProjectSession("session", "/projects/cake");
      yield* coordinator.bind({ _tag: "ProjectSession", sessionId: "session" }, 11);
      const record = {
        id: "call-1",
        sessionId: "session",
        request: {
          protocol: "cake.request/v1" as const,
          id: "choice",
          title: "Choose",
          responseSchema: { type: "object" as const },
          view: {
            type: "form" as const,
            fields: [{ id: "answer", label: "Answer", type: "text" as const }],
          },
          fallback: { markdown: "Choose" },
        },
      };
      const controller = new AbortController();
      const start = () =>
        coordinator.requestInterview("session", record, controller.signal).pipe(Effect.forkChild);
      const cancelled = yield* start();
      const event = yield* Queue.take(events);
      assert.equal(event.type, "interview-requested");
      yield* coordinator.respondInterview(11, "session", {
        requestId: event.requestId,
        interviewRequestId: event.interviewRequestId,
        sessionId: "session",
        cancelled: true,
      });
      expect(yield* Fiber.join(cancelled)).toBeUndefined();
      const released = yield* start();
      const releaseEvent = yield* Queue.take(events);
      assert.equal(releaseEvent.type, "interview-requested");
      yield* coordinator.releaseSession({ _tag: "ProjectSession", sessionId: "session" });
      expect(yield* Fiber.join(released)).toBeUndefined();
      expect(
        (yield* coordinator
          .respondInterview(11, "session", {
            requestId: releaseEvent.requestId,
            interviewRequestId: releaseEvent.interviewRequestId,
            sessionId: "session",
            cancelled: true,
          })
          .pipe(Effect.exit))._tag,
      ).toBe("Failure");
      yield* coordinator.bind({ _tag: "ProjectSession", sessionId: "session" }, 11);
      const interrupted = yield* start();
      const abortEvent = yield* Queue.take(events);
      assert.equal(abortEvent.type, "interview-requested");
      controller.abort();
      expect(yield* Fiber.join(interrupted)).toBeUndefined();
      expect(
        (yield* coordinator
          .respondInterview(11, "session", {
            requestId: abortEvent.requestId,
            interviewRequestId: abortEvent.interviewRequestId,
            sessionId: "session",
            cancelled: true,
          })
          .pipe(Effect.exit))._tag,
      ).toBe("Failure");
    }),
  );

  it.effect(
    "remote browser only accepts the bound desktop reply; no desktop and cancellation settle without a stale result",
    () =>
      Effect.gen(function* () {
        const { coordinator, clients, events } = yield* makeFixture;
        const controller = new AbortController();
        const request = () =>
          coordinator.requestBrowserNative(
            "project-1",
            {
              operation: "cdp",
              workspacePath: "/projects/cake",
              method: "Runtime.evaluate",
              params: {},
            },
            controller.signal,
          );
        expect((yield* request().pipe(Effect.exit))._tag).toBe("Failure");
        const browserViewer = clients.socket();
        yield* coordinator.bind({ _tag: "ProjectSession", sessionId: "project-1" }, browserViewer);
        expect((yield* request().pipe(Effect.exit))._tag).toBe("Failure");
        yield* coordinator.bind({ _tag: "ProjectSession", sessionId: "project-1" }, 11);
        const pending = yield* request().pipe(Effect.forkChild({ startImmediately: true }));
        const event = yield* Queue.take(events);
        if (event.type !== "browser-native-requested")
          throw new Error(`Unexpected event ${event.type}`);
        expect(event.operation).toBe("cdp");
        expect(
          (yield* coordinator
            .respondBrowserNative(22, "project-1", event.requestId, {
              status: "completed",
              value: "forged",
            })
            .pipe(Effect.exit))._tag,
        ).toBe("Failure");
        expect(
          (yield* coordinator
            .respondBrowserNative(11, "wrong-session", event.requestId, {
              status: "completed",
              value: "forged",
            })
            .pipe(Effect.exit))._tag,
        ).toBe("Failure");
        yield* coordinator.respondBrowserNative(11, "project-1", event.requestId, {
          status: "completed",
          value: "real",
        });
        expect(yield* Fiber.join(pending)).toEqual({ status: "completed", value: "real" });
        expect(
          (yield* coordinator
            .respondBrowserNative(11, "project-1", event.requestId, {
              status: "completed",
              value: "late",
            })
            .pipe(Effect.exit))._tag,
        ).toBe("Failure");
        const interrupted = yield* request().pipe(Effect.forkChild({ startImmediately: true }));
        const second = yield* Queue.take(events);
        if (second.type !== "browser-native-requested") throw new Error("Browser request missing");
        controller.abort();
        expect((yield* Fiber.await(interrupted))._tag).toBe("Failure");
        expect(
          (yield* coordinator
            .respondBrowserNative(11, "project-1", second.requestId, {
              status: "completed",
              value: "late",
            })
            .pipe(Effect.exit))._tag,
        ).toBe("Failure");
      }),
  );

  it.effect("preview leases require the bound desktop and revoke with session and connection", () =>
    Effect.gen(function* () {
      const { coordinator, clients } = yield* makeFixture;
      const released: string[] = [];
      yield* coordinator.setPreviewBridge({
        acquire: (_connectionId, _sessionId, port) =>
          Effect.succeed({ port, endpoint: `/preview/${"a".repeat(64)}/`, secret: "b".repeat(64) }),
        releaseSession: (id) =>
          Effect.sync(() => {
            released.push(`session:${id}`);
          }),
        releaseConnection: (id) =>
          Effect.sync(() => {
            released.push(`connection:${id}`);
          }),
      });
      const viewer = clients.socket();
      yield* coordinator.bind({ _tag: "ProjectSession", sessionId: "session" }, viewer);
      expect(
        (yield* coordinator.acquirePreview(viewer, "session", 5173).pipe(Effect.exit))._tag,
      ).toBe("Failure");
      yield* coordinator.bind({ _tag: "ProjectSession", sessionId: "session" }, 11);
      expect((yield* coordinator.acquirePreview(22, "session", 5173).pipe(Effect.exit))._tag).toBe(
        "Failure",
      );
      expect(yield* coordinator.acquirePreview(11, "session", 5173)).toEqual({
        port: 5173,
        endpoint: `/preview/${"a".repeat(64)}/`,
        secret: "b".repeat(64),
      });
      yield* coordinator.releaseSession({ _tag: "ProjectSession", sessionId: "session" });
      yield* coordinator.releaseConnection(11);
      expect(released).toEqual(["session:session", "connection:11"]);
    }),
  );

  it.effect("renderer_requests_use_transport_neutral_events", () =>
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

  it.effect("projects pending Cake Chat controls current-first across reconnect and removal", () =>
    Effect.gen(function* () {
      const { coordinator } = yield* makeFixture;
      yield* coordinator.bind({ _tag: "CakeChatSession", sessionId: "chat-1" }, 21);

      // The request exists before the first observer subscribes.
      const requestFiber = yield* coordinator
        .requestCakeChatControl(
          "chat-1",
          { name: "projects.open", arguments: {} },
          new AbortController().signal,
        )
        .pipe(Effect.forkChild({ startImmediately: true }));
      const observe = () =>
        observeControls({ sessionId: "chat-1", tools: [] }, 21).pipe(
          Effect.provideService(RendererRequestCoordinator, coordinator),
        );
      const firstStream = yield* observe();
      const first = yield* firstStream.pipe(Stream.runHead);
      assert.equal(first._tag, "Some");
      expect(first.value.requests).toHaveLength(1);

      // A replacement subscription receives the same pending request exactly once.
      const reconnectedStream = yield* observe();
      const reconnected = yield* reconnectedStream.pipe(Stream.runHead);
      assert.equal(reconnected._tag, "Some");
      expect(reconnected.value.requests.map(({ controlRequestId }) => controlRequestId)).toEqual([
        first.value.requests[0]!.controlRequestId,
      ]);

      yield* coordinator.respondCakeChatControl(21, first.value.requests[0]!.controlRequestId, {
        ok: false,
        error: "Not allowed",
      });
      expect(yield* Fiber.join(requestFiber)).toEqual({ ok: false, error: "Not allowed" });
      const settled = yield* coordinator.cakeChatControlSnapshots(21).pipe(Stream.runHead);
      assert.equal(settled._tag, "Some");
      expect(settled.value).toEqual([]);

      const controller = new AbortController();
      const cancelled = yield* coordinator
        .requestCakeChatControl(
          "chat-1",
          { name: "projects.open", arguments: {} },
          controller.signal,
        )
        .pipe(Effect.forkChild({ startImmediately: true }));
      const pending = yield* coordinator.cakeChatControlSnapshots(21).pipe(Stream.runHead);
      assert.equal(pending._tag, "Some");
      expect(pending.value).toHaveLength(1);
      controller.abort();
      expect(yield* Fiber.join(cancelled)).toEqual({
        ok: false,
        name: "projects.open",
        error: "The Cake Chat request was cancelled.",
      });
      const cleared = yield* coordinator.cakeChatControlSnapshots(21).pipe(Stream.runHead);
      assert.equal(cleared._tag, "Some");
      expect(cleared.value).toEqual([]);

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

  it.effect("settles Cake Chat response atomically when the responder is interrupted", () =>
    Effect.gen(function* () {
      const { coordinator } = yield* makeFixture;
      yield* coordinator.bind({ _tag: "CakeChatSession", sessionId: "chat-1" }, 24);
      const request = yield* coordinator
        .requestCakeChatControl(
          "chat-1",
          { name: "projects.open", arguments: {} },
          new AbortController().signal,
        )
        .pipe(Effect.forkChild({ startImmediately: true }));
      const initial = yield* coordinator.cakeChatControlSnapshots(24).pipe(Stream.runHead);
      assert.equal(initial._tag, "Some");
      const controlRequestId = initial.value[0]!.controlRequestId;
      const removed = yield* coordinator.cakeChatControlSnapshots(24).pipe(
        Stream.filter((requests) => requests.length === 0),
        Stream.runHead,
        Effect.forkChild({ startImmediately: true }),
      );
      const response = yield* coordinator
        .respondCakeChatControl(24, controlRequestId, { ok: true })
        .pipe(
          Effect.provideService(References.MaxOpsBeforeYield, 10),
          Effect.forkChild({ startImmediately: true }),
        );
      yield* Fiber.join(removed);
      yield* Fiber.interrupt(response);

      expect(yield* Fiber.join(request)).toEqual({ ok: true });
      const current = yield* coordinator.cakeChatControlSnapshots(24).pipe(Stream.runHead);
      assert.equal(current._tag, "Some");
      expect(current.value).toEqual([]);
    }),
  );

  it.effect("does not publish a Cake Chat request after its session is released", () =>
    Effect.gen(function* () {
      const { coordinator } = yield* makeFixture;
      yield* coordinator.bind({ _tag: "CakeChatSession", sessionId: "chat-1" }, 25);
      const abort = new AbortController();
      const request = yield* coordinator
        .requestCakeChatControl("chat-1", { name: "projects.open", arguments: {} }, abort.signal)
        .pipe(
          Effect.provideService(References.MaxOpsBeforeYield, 10),
          Effect.forkChild({ startImmediately: true }),
        );
      yield* Effect.yieldNow;
      yield* coordinator.releaseSession({ _tag: "CakeChatSession", sessionId: "chat-1" });
      abort.abort();

      expect(yield* Fiber.join(request)).toEqual({
        ok: false,
        name: "projects.open",
        error: "Cake Chat stopped.",
      });
      const current = yield* coordinator.cakeChatControlSnapshots(25).pipe(Stream.runHead);
      assert.equal(current._tag, "Some");
      expect(current.value).toEqual([]);
    }),
  );

  it.effect("removes a published Cake Chat control when its request fiber is interrupted", () =>
    Effect.gen(function* () {
      const { coordinator } = yield* makeFixture;
      yield* coordinator.bind({ _tag: "CakeChatSession", sessionId: "chat-1" }, 23);
      const published = yield* coordinator.cakeChatControlSnapshots(23).pipe(
        Stream.filter((requests) => requests.length > 0),
        Stream.runHead,
        Effect.forkChild({ startImmediately: true }),
      );
      const request = yield* coordinator
        .requestCakeChatControl(
          "chat-1",
          { name: "projects.open", arguments: {} },
          new AbortController().signal,
        )
        .pipe(Effect.forkChild({ startImmediately: true }));

      const snapshot = yield* Fiber.join(published);
      assert.equal(snapshot._tag, "Some");
      expect(snapshot.value).toHaveLength(1);
      yield* Fiber.interrupt(request);

      const current = yield* coordinator.cakeChatControlSnapshots(23).pipe(Stream.runHead);
      assert.equal(current._tag, "Some");
      expect(current.value).toEqual([]);
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
      // A later binding change must not redirect a pending request's recipient.
      yield* coordinator.bind({ _tag: "ProjectSession", sessionId: "project-1" }, 32);

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

  it.effect(
    "rejects publication to a disconnected event recipient without leaving a pending request",
    () =>
      Effect.gen(function* () {
        const { coordinator } = yield* makeFixture;
        yield* coordinator.bind({ _tag: "ProjectSession", sessionId: "project-1" }, 99);
        const failed = yield* coordinator
          .requestProjectControl("project-1", createDraft, new AbortController().signal)
          .pipe(Effect.exit);
        expect(Exit.isFailure(failed)).toBe(true);
        yield* coordinator.releaseConnection(99);
      }),
  );

  it.effect("rejects requests when only an unrelated recipient event channel is active", () =>
    Effect.gen(function* () {
      const context = yield* Layer.build(
        RendererRequestCoordinatorLive.pipe(
          Layer.provideMerge(Layer.merge(ClientConnectionsLive, ClientEventsLive)),
        ),
      );
      const coordinator = Context.get(context, RendererRequestCoordinator);
      const clientEvents = Context.get(context, ClientEvents);
      const received = yield* Queue.unbounded<CakeEvent>();
      yield* clientEvents.terminals(99).pipe(
        Stream.runForEach((event) => Queue.offer(received, event)),
        Effect.forkScoped,
      );
      expect(yield* Queue.take(received)).toEqual({
        type: "renderer-events-ready",
        channel: "terminals",
      });
      yield* coordinator.bind({ _tag: "ProjectSession", sessionId: "project-1" }, 99);
      const failure = yield* coordinator
        .requestProjectControl("project-1", createDraft, new AbortController().signal)
        .pipe(Effect.flip);
      expect(failure.operation).toBe("publishProjectEvent");
      yield* coordinator.releaseConnection(99);
    }),
  );

  it.effect(
    "a discussion control response survives parent retirement but still cancels with its caller or connection",
    () =>
      Effect.gen(function* () {
        const { coordinator, events } = yield* makeFixture;
        for (const retirement of ["session", "working-directory"] as const) {
          yield* coordinator.registerProjectSession("project-1", "/projects/cake");
          yield* coordinator.bind({ _tag: "ProjectSession", sessionId: "project-1" }, 41);
          const responding = yield* coordinator
            .requestProjectControl(
              "project-1",
              createDraft,
              new AbortController().signal,
              "discussion-session",
            )
            .pipe(Effect.forkChild);
          const event = yield* Queue.take(events);
          if (event.type !== "project-session-control-requested")
            throw new Error(`Unexpected event ${event.type}`);
          if (retirement === "session")
            yield* coordinator.releaseSession({ _tag: "ProjectSession", sessionId: "project-1" });
          else yield* coordinator.releaseWorkingDirectory("/projects/cake");
          yield* coordinator.respondProjectControl(41, "project-1", event.controlRequestId, {
            ok: true,
          });
          expect(yield* Fiber.join(responding)).toEqual({ ok: true });
        }
        yield* coordinator.bind({ _tag: "ProjectSession", sessionId: "project-1" }, 41);
        const controller = new AbortController();
        const cancelled = yield* coordinator
          .requestProjectControl("project-1", createDraft, controller.signal, "discussion-session")
          .pipe(Effect.forkChild);
        yield* Queue.take(events);
        yield* coordinator.releaseSession({ _tag: "ProjectSession", sessionId: "project-1" });
        controller.abort();
        expect(yield* Fiber.join(cancelled)).toEqual({
          ok: false,
          error: "The request was cancelled.",
        });
        yield* coordinator.bind({ _tag: "ProjectSession", sessionId: "project-1" }, 41);
        const disconnected = yield* coordinator
          .requestProjectControl(
            "project-1",
            createDraft,
            new AbortController().signal,
            "discussion-session",
          )
          .pipe(Effect.forkChild);
        yield* Queue.take(events);
        yield* coordinator.releaseSession({ _tag: "ProjectSession", sessionId: "project-1" });
        yield* coordinator.releaseConnection(41);
        expect(yield* Fiber.join(disconnected)).toEqual({
          ok: false,
          error: "The Project Session request was cancelled.",
        });
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
