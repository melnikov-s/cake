import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { Cause, Deferred, Effect, Exit, Layer, Queue, Schema, Stream } from "effect";
import { defaultApplicationState } from "../../../src/contracts/application/application-data";
import { parseCrossSessionMessage } from "../../../src/contracts/conversations/cross-session-message";
import { SessionFamilyStorageError } from "../../../src/contracts/storage/session-family-storage-errors";
import { acquireOptions } from "../../../src/domain/project-sessions/projectSessionRuntime";
import { route } from "../../../src/domain/session-families/sessionFamilyMessaging";
import { ProjectSessionError } from "../../../src/contracts/project-sessions/project-session-data";
import {
  CakeSessionRuntimes,
  makeCakeSessionRuntimesLayer,
} from "../../../src/services/pi/CakeSessionRuntimes";
import type { PiPendingMessages } from "../../../src/contracts/conversations/pending-message-data";
import {
  SessionCatalogChanges,
  type SessionCatalogChange,
} from "../../../src/services/session-catalogs/SessionCatalogChanges";
import { ApplicationState } from "../../../src/services/storage/ApplicationState";
import { SessionArchiveStorage } from "../../../src/services/storage/SessionArchiveStorage";
import { SessionFamilyStorage } from "../../../src/services/storage/SessionFamilyStorage";
import { ManagedWorktrees } from "../../../src/services/worktrees/ManagedWorktrees";
import { familyStorageHarness } from "../helpers/familyStorageHarness";
import { WorkflowTestLive } from "../helpers/workflowFixture";
import { fakeRuntime, snapshot } from "../helpers/piRuntimeFixture";
import { makeProjectSessionRuntimeMechanismTestLayer } from "./projectSessionRuntimeTestLayer";

const location = {
  projectPath: "/project",
  projectName: "Project",
  workingDirectory: "/project",
  sessionDirectory: "/cake/sessions",
  resolvedSessionDirectory: "/cake/resolved",
};
const familyId = "4c41e44b-df48-4dfb-a891-d77748851586";
const messageId = "0b1bf3dd-458b-4025-8c39-c4f4e2febc0e";
const queueItemId = "3d7377aa-d150-49a7-a685-81a5eb974e73";
const caller = { sessionId: "root", location };
const addFamily = Effect.gen(function* () {
  yield* (yield* SessionFamilyStorage).addChild({
    familyId,
    parentSessionId: "root",
    parentWorkingDirectory: "/project",
    childSessionId: "child",
    childWorkingDirectory: "/project",
    requestId: "create-child",
    projectPath: "/project",
    createdAt: "2026-01-01T00:00:00.000Z",
  });
});

const environment = (
  pi: Layer.Layer<CakeSessionRuntimes>,
  changes: SessionCatalogChange[] = [],
  namespace: "active" | "resolved" = "active",
) =>
  Layer.mergeAll(
    WorkflowTestLive,
    familyStorageHarness().layer,
    makeProjectSessionRuntimeMechanismTestLayer(),
    Layer.mock(SessionCatalogChanges, {
      publish: (change) =>
        Effect.sync(() => {
          changes.push(change);
        }),
    }),
    Layer.mock(ApplicationState, {
      snapshot: () => ({
        ...defaultApplicationState(),
        projects: [
          {
            path: "/project",
            name: "Project",
            addedAt: "2026-01-01T00:00:00.000Z",
            lastOpenedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      }),
    }),
    Layer.mock(SessionArchiveStorage, {
      locate: () => Effect.succeed(namespace),
      resolvedProjects: () => Stream.empty,
      resolved: () => Stream.empty,
    }),
    Layer.mock(ManagedWorktrees, { records: () => Effect.succeed([]) }),
    pi,
  );

// Consumed-request selection and durable receipt correlation are covered end to
// end in sessionFamilyReplySelection.test.ts. Coordinator routing (including no
// spawning association) is covered in spawnedSessionReporting.test.ts.
it.effect.each([
  { streaming: false, delivery: undefined, expected: "prompt", lane: "prompt", ask: true },
  { streaming: true, delivery: undefined, expected: "queue", lane: "follow-up", ask: true },
  { streaming: true, delivery: "steer" as const, expected: "steer", lane: "steer", ask: true },
  { streaming: false, delivery: "queue" as const, expected: "queue", lane: "follow-up", ask: true },
  // Omitting expectsResponse is informational: no reply obligation is recorded.
  { streaming: true, delivery: "steer" as const, expected: "steer", lane: "steer", ask: false },
])(
  "starts idle recipients, queues active recipients, and steers only when requested (%j)",
  (scenario) =>
    Effect.gen(function* () {
      const received = yield* Queue.unbounded<{ text: string; delivery: string }>();
      const release = yield* Deferred.make<void>();
      const queued = yield* Deferred.make<void>();
      const changes: SessionCatalogChange[] = [];
      let pending: PiPendingMessages = { items: [] };
      const pi = makeCakeSessionRuntimesLayer({
        sessionIds: () => Stream.empty,
        catalog: () => Stream.empty,
        catalogEntry: () => Effect.succeed(undefined),
        inspect: () => Effect.succeed(undefined),
        changelog: () => Effect.succeed(""),
        createRuntime: (options) =>
          Effect.succeed({
            ...fakeRuntime(options, () => undefined),
            sessionId: options.sessionId ?? "unknown",
            streaming: scenario.streaming,
            snapshot: async () => ({
              ...snapshot,
              sessionId: options.sessionId ?? "unknown",
              streaming: scenario.streaming,
            }),
            pendingMessages: async () => {
              await Effect.runPromise(Deferred.await(queued));
              return pending;
            },
            prompt: (text, delivery) => {
              const parsed = parseCrossSessionMessage(text);
              if (delivery === "follow-up" && parsed)
                pending = {
                  items: [
                    {
                      itemId: queueItemId,
                      lane: "follow-up",
                      position: 1,
                      state: "queued",
                      text: parsed.text,
                      crossSession: parsed.metadata,
                    },
                  ],
                };
              Deferred.doneUnsafe(queued, Effect.void);
              return Effect.runPromise(
                Queue.offer(received, { text, delivery }).pipe(
                  Effect.andThen(Deferred.await(release)),
                ),
              );
            },
          }),
      });
      yield* Effect.gen(function* () {
        yield* addFamily;
        // Exercise the decoder/cancellation adapter as well as the extracted route.
        const options = yield* acquireOptions({ location, sessionId: "root", newSession: false });
        const send = options.runtime.currentSessionControl?.routeFamilyMessage;
        assert.ok(send);
        const receipt = yield* Effect.promise(() =>
          send(
            "sessions.send",
            {
              sessionId: "child",
              text: "Investigate queue behavior",
              ...(scenario.ask ? { expectsResponse: true } : {}),
              ...(scenario.delivery ? { delivery: scenario.delivery } : {}),
            },
            new AbortController().signal,
            { usedTokens: 10, windowTokens: 100 },
          ),
        );
        const decoded = yield* Schema.decodeUnknownEffect(
          Schema.Struct({
            messageId: Schema.String,
            threadId: Schema.String,
            turnId: Schema.String,
            delivery: Schema.String,
            expectsResponse: Schema.Boolean,
            status: Schema.String,
            queue: Schema.optionalKey(
              Schema.Struct({
                itemId: Schema.String,
                lane: Schema.String,
                position: Schema.Number,
                length: Schema.Number,
              }),
            ),
          }),
        )(receipt);
        const delivered = yield* Queue.take(received);
        assert.equal(delivered.delivery, scenario.lane);
        assert.equal(decoded.delivery, scenario.expected);
        assert.equal(decoded.expectsResponse, scenario.ask);
        assert.equal(decoded.status, scenario.expected === "queue" ? "queued" : "accepted");
        const metadata = parseCrossSessionMessage(delivered.text)?.metadata;
        assert.equal(metadata?.messageId, decoded.messageId);
        assert.equal(metadata?.threadId, decoded.threadId);
        assert.deepEqual(metadata?.context, { usedTokens: 10, windowTokens: 100 });
        const turns = (yield* (yield* SessionFamilyStorage).state()).turns;
        assert.equal(turns.length, scenario.ask ? 1 : 0);
        if (scenario.ask) {
          assert.equal(turns[0]?.turnId, decoded.turnId);
          assert.equal(turns[0]?.requestMessageId, decoded.messageId);
          assert.equal(turns[0]?.reported, false);
        }
        assert.deepEqual(
          decoded.queue,
          scenario.expected === "queue"
            ? {
                itemId: queueItemId,
                lane: "follow-up",
                position: 1,
                length: 1,
              }
            : undefined,
        );
        assert.deepEqual(changes, [
          {
            _tag: "ProjectSessionActivityChanged",
            sessionId: "child",
            projectPath: "/project",
            workingDirectory: "/project",
            sessionDirectory: "/cake/sessions",
          },
          {
            _tag: "ProjectSessionChanged",
            sessionId: "child",
            projectPath: "/project",
            workingDirectory: "/project",
            resolved: false,
          },
        ]);
      }).pipe(
        Effect.ensuring(Deferred.succeed(release, undefined)),
        Effect.provide(environment(pi, changes)),
      );
    }),
);

it.effect("records a substantive completion report without sending it before settlement", () =>
  Effect.gen(function* () {
    yield* addFamily;
    const storage = yield* SessionFamilyStorage;
    yield* storage.recordTurn({
      sessionId: "child",
      senderSessionId: "root",
      turnId: "turn",
      requestMessageId: messageId,
      threadId: familyId,
      reported: false,
    });
    const result = yield* route({ sessionId: "child", location }, "sessions.reply", {
      text: "Fixed the queue race and verified the regression tests.",
      outcome: "completed",
    });
    assert.deepEqual(result, {
      ok: true,
      command: "sessions.reply",
      status: "report-recorded",
      expectsResponse: false,
    });
    const [turn] = (yield* storage.state()).turns;
    assert.ok(turn);
    assert.deepEqual(turn.report, {
      outcome: "completed",
      text: "Fixed the queue race and verified the regression tests.",
    });
    assert.equal(turn.outcome, undefined);
    assert.equal(turn.deliveryTurnId, undefined);
    assert.equal(turn.reported, false);
    const acknowledgment = yield* route({ sessionId: "child", location }, "sessions.reply", {
      text: "Thanks",
      outcome: "completed",
    }).pipe(Effect.flip);
    assert.equal(acknowledgment._tag, "ProjectSessionError");
    assert.match(acknowledgment.message, /substantive/);
  }).pipe(
    Effect.provide(
      environment(
        Layer.mock(CakeSessionRuntimes, { executingTurnIds: () => Effect.succeed(["turn"]) }),
      ),
    ),
  ),
);

it.effect("rejects delivery to a resolved family without admitting or publishing a message", () => {
  const changes: SessionCatalogChange[] = [];
  return Effect.gen(function* () {
    yield* addFamily;
    const failure = yield* route(caller, "sessions.send", {
      sessionId: "child",
      text: "Continue work",
    }).pipe(Effect.flip);
    assert.ok(failure instanceof ProjectSessionError);
    assert.equal(
      failure.message,
      `Session Family ${familyId} is resolved; restore it explicitly before messaging`,
    );
    assert.deepEqual((yield* (yield* SessionFamilyStorage).state()).turns, []);
    assert.deepEqual(changes, []);
  }).pipe(Effect.provide(environment(Layer.mock(CakeSessionRuntimes, {}), changes, "resolved")));
});

it.effect("retains the not-handled fallback for unrelated destinations and unmatched replies", () =>
  Effect.gen(function* () {
    assert.equal(
      yield* route(caller, "sessions.send", { sessionId: "unrelated", text: "Question" }),
      undefined,
    );
    yield* addFamily;
    assert.equal(
      yield* route(caller, "sessions.send", { sessionId: "unrelated", text: "Question" }),
      undefined,
    );
    assert.equal(
      yield* route(caller, "sessions.reply", { text: "No request is executing" }),
      undefined,
    );
  }).pipe(
    Effect.provide(
      environment(Layer.mock(CakeSessionRuntimes, { executingTurnIds: () => Effect.succeed([]) })),
    ),
  ),
);

it.effect("propagates callback cancellation to routing and runs its finalizers", () =>
  Effect.gen(function* () {
    const storage = yield* SessionFamilyStorage;
    const entered = yield* Deferred.make<void>();
    const finalized = yield* Deferred.make<void>();
    let wait = false;
    const options = yield* acquireOptions({ location, sessionId: "root", newSession: false }).pipe(
      Effect.provideService(SessionFamilyStorage, {
        ...storage,
        familyForMember: (sessionId) =>
          wait
            ? Deferred.succeed(entered, undefined).pipe(
                Effect.andThen(Effect.never),
                Effect.ensuring(Deferred.succeed(finalized, undefined)),
              )
            : storage.familyForMember(sessionId),
      }),
    );
    const send = options.runtime.currentSessionControl?.routeFamilyMessage;
    assert.ok(send);
    wait = true;
    const controller = new AbortController();
    const result = send(
      "sessions.send",
      { sessionId: "child", text: "Question" },
      controller.signal,
    ).then(
      () => undefined,
      (error: unknown) => error,
    );
    yield* Deferred.await(entered);
    controller.abort();
    const failure = yield* Effect.promise(() => result);
    yield* Deferred.await(finalized);
    assert.ok(failure instanceof Error);
    assert.match(failure.message, /interrupt/i);
    assert.equal(Schema.is(ProjectSessionError)(failure), false);
  }).pipe(Effect.provide(environment(Layer.mock(CakeSessionRuntimes, {})))),
);

it.effect("maps expected routing failures without converting defects or interruption", () =>
  Effect.gen(function* () {
    const storage = yield* SessionFamilyStorage;
    const expected = new SessionFamilyStorageError({
      operation: "read",
      message: "Family store unavailable",
    });
    const send = route(caller, "sessions.send", { sessionId: "child", text: "Question" });
    const failure = yield* send.pipe(
      Effect.provideService(SessionFamilyStorage, {
        ...storage,
        familyForMember: () => Effect.fail(expected),
      }),
      Effect.flip,
    );
    assert.equal(failure._tag, "ProjectSessionError");
    assert.equal(failure.message, expected.message);
    const defect = yield* send.pipe(
      Effect.provideService(SessionFamilyStorage, {
        ...storage,
        familyForMember: () => Effect.die("routing defect"),
      }),
      Effect.exit,
    );
    assert.ok(Exit.isFailure(defect) && Cause.hasDies(defect.cause));
    const interrupted = yield* send.pipe(
      Effect.provideService(SessionFamilyStorage, {
        ...storage,
        familyForMember: () => Effect.interrupt,
      }),
      Effect.exit,
    );
    assert.ok(Exit.isFailure(interrupted) && Cause.hasInterrupts(interrupted.cause));
  }).pipe(Effect.provide(environment(Layer.mock(CakeSessionRuntimes, {})))),
);
