import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { Deferred, Effect, Layer, Stream } from "effect";
import { encodeCrossSessionMessage } from "../../../src/domain/conversations/cross-session-coordination";
import { defaultApplicationState } from "../../../src/domain/application/application-data";
import { acquireOptions } from "../../../src/domain/project-sessions/projectSessionRuntime";
import { initialize } from "../../../src/domain/session-families/sessionFamilies";
import { SessionCatalogChanges } from "../../../src/services/session-catalogs/SessionCatalogChanges";
import { ApplicationState } from "../../../src/services/storage/ApplicationState";
import { SessionArchiveStorage } from "../../../src/services/storage/SessionArchiveStorage";
import { SessionFamilyStorage } from "../../../src/services/storage/SessionFamilyStorage";
import { makePiSessionsLayer, PiSessions } from "../../../src/services/pi/PiSessions";
import { ManagedWorktrees } from "../../../src/services/worktrees/ManagedWorktrees";
import { familyStorageHarness } from "../helpers/familyStorageHarness";
import { fakeRuntime } from "../helpers/piRuntimeFixture";
import { makeProjectSessionRuntimeMechanismTestLayer } from "./projectSessionRuntimeTestLayer";

const location = {
  projectPath: "/project",
  projectName: "Project",
  workingDirectory: "/project",
  sessionDirectory: "/cake/sessions",
  resolvedSessionDirectory: "/cake/resolved",
};
const familyId = "4c41e44b-df48-4dfb-a891-d77748851586";
const requestId = "0b1bf3dd-458b-4025-8c39-c4f4e2febc0e";

const addFamily = Effect.fn("SessionFamilyRootSettlementTest.addFamily")(function* () {
  yield* (yield* SessionFamilyStorage).addChild({
    familyId,
    parentSessionId: "root",
    parentWorkingDirectory: "/project",
    childSessionId: "child",
    childWorkingDirectory: "/project",
    requestId: "child-creation-request",
    projectPath: "/project",
    createdAt: "2026-01-01T00:00:00.000Z",
  });
});

const message = (expectsResponse: boolean) =>
  encodeCrossSessionMessage("Child result", {
    version: 1,
    messageId: requestId,
    threadId: familyId,
    sequence: 1,
    expectsResponse,
    sender: { sessionId: "child", title: "Child", kind: "project-session" },
  });

const environment = (disposed: Deferred.Deferred<void>) =>
  Layer.mergeAll(
    familyStorageHarness().layer,
    makeProjectSessionRuntimeMechanismTestLayer(),
    SessionCatalogChanges.layer,
    Layer.mock(ApplicationState, {
      snapshot: () => ({
        ...defaultApplicationState(),
        trustedProjectPaths: ["/project"],
      }),
    }),
    Layer.mock(SessionArchiveStorage, { locate: () => Effect.succeed("active" as const) }),
    Layer.mock(ManagedWorktrees, {
      records: () => Effect.succeed([]),
      proposeSquashMessage: () => Effect.void,
    }),
    makePiSessionsLayer({
      catalog: () => Stream.empty,
      catalogEntry: () => Effect.succeed(undefined),
      inspect: () => Effect.succeed(undefined),
      changelog: () => Effect.succeed(""),
      createRuntime: (options) =>
        Effect.succeed({
          ...fakeRuntime(options, () => {
            Deferred.doneUnsafe(disposed, Effect.void);
          }),
          sessionId: options.sessionId ?? "root",
        }),
    }),
  );

it.effect("settles an informational message received by a family root without a notice", () =>
  Effect.gen(function* () {
    const disposed = yield* Deferred.make<void>();
    yield* Effect.gen(function* () {
      yield* addFamily();
      yield* Effect.scoped(
        Effect.gen(function* () {
          const options = yield* acquireOptions({ location, sessionId: "root", newSession: false });
          const handle = yield* (yield* PiSessions).acquire(options);
          yield* handle.prompt(message(false));
        }),
      );
      yield* Deferred.await(disposed);

      const storage = yield* SessionFamilyStorage;
      assert.deepEqual((yield* storage.state()).turns, []);
      yield* initialize(location.sessionDirectory, location.resolvedSessionDirectory);
      assert.deepEqual((yield* storage.state()).turns, []);
    }).pipe(Effect.provide(environment(disposed)));
  }),
);

it.effect("retains a completed root request that expected a response", () =>
  Effect.gen(function* () {
    const disposed = yield* Deferred.make<void>();
    yield* Effect.gen(function* () {
      yield* addFamily();
      yield* Effect.scoped(
        Effect.gen(function* () {
          const options = yield* acquireOptions({ location, sessionId: "root", newSession: false });
          const handle = yield* (yield* PiSessions).acquire(options);
          yield* handle.prompt(message(true));
        }),
      );
      yield* Deferred.await(disposed);

      const storage = yield* SessionFamilyStorage;
      const state = yield* storage.state();
      assert.deepEqual(state.turns, [
        {
          sessionId: "root",
          senderSessionId: "child",
          turnId: state.turns[0]?.turnId,
          requestMessageId: requestId,
          threadId: familyId,
          expectsResponse: true,
          reported: false,
          outcome: "complete",
        },
      ]);
      const pending = yield* storage.pendingResponseRequest("root", [], familyId, requestId);
      assert.equal(pending?.outcome, "complete");
      assert.equal(pending?.reported, false);
      yield* initialize(location.sessionDirectory, location.resolvedSessionDirectory);
      assert.equal(
        (yield* storage.pendingResponseRequest("root", [], familyId, requestId))?.outcome,
        "complete",
      );
    }).pipe(Effect.provide(environment(disposed)));
  }),
);

it.effect("settles family work in a root runtime acquired before promotion", () =>
  Effect.gen(function* () {
    const disposed = yield* Deferred.make<void>();
    yield* Effect.gen(function* () {
      yield* Effect.scoped(
        Effect.gen(function* () {
          const options = yield* acquireOptions({ location, sessionId: "root", newSession: false });
          const handle = yield* (yield* PiSessions).acquire(options);

          yield* handle.prompt("Untracked standalone work");
          yield* addFamily();
          yield* handle.prompt(message(false));
        }),
      );
      yield* Deferred.await(disposed);
      assert.deepEqual((yield* (yield* SessionFamilyStorage).state()).turns, []);
    }).pipe(Effect.provide(environment(disposed)));
  }),
);
