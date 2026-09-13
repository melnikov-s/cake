import { NodeFileSystem, NodePath } from "@effect/platform-node-shared";
import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import {
  Clock,
  Deferred,
  Effect,
  Fiber,
  FileSystem,
  Layer,
  Path,
  PlatformError,
  Stream,
} from "effect";
import { describe, expect, it } from "@effect/vitest";
import {
  cakeWorkspaceSessionDirectory,
  streamWorkspaceSessions,
} from "../../../../src/services/pi/runtime/session-discovery";
import { SessionArchiveStorage } from "../../../../src/services/storage/SessionArchiveStorage";
import { makeSessionArchiveStorageLive } from "../../../../src/services/storage/SessionArchiveStorageLive";

const PlatformLive = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer);

const runArchive = <A, E>(
  metadataRoot: string,
  use: (storage: SessionArchiveStorage["Service"]) => Effect.Effect<A, E>,
) =>
  Effect.flatMap(SessionArchiveStorage, use).pipe(
    Effect.provide(makeSessionArchiveStorageLive(metadataRoot).pipe(Layer.provide(PlatformLive))),
  );

const makeFixture = Effect.fn("SessionArchiveStorage.test.makeFixture")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "cake-session-archive-" });
  const activeRoot = path.join(cwd, "active");
  const resolvedRoot = path.join(cwd, "resolved");
  const activeDirectory = cakeWorkspaceSessionDirectory(cwd, activeRoot);
  const now = yield* Clock.currentTimeMillis;
  const timestamp = new Date(now).toISOString();
  yield* fileSystem.makeDirectory(activeDirectory, { recursive: true });
  yield* fileSystem.writeFileString(
    path.join(activeDirectory, "2026-01-01T00-00-00-000Z_session-1.jsonl"),
    `${[
      { type: "session", version: 3, id: "session-1", timestamp, cwd },
      {
        type: "message",
        id: "user-1",
        parentId: null,
        timestamp,
        message: { role: "user", content: "Archived work", timestamp: now },
      },
    ]
      .map((entry) => JSON.stringify(entry))
      .join("\n")}\n`,
  );
  return { cwd, activeRoot, resolvedRoot };
});

const makeMetadataRoot = Effect.fn("SessionArchiveStorage.test.makeMetadataRoot")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fileSystem.makeTempDirectoryScoped({
    prefix: "cake-session-archive-metadata-",
  });
  return path.join(directory, "archive");
});

const withPlatform = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provide(PlatformLive));

describe("SessionArchiveStorage", () => {
  it.effect("lazily indexes legacy project archives from Pi transcripts", () =>
    withPlatform(
      Effect.gen(function* () {
        const metadataRoot = yield* makeMetadataRoot();
        const location = yield* makeFixture();
        yield* runArchive(metadataRoot, (storage) => storage.resolve("session-1", location));

        expect(
          yield* runArchive(metadataRoot, (storage) =>
            storage.projectMigrationComplete("/projects/cake"),
          ),
        ).toBe(false);
        expect(
          yield* runArchive(metadataRoot, (storage) =>
            storage
              .migrateProject("/projects/cake", "Cake", [
                { location, worktreeName: "legacy-worktree" },
              ])
              .pipe(Stream.runCollect),
          ),
        ).toEqual([
          expect.objectContaining({
            sessionId: "session-1",
            worktreeName: "legacy-worktree",
          }),
        ]);
        expect(
          yield* runArchive(metadataRoot, (storage) =>
            storage.projectMigrationComplete("/projects/cake"),
          ),
        ).toBe(true);
        expect(
          yield* runArchive(metadataRoot, (storage) =>
            storage
              .migrateProject("/projects/cake", "Cake", [{ location }])
              .pipe(Stream.runCollect),
          ),
        ).toEqual([
          expect.objectContaining({
            sessionId: "session-1",
            worktreeName: "legacy-worktree",
          }),
        ]);
      }),
    ),
  );

  it.effect("lists project archives from Pi transcripts and restores with one file move", () =>
    withPlatform(
      Effect.gen(function* () {
        const metadataRoot = yield* makeMetadataRoot();
        const location = yield* makeFixture();

        yield* runArchive(metadataRoot, (storage) =>
          storage.resolveProject("session-1", location, {
            projectPath: "/projects/cake",
            projectName: "Cake",
            worktreeName: "archive-index",
          }),
        );
        const projectDirectory = yield* Effect.promise(() =>
          stat(
            `${metadataRoot}/projects/${createHash("sha256").update("/projects/cake").digest("hex")}`,
          ),
        );
        expect(projectDirectory.mode & 0o777).toBe(0o700);
        const projectEntry = yield* Effect.promise(() =>
          stat(
            `${metadataRoot}/projects/${createHash("sha256").update("/projects/cake").digest("hex")}/${createHash("sha256").update("session-1").digest("hex")}.json`,
          ),
        );
        expect(projectEntry.mode & 0o777).toBe(0o600);
        expect(
          yield* runArchive(metadataRoot, (storage) =>
            storage.resolvedProjects("/projects/cake").pipe(Stream.runCollect),
          ),
        ).toEqual([
          expect.objectContaining({
            sessionId: "session-1",
            worktreeName: "archive-index",
          }),
        ]);

        expect(
          yield* runArchive(metadataRoot, (storage) => storage.restoreProject("session-1")),
        ).toEqual(expect.objectContaining({ sessionId: "session-1" }));
        expect(
          yield* runArchive(metadataRoot, (storage) =>
            storage.resolvedProjects("/projects/cake").pipe(Stream.runCollect),
          ),
        ).toEqual([]);
        expect(
          yield* streamWorkspaceSessions(location.cwd, location.activeRoot).pipe(Stream.runCollect),
        ).toEqual([expect.objectContaining({ id: "session-1" })]);
      }),
    ),
  );

  it.effect("restores the active transcript when project metadata persistence is interrupted", () =>
    withPlatform(
      Effect.gen(function* () {
        const metadataRoot = yield* makeMetadataRoot();
        const location = yield* makeFixture();
        const fileSystem = yield* FileSystem.FileSystem;
        const locatorWriteStarted = yield* Deferred.make<void>();
        const releaseLocatorWrite = yield* Deferred.make<void>();
        const controlledFileSystem = FileSystem.makeNoop({
          ...fileSystem,
          writeFileString: (target, content, options) =>
            fileSystem
              .writeFileString(target, content, options)
              .pipe(
                Effect.andThen(
                  target.startsWith(`${metadataRoot}/sessions/`)
                    ? Deferred.succeed(locatorWriteStarted, undefined).pipe(
                        Effect.andThen(Deferred.await(releaseLocatorWrite)),
                      )
                    : Effect.void,
                ),
              ),
        });
        const controlledPlatform = Layer.mergeAll(
          Layer.succeed(FileSystem.FileSystem)(controlledFileSystem),
          NodePath.layer,
        );
        yield* Effect.gen(function* () {
          const storage = yield* SessionArchiveStorage;
          const resolving = yield* storage
            .resolveProject("session-1", location, {
              projectPath: "/projects/cake",
              projectName: "Cake",
            })
            .pipe(Effect.forkChild);
          yield* Deferred.await(locatorWriteStarted);
          yield* Fiber.interrupt(resolving);
          expect(yield* storage.locate("session-1", location)).toBe("active");
          expect(yield* storage.resolvedProjectEntry("session-1")).toBeUndefined();
        }).pipe(
          Effect.provide(
            makeSessionArchiveStorageLive(metadataRoot).pipe(Layer.provide(controlledPlatform)),
          ),
        );
      }),
    ),
  );

  it.effect("restores archive metadata and transcript when restore metadata removal fails", () =>
    withPlatform(
      Effect.gen(function* () {
        const metadataRoot = yield* makeMetadataRoot();
        const location = yield* makeFixture();
        const fileSystem = yield* FileSystem.FileSystem;
        let failLocatorRemoval = false;
        const controlledFileSystem = FileSystem.makeNoop({
          ...fileSystem,
          remove: (target, options) =>
            failLocatorRemoval && target.startsWith(`${metadataRoot}/sessions/`)
              ? Effect.fail(
                  PlatformError.systemError({
                    _tag: "Unknown",
                    module: "SessionArchiveStorageTest",
                    method: "remove",
                  }),
                )
              : fileSystem.remove(target, options),
        });
        const controlledPlatform = Layer.mergeAll(
          Layer.succeed(FileSystem.FileSystem)(controlledFileSystem),
          NodePath.layer,
        );
        yield* Effect.gen(function* () {
          const storage = yield* SessionArchiveStorage;
          yield* storage.resolveProject("session-1", location, {
            projectPath: "/projects/cake",
            projectName: "Cake",
          });
          failLocatorRemoval = true;
          const error = yield* storage.restoreProject("session-1").pipe(Effect.flip);
          expect(error.operation).toBe("restoreProject");
          expect(yield* storage.locate("session-1", location)).toBe("resolved");
          expect(yield* storage.resolvedProjectEntry("session-1")).toEqual(
            expect.objectContaining({ sessionId: "session-1" }),
          );
        }).pipe(
          Effect.provide(
            makeSessionArchiveStorageLive(metadataRoot).pipe(Layer.provide(controlledPlatform)),
          ),
        );
      }),
    ),
  );

  it.effect("preserves Pi titles across resolve and restore", () =>
    withPlatform(
      Effect.gen(function* () {
        const metadataRoot = yield* makeMetadataRoot();
        const location = yield* makeFixture();

        yield* runArchive(metadataRoot, (storage) => storage.resolve("session-1", location));
        expect(
          yield* runArchive(metadataRoot, (storage) =>
            storage.resolvedEntry("session-1", location),
          ),
        ).toEqual(expect.objectContaining({ title: "Archived work" }));
        yield* runArchive(metadataRoot, (storage) => storage.restore("session-1", location));

        expect(
          yield* streamWorkspaceSessions(location.cwd, location.activeRoot).pipe(Stream.runCollect),
        ).toEqual([expect.objectContaining({ title: "Archived work" })]);
      }),
    ),
  );

  it.effect("moves a project session out of Pi's active root and restores it", () =>
    withPlatform(
      Effect.gen(function* () {
        const metadataRoot = yield* makeMetadataRoot();
        const location = yield* makeFixture();
        expect(
          yield* runArchive(metadataRoot, (storage) => storage.resolve("session-1", location)),
        ).toBe(true);
        expect(
          yield* runArchive(metadataRoot, (storage) => storage.resolve("session-1", location)),
        ).toBe(false);
        expect(
          yield* streamWorkspaceSessions(location.cwd, location.activeRoot).pipe(Stream.runCollect),
        ).toEqual([]);
        expect(
          yield* runArchive(metadataRoot, (storage) =>
            storage.resolved(location).pipe(Stream.runCollect),
          ),
        ).toEqual([expect.objectContaining({ id: "session-1", resolved: true })]);
        expect(
          yield* runArchive(metadataRoot, (storage) =>
            storage.resolvedEntry("session-1", location),
          ),
        ).toEqual(expect.objectContaining({ id: "session-1", resolved: true }));

        expect(
          yield* runArchive(metadataRoot, (storage) => storage.restore("session-1", location)),
        ).toBe(true);
        expect(
          yield* runArchive(metadataRoot, (storage) => storage.restore("session-1", location)),
        ).toBe(false);
        expect(
          yield* streamWorkspaceSessions(location.cwd, location.activeRoot).pipe(Stream.runCollect),
        ).toEqual([expect.objectContaining({ id: "session-1", resolved: false })]);
      }),
    ),
  );

  it.effect("treats concurrent archive requests as one idempotent move", () =>
    withPlatform(
      Effect.gen(function* () {
        const metadataRoot = yield* makeMetadataRoot();
        const location = yield* makeFixture();
        const outcomes = yield* Effect.all(
          [
            runArchive(metadataRoot, (storage) => storage.resolve("session-1", location)),
            runArchive(metadataRoot, (storage) => storage.resolve("session-1", location)),
          ],
          { concurrency: "unbounded" },
        );

        expect([...outcomes].sort()).toEqual([false, true]);
        expect(
          yield* streamWorkspaceSessions(location.cwd, location.activeRoot).pipe(Stream.runCollect),
        ).toEqual([]);
        expect(
          yield* runArchive(metadataRoot, (storage) =>
            storage.resolved(location).pipe(Stream.runCollect),
          ),
        ).toEqual([expect.objectContaining({ id: "session-1", resolved: true })]);
      }),
    ),
  );

  it.effect("permanently deletes a transcript from either namespace", () =>
    withPlatform(
      Effect.gen(function* () {
        const metadataRoot = yield* makeMetadataRoot();
        const activeLocation = yield* makeFixture();
        const resolvedLocation = yield* makeFixture();
        yield* runArchive(metadataRoot, (storage) =>
          storage.resolve("session-1", resolvedLocation),
        );

        yield* runArchive(metadataRoot, (storage) => storage.delete("session-1", activeLocation));
        yield* runArchive(metadataRoot, (storage) => storage.delete("session-1", resolvedLocation));
        const error = yield* runArchive(metadataRoot, (storage) =>
          storage.delete("session-1", activeLocation),
        ).pipe(Effect.flip);
        expect(error.message).toContain("Cake could not find session session-1");
      }),
    ),
  );

  it.effect("permanently deletes only a resolved transcript", () =>
    withPlatform(
      Effect.gen(function* () {
        const metadataRoot = yield* makeMetadataRoot();
        const location = yield* makeFixture();
        const firstError = yield* runArchive(metadataRoot, (storage) =>
          storage.deleteResolved("session-1", location),
        ).pipe(Effect.flip);
        expect(firstError.message).toContain("Cake could not find resolved session session-1");
        yield* runArchive(metadataRoot, (storage) => storage.resolve("session-1", location));
        yield* runArchive(metadataRoot, (storage) => storage.deleteResolved("session-1", location));
        const secondError = yield* runArchive(metadataRoot, (storage) =>
          storage.deleteResolved("session-1", location),
        ).pipe(Effect.flip);
        expect(secondError.message).toContain("Cake could not find resolved session session-1");
        expect(
          yield* runArchive(metadataRoot, (storage) =>
            storage.resolved(location).pipe(Stream.runCollect),
          ),
        ).toEqual([]);
      }),
    ),
  );
});
