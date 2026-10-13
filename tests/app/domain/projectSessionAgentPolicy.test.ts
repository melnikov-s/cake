import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { Effect, Layer, Stream } from "effect";
import { describe } from "vitest";
import { defaultApplicationState } from "../../../src/contracts/application/application-data";
import * as policy from "../../../src/domain/project-sessions/projectSessionAgentPolicy";
import { fork } from "../../../src/domain/project-sessions/projectSessionContinuations";
import { acquireOptions } from "../../../src/domain/project-sessions/projectSessionRuntime";
import { makeCakeSessionRuntimesLayer } from "../../../src/services/pi/CakeSessionRuntimes";
import { ApplicationState } from "../../../src/services/storage/ApplicationState";
import { ArtifactStorage } from "../../../src/services/storage/ArtifactStorage";
import { SessionArchiveStorage } from "../../../src/services/storage/SessionArchiveStorage";
import { SessionFamilyStorage } from "../../../src/services/storage/SessionFamilyStorage";
import { SessionCatalogChanges } from "../../../src/services/session-catalogs/SessionCatalogChanges";
import { ManagedWorktrees } from "../../../src/services/worktrees/ManagedWorktrees";
import { familyStorageHarness } from "../helpers/familyStorageHarness";
import { WorkflowTestLive } from "../helpers/workflowFixture";
import { fakeRuntime } from "../helpers/piRuntimeFixture";
import { makeProjectSessionRuntimeMechanismTestLayer } from "./projectSessionRuntimeTestLayer";

const location = {
  projectPath: "/project",
  projectName: "Project",
  workingDirectory: "/project",
  sessionDirectory: "/cake/sessions",
  resolvedSessionDirectory: "/cake/resolved",
};

const addChild = Effect.fn("Test.addChild")(function* (
  parentSessionId: string,
  childSessionId: string,
) {
  const storage = yield* SessionFamilyStorage;
  yield* storage.addChild({
    familyId: "family",
    parentSessionId,
    childSessionId,
    requestId: `create-${childSessionId}`,
    parentWorkingDirectory: "/project",
    childWorkingDirectory: "/project",
    projectPath: "/project",
    createdAt: "2026-01-01T00:00:00.000Z",
  });
});

const environment = (forked: string[] = []) =>
  Layer.mergeAll(
    WorkflowTestLive,
    familyStorageHarness().layer,
    makeProjectSessionRuntimeMechanismTestLayer(),
    SessionCatalogChanges.layer,
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
    Layer.mock(ArtifactStorage, {}),
    Layer.mock(SessionArchiveStorage, {
      locate: () => Effect.succeed("active" as const),
      resolved: () => Stream.empty,
      resolvedProjects: () => Stream.empty,
      resolvedProjectEntry: () => Effect.succeed(undefined),
    }),
    Layer.mock(ManagedWorktrees, {
      records: () => Effect.succeed([]),
      awaitSetup: () => Effect.void,
    }),
    makeCakeSessionRuntimesLayer({
      sessionIds: () => Stream.empty,
      catalog: () => Stream.empty,
      catalogEntry: () => Effect.succeed(undefined),
      inspect: () => Effect.succeed(undefined),
      changelog: () => Effect.succeed(""),
      createRuntime: (options) =>
        Effect.succeed({
          ...fakeRuntime(options, () => undefined),
          sessionId: options.sessionId ?? "unknown",
          fork: async () => {
            forked.push(options.sessionId ?? "unknown");
            return { sessionId: "fork", sessionFile: "/sessions/fork.jsonl", artifactPointers: [] };
          },
        }),
    }),
  );

describe("Project Session live agent policy", () => {
  it.effect(
    "changes standalone fork and deferral policy after the same session becomes a family root",
    () =>
      Effect.gen(function* () {
        const options = yield* acquireOptions({ location, sessionId: "root", newSession: false });
        const control = options.runtime.currentSessionControl;
        assert.ok(control?.forkSession);
        assert.deepEqual(yield* Effect.promise(() => control.readPolicy()), {
          canFork: true,
          deferResolution: true,
        });
        yield* policy.assertCanFork("root");
        yield* addChild("root", "child");
        assert.deepEqual(yield* Effect.promise(() => control.readPolicy()), {
          canFork: false,
          deferResolution: false,
          family: {
            familyId: "family",
            parentSessionId: "root",
            role: "root",
            childSessionIds: ["child"],
          },
        });
        assert.deepEqual(yield* policy.read("unrelated"), { canFork: true, deferResolution: true });
        // Acquisition after promotion still exposes the fixed Project Session capability.
        const promoted = yield* acquireOptions({ location, sessionId: "root", newSession: false });
        assert.ok(promoted.runtime.currentSessionControl?.forkSession);
      }).pipe(Effect.provide(environment())),
  );

  it.effect("reports newly created direct children without reacquiring the parent runtime", () =>
    Effect.gen(function* () {
      const options = yield* acquireOptions({ location, sessionId: "root", newSession: false });
      const control = options.runtime.currentSessionControl;
      assert.ok(control);
      yield* addChild("root", "first");
      const childOptions = yield* acquireOptions({
        location,
        sessionId: "first",
        newSession: false,
      });
      const childControl = childOptions.runtime.currentSessionControl;
      assert.ok(childControl);
      yield* addChild("first", "grandchild");
      yield* addChild("root", "second");
      yield* addChild("first", "other-grandchild");
      assert.deepEqual(
        (yield* Effect.promise(() => control.readPolicy())).family?.childSessionIds,
        ["first", "second"],
      );
      assert.deepEqual(yield* Effect.promise(() => childControl.readPolicy()), {
        canFork: false,
        deferResolution: false,
        family: {
          familyId: "family",
          parentSessionId: "root",
          role: "child",
          childSessionIds: ["grandchild", "other-grandchild"],
        },
      });
      assert.deepEqual((yield* policy.read("grandchild")).family, {
        familyId: "family",
        parentSessionId: "first",
        role: "child",
        childSessionIds: [],
      });
    }).pipe(Effect.provide(environment())),
  );

  it.effect(
    "rejects an agent fork after family promotion while preserving ordinary user forks",
    () => {
      const forked: string[] = [];
      return Effect.gen(function* () {
        const options = yield* acquireOptions({ location, sessionId: "root", newSession: false });
        const control = options.runtime.currentSessionControl;
        const agentFork = control?.forkSession;
        assert.ok(control);
        assert.ok(agentFork);
        assert.equal((yield* Effect.promise(() => control.readPolicy())).canFork, true);
        yield* addChild("root", "child");
        yield* Effect.promise(() =>
          assert.rejects(agentFork({ entryId: "entry", resolveSource: false, placement: "none" }), {
            _tag: "ProjectSessionError",
            operation: "fork",
            message: "Session Family members cannot be forked by their agent",
          }),
        );
        assert.deepEqual(forked, []);
        const result = yield* fork({
          target: { sessionId: "root", workingDirectory: "/project" },
          entryId: "entry",
          resolveSource: false,
        });
        assert.deepEqual(result, { sessionId: "fork" });
        assert.deepEqual(forked, ["root"]);
        assert.equal((yield* policy.read("fork")).canFork, true);
      }).pipe(Effect.provide(environment(forked)));
    },
  );
});
