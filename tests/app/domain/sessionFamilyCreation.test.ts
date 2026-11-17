import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { Deferred, Effect, Layer, Stream } from "effect";
import { describe } from "vitest";
import { createChild } from "../../../src/domain/session-families/sessionFamilyAdmission";
import { parseCrossSessionMessage } from "../../../src/contracts/conversations/cross-session-message";
import { PiModels } from "../../../src/services/pi/PiModels";
import { makeCakeSessionRuntimesLayer } from "../../../src/services/pi/CakeSessionRuntimes";
import { SessionFamilyStorage } from "../../../src/services/storage/SessionFamilyStorage";
import { familyMember } from "../../../src/contracts/session-families/session-family-document";
import { SessionArchiveStorage } from "../../../src/services/storage/SessionArchiveStorage";
import {
  RuntimeRecoveryStorage,
  type RuntimeRecoveryRecord,
} from "../../../src/services/storage/RuntimeRecoveryStorage";
import { SessionCatalogChanges } from "../../../src/services/session-catalogs/SessionCatalogChanges";
import { ArtifactStorage } from "../../../src/services/storage/ArtifactStorage";
import { messageBoardHarness } from "../helpers/messageBoardHarness";
import { familyStorageHarness } from "../helpers/familyStorageHarness";
import { projectTodoLayer } from "../helpers/projectTodoHarness";
import * as todos from "../../../src/domain/projects/projectTodos";
import {
  ProjectTodoReports,
  type ProjectTodoInitialDescription,
} from "../../../src/services/projects/ProjectTodoReports";
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
  for (const association of ["none", "explicit", "historical"] as const) {
    it.effect.each(["active", "blocked", "complete", "failed", "stopped"] as const)(
      `retries a %s child across restart without new tasks, preserving ${association} associations`,
      (state) =>
        Effect.gen(function* () {
          const familyFiles = new Map<string, string>();
          const boardFiles = new Map<string, string>();
          const started = yield* Deferred.make<void>();
          let launches = 0;
          let acquisitions = 0;
          const requests: ProjectTodoInitialDescription[] = [];
          const factory = (id: string) => {
            acquisitions++;
            return Effect.succeed(
              options({ cwd: location.workingDirectory, sessionId: id, newSession: true }),
            );
          };
          const environment = (records: ReadonlyArray<RuntimeRecoveryRecord> = []) =>
            Layer.mergeAll(
              familyStorageHarness(familyFiles).layer,
              messageBoardHarness(boardFiles).layer,
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
                    prompt: async () => {
                      launches++;
                      Deferred.doneUnsafe(started, Effect.void);
                    },
                  }),
              }).pipe(Layer.provideMerge(makeRuntimeRecoveryStorageTestLayer(records))),
            );
          yield* Effect.gen(function* () {
            yield* todos.ensureAdmittedSession("/project", "parent", "Outcome", "Do the work.");
            const parent = (yield* todos.list("/project")).items[0];
            assert.ok(parent);
            const admitted = yield* Effect.gen(function* () {
              const child = yield* createChild("parent", location, input, factory);
              assert.equal(child.launch.status, "accepted");
              yield* Deferred.await(started);
              assert.deepEqual((yield* todos.list("/project")).items, [parent]);
              const record = yield* (yield* RuntimeRecoveryStorage).get(child.childSessionId);
              assert.ok(record);
              return { child, record };
            }).pipe(Effect.provide(environment()));
            if (association === "explicit")
              yield* todos.attachExisting("/project", parent.id, {
                kind: "session",
                sessionId: admitted.child.childSessionId,
                title: input.title,
              });
            if (association === "historical")
              yield* todos.ensureSession(
                "/project",
                admitted.child.childSessionId,
                "Historical child task",
                "",
              );
            const before = yield* todos.list("/project");
            for (let pass = 0; pass < 2; pass++)
              yield* Effect.gen(function* () {
                const retried = yield* createChild("parent", location, input, factory);
                assert.equal(retried.childSessionId, admitted.child.childSessionId);
                assert.deepEqual(retried.launch, { status: "already-admitted", state });
                assert.deepEqual(yield* todos.list("/project"), before);
              }).pipe(Effect.provide(environment([{ ...admitted.record, state }])));
            assert.equal(acquisitions, 1);
            assert.equal(launches, 1);
            assert.equal(requests.length, 1, "Only the parent's automatic task queues a brief");
          }).pipe(
            Effect.provide(projectTodoLayer()),
            Effect.provide(
              Layer.mock(ProjectTodoReports, {
                offerInitial: (request) =>
                  Effect.sync(() => {
                    requests.push(request);
                  }),
              }),
            ),
          );
        }),
    );
  }

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

  it.effect("admits and retries a child without creating a to-do or starting it twice", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      let launches = 0;
      let disposed = false;
      let initialMessage: string | undefined;
      const requests: ProjectTodoInitialDescription[] = [];
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
        assert.deepEqual((yield* todos.list("/project")).items, []);
        assert.equal(requests.length, 0);
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
        assert.deepEqual((yield* todos.list("/project")).items, []);
        assert.equal(requests.length, 0);
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
        Effect.provide(
          Layer.mock(ProjectTodoReports, {
            offerInitial: (request) =>
              Effect.sync(() => {
                requests.push(request);
              }),
          }),
        ),
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
