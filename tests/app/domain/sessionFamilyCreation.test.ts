import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { Deferred, Effect, Layer, Stream } from "effect";
import { describe } from "vitest";
import { createChild } from "../../../src/domain/session-families/sessionFamilies";
import { parseCrossSessionMessage } from "../../../src/contracts/conversations/cross-session-message";
import { PiModels } from "../../../src/services/pi/PiModels";
import { makeCakeSessionRuntimesLayer } from "../../../src/services/pi/CakeSessionRuntimes";
import {
  SessionFamilyStorage,
  familyMember,
} from "../../../src/services/storage/SessionFamilyStorage";
import { SessionArchiveStorage } from "../../../src/services/storage/SessionArchiveStorage";
import { SessionCatalogChanges } from "../../../src/services/session-catalogs/SessionCatalogChanges";
import { ArtifactStorage } from "../../../src/services/storage/ArtifactStorage";
import { messageBoardHarness } from "../helpers/messageBoardHarness";
import { familyStorageHarness } from "../helpers/familyStorageHarness";
import { projectTodoLayer } from "../helpers/projectTodoHarness";
import * as todos from "../../../src/domain/projects/projectTodos";
import {
  makeRuntimeRecoveryStorageTestLayer,
  fakeRuntime,
  options,
} from "../helpers/piRuntimeFixture";

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
  assignment: { description: "Implement", body: "Implement and report on the Workboard" },
  model: { provider: "test", modelId: "test", thinkingLevel: "off" as const, fastMode: false },
  senderContext: { usedTokens: 64_000, windowTokens: 128_000 },
};
const modelLayer = Layer.mock(PiModels, { resolve: (selection) => Effect.succeed(selection) });
const archiveLayer = Layer.mock(SessionArchiveStorage, { locate: () => Effect.succeed(undefined) });

describe("Session Family creation", () => {
  it.effect("retains the reservation and worktree for retry when runtime acquisition fails", () =>
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
      assert.equal(discardedWorkingDirectory, undefined);
      const storage = yield* SessionFamilyStorage;
      assert.equal((yield* storage.familyForMember("parent"))?.children.length, 1);
      assert.ok(yield* storage.familyForMember(result.childSessionId));
    }).pipe(
      Effect.provide(messageBoardHarness().layer),
      Effect.provide(projectTodoLayer()),
      Effect.provide(
        Layer.mergeAll(
          familyStorageHarness().layer,
          modelLayer,
          archiveLayer,
          SessionCatalogChanges.layer,
          makeCakeSessionRuntimesLayer({
            sessionIds: () => Stream.empty,
            catalog: () => Stream.empty,
            catalogEntry: () => Effect.succeed(undefined),
            inspect: () => Effect.succeed(undefined),
            changelog: () => Effect.succeed(""),
            createRuntime: () => Effect.fail(new Error("Could not load resources")),
          }).pipe(Layer.provideMerge(makeRuntimeRecoveryStorageTestLayer())),
        ),
      ),
    ),
  );

  it.effect("retains the reservation when configuration fails before admission", () =>
    Effect.gen(function* () {
      const result = yield* Effect.scoped(
        createChild("parent", location, input, (id) =>
          Effect.succeed(
            options({ cwd: location.workingDirectory, sessionId: id, newSession: true }),
          ),
        ),
      );
      assert.equal(result.launch.status, "failed");
      assert.equal((yield* (yield* SessionFamilyStorage).list())[0]?.children.length, 1);
    }).pipe(
      Effect.provide(messageBoardHarness().layer),
      Effect.provide(projectTodoLayer()),
      Effect.provide(
        Layer.mergeAll(
          familyStorageHarness().layer,
          modelLayer,
          archiveLayer,
          SessionCatalogChanges.layer,
          makeCakeSessionRuntimesLayer({
            sessionIds: () => Stream.empty,
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
          }).pipe(Layer.provideMerge(makeRuntimeRecoveryStorageTestLayer())),
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
      const artifacts = yield* ArtifactStorage;
      const lineage = (yield* artifacts.catalog()).lineages[0];
      assert.ok(lineage);
      assert.equal((yield* artifacts.read(lineage.id))?.snapshot.title, "Editor isolation");
    }).pipe(
      Effect.provide(messageBoardHarness().layer),
      Effect.provide(projectTodoLayer()),
      Effect.provide(
        Layer.mergeAll(
          familyStorageHarness().layer,
          modelLayer,
          archiveLayer,
          SessionCatalogChanges.layer,
          makeCakeSessionRuntimesLayer({
            sessionIds: () => Stream.empty,
            catalog: () => Stream.empty,
            catalogEntry: (query, sessionId) => {
              assert.equal(query.workingDirectory, "/worktree");
              assert.equal(sessionId, "parent");
              return Effect.succeed({
                id: sessionId,
                title: "Editor isolation",
                created: "2026-01-01T00:00:00.000Z",
                modified: "2026-01-01T00:00:00.000Z",
                messageCount: 1,
                resolved: false,
              });
            },
            inspect: () => Effect.succeed(undefined),
            changelog: () => Effect.succeed(""),
            createRuntime: (runtimeOptions) =>
              Effect.succeed({
                ...fakeRuntime(runtimeOptions, () => undefined),
                sessionId: runtimeOptions.sessionId ?? "missing",
              }),
          }).pipe(Layer.provideMerge(makeRuntimeRecoveryStorageTestLayer())),
        ),
      ),
    ),
  );

  it.effect("retries a creation receipt without starting the same child twice", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      let launches = 0;
      let disposed = false;
      let initialMessage: string | undefined;
      const pi = makeCakeSessionRuntimesLayer({
        sessionIds: () => Stream.empty,
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
            prompt: async (text) => {
              initialMessage = text;
              launches += 1;
              Deferred.doneUnsafe(started, Effect.void);
            },
          }),
      }).pipe(Layer.provideMerge(makeRuntimeRecoveryStorageTestLayer()));
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
        assert.equal(second.launch.status, "already-admitted");
        assert.equal(launches, 1);
        const items = (yield* todos.list("/project")).items;
        assert.equal(items.length, 1);
        assert.equal(items[0]?.title, input.title);
        assert.equal(items[0]?.description, input.assignment.description);
        assert.deepEqual(items[0]?.associations, [
          { kind: "session", sessionId: first.childSessionId, title: input.title },
        ]);
        assert.deepEqual(parseCrossSessionMessage(initialMessage ?? ""), {
          text: parseCrossSessionMessage(initialMessage ?? "")?.text,
          metadata: {
            version: 1,
            messageId: first.childSessionId,
            threadId: first.familyId,
            sequence: 1,
            expectsResponse: true,
            resultDelivery: "notification",
            context: input.senderContext,
            sender: {
              sessionId: "parent",
              title: "Parent session parent",
              kind: "project-session",
              projectName: "Project",
              workingDirectory: "/worktree",
            },
          },
        });
      }).pipe(
        Effect.provide(messageBoardHarness().layer),
        Effect.provide(projectTodoLayer()),
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
