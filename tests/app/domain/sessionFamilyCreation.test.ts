import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { Deferred, Effect, Layer, Stream } from "effect";
import { describe } from "vitest";
import { createChild } from "../../../src/domain/sessionFamilies";
import { PiModels } from "../../../src/services/pi/PiModels";
import { makePiSessionsLayer } from "../../../src/services/pi/PiSessions";
import { SessionFamilyStorage } from "../../../src/services/storage/SessionFamilyStorage";
import { SessionArchiveStorage } from "../../../src/services/storage/SessionArchiveStorage";
import { SessionCatalogChanges } from "../../../src/services/session-catalogs/SessionCatalogChanges";
import { familyStorageHarness } from "../helpers/familyStorageHarness";
import { fakeRuntime, options } from "../helpers/piRuntimeFixture";

const location = {
  projectPath: "/project",
  projectName: "Project",
  workingDirectory: "/worktree",
  sessionDirectory: "/sessions",
  resolvedSessionDirectory: "/resolved",
};
const input = {
  requestId: "creation-request",
  title: "Implement",
  initialPrompt: "Implement and report back",
  model: { provider: "test", modelId: "test", thinkingLevel: "off" as const, fastMode: false },
};
const modelLayer = Layer.mock(PiModels, { resolve: (selection) => Effect.succeed(selection) });
const archiveLayer = Layer.mock(SessionArchiveStorage, { locate: () => Effect.succeed(undefined) });

describe("Session Family creation", () => {
  it.effect(
    "removes the reservation when runtime acquisition fails before a transcript exists",
    () =>
      Effect.gen(function* () {
        const result = yield* Effect.scoped(
          createChild("parent", location, input, (id) =>
            Effect.succeed(
              options({ cwd: location.workingDirectory, sessionId: id, newSession: true }),
            ),
          ),
        );
        assert.equal(result.launch.status, "failed");
        const storage = yield* SessionFamilyStorage;
        assert.deepEqual((yield* storage.familyForMember("parent"))?.children, []);
        assert.equal(yield* storage.familyForMember(result.childSessionId), undefined);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            familyStorageHarness().layer,
            modelLayer,
            archiveLayer,
            SessionCatalogChanges.layer,
            makePiSessionsLayer({
              catalog: () => Stream.empty,
              catalogEntry: () => Effect.succeed(undefined),
              inspect: () => Effect.succeed(undefined),
              changelog: () => Effect.succeed(""),
              createRuntime: () => Effect.fail(new Error("Could not load resources")),
            }),
          ),
        ),
      ),
  );

  it.effect("removes the reservation when configuration fails before the initial prompt", () =>
    Effect.gen(function* () {
      const result = yield* Effect.scoped(
        createChild("parent", location, input, (id) =>
          Effect.succeed(
            options({ cwd: location.workingDirectory, sessionId: id, newSession: true }),
          ),
        ),
      );
      assert.equal(result.launch.status, "failed");
      assert.deepEqual((yield* (yield* SessionFamilyStorage).list())[0]?.children, []);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          familyStorageHarness().layer,
          modelLayer,
          archiveLayer,
          SessionCatalogChanges.layer,
          makePiSessionsLayer({
            catalog: () => Stream.empty,
            catalogEntry: () => Effect.succeed(undefined),
            inspect: () => Effect.succeed(undefined),
            changelog: () => Effect.succeed(""),
            createRuntime: (runtimeOptions) =>
              Effect.succeed({
                ...fakeRuntime(runtimeOptions, () => undefined),
                sessionId: runtimeOptions.sessionId ?? "missing",
                applyConfiguration: async () => {
                  throw new Error("Configuration failed");
                },
              }),
          }),
        ),
      ),
    ),
  );

  it.effect("retries a creation receipt without starting the same child twice", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      let launches = 0;
      let disposed = false;
      const pi = makePiSessionsLayer({
        catalog: () => Stream.empty,
        catalogEntry: () => Effect.succeed(undefined),
        inspect: () => Effect.succeed(undefined),
        changelog: () => Effect.succeed(""),
        createRuntime: (runtimeOptions) =>
          Effect.succeed({
            ...fakeRuntime(runtimeOptions, () => {
              disposed = true;
            }),
            sessionId: runtimeOptions.sessionId ?? "missing",
            prompt: async () => {
              launches += 1;
              Deferred.doneUnsafe(started, Effect.void);
            },
          }),
      });
      yield* Effect.gen(function* () {
        const factory = (id: string) =>
          Effect.succeed(
            options({ cwd: location.workingDirectory, sessionId: id, newSession: true }),
          );
        const first = yield* createChild("parent", location, input, factory);
        assert.equal(
          disposed,
          false,
          "The admission lock must not dispose the child runtime lease",
        );
        yield* Deferred.await(started);
        const second = yield* createChild("parent", location, input, factory);
        assert.equal(first.childSessionId, second.childSessionId);
        assert.equal(first.familyChildOrder, 0);
        assert.equal(second.familyChildOrder, 0);
        assert.equal(second.launch.status, "already-started");
        assert.equal(launches, 1);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            familyStorageHarness().layer,
            modelLayer,
            archiveLayer,
            SessionCatalogChanges.layer,
            pi,
          ),
        ),
      );
    }),
  );
});
