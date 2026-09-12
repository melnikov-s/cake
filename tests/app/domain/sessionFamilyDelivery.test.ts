import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { Deferred, Effect, Layer, Stream } from "effect";
import { describe } from "vitest";
import { deliver, initialize } from "../../../src/domain/session-families/sessionFamilies";
import { parseCrossSessionMessage } from "../../../src/domain/conversations/cross-session-coordination";
import { makePiSessionsLayer, PiSessions } from "../../../src/services/pi/PiSessions";
import { defaultApplicationState } from "../../../src/domain/application/application-data";
import { ApplicationState } from "../../../src/services/storage/ApplicationState";
import { ManagedWorktrees } from "../../../src/services/worktrees/ManagedWorktrees";
import { makeProjectSessionRuntimeMechanismTestLayer } from "./projectSessionRuntimeTestLayer";
import { SessionCatalogChanges } from "../../../src/services/session-catalogs/SessionCatalogChanges";
import { SessionArchiveStorage } from "../../../src/services/storage/SessionArchiveStorage";
import { SessionFamilyStorage } from "../../../src/services/storage/SessionFamilyStorage";
import { familyStorageHarness } from "../helpers/familyStorageHarness";
import { fakeRuntime, snapshot } from "../helpers/piRuntimeFixture";

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
  parentWorkingDirectory: "/project",
  childSessionId: childId,
  childWorkingDirectory: "/project",
  requestId: "request",
  projectPath: "/project",
  createdAt: "2026-09-05",
};
const outcome = {
  sessionId: childId,
  senderSessionId: "session-1",
  turnId,
  requestMessageId: childId,
  threadId: turnId,
  expectsResponse: true,
  reported: false,
  outcome: "complete" as const,
};
const environment = Layer.mergeAll(
  makeProjectSessionRuntimeMechanismTestLayer(),
  Layer.mock(ApplicationState, {
    snapshot: () => ({
      ...defaultApplicationState(),
      projects: [
        {
          path: location.projectPath,
          name: location.projectName,
          addedAt: "2026-01-01T00:00:00.000Z",
          lastOpenedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
      trustedProjectPaths: [location.workingDirectory],
    }),
  }),
  Layer.mock(ManagedWorktrees, {
    records: () => Effect.succeed([]),
    proposeSquashMessage: () => Effect.void,
  }),
  SessionCatalogChanges.layer,
);

describe("Session Family outcome delivery", () => {
  it.effect("recovers an accepted reply when acknowledgement was interrupted", () => {
    const replyId = "367f6f87-5cc4-440f-b91f-28f6e722db81";
    return Effect.gen(function* () {
      const storage = yield* SessionFamilyStorage;
      yield* storage.addChild(reservation);
      yield* storage.recordTurn(outcome);
      yield* storage.prepareResponse(childId, "session-1", childId, replyId);
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
            sessionIds: () => Stream.empty,
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
                        expectsResponse: false,
                        replyToMessageId: childId,
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
          sessionIds: () => Stream.empty,
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
            const notice = parseCrossSessionMessage(transcript[0] ?? "");
            assert.equal(notice?.metadata.expectsResponse, false);
            assert.equal(notice?.metadata.generatedNotice, true);
            assert.match(notice?.text ?? "", /stopped without replying/);
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
              sessionIds: () => Stream.empty,
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

  it.effect("reports informational failures without creating a response obligation", () =>
    Effect.gen(function* () {
      const received = yield* Deferred.make<string>();
      const failedInformational = {
        ...outcome,
        turnId: "69127286-fb4e-4831-a47e-b4d423ab4af0",
        requestMessageId: "d4d316e8-e2e9-4d8d-9e5d-d3f1314b680f",
        expectsResponse: false,
        outcome: "failed" as const,
      };
      yield* Effect.gen(function* () {
        const storage = yield* SessionFamilyStorage;
        yield* storage.addChild(reservation);
        yield* storage.recordTurn(failedInformational);
        yield* Effect.scoped(deliver(failedInformational));
        const notice = parseCrossSessionMessage(yield* Deferred.await(received));
        assert.equal(notice?.metadata.expectsResponse, false);
        assert.equal(notice?.metadata.generatedNotice, true);
        assert.match(notice?.text ?? "", /stopped with an error/);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            familyStorageHarness().layer,
            environment,
            Layer.mock(SessionArchiveStorage, { locate: () => Effect.succeed("active" as const) }),
            makePiSessionsLayer({
              sessionIds: () => Stream.empty,
              catalog: () => Stream.empty,
              catalogEntry: () => Effect.succeed(undefined),
              inspect: () => Effect.succeed(undefined),
              changelog: () => Effect.succeed(""),
              createRuntime: (runtimeOptions) =>
                Effect.succeed({
                  ...fakeRuntime(runtimeOptions, () => undefined),
                  prompt: (text: string) =>
                    Effect.runPromise(Deferred.succeed(received, text)).then(() => undefined),
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
          environment,
          Layer.mock(PiSessions, { currentStatus: () => Effect.succeed(undefined) }),
          Layer.mock(SessionArchiveStorage, {
            locate: (id) => Effect.succeed(id === childId ? undefined : ("active" as const)),
          }),
        ),
      ),
    ),
  );

  it.effect("suppresses outcome delivery while stop-all lifecycle work is admitted", () =>
    Effect.gen(function* () {
      const storage = yield* SessionFamilyStorage;
      yield* storage.addChild(reservation);
      yield* storage.recordTurn(outcome);
      yield* storage.beginTransition("session-1", true);
      yield* Effect.scoped(deliver(outcome));
      assert.equal((yield* storage.state()).turns.length, 1);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          familyStorageHarness().layer,
          environment,
          Layer.mock(SessionArchiveStorage, { locate: () => Effect.succeed("active" as const) }),
          Layer.mock(PiSessions, {}),
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
