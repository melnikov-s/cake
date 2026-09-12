import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { Deferred, Effect, Layer, Stream } from "effect";
import { describe } from "vitest";
import { createChild } from "../../../src/domain/session-families/sessionFamilies";
import { PiModels } from "../../../src/services/pi/PiModels";
import { makePiSessionsLayer } from "../../../src/services/pi/PiSessions";
import {
  SessionFamilyStorage,
  familyMember,
} from "../../../src/services/storage/SessionFamilyStorage";
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
        let discardedWorkingDirectory: string | undefined;
        const childLocation = { ...location, workingDirectory: "/child-worktree" };
        const result = yield* Effect.scoped(
          createChild(
            "parent",
            location,
            { ...input, worktreeName: "child-worktree" },
            (id, runtimeLocation) =>
              Effect.succeed(
                options({ cwd: runtimeLocation.workingDirectory, sessionId: id, newSession: true }),
              ),
            () => Effect.succeed(childLocation),
            undefined,
            (workingDirectory) =>
              Effect.sync(() => {
                discardedWorkingDirectory = workingDirectory;
              }),
          ),
        );
        assert.equal(result.launch.status, "failed");
        assert.equal(discardedWorkingDirectory, "/child-worktree");
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

  it.effect("binds an isolated child to the location created from its parent checkout", () =>
    Effect.gen(function* () {
      let createdName: string | undefined;
      let acquiredWorkingDirectory: string | undefined;
      const childLocation = {
        ...location,
        workingDirectory: "/child-worktree",
        managedWorktree: {
          projectPath: "/project",
          worktreePath: "/child-worktree",
          branch: "child-branch",
          baseBranch: "main",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      };
      const result = yield* Effect.scoped(
        createChild(
          "parent",
          location,
          { ...input, worktreeName: "child-branch" },
          (id, runtimeLocation) => {
            acquiredWorkingDirectory = runtimeLocation.workingDirectory;
            return Effect.succeed(
              options({ cwd: runtimeLocation.workingDirectory, sessionId: id, newSession: true }),
            );
          },
          (worktreeName) => {
            createdName = worktreeName;
            return Effect.succeed(childLocation);
          },
        ),
      );
      assert.equal(result.launch.status, "accepted");
      assert.equal(result.workingDirectory, "/child-worktree");
      assert.equal(createdName, "child-branch");
      assert.equal(acquiredWorkingDirectory, "/child-worktree");
      const family = yield* (yield* SessionFamilyStorage).familyForMember(result.childSessionId);
      assert.ok(family);
      assert.equal(family.parentSessionId, "parent");
      assert.equal(family.workingDirectory, "/worktree");
      assert.equal(family.managedWorktreePath, undefined);
      assert.deepEqual(familyMember(family, "parent"), {
        sessionId: "parent",
        workingDirectory: "/worktree",
      });
      assert.equal(family.children[0]?.sessionId, result.childSessionId);
      assert.equal(family.children[0]?.parentSessionId, "parent");
      assert.equal(family.children[0]?.workingDirectory, "/child-worktree");
      assert.equal(family.children[0]?.managedWorktreePath, "/child-worktree");
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
