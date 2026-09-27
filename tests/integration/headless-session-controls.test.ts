import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { Context, Effect, Layer, Queue, Stream } from "effect";
import { acquireOptions } from "../../src/domain/project-sessions/projectSessionRuntime";
import { ManagedWorktrees } from "../../src/services/worktrees/ManagedWorktrees";
import { ProjectAccess } from "../../src/services/projects/ProjectAccess";
import { PiModels } from "../../src/services/pi/PiModels";
import { SessionFamilyStorage } from "../../src/services/storage/SessionFamilyStorage";
import { familyStorageHarness } from "../app/helpers/familyStorageHarness";
import { SessionArchiveStorage } from "../../src/services/storage/SessionArchiveStorage";
import { makeNetworkTestBackend } from "./fixtures/network-backend";

const project = {
  sessionId: "00000000-0000-4000-8000-000000000001",
  newSession: false,
  location: {
    projectPath: "/project",
    projectName: "Test",
    workingDirectory: "/project",
    sessionDirectory: "/sessions",
    resolvedSessionDirectory: "/resolved",
  },
};
const model = {
  provider: "test",
  modelId: "controlled",
  thinkingLevel: "off" as const,
  fastMode: false,
};

it.live(
  "headless create control admits root and managed-worktree turns with no presentation client",
  () =>
    Effect.gen(function* () {
      const backend = yield* makeNetworkTestBackend();
      const service = Context.get(backend.context, ManagedWorktrees);
      const access = Context.get(backend.context, ProjectAccess);
      const archive = Context.get(backend.context, SessionArchiveStorage);
      const models = Context.get(backend.context, PiModels);
      const familyContext = yield* Layer.build(familyStorageHarness().layer);
      const families = Context.get(familyContext, SessionFamilyStorage);
      const created: Array<{ projectPath: string; base?: string; name?: string }> = [];
      const records: Array<{
        projectPath: string;
        worktreePath: string;
        branch: string;
        baseBranch: string;
        createdAt: string;
      }> = [];
      const worktrees = ManagedWorktrees.of({
        ...service,
        records: () => Effect.succeed(records),
        createWithBackgroundSetup: (projectPath, base, name) =>
          Effect.sync(() => {
            created.push({ projectPath, base, name });
            const record = {
              projectPath,
              worktreePath: `/worktrees/${name}`,
              branch: `agent/${name}`,
              baseBranch: "main",
              createdAt: "2026-01-01T00:00:00.000Z",
            };
            records.push(record);
            return record;
          }),
        awaitSetup: () => Effect.void,
      });
      const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        effect.pipe(
          Effect.provideService(ManagedWorktrees, worktrees),
          Effect.provideService(SessionFamilyStorage, families),
          Effect.provideService(
            PiModels,
            PiModels.of({ ...models, resolve: (selection) => Effect.succeed(selection) }),
          ),
          Effect.provideService(
            SessionArchiveStorage,
            SessionArchiveStorage.of({
              ...archive,
              resolved: () => Stream.empty,
              locate: () => Effect.succeed(undefined),
            }),
          ),
          Effect.provideService(
            ProjectAccess,
            ProjectAccess.of({
              ...access,
              allow: () => Effect.void,
              isAllowed: () => Effect.succeed(true),
            }),
          ),
          Effect.provideContext(backend.context),
        );
      const options = yield* run(acquireOptions(project));
      const create = options.runtime.currentSessionControl?.createSession;
      assert.ok(create);
      const root = yield* Effect.promise(() =>
        create(
          { name: "Root job", initialPrompt: "Root work", model },
          new AbortController().signal,
        ),
      );
      assert.equal((root as { workspacePath: string }).workspacePath, "/project");
      assert.equal(yield* Queue.take(backend.started), "Root work");
      const isolated = yield* Effect.promise(() =>
        create(
          {
            name: "Isolated job",
            initialPrompt: "Isolated work",
            model,
            worktreeName: "isolated-job",
          },
          new AbortController().signal,
        ),
      );
      assert.equal(
        (isolated as { workspacePath: string }).workspacePath,
        "/worktrees/isolated-job",
      );
      assert.equal(yield* Queue.take(backend.started), "Isolated work");
      assert.deepEqual(created, [
        { projectPath: "/project", base: undefined, name: "isolated-job" },
      ]);
      assert.equal(backend.stats.turns, 2);
      const fork = options.runtime.currentSessionControl?.forkSession;
      assert.ok(fork);
      const forked = yield* Effect.promise(() =>
        fork({ entryId: "entry-1", resolveSource: false, placement: "none" }),
      );
      assert.equal((forked as { sessionId: string }).sessionId, "fork");
      // Source and continuation pass through the real Cake domain/runtime;
      // only Pi's fork operation returns the controlled fixture identity.
      assert.equal(backend.stats.acquisitions, 4);
      const createChild = options.runtime.currentSessionControl?.createChildSession;
      assert.ok(createChild);
      const child = yield* Effect.promise(() =>
        createChild(
          {
            requestId: "00000000-0000-4000-8000-000000000009",
            title: "Child task",
            initialPrompt: "Child work",
            model,
            placement: "none",
            worktreeName: "child-isolated",
            senderContext: { usedTokens: 100, windowTokens: 1000 },
          },
          new AbortController().signal,
        ),
      );
      assert.equal(
        (child as { workingDirectory: string }).workingDirectory,
        "/worktrees/child-isolated",
      );
      assert.equal((child as { launch: { status: string } }).launch.status, "accepted");
      assert.match(yield* Queue.take(backend.started), /Child work/);
      assert.equal(created.at(-1)?.base, "/project");
      assert.equal(backend.stats.turns, 3);
    }).pipe(Effect.scoped),
);
