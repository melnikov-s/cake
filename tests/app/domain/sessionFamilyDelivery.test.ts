import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { Deferred, Effect, Layer, Stream } from "effect";
import { describe } from "vitest";
import { deliver, initialize } from "../../../src/domain/sessionFamilies";
import { parseCrossSessionMessage } from "../../../src/domain/cross-session-coordination";
import { makePiSessionsLayer, PiSessions } from "../../../src/services/pi/PiSessions";
import { ProjectSessionEnvironment } from "../../../src/services/project-sessions/ProjectSessionEnvironment";
import { ProjectSessionLifecycle } from "../../../src/services/project-sessions/ProjectSessionLifecycle";
import { SessionArchiveStorage } from "../../../src/services/storage/SessionArchiveStorage";
import { SessionFamilyStorage } from "../../../src/services/storage/SessionFamilyStorage";
import { familyStorageHarness } from "../helpers/familyStorageHarness";
import { fakeRuntime, options, snapshot } from "../helpers/piRuntimeFixture";

const location = {
  projectPath: "/project",
  projectName: "Project",
  workingDirectory: "/project",
  sessionDirectory: "/sessions",
  resolvedSessionDirectory: "/resolved",
};
const childId = "82fbeb9d-cced-4514-aa40-4b55db215375";
const turnId = "eb8dcb83-691b-4fbe-9a65-1ce8461e6c7d";
const reservation = {
  familyId: "family",
  parentSessionId: "session-1",
  childSessionId: childId,
  requestId: "request",
  projectPath: "/project",
  workingDirectory: "/project",
  createdAt: "2026-09-05",
};
const outcome = {
  sessionId: childId,
  parentSessionId: "session-1",
  turnId,
  reported: false,
  outcome: "complete" as const,
};
const environment = Layer.mock(ProjectSessionEnvironment, {
  locations: () => Effect.succeed([location]),
  runtimeOptions: () => Effect.succeed(options()),
});

describe("Session Family outcome delivery", () => {
  it.effect("recovers an accepted reply when acknowledgement was interrupted", () => {
    const replyId = "367f6f87-5cc4-440f-b91f-28f6e722db81";
    return Effect.gen(function* () {
      const storage = yield* SessionFamilyStorage;
      yield* storage.addChild(reservation);
      yield* storage.recordTurn(outcome);
      yield* storage.prepareReply(childId, [turnId], replyId);
      const pending = (yield* storage.state()).turns[0];
      assert.ok(pending);
      yield* Effect.scoped(deliver(pending));
      assert.deepEqual((yield* storage.state()).turns, []);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          familyStorageHarness().layer,
          environment,
          Layer.mock(SessionArchiveStorage, { locate: () => Effect.succeed("active" as const) }),
          makePiSessionsLayer({
            catalog: () => Stream.empty,
            catalogEntry: () => Effect.succeed(undefined),
            inspect: () => Effect.succeed(undefined),
            changelog: () => Effect.succeed(""),
            createRuntime: (runtimeOptions) =>
              Effect.succeed({
                ...fakeRuntime(runtimeOptions, () => undefined),
                snapshot: async () => ({
                  ...snapshot,
                  parts: [
                    {
                      id: replyId,
                      kind: "text" as const,
                      status: "complete" as const,
                      role: "user" as const,
                      text: "Finished",
                      crossSession: {
                        version: 1 as const,
                        messageId: replyId,
                        threadId: replyId,
                        sequence: 1,
                        sender: {
                          sessionId: childId,
                          title: "Child",
                          kind: "project-session" as const,
                        },
                      },
                    },
                  ],
                }),
                prompt: async () => {
                  throw new Error("Do not send a fallback for a delivered reply");
                },
              }),
          }),
        ),
      ),
    );
  });

  it.effect(
    "keeps a failed delivery durable and does not replay a persisted receipt after restart",
    () => {
      const harness = familyStorageHarness();
      const transcript: string[] = [];
      let unavailable = true;
      return Effect.gen(function* () {
        const received = yield* Deferred.make<void>();
        const pi = makePiSessionsLayer({
          catalog: () => Stream.empty,
          catalogEntry: () => Effect.succeed(undefined),
          inspect: () => Effect.succeed(undefined),
          changelog: () => Effect.succeed(""),
          createRuntime: (runtimeOptions) =>
            Effect.try(() => {
              if (unavailable) throw new Error("Parent temporarily unavailable");
              return {
                ...fakeRuntime(runtimeOptions, () => undefined),
                snapshot: async () => ({
                  ...snapshot,
                  parts: transcript.flatMap((content) => {
                    const message = parseCrossSessionMessage(content);
                    return message
                      ? [
                          {
                            id: message.metadata.messageId,
                            kind: "text" as const,
                            status: "complete" as const,
                            role: "user" as const,
                            text: message.text,
                            crossSession: message.metadata,
                          },
                        ]
                      : [];
                  }),
                }),
                prompt: async (text: string, delivery: string) => {
                  assert.equal(delivery, "prompt");
                  transcript.push(text);
                  Deferred.doneUnsafe(received, Effect.void);
                },
              };
            }),
        });
        const dependencies = Layer.mergeAll(
          environment,
          pi,
          Layer.mock(SessionArchiveStorage, { locate: () => Effect.succeed("active" as const) }),
        );
        return yield* Effect.gen(function* () {
          yield* Effect.gen(function* () {
            const storage = yield* SessionFamilyStorage;
            yield* storage.addChild(reservation);
            yield* storage.recordTurn(outcome);
            const result = yield* Effect.result(Effect.scoped(deliver(outcome)));
            assert.equal(result._tag, "Failure");
            assert.equal((yield* storage.state()).turns.length, 1);
            unavailable = false;
            yield* Effect.scoped(deliver(outcome));
            yield* Deferred.await(received);
            // The receipt remains pending until the parent transcript proves delivery.
            assert.equal((yield* storage.state()).turns.length, 1);
          }).pipe(Effect.provide(harness.layer));
          yield* Effect.gen(function* () {
            const storage = yield* SessionFamilyStorage;
            const pending = (yield* storage.state()).turns[0];
            assert.ok(pending);
            yield* Effect.scoped(deliver(pending));
            assert.equal(transcript.length, 1);
            assert.deepEqual((yield* storage.state()).turns, []);
          }).pipe(Effect.provide(familyStorageHarness(harness.files).layer));
        }).pipe(Effect.provide(dependencies));
      });
    },
  );

  it.effect("queues a notice behind active parent work without steering it", () =>
    Effect.gen(function* () {
      const received = yield* Deferred.make<void>();
      yield* Effect.gen(function* () {
        const storage = yield* SessionFamilyStorage;
        yield* storage.addChild(reservation);
        yield* storage.recordTurn(outcome);
        yield* Effect.scoped(deliver(outcome));
        yield* Deferred.await(received);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            familyStorageHarness().layer,
            environment,
            Layer.mock(SessionArchiveStorage, { locate: () => Effect.succeed("active" as const) }),
            makePiSessionsLayer({
              catalog: () => Stream.empty,
              catalogEntry: () => Effect.succeed(undefined),
              inspect: () => Effect.succeed(undefined),
              changelog: () => Effect.succeed(""),
              createRuntime: (runtimeOptions) =>
                Effect.succeed({
                  ...fakeRuntime(runtimeOptions, () => undefined),
                  snapshot: async () => ({ ...snapshot, streaming: true }),
                  prompt: async (_text: string, delivery: string) => {
                    assert.equal(delivery, "follow-up");
                    Deferred.doneUnsafe(received, Effect.void);
                  },
                }),
            }),
          ),
        ),
      );
    }),
  );

  it.effect("recovers a reservation without a transcript and reports the failed launch", () =>
    Effect.gen(function* () {
      const storage = yield* SessionFamilyStorage;
      yield* storage.addChild(reservation);
      yield* initialize("/sessions", "/resolved");
      assert.deepEqual((yield* storage.list())[0]?.children, []);
      assert.equal((yield* storage.state()).turns[0]?.outcome, "failed");
      yield* initialize("/sessions", "/resolved");
      assert.equal((yield* storage.state()).turns.length, 1);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          familyStorageHarness().layer,
          Layer.mock(SessionArchiveStorage, {
            locate: (id) => Effect.succeed(id === childId ? undefined : ("active" as const)),
          }),
          Layer.mock(ProjectSessionLifecycle, {}),
        ),
      ),
    ),
  );

  it.effect("does not restore or message a resolved parent", () =>
    Effect.gen(function* () {
      const storage = yield* SessionFamilyStorage;
      yield* storage.addChild(reservation);
      yield* storage.recordTurn(outcome);
      yield* Effect.scoped(deliver(outcome));
      assert.equal((yield* storage.state()).turns.length, 1);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          familyStorageHarness().layer,
          environment,
          Layer.mock(SessionArchiveStorage, { locate: () => Effect.succeed("resolved" as const) }),
          Layer.mock(PiSessions, {}),
        ),
      ),
    ),
  );
});
