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
  roots = { activeRoot: `${metadataRoot}/active`, resolvedRoot: `${metadataRoot}/resolved` },
) =>
  Effect.flatMap(SessionArchiveStorage, use).pipe(
    Effect.provide(
      makeSessionArchiveStorageLive(metadataRoot, roots).pipe(Layer.provide(PlatformLive)),
    ),
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
  return {
    cwd,
    activeRoot,
    resolvedRoot,
    sessionFile: path.join(activeDirectory, "2026-01-01T00-00-00-000Z_session-1.jsonl"),
  };
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
  it.effect(
    "resolution snapshot reads the existing metadata index exactly once, without archives, migrations or transcripts",
    () =>
      withPlatform(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const metadataRoot = yield* fs.makeTempDirectoryScoped({
            prefix: "cake-resolution-snapshot-",
          });
          const indexPath = `${metadataRoot}/resolution.json`;
          const document = {
            version: 1,
            directories: { "/sessions/project": ["resolved-session"] },
          };
          yield* fs.writeFileString(indexPath, JSON.stringify(document));
          const reads: string[] = [];
          const scans: string[] = [];
          const instrumented = Layer.succeed(FileSystem.FileSystem, {
            ...fs,
            readFileString: (...args) => {
              reads.push(args[0]);
              return fs.readFileString(...args);
            },
            readDirectory: (...args) => {
              scans.push(args[0]);
              return fs.readDirectory(...args);
            },
          });
          const snapshot = yield* Effect.flatMap(SessionArchiveStorage, (storage) =>
            storage.resolutionSnapshot(),
          ).pipe(
            Effect.provide(
              makeSessionArchiveStorageLive(metadataRoot, {
                activeRoot: "/sessions",
                resolvedRoot: "/resolved",
              }).pipe(Layer.provide(Layer.mergeAll(instrumented, NodePath.layer))),
            ),
          );
          expect(snapshot).toEqual(document);
          expect(reads).toEqual([indexPath]);
          expect(scans).toEqual([]);
        }),
      ),
  );
  it.effect("migrates stale v1 Pi roots without modifying either transcript copy", () =>
    withPlatform(
      Effect.gen(function* () {
        const metadataRoot = yield* makeMetadataRoot();
        const location = yield* makeFixture();
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const hash = (value: string) => createHash("sha256").update(value).digest("hex");
        const entryPath = path.join(
          metadataRoot,
          "projects",
          hash("/projects/cake"),
          `${hash("session-1")}.json`,
        );
        const original = yield* fs.readFileString(location.sessionFile);
        yield* runArchive(
          metadataRoot,
          (storage) =>
            storage.resolveProject("session-1", location, {
              projectPath: "/projects/cake",
              projectName: "Cake",
              worktreeName: "archive-index",
            }),
          location,
        );
        const oldRoots = {
          activeRoot: path.join(location.cwd, "old-pi", "sessions"),
          resolvedRoot: path.join(location.cwd, "old-pi", "resolved"),
        };
        const oldDirectory = cakeWorkspaceSessionDirectory(location.cwd, oldRoots.activeRoot);
        const oldCopy = path.join(oldDirectory, path.basename(location.sessionFile));
        yield* fs.makeDirectory(oldDirectory, { recursive: true });
        yield* fs.writeFileString(oldCopy, original);
        const stored = JSON.parse(yield* fs.readFileString(entryPath));
        yield* fs.writeFileString(
          entryPath,
          JSON.stringify({ ...stored, ...oldRoots, version: 1 }),
        );
        const migrated = yield* runArchive(
          metadataRoot,
          (storage) => storage.resolvedProjects("/projects/cake").pipe(Stream.runCollect),
          location,
        );
        expect(migrated).toEqual([
          expect.objectContaining({
            version: 2,
            activeRoot: location.activeRoot,
            resolvedRoot: location.resolvedRoot,
            worktreeName: "archive-index",
          }),
        ]);
        expect(JSON.parse(yield* fs.readFileString(entryPath))).toEqual(migrated[0]);
        expect(yield* fs.readFileString(location.sessionFile)).toBe(original);
        expect(yield* fs.readFileString(oldCopy)).toBe(original);
        yield* runArchive(metadataRoot, (storage) => storage.restoreProject("session-1"), location);
        expect(yield* fs.readFileString(location.sessionFile)).toBe(original);
        expect(yield* fs.readFileString(oldCopy)).toBe(original);
        expect(
          yield* runArchive(
            metadataRoot,
            (storage) => storage.locate("session-1", location),
            location,
          ),
        ).toBe("active");
      }),
    ),
  );

  it.effect("relocates a legacy-only archived transcript when migrating its index", () =>
    withPlatform(
      Effect.gen(function* () {
        const metadataRoot = yield* makeMetadataRoot();
        const location = yield* makeFixture();
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const hash = (value: string) => createHash("sha256").update(value).digest("hex");
        const entryPath = path.join(
          metadataRoot,
          "projects",
          hash("/projects/cake"),
          `${hash("session-1")}.json`,
        );
        yield* runArchive(
          metadataRoot,
          (storage) =>
            storage.resolveProject("session-1", location, {
              projectPath: "/projects/cake",
              projectName: "Cake",
            }),
          location,
        );
        const archivedDirectory = cakeWorkspaceSessionDirectory(
          location.cwd,
          location.resolvedRoot,
        );
        yield* fs.makeDirectory(archivedDirectory, { recursive: true });
        yield* fs.rename(
          location.sessionFile,
          path.join(archivedDirectory, path.basename(location.sessionFile)),
        );
        const stored = JSON.parse(yield* fs.readFileString(entryPath));
        yield* fs.writeFileString(entryPath, JSON.stringify({ ...stored, version: 1 }));
        const roots = {
          activeRoot: path.join(location.cwd, "cake", "active"),
          resolvedRoot: path.join(location.cwd, "cake", "resolved"),
        };
        const migrated = yield* runArchive(
          metadataRoot,
          (storage) => storage.resolvedProjectEntry("session-1"),
          roots,
        );
        expect(migrated).toMatchObject({ ...roots, version: 2 });
        expect(
          yield* runArchive(
            metadataRoot,
            (storage) => storage.locate("session-1", { ...location, ...roots }),
            roots,
          ),
        ).toBe("resolved");
        expect(
          yield* runArchive(
            metadataRoot,
            (storage) => storage.locate("session-1", location),
            roots,
          ),
        ).toBeUndefined();
        expect(JSON.parse(yield* fs.readFileString(entryPath))).toEqual(migrated);
      }),
    ),
  );

  it.effect("does not rewrite a legacy index when the archived transcript is missing", () =>
    withPlatform(
      Effect.gen(function* () {
        const metadataRoot = yield* makeMetadataRoot();
        const location = yield* makeFixture();
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const hash = (value: string) => createHash("sha256").update(value).digest("hex");
        const entryPath = path.join(
          metadataRoot,
          "projects",
          hash("/projects/cake"),
          `${hash("session-1")}.json`,
        );
        yield* runArchive(
          metadataRoot,
          (storage) =>
            storage.resolveProject("session-1", location, {
              projectPath: "/projects/cake",
              projectName: "Cake",
            }),
          location,
        );
        yield* runArchive(
          metadataRoot,
          (storage) => storage.restore("session-1", location),
          location,
        );
        const stored = { ...JSON.parse(yield* fs.readFileString(entryPath)), version: 1 };
        yield* fs.writeFileString(entryPath, JSON.stringify(stored));
        const roots = {
          activeRoot: path.join(location.cwd, "cake", "active"),
          resolvedRoot: path.join(location.cwd, "cake", "resolved"),
        };
        const error = yield* runArchive(
          metadataRoot,
          (storage) => storage.resolvedProjectEntry("session-1"),
          roots,
        ).pipe(Effect.flip);
        expect(error.message).toContain("the archived transcript is missing");
        expect(JSON.parse(yield* fs.readFileString(entryPath))).toEqual(stored);
        expect(
          yield* runArchive(
            metadataRoot,
            (storage) => storage.locate("session-1", location),
            roots,
          ),
        ).toBe("active");
      }),
    ),
  );
  it.effect(
    "preserves transcript bytes, path and modification time across resolution and restoration",
    () =>
      withPlatform(
        Effect.gen(function* () {
          const metadataRoot = yield* makeMetadataRoot();
          const location = yield* makeFixture();
          const fs = yield* FileSystem.FileSystem;
          const before = yield* fs.readFileString(location.sessionFile);
          const modified = (yield* fs.stat(location.sessionFile)).mtime;
          yield* runArchive(metadataRoot, (storage) => storage.resolve("session-1", location));
          expect(yield* fs.readFileString(location.sessionFile)).toBe(before);
          expect((yield* fs.stat(location.sessionFile)).mtime).toEqual(modified);
          expect(
            yield* runArchive(metadataRoot, (storage) => storage.locate("session-1", location)),
          ).toBe("resolved");
          yield* runArchive(metadataRoot, (storage) => storage.restore("session-1", location));
          expect(yield* fs.readFileString(location.sessionFile)).toBe(before);
          expect((yield* fs.stat(location.sessionFile)).mtime).toEqual(modified);
        }),
      ),
  );

  it.effect(
    "does not lose concurrent metadata updates for separate directories and supports direct Cake Chat roots",
    () =>
      withPlatform(
        Effect.gen(function* () {
          const metadataRoot = yield* makeMetadataRoot();
          const project = yield* makeFixture();
          const chatFixture = yield* makeFixture();
          const path = yield* Path.Path;
          const chat = {
            ...chatFixture,
            activeRoot: path.dirname(chatFixture.sessionFile),
            direct: true,
          };
          yield* runArchive(metadataRoot, (storage) =>
            Effect.gen(function* () {
              yield* Effect.all(
                [storage.resolve("session-1", project), storage.resolve("session-1", chat)],
                { concurrency: "unbounded" },
              );
              expect(Object.values((yield* storage.resolutionSnapshot()).directories)).toEqual([
                ["session-1"],
                ["session-1"],
              ]);
              expect([...(yield* storage.resolvedIds(project))]).toEqual(["session-1"]);
              expect([...(yield* storage.resolvedIds(chat))]).toEqual(["session-1"]);
              yield* storage.restore("session-1", project);
              expect(
                Object.values((yield* storage.resolutionSnapshot()).directories).flat(),
              ).toEqual(["session-1"]);
              expect([...(yield* storage.resolvedIds(project))]).toEqual([]);
              expect([...(yield* storage.resolvedIds(chat))]).toEqual(["session-1"]);
            }),
          );
        }),
      ),
  );

  it.effect(
    "rejects malformed resolution metadata instead of treating resolved sessions as active",
    () =>
      withPlatform(
        Effect.gen(function* () {
          const metadataRoot = yield* makeMetadataRoot();
          const location = yield* makeFixture();
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          yield* fs.makeDirectory(metadataRoot, { recursive: true });
          yield* fs.writeFileString(
            path.join(metadataRoot, "resolution.json"),
            JSON.stringify({ version: 1, directories: { bad: true } }),
          );
          const error = yield* runArchive(metadataRoot, (storage) =>
            storage.resolvedIds(location),
          ).pipe(Effect.flip);
          expect(error._tag).toBe("SessionArchiveStorageError");
        }),
      ),
  );

  it.effect(
    "retries legacy migration after resolution metadata commits but the file move fails",
    () =>
      withPlatform(
        Effect.gen(function* () {
          const metadataRoot = yield* makeMetadataRoot();
          const location = yield* makeFixture();
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const directory = cakeWorkspaceSessionDirectory(location.cwd, location.resolvedRoot);
          const archivedFile = path.join(directory, path.basename(location.sessionFile));
          yield* fs.makeDirectory(directory, { recursive: true });
          yield* fs.rename(location.sessionFile, archivedFile);
          const controlled = FileSystem.makeNoop({
            ...fs,
            rename: (source, destination) =>
              source === archivedFile
                ? Effect.fail(
                    PlatformError.systemError({
                      _tag: "Unknown",
                      module: "MigrationTest",
                      method: "rename",
                    }),
                  )
                : fs.rename(source, destination),
          });
          const failed = yield* Effect.flatMap(SessionArchiveStorage, (storage) =>
            storage.resolvedIds(location),
          ).pipe(
            Effect.provide(
              makeSessionArchiveStorageLive(metadataRoot, location).pipe(
                Layer.provide(
                  Layer.mergeAll(Layer.succeed(FileSystem.FileSystem)(controlled), NodePath.layer),
                ),
              ),
            ),
            Effect.flip,
          );
          expect(failed._tag).toBe("SessionArchiveStorageError");
          expect(yield* fs.exists(archivedFile)).toBe(true);
          expect(yield* fs.exists(location.sessionFile)).toBe(false);
          expect(
            yield* runArchive(metadataRoot, (storage) => storage.locate("session-1", location)),
          ).toBe("resolved");
          expect(yield* fs.exists(location.sessionFile)).toBe(true);
          expect(yield* fs.exists(archivedFile)).toBe(false);
        }),
      ),
  );

  it.effect(
    "migrates indexed archives for retired worktrees even without registered location sources",
    () =>
      withPlatform(
        Effect.gen(function* () {
          const metadataRoot = yield* makeMetadataRoot();
          const location = yield* makeFixture();
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const directory = cakeWorkspaceSessionDirectory(location.cwd, location.resolvedRoot);
          yield* fs.makeDirectory(directory, { recursive: true });
          yield* fs.rename(
            location.sessionFile,
            path.join(directory, path.basename(location.sessionFile)),
          );
          const projectPath = "/projects/cake";
          const projectHash = createHash("sha256").update(projectPath).digest("hex");
          const sessionHash = createHash("sha256").update("session-1").digest("hex");
          const projectDirectory = path.join(metadataRoot, "projects", projectHash);
          const locatorDirectory = path.join(metadataRoot, "sessions", sessionHash.slice(0, 2));
          yield* fs.makeDirectory(projectDirectory, { recursive: true });
          yield* fs.makeDirectory(locatorDirectory, { recursive: true });
          yield* fs.writeFileString(
            path.join(projectDirectory, `${sessionHash}.json`),
            JSON.stringify({
              version: 1,
              sessionId: "session-1",
              projectPath,
              projectName: "Cake",
              workingDirectory: location.cwd,
              activeRoot: location.activeRoot,
              resolvedRoot: location.resolvedRoot,
              worktreeName: "retired",
              createdAt: "2026-01-01T00:00:00.000Z",
              modifiedAt: "2026-01-01T00:00:00.000Z",
            }),
          );
          yield* fs.writeFileString(
            path.join(locatorDirectory, `${sessionHash}.json`),
            JSON.stringify({ version: 1, projectPath }),
          );
          expect(
            yield* runArchive(
              metadataRoot,
              (storage) => storage.migrateProject(projectPath, "Cake", []).pipe(Stream.runCollect),
              location,
            ),
          ).toEqual([expect.objectContaining({ sessionId: "session-1", worktreeName: "retired" })]);
          expect(yield* fs.exists(location.sessionFile)).toBe(true);
          expect(
            yield* runArchive(metadataRoot, (storage) => storage.locate("session-1", location)),
          ).toBe("resolved");
        }),
      ),
  );

  it.effect("lazily indexes legacy project archives from Pi transcripts", () =>
    withPlatform(
      Effect.gen(function* () {
        const metadataRoot = yield* makeMetadataRoot();
        const location = yield* makeFixture();
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const legacyDirectory = cakeWorkspaceSessionDirectory(location.cwd, location.resolvedRoot);
        yield* fileSystem.makeDirectory(legacyDirectory, { recursive: true });
        yield* fileSystem.rename(
          location.sessionFile,
          path.join(legacyDirectory, path.basename(location.sessionFile)),
        );

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

  it.effect("lists project resolution metadata and restores without changing the Pi file", () =>
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

  it.effect("rolls resolution metadata back when project metadata persistence is interrupted", () =>
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
            makeSessionArchiveStorageLive(metadataRoot, location).pipe(
              Layer.provide(controlledPlatform),
            ),
          ),
        );
      }),
    ),
  );

  it.effect(
    "rolls resolve back when interrupted immediately after committing the resolution index",
    () =>
      withPlatform(
        Effect.gen(function* () {
          const metadataRoot = yield* makeMetadataRoot();
          const location = yield* makeFixture();
          const fileSystem = yield* FileSystem.FileSystem;
          const transcriptMoved = yield* Deferred.make<void>();
          const releaseMove = yield* Deferred.make<void>();
          let pauseNextRename = true;
          const controlledFileSystem = FileSystem.makeNoop({
            ...fileSystem,
            rename: (source, destination) => {
              const pause = pauseNextRename;
              pauseNextRename = false;
              return fileSystem
                .rename(source, destination)
                .pipe(
                  Effect.andThen(
                    pause
                      ? Deferred.succeed(transcriptMoved, undefined).pipe(
                          Effect.andThen(Deferred.await(releaseMove)),
                        )
                      : Effect.void,
                  ),
                );
            },
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
            yield* Deferred.await(transcriptMoved);
            const interruption = yield* Fiber.interrupt(resolving).pipe(Effect.forkChild);
            yield* Deferred.succeed(releaseMove, undefined);
            yield* Fiber.join(interruption);

            expect(yield* storage.locate("session-1", location)).toBe("active");
            expect(yield* storage.resolvedProjectEntry("session-1")).toBeUndefined();
          }).pipe(
            Effect.provide(
              makeSessionArchiveStorageLive(metadataRoot, location).pipe(
                Layer.provide(controlledPlatform),
              ),
            ),
          );
        }),
      ),
  );

  it.effect(
    "rolls restore back when interrupted immediately after committing the resolution index",
    () =>
      withPlatform(
        Effect.gen(function* () {
          const metadataRoot = yield* makeMetadataRoot();
          const location = yield* makeFixture();
          const fileSystem = yield* FileSystem.FileSystem;
          const transcriptMoved = yield* Deferred.make<void>();
          const releaseMove = yield* Deferred.make<void>();
          let pauseNextRename = false;
          const controlledFileSystem = FileSystem.makeNoop({
            ...fileSystem,
            rename: (source, destination) => {
              const pause = pauseNextRename;
              pauseNextRename = false;
              return fileSystem
                .rename(source, destination)
                .pipe(
                  Effect.andThen(
                    pause
                      ? Deferred.succeed(transcriptMoved, undefined).pipe(
                          Effect.andThen(Deferred.await(releaseMove)),
                        )
                      : Effect.void,
                  ),
                );
            },
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
            pauseNextRename = true;
            const restoring = yield* storage.restoreProject("session-1").pipe(Effect.forkChild);
            yield* Deferred.await(transcriptMoved);
            const interruption = yield* Fiber.interrupt(restoring).pipe(Effect.forkChild);
            yield* Deferred.succeed(releaseMove, undefined);
            yield* Fiber.join(interruption);

            expect(yield* storage.locate("session-1", location)).toBe("resolved");
            expect(yield* storage.resolvedProjectEntry("session-1")).toEqual(
              expect.objectContaining({ sessionId: "session-1" }),
            );
          }).pipe(
            Effect.provide(
              makeSessionArchiveStorageLive(metadataRoot, location).pipe(
                Layer.provide(controlledPlatform),
              ),
            ),
          );
        }),
      ),
  );

  it.effect("restores resolution metadata when project metadata removal fails", () =>
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
            makeSessionArchiveStorageLive(metadataRoot, location).pipe(
              Layer.provide(controlledPlatform),
            ),
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

  it.effect("keeps Pi sessions in place while resolving and restoring idempotently", () =>
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
        ).toEqual([expect.objectContaining({ id: "session-1" })]);
        const ids = yield* runArchive(metadataRoot, (storage) => storage.resolvedIds(location));
        expect(
          yield* streamWorkspaceSessions(location.cwd, location.activeRoot, {
            excludedSessionIds: [...ids],
          }).pipe(Stream.runCollect),
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

  it.effect("serializes concurrent resolution requests as one idempotent metadata update", () =>
    withPlatform(
      Effect.gen(function* () {
        const metadataRoot = yield* makeMetadataRoot();
        const location = yield* makeFixture();
        const outcomes = yield* runArchive(metadataRoot, (storage) =>
          Effect.all(
            [storage.resolve("session-1", location), storage.resolve("session-1", location)],
            { concurrency: "unbounded" },
          ),
        );

        expect([...outcomes].sort()).toEqual([false, true]);
        expect(
          yield* streamWorkspaceSessions(location.cwd, location.activeRoot).pipe(Stream.runCollect),
        ).toEqual([expect.objectContaining({ id: "session-1" })]);
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
