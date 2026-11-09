import assert from "node:assert/strict";
import type * as fsPromises from "node:fs/promises";
import { lstat, mkdir, mkdtemp, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { it } from "@effect/vitest";
import { Effect, Layer, Queue, Stream } from "effect";
import { afterEach, describe, vi } from "vitest";
import { defaultApplicationState } from "../../../src/contracts/application/application-data";
import type { SessionCatalogUpdate } from "../../../src/contracts/application/catalog-data";
import {
  familyMember,
  familyMemberIds,
  type SessionFamily,
} from "../../../src/contracts/session-families/session-family-document";
import * as metadata from "../../../src/domain/project-sessions/projectSessionMetadata";
import {
  CakeSessionRuntimes,
  makeCakeSessionRuntimesLayer,
  PiSessionError,
} from "../../../src/services/pi/CakeSessionRuntimes";
import {
  loadWorkspacePiSessionSummary,
  streamWorkspaceSessionIds,
  streamWorkspaceSessions,
} from "../../../src/services/pi/runtime/session-discovery";
import { ProjectSessionConfiguration } from "../../../src/services/project-sessions/ProjectSessionConfiguration";
import { SessionCatalogChanges } from "../../../src/services/session-catalogs/SessionCatalogChanges";
import { ApplicationState } from "../../../src/services/storage/ApplicationState";
import { SessionArchiveStorage } from "../../../src/services/storage/SessionArchiveStorage";
import { SessionFamilyStorage } from "../../../src/services/storage/SessionFamilyStorage";
import {
  type SessionFileSnapshot,
  workingDirectorySessionPath,
} from "../../../src/services/storage/session-files";
import { ManagedWorktrees } from "../../../src/services/worktrees/ManagedWorktrees";
import { makeRuntimeRecoveryStorageTestLayer } from "../helpers/piRuntimeFixture";

vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof fsPromises>();
  return { ...fs, readdir: vi.fn(fs.readdir), lstat: vi.fn(fs.lstat) };
});

afterEach(() => {
  vi.mocked(readdir).mockClear();
  vi.mocked(lstat).mockClear();
});

const timestamp = "2026-01-01T00:00:00.000Z";
const filename = (id: string) => `2026-01-01T00-00-00-000Z_${id}.jsonl`;
const makeFixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "cake-catalog-generation-"));
  const project = join(root, "project");
  const worktree = join(root, "retired-worktree");
  const sessions = join(root, "sessions");
  let families: SessionFamily[] = [0, 1].map((index) => ({
    familyId: `family-${index}`,
    parentSessionId: `parent-${index}`,
    projectPath: project,
    workingDirectory: project,
    createdAt: timestamp,
    children: Array.from({ length: index === 0 ? 20 : 2 }, (_, child) => ({
      sessionId: `child-${index}-${child}`,
      parentSessionId: `parent-${index}`,
      requestId: `request-${index}-${child}`,
      workingDirectory: child === 19 ? worktree : project,
      createdAt: timestamp,
    })),
  }));
  const write = async (id: string, cwd: string, title = `Title ${id}`, contentId = id) => {
    const directory = workingDirectorySessionPath(cwd, sessions);
    await mkdir(directory, { recursive: true });
    const file = join(directory, filename(id));
    await writeFile(
      file,
      [
        { type: "session", version: 3, id: contentId, cwd, timestamp },
        { type: "session_info", id: "title", parentId: null, name: title, timestamp },
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n") + "\n",
    );
    return file;
  };
  for (const family of families) {
    await write(family.parentSessionId, family.workingDirectory);
    for (const child of family.children) await write(child.sessionId, child.workingDirectory);
  }
  const noiseFiles = process.env.CAKE_CATALOG_LARGE_FIXTURE === "1" ? 2500 : 0;
  for (let offset = 0; offset < noiseFiles; offset += 32) {
    await Promise.all(
      Array.from({ length: Math.min(32, noiseFiles - offset) }, (_, index) =>
        write(`history-${offset + index}`, project),
      ),
    );
  }
  const uses: Array<{ id: string; cwd: string; snapshot: SessionFileSnapshot | undefined }> = [];
  const state = {
    ...defaultApplicationState(),
    projects: [{ path: project, name: "Fixture", addedAt: timestamp, lastOpenedAt: timestamp }],
  };
  const runtimes = makeCakeSessionRuntimesLayer({
    sessionIds: (query) =>
      streamWorkspaceSessionIds(query.workingDirectory, query.sessionDirectory),
    catalog: (query) =>
      streamWorkspaceSessions(query.workingDirectory, query.sessionDirectory, query),
    catalogEntry: (query, id, fileSnapshot) => {
      uses.push({ id, cwd: query.workingDirectory, snapshot: fileSnapshot });
      return Effect.tryPromise({
        try: () =>
          loadWorkspacePiSessionSummary(query.workingDirectory, id, query.sessionDirectory, {
            fileSnapshot,
          }),
        catch: (error) => new PiSessionError({ operation: "catalogEntry", message: String(error) }),
      });
    },
    inspect: () => Effect.die("Catalog discovery must not inspect conversations"),
    createRuntime: () => Effect.die("Catalog discovery must not acquire workers"),
    changelog: () => Effect.succeed(""),
  }).pipe(Layer.provide(makeRuntimeRecoveryStorageTestLayer()));
  const layer = Layer.mergeAll(
    runtimes,
    SessionCatalogChanges.layer,
    Layer.mock(ApplicationState, { current: () => Effect.succeed(state), snapshot: () => state }),
    Layer.succeed(ProjectSessionConfiguration, {
      agentDirectory: join(root, "agent"),
      sessionDirectory: sessions,
      resolvedSessionDirectory: join(root, "resolved"),
    }),
    Layer.mock(ManagedWorktrees, { records: () => Effect.succeed([]) }),
    Layer.mock(SessionFamilyStorage, {
      state: () => Effect.succeed({ families, turns: [], spawnedSessions: [] }),
      familyForMember: (id) => Effect.succeed(families.find((family) => familyMember(family, id))),
    }),
    Layer.mock(SessionArchiveStorage, {
      locate: () => Effect.succeed("active"),
      resolvedIds: () => Effect.succeed(new Set<string>()),
      resolvedProjectEntry: () => Effect.succeed(undefined),
      projectMigrationComplete: () => Effect.succeed(true),
      resolvedProjects: () => Stream.empty,
      projectTitles: () => Effect.succeed(new Map<string, string>()),
    }),
  );
  return {
    root,
    project,
    worktree,
    sessions,
    directoryFiles: 24 + noiseFiles,
    layer,
    uses,
    write,
    families: () => families,
    addChild: async () => {
      const family = families[0];
      assert.ok(family);
      const child = {
        sessionId: "new-child",
        parentSessionId: family.parentSessionId,
        requestId: "new-request",
        workingDirectory: project,
        createdAt: timestamp,
      };
      await write(child.sessionId, project);
      families = [{ ...family, children: [...family.children, child] }, ...families.slice(1)];
    },
  };
};

type Fixture = Awaited<ReturnType<typeof makeFixture>>;
const usingFixture = <A, E, R>(run: (fixture: Fixture) => Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.promise(makeFixture),
    (fixture) => Effect.scoped(run(fixture).pipe(Effect.provide(fixture.layer))),
    (fixture) => Effect.promise(() => rm(fixture.root, { recursive: true, force: true })),
  );
const clear = (fixture: Fixture) => {
  fixture.uses.length = 0;
  vi.mocked(readdir).mockClear();
  vi.mocked(lstat).mockClear();
};
const open = Effect.fn("CatalogSnapshotsTest.open")(function* (
  fixture: Fixture,
  resolved: boolean,
) {
  const queue = yield* Queue.unbounded<SessionCatalogUpdate>();
  yield* (yield* metadata.observeCatalog({ projectPath: fixture.project, resolved })).pipe(
    Stream.runForEach((update) => Queue.offer(queue, update)),
    Effect.forkScoped,
  );
  const initial = yield* Queue.take(queue);
  assert.equal(initial._tag, "Snapshot");
  return { queue, initial };
});
const publish = Effect.fn("CatalogSnapshotsTest.publish")(function* (fixture: Fixture) {
  yield* (yield* SessionCatalogChanges).publish({
    _tag: "ProjectSessionChanged",
    projectPath: fixture.project,
    sessionId: "parent-0",
    workingDirectory: fixture.project,
    resolved: false,
  });
});
const expectFamily = Effect.fn("CatalogSnapshotsTest.expectFamily")(function* (
  fixture: Fixture,
  queue: Queue.Queue<SessionCatalogUpdate>,
) {
  const update = yield* Queue.take(queue);
  assert.ok(update._tag === "Event" && update.event._tag === "UpsertedBatch");
  assert.deepEqual(
    update.event.sessions.map((session) => session.sessionId),
    familyMemberIds(fixture.families()[0]!),
  );
});

describe("production catalog generation filename snapshots", () => {
  it.effect(
    "shares one listing per route across concurrent members and multiple families, but leaves resolved-only lanes lazy",
    () =>
      usingFixture((fixture) =>
        Effect.gen(function* () {
          clear(fixture);
          yield* open(fixture, true);
          assert.equal(vi.mocked(readdir).mock.calls.length, 0);
          yield* open(fixture, false);
          assert.equal(vi.mocked(readdir).mock.calls.length, 2);
          assert.equal(fixture.uses.length, 24);
          for (const cwd of [fixture.project, fixture.worktree]) {
            const snapshots = fixture.uses
              .filter((use) => use.cwd === cwd)
              .map((use) => use.snapshot);
            assert.ok(snapshots.every((snapshot) => snapshot !== undefined));
            assert.equal(new Set(snapshots).size, 1);
          }
          assert.equal(
            vi.mocked(lstat).mock.calls.length,
            24,
            "filenames are reused, not per-member metadata",
          );
        }),
      ),
  );

  it.live.each([1, 2, 8])(
    "measures real filesystem fan-out at %i windows with fresh generations",
    (windows) =>
      usingFixture((fixture) =>
        Effect.gen(function* () {
          const consumers = yield* Effect.forEach(Array.from({ length: windows }), () =>
            open(fixture, false),
          );
          yield* open(fixture, true);
          clear(fixture);
          const start = performance.now();
          const loop = performance.eventLoopUtilization();
          yield* publish(fixture);
          for (const { queue } of consumers) yield* expectFamily(fixture, queue);
          const firstSnapshots = fixture.uses.map((use) => use.snapshot);
          yield* Effect.promise(fixture.addChild);
          yield* publish(fixture);
          for (const { queue } of consumers) yield* expectFamily(fixture, queue);
          const baseline = process.env.CAKE_CATALOG_SNAPSHOT_BASELINE === "1";
          const listings = vi.mocked(readdir).mock.calls.length;
          const stats = vi.mocked(lstat).mock.calls.length;
          console.log(
            "catalog-filesystem",
            JSON.stringify({
              windows,
              baseline,
              directoryFiles: fixture.directoryFiles,
              listings,
              stats,
              elapsedMs: +(performance.now() - start).toFixed(3),
              eventLoopActiveMs: +performance.eventLoopUtilization(loop).active.toFixed(3),
            }),
          );
          assert.equal(listings, baseline ? 43 : 4);
          assert.equal(stats, 43);
          if (!baseline) {
            assert.equal(new Set(firstSnapshots).size, 2);
            assert.ok(
              fixture.uses
                .slice(21)
                .every((use) => use.snapshot && !firstSnapshots.includes(use.snapshot)),
            );
          }
        }),
      ),
  );

  it.effect(
    "exact lookup refreshes filename and title evidence on each request and still rejects deletion and collisions",
    () =>
      usingFixture((fixture) =>
        Effect.gen(function* () {
          const target = { sessionId: "child-0-19", workingDirectory: fixture.worktree };
          clear(fixture);
          assert.equal((yield* metadata.lookup(target)).title, "Title child-0-19");
          assert.equal(vi.mocked(readdir).mock.calls.length, 1);
          assert.ok(fixture.uses[0]?.snapshot);
          const file = join(
            workingDirectorySessionPath(fixture.worktree, fixture.sessions),
            filename(target.sessionId),
          );
          const replacement = yield* Effect.promise(() =>
            fixture.write(
              "replacement",
              fixture.worktree,
              "Fresh externally replaced title",
              target.sessionId,
            ),
          );
          yield* Effect.promise(() => rename(replacement, file));
          const previous = fixture.uses[0]?.snapshot;
          clear(fixture);
          assert.equal((yield* metadata.lookup(target)).title, "Fresh externally replaced title");
          assert.equal(vi.mocked(readdir).mock.calls.length, 1);
          assert.notEqual(fixture.uses[0]?.snapshot, previous);
          const collision = join(
            workingDirectorySessionPath(fixture.worktree, fixture.sessions),
            `malformed_${target.sessionId}.jsonl`,
          );
          yield* Effect.promise(() => writeFile(collision, "collision"));
          const failed = yield* Effect.result(metadata.lookup(target));
          assert.equal(failed._tag, "Failure");
          if (failed._tag === "Failure") assert.match(failed.failure.message, /collision/);
          yield* Effect.promise(() => rm(collision));
          yield* Effect.promise(() => rm(file));
          const deleted = yield* Effect.result(metadata.lookup(target));
          assert.equal(deleted._tag, "Failure");
          if (deleted._tag === "Failure") assert.match(deleted.failure.message, /could not find/);
        }),
      ),
  );
});
