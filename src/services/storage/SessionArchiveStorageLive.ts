import { createHash } from "node:crypto";
import {
  Effect,
  Exit,
  FileSystem,
  Layer,
  Path,
  RcMap,
  Schema,
  Scope,
  Semaphore,
  Stream,
} from "effect";
import {
  findSessionFileById,
  findSessionFileMetadataById,
  sessionDirectoryPath,
  streamSessionFiles,
} from "./session-files";
import {
  SessionArchiveStorage,
  SessionResolutionIndex,
  SessionArchiveStorageError,
  ProjectSessionArchiveMetadata,
  type ProjectSessionArchiveContext,
  type ProjectSessionArchiveMigrationSource,
  type SessionArchiveLocation,
} from "./SessionArchiveStorage";
import { sessionTitleFromFile } from "../pi/runtime/session-title";
import { atomicWriteFile } from "./internal/atomicFile";

const archiveError = (operation: string, sessionId: string, cause: unknown) =>
  new SessionArchiveStorageError({
    operation,
    sessionId,
    message: cause instanceof Error ? cause.message : String(cause),
  });

const ProjectSessionArchiveLocator = Schema.Struct({
  version: Schema.Literal(1),
  projectPath: Schema.String,
});

const ProjectSessionArchiveMigration = Schema.Struct({
  version: Schema.Literal(1),
  projectPath: Schema.String,
});

const digest = (value: string) => createHash("sha256").update(value).digest("hex");

// Version 1 could retain pre-Cake Pi roots even after transcripts moved into Cake home.
const ProjectSessionArchiveMetadataV1 = Schema.Struct({
  ...ProjectSessionArchiveMetadata.fields,
  version: Schema.Literal(1),
});
const StoredProjectSessionArchiveMetadata = Schema.Union([
  ProjectSessionArchiveMetadata,
  ProjectSessionArchiveMetadataV1,
]);

export const makeSessionArchiveStorageLive = (
  archiveMetadataRoot: string,
  projectSessionRoots: Pick<SessionArchiveLocation, "activeRoot" | "resolvedRoot">,
) =>
  Layer.effect(
    SessionArchiveStorage,
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const updates = yield* RcMap.make({ lookup: () => Semaphore.make(1) });
      // Backend-owned metadata. Serialize read/merge/write across directories;
      // publish only after the atomic metadata replacement commits.
      const indexUpdates = yield* Semaphore.make(1);
      const indexPath = path.join(archiveMetadataRoot, "resolution.json");

      const projectDirectory = (projectPath: string) =>
        path.join(archiveMetadataRoot, "projects", digest(projectPath));
      const projectEntryPath = (projectPath: string, sessionId: string) =>
        path.join(projectDirectory(projectPath), `${digest(sessionId)}.json`);
      const projectMigrationPath = (projectPath: string) =>
        path.join(archiveMetadataRoot, "migrations", `${digest(projectPath)}.project-archives-v2`);
      const locatorPath = (sessionId: string) =>
        path.join(
          archiveMetadataRoot,
          "sessions",
          digest(sessionId).slice(0, 2),
          `${digest(sessionId)}.json`,
        );

      const withUpdateLock = <A, E, R>(key: string, effect: Effect.Effect<A, E, R>) =>
        Effect.acquireUseRelease(
          Scope.make(),
          (leaseScope) =>
            RcMap.get(updates, key).pipe(
              Effect.provideService(Scope.Scope, leaseScope),
              Effect.flatMap((lock) => lock.withPermits(1)(effect)),
            ),
          (leaseScope) => Scope.close(leaseScope, Exit.void),
        );

      const readDocument = Effect.fn("SessionArchiveStorage.readDocument")(function* <
        S extends Schema.ConstraintDecoder<unknown>,
      >(operation: string, sessionId: string, documentPath: string, schema: S) {
        const exists = yield* fileSystem
          .exists(documentPath)
          .pipe(Effect.mapError((cause) => archiveError(operation, sessionId, cause)));
        if (!exists) return undefined;
        const text = yield* fileSystem
          .readFileString(documentPath)
          .pipe(Effect.mapError((cause) => archiveError(operation, sessionId, cause)));
        const parsed: unknown = yield* Effect.try({
          try: () => JSON.parse(text),
          catch: (cause) => archiveError(operation, sessionId, cause),
        });
        return yield* Schema.decodeUnknownEffect(schema)(parsed).pipe(
          Effect.mapError((cause) => archiveError(operation, sessionId, cause)),
        );
      });

      const readProjectEntry = Effect.fn("SessionArchiveStorage.readProjectEntry")(function* (
        operation: string,
        sessionId: string,
      ) {
        const locator = yield* readDocument(
          operation,
          sessionId,
          locatorPath(sessionId),
          ProjectSessionArchiveLocator,
        );
        if (!locator) return undefined;
        const entryPath = projectEntryPath(locator.projectPath, sessionId);
        const stored = yield* readDocument(
          operation,
          sessionId,
          entryPath,
          StoredProjectSessionArchiveMetadata,
        );
        const entry =
          stored?.version === 1
            ? ProjectSessionArchiveMetadata.make({ ...stored, ...projectSessionRoots, version: 2 })
            : stored;
        if (entry?.sessionId !== sessionId)
          return yield* archiveError(
            operation,
            sessionId,
            new Error("Project archive identity mismatch"),
          );
        if (stored?.version === 1) {
          if (
            stored.activeRoot !== entry.activeRoot ||
            stored.resolvedRoot !== entry.resolvedRoot
          ) {
            const currentLocation = {
              cwd: entry.workingDirectory,
              activeRoot: entry.activeRoot,
              resolvedRoot: entry.resolvedRoot,
            };
            const currentArchive = yield* findAt(sessionId, currentLocation, true).pipe(
              Effect.mapError((cause) => archiveError(operation, sessionId, cause)),
            );
            const currentResolved = (yield* readResolvedIds(currentLocation)).has(sessionId);
            const currentTranscript = currentResolved
              ? yield* findAt(sessionId, currentLocation, false).pipe(
                  Effect.mapError((cause) => archiveError(operation, sessionId, cause)),
                )
              : undefined;
            if (!currentArchive && !currentTranscript) {
              // Archives that were not already relocated must move with their index.
              // Never repurpose a legacy active copy as the archived authority.
              const legacy = yield* findAt(
                sessionId,
                {
                  cwd: stored.workingDirectory,
                  activeRoot: stored.activeRoot,
                  resolvedRoot: stored.resolvedRoot,
                },
                true,
              ).pipe(Effect.mapError((cause) => archiveError(operation, sessionId, cause)));
              if (!legacy)
                return yield* archiveError(
                  operation,
                  sessionId,
                  new Error(
                    `Cannot migrate archive ${sessionId}: the archived transcript is missing`,
                  ),
                );
              const destinationDirectory = sessionDirectoryPath({
                workingDirectory: entry.workingDirectory,
                root: entry.resolvedRoot,
              });
              yield* fileSystem
                .makeDirectory(destinationDirectory, { recursive: true, mode: 0o700 })
                .pipe(Effect.mapError((cause) => archiveError(operation, sessionId, cause)));
              yield* fileSystem
                .rename(legacy, path.join(destinationDirectory, path.basename(legacy)))
                .pipe(
                  Effect.uninterruptible,
                  Effect.mapError((cause) => archiveError(operation, sessionId, cause)),
                );
            }
          }
          const encoded = yield* Schema.encodeEffect(ProjectSessionArchiveMetadata)(entry).pipe(
            Effect.mapError((cause) => archiveError(operation, sessionId, cause)),
          );
          // The caller holds the session's update lock. Already-relocated transcripts
          // and legacy active copies remain untouched.
          yield* atomicWriteFile(
            fileSystem,
            path,
            entryPath,
            `${JSON.stringify(encoded)}\n`,
            (_stage, cause) => archiveError(operation, sessionId, cause),
          );
        }
        return entry;
      });

      const writeProjectEntryUnlocked = Effect.fn(
        "SessionArchiveStorage.writeProjectEntryUnlocked",
      )(function* (operation: string, entry: ProjectSessionArchiveMetadata) {
        const encodedEntry = yield* Schema.encodeEffect(ProjectSessionArchiveMetadata)(entry).pipe(
          Effect.mapError((cause) => archiveError(operation, entry.sessionId, cause)),
        );
        const encodedLocator = yield* Schema.encodeEffect(ProjectSessionArchiveLocator)({
          version: 1,
          projectPath: entry.projectPath,
        }).pipe(Effect.mapError((cause) => archiveError(operation, entry.sessionId, cause)));
        yield* atomicWriteFile(
          fileSystem,
          path,
          projectEntryPath(entry.projectPath, entry.sessionId),
          `${JSON.stringify(encodedEntry, null, 2)}\n`,
          (_stage, cause) => archiveError(operation, entry.sessionId, cause),
        );
        yield* atomicWriteFile(
          fileSystem,
          path,
          locatorPath(entry.sessionId),
          `${JSON.stringify(encodedLocator, null, 2)}\n`,
          (_stage, cause) => archiveError(operation, entry.sessionId, cause),
        );
      });

      const writeProjectEntry = Effect.fn("SessionArchiveStorage.writeProjectEntry")(
        (operation: string, entry: ProjectSessionArchiveMetadata) =>
          withUpdateLock(locatorPath(entry.sessionId), writeProjectEntryUnlocked(operation, entry)),
      );

      const removeProjectEntryUnlocked = Effect.fn(
        "SessionArchiveStorage.removeProjectEntryUnlocked",
      )((operation: string, entry: ProjectSessionArchiveMetadata) =>
        Effect.all([
          fileSystem.remove(projectEntryPath(entry.projectPath, entry.sessionId), {
            force: true,
          }),
          fileSystem.remove(locatorPath(entry.sessionId), { force: true }),
        ]).pipe(
          Effect.asVoid,
          Effect.mapError((cause) => archiveError(operation, entry.sessionId, cause)),
        ),
      );

      const directoryInput = (location: SessionArchiveLocation, resolved: boolean) => ({
        workingDirectory: location.cwd,
        root: resolved ? location.resolvedRoot : location.activeRoot,
        direct: location.direct,
      });

      const findAt = Effect.fn("SessionArchiveStorage.findSessionFile")(function* (
        sessionId: string,
        location: SessionArchiveLocation,
        resolved: boolean,
      ) {
        return yield* Effect.tryPromise(() =>
          findSessionFileById(sessionId, directoryInput(location, resolved)),
        );
      });

      const findMetadataAt = Effect.fn("SessionArchiveStorage.findSessionFileMetadata")(function* (
        sessionId: string,
        location: SessionArchiveLocation,
        resolved: boolean,
      ) {
        return yield* Effect.tryPromise(() =>
          findSessionFileMetadataById(sessionId, directoryInput(location, resolved)),
        );
      });

      const readIndex = Effect.fn("SessionArchiveStorage.readIndex")(function* () {
        return (
          (yield* readDocument("resolution", "", indexPath, SessionResolutionIndex)) ?? {
            version: 1 as const,
            directories: {},
          }
        );
      });

      const readResolvedIds = Effect.fn("SessionArchiveStorage.readResolvedIds")(function* (
        location: SessionArchiveLocation,
      ) {
        const index = yield* readIndex();
        return new Set(
          index.directories[sessionDirectoryPath(directoryInput(location, false))] ?? [],
        );
      });

      const setResolution = Effect.fn("SessionArchiveStorage.setResolution")(
        (sessionId: string, location: SessionArchiveLocation, resolved: boolean) =>
          indexUpdates.withPermits(1)(
            Effect.uninterruptibleMask((restore) =>
              Effect.gen(function* () {
                const index = yield* restore(readIndex());
                const directory = sessionDirectoryPath(directoryInput(location, false));
                const ids = new Set(index.directories[directory] ?? []);
                if (ids.has(sessionId) === resolved) return false;
                if (resolved) ids.add(sessionId);
                else ids.delete(sessionId);
                const directories = { ...index.directories };
                if (ids.size === 0) delete directories[directory];
                else directories[directory] = [...ids];
                yield* atomicWriteFile(
                  fileSystem,
                  path,
                  indexPath,
                  `${JSON.stringify({ version: 1, directories }, null, 2)}\n`,
                  (_stage, cause) => archiveError("resolution", sessionId, cause),
                );
                return true;
              }),
            ),
          ),
      );

      // Storage migration only: old installations moved resolved Pi files out of
      // their normal directory. Record resolution before moving each one back;
      // interruption/restart can safely retry without losing that status.
      const migrateLocation = Effect.fn("SessionArchiveStorage.migrateLocation")(
        (location: SessionArchiveLocation) =>
          streamSessionFiles(directoryInput(location, true)).pipe(
            Stream.runForEach((item) =>
              withUpdateLock(
                locatorPath(item.id),
                Effect.uninterruptibleMask((restore) =>
                  Effect.gen(function* () {
                    const source = yield* restore(findAt(item.id, location, true));
                    if (!source) return;
                    if (yield* restore(findAt(item.id, location, false)))
                      return yield* archiveError(
                        "migrateLocation",
                        item.id,
                        new Error(`Session ${item.id} exists in both namespaces`),
                      );
                    yield* setResolution(item.id, location, true);
                    const directory = sessionDirectoryPath(directoryInput(location, false));
                    yield* fileSystem.makeDirectory(directory, { recursive: true, mode: 0o700 });
                    yield* fileSystem.rename(source, path.join(directory, path.basename(source)));
                  }),
                ),
              ),
            ),
            Effect.mapError((cause) => archiveError("migrateLocation", "", cause)),
          ),
      );

      const resolvedIds = Effect.fn("SessionArchiveStorage.resolvedIds")(function* (
        location: SessionArchiveLocation,
      ) {
        yield* migrateLocation(location);
        return yield* readResolvedIds(location);
      });

      const setResolvedUnlocked = Effect.fn("SessionArchiveStorage.setResolvedUnlocked")(
        function* (sessionId: string, location: SessionArchiveLocation, resolved: boolean) {
          if (!(yield* findAt(sessionId, location, false)))
            return yield* Effect.fail(new Error(`Cake could not find session ${sessionId}`));
          return yield* setResolution(sessionId, location, resolved);
        },
        (effect, sessionId, _location, resolved) =>
          effect.pipe(
            Effect.mapError((cause) =>
              archiveError(resolved ? "resolve" : "restore", sessionId, cause),
            ),
          ),
      );

      const deleteAtUnlocked = Effect.fn("SessionArchiveStorage.deleteAtUnlocked")(
        function* (
          operation: "delete" | "deleteResolved",
          sessionId: string,
          location: SessionArchiveLocation,
        ) {
          const source = yield* findAt(sessionId, location, false);
          if (
            !source ||
            (operation === "deleteResolved" && !(yield* readResolvedIds(location)).has(sessionId))
          )
            return yield* Effect.fail(
              new Error(
                `Cake could not find ${operation === "deleteResolved" ? "resolved " : ""}session ${sessionId}`,
              ),
            );
          yield* fileSystem.remove(source);
          yield* setResolution(sessionId, location, false);
          const entry = yield* readProjectEntry(operation, sessionId);
          if (entry) yield* removeProjectEntryUnlocked(operation, entry);
        },
        (effect, operation, sessionId) =>
          effect.pipe(Effect.mapError((cause) => archiveError(operation, sessionId, cause))),
      );

      const locate = Effect.fn("SessionArchiveStorage.locate")(
        function* (sessionId: string, location: SessionArchiveLocation) {
          yield* migrateLocation(location);
          if (!(yield* findAt(sessionId, location, false))) return undefined;
          return (yield* readResolvedIds(location)).has(sessionId)
            ? ("resolved" as const)
            : ("active" as const);
        },
        (effect, sessionId) =>
          effect.pipe(Effect.mapError((cause) => archiveError("locate", sessionId, cause))),
      );

      const resolved = (location: SessionArchiveLocation) =>
        Stream.unwrap(
          resolvedIds(location).pipe(
            Effect.map((ids) =>
              streamSessionFiles(directoryInput(location, false)).pipe(
                Stream.filter((item) => ids.has(item.id)),
              ),
            ),
          ),
        ).pipe(
          Stream.mapEffect(
            (item) =>
              Effect.try({
                try: () => ({
                  id: item.id,
                  title: sessionTitleFromFile(item.path, location.cwd),
                  created: item.createdAt,
                  modified: item.modifiedAt,
                  messageCount: 0,
                  resolved: true,
                }),
                catch: (cause) => archiveError("resolved", item.id, cause),
              }),
            { concurrency: 16 },
          ),
          Stream.mapError((cause) => archiveError("resolved", "", cause)),
        );

      const resolvedEntry = Effect.fn("SessionArchiveStorage.resolvedEntry")(function* (
        sessionId: string,
        location: SessionArchiveLocation,
      ) {
        if (!(yield* resolvedIds(location)).has(sessionId)) return undefined;
        const item = yield* findMetadataAt(sessionId, location, false).pipe(
          Effect.mapError((cause) => archiveError("resolvedEntry", sessionId, cause)),
        );
        if (!item) return undefined;
        const title = yield* Effect.try({
          try: () => sessionTitleFromFile(item.path, location.cwd),
          catch: (cause) => archiveError("resolvedEntry", sessionId, cause),
        });
        return {
          id: item.id,
          title,
          created: item.createdAt,
          modified: item.modifiedAt,
          messageCount: 0,
          resolved: true,
        };
      });

      const resolvedProjectEntry = Effect.fn("SessionArchiveStorage.resolvedProjectEntry")(
        function* (sessionId: string) {
          const entry = yield* withUpdateLock(
            locatorPath(sessionId),
            readProjectEntry("resolvedProjectEntry", sessionId),
          );
          if (!entry) return undefined;
          const location = {
            cwd: entry.workingDirectory,
            activeRoot: entry.activeRoot,
            resolvedRoot: entry.resolvedRoot,
          };
          yield* migrateLocation(location);
          return (yield* readResolvedIds(location)).has(sessionId) ? entry : undefined;
        },
      );

      const resolveProject = Effect.fn("SessionArchiveStorage.resolveProject")(
        (
          sessionId: string,
          location: SessionArchiveLocation,
          context: ProjectSessionArchiveContext,
        ) =>
          migrateLocation(location).pipe(
            Effect.andThen(
              withUpdateLock(
                locatorPath(sessionId),
                Effect.uninterruptibleMask((restore) =>
                  Effect.gen(function* () {
                    const item = yield* restore(
                      findMetadataAt(sessionId, location, false).pipe(
                        Effect.mapError((cause) =>
                          archiveError("resolveProject", sessionId, cause),
                        ),
                      ),
                    );
                    if (!item)
                      return yield* archiveError(
                        "resolveProject",
                        sessionId,
                        new Error(`Cake could not find session ${sessionId}`),
                      );
                    const changed = yield* setResolution(sessionId, location, true);
                    const entryBase = {
                      version: 2 as const,
                      sessionId,
                      projectPath: context.projectPath,
                      projectName: context.projectName,
                      workingDirectory: location.cwd,
                      activeRoot: location.activeRoot,
                      resolvedRoot: location.resolvedRoot,
                      createdAt: item.createdAt,
                      modifiedAt: item.modifiedAt,
                    };
                    const entry = ProjectSessionArchiveMetadata.make(
                      context.worktreeName
                        ? { ...entryBase, worktreeName: context.worktreeName }
                        : entryBase,
                    );
                    yield* restore(writeProjectEntryUnlocked("resolveProject", entry)).pipe(
                      Effect.onExit((exit) =>
                        Exit.isSuccess(exit) || !changed
                          ? Effect.void
                          : Effect.all(
                              [
                                removeProjectEntryUnlocked("resolveProjectCompensation", entry),
                                setResolvedUnlocked(sessionId, location, false).pipe(Effect.asVoid),
                              ],
                              { concurrency: "unbounded", discard: true },
                            ),
                      ),
                    );
                    return changed;
                  }),
                ),
              ),
            ),
          ),
      );

      const restoreProject = Effect.fn("SessionArchiveStorage.restoreProject")(
        (sessionId: string) =>
          resolvedProjectEntry(sessionId).pipe(
            Effect.andThen(
              withUpdateLock(
                locatorPath(sessionId),
                Effect.uninterruptibleMask((restore) =>
                  Effect.gen(function* () {
                    const entry = yield* restore(readProjectEntry("restoreProject", sessionId));
                    if (!entry) return undefined;
                    const location = {
                      cwd: entry.workingDirectory,
                      activeRoot: entry.activeRoot,
                      resolvedRoot: entry.resolvedRoot,
                    };
                    yield* restore(findAt(sessionId, location, false)).pipe(
                      Effect.mapError((cause) => archiveError("restoreProject", sessionId, cause)),
                      Effect.flatMap((file) =>
                        file
                          ? Effect.void
                          : Effect.fail(
                              archiveError(
                                "restoreProject",
                                sessionId,
                                new Error(`Cake could not find session ${sessionId}`),
                              ),
                            ),
                      ),
                    );
                    const changed = yield* setResolution(sessionId, location, false);
                    yield* restore(removeProjectEntryUnlocked("restoreProject", entry)).pipe(
                      Effect.onExit((exit) =>
                        Exit.isSuccess(exit)
                          ? Effect.void
                          : Effect.all(
                              [
                                writeProjectEntryUnlocked("restoreProjectCompensation", entry),
                                changed
                                  ? setResolvedUnlocked(sessionId, location, true).pipe(
                                      Effect.asVoid,
                                    )
                                  : Effect.void,
                              ],
                              { concurrency: "unbounded", discard: true },
                            ),
                      ),
                    );
                    return entry;
                  }),
                ),
              ),
            ),
          ),
      );

      const deleteResolvedProject = Effect.fn("SessionArchiveStorage.deleteResolvedProject")(
        (sessionId: string) =>
          resolvedProjectEntry(sessionId).pipe(
            Effect.andThen(
              withUpdateLock(
                locatorPath(sessionId),
                Effect.gen(function* () {
                  const entry = yield* readProjectEntry("deleteResolvedProject", sessionId);
                  if (!entry)
                    return yield* archiveError(
                      "deleteResolvedProject",
                      sessionId,
                      new Error("Only resolved project sessions can be deleted"),
                    );
                  yield* deleteAtUnlocked("deleteResolved", sessionId, {
                    cwd: entry.workingDirectory,
                    activeRoot: entry.activeRoot,
                    resolvedRoot: entry.resolvedRoot,
                  });
                }),
              ),
            ),
          ),
      );

      const projectEntries = (projectPath: string) =>
        Stream.unwrap(
          fileSystem.exists(projectDirectory(projectPath)).pipe(
            Effect.mapError((cause) => archiveError("resolvedProjects", "", cause)),
            Effect.flatMap((exists) =>
              exists
                ? fileSystem
                    .readDirectory(projectDirectory(projectPath))
                    .pipe(Effect.mapError((cause) => archiveError("resolvedProjects", "", cause)))
                : Effect.succeed([]),
            ),
            Effect.map((items) =>
              Stream.fromIterable(items.filter((item) => item.endsWith(".json"))).pipe(
                Stream.mapEffect((item) =>
                  readDocument(
                    "resolvedProjects",
                    "",
                    path.join(projectDirectory(projectPath), item),
                    StoredProjectSessionArchiveMetadata,
                  ).pipe(
                    Effect.flatMap((entry) =>
                      entry ? resolvedProjectEntry(entry.sessionId) : Effect.succeed(undefined),
                    ),
                  ),
                ),
                Stream.filter(
                  (entry): entry is ProjectSessionArchiveMetadata =>
                    entry !== undefined && entry.projectPath === projectPath,
                ),
              ),
            ),
          ),
        );

      const resolvedProjects = (projectPath: string) =>
        Stream.unwrap(
          projectEntries(projectPath).pipe(
            Stream.runCollect,
            Effect.flatMap((entries) =>
              Effect.gen(function* () {
                for (const entry of entries)
                  yield* migrateLocation({
                    cwd: entry.workingDirectory,
                    activeRoot: entry.activeRoot,
                    resolvedRoot: entry.resolvedRoot,
                  });
                const index = yield* readIndex();
                return Stream.fromIterable(
                  entries.filter((entry) =>
                    index.directories[
                      sessionDirectoryPath({
                        workingDirectory: entry.workingDirectory,
                        root: entry.activeRoot,
                      })
                    ]?.includes(entry.sessionId),
                  ),
                );
              }),
            ),
          ),
        );

      const projectMigrationComplete = Effect.fn("SessionArchiveStorage.projectMigrationComplete")(
        function* (projectPath: string) {
          return yield* fileSystem
            .exists(projectMigrationPath(projectPath))
            .pipe(Effect.mapError((cause) => archiveError("projectMigrationComplete", "", cause)));
        },
      );

      const migrateProject = (
        projectPath: string,
        projectName: string,
        sources: ReadonlyArray<ProjectSessionArchiveMigrationSource>,
      ) => {
        const seenSessionIds = new Set<string>();
        const retainedLocations = projectEntries(projectPath).pipe(
          Stream.map((entry) => {
            const source: ProjectSessionArchiveMigrationSource = {
              location: {
                cwd: entry.workingDirectory,
                activeRoot: entry.activeRoot,
                resolvedRoot: entry.resolvedRoot,
              },
            };
            return entry.worktreeName ? { ...source, worktreeName: entry.worktreeName } : source;
          }),
        );
        const seenDirectories = new Set<string>();
        const discovered = Stream.fromIterable(sources).pipe(
          Stream.concat(retainedLocations),
          Stream.filter((source) => {
            const directory = sessionDirectoryPath(directoryInput(source.location, false));
            if (seenDirectories.has(directory)) return false;
            seenDirectories.add(directory);
            return true;
          }),
          Stream.flatMap(
            (source) =>
              resolved(source.location).pipe(
                Stream.mapEffect((item) =>
                  Effect.gen(function* () {
                    if (seenSessionIds.has(item.id))
                      return yield* archiveError(
                        "migrateProject",
                        item.id,
                        new Error(`Session ID collision detected: ${item.id}`),
                      );
                    seenSessionIds.add(item.id);
                    const entryBase = {
                      version: 2 as const,
                      sessionId: item.id,
                      projectPath,
                      projectName,
                      workingDirectory: source.location.cwd,
                      activeRoot: source.location.activeRoot,
                      resolvedRoot: source.location.resolvedRoot,
                      createdAt: item.created,
                      modifiedAt: item.modified,
                    };
                    const entry = ProjectSessionArchiveMetadata.make(
                      source.worktreeName
                        ? { ...entryBase, worktreeName: source.worktreeName }
                        : entryBase,
                    );
                    yield* writeProjectEntry("migrateProject", entry);
                    return entry;
                  }),
                ),
              ),
            { concurrency: 8 },
          ),
        );
        const markComplete = Effect.gen(function* () {
          const encoded = yield* Schema.encodeEffect(ProjectSessionArchiveMigration)({
            version: 1,
            projectPath,
          }).pipe(Effect.mapError((cause) => archiveError("migrateProject", "", cause)));
          yield* atomicWriteFile(
            fileSystem,
            path,
            projectMigrationPath(projectPath),
            `${JSON.stringify(encoded)}\n`,
            (_stage, cause) => archiveError("migrateProject", "", cause),
          );
        });
        return Stream.unwrap(
          projectMigrationComplete(projectPath).pipe(
            Effect.map((complete) =>
              complete
                ? resolvedProjects(projectPath)
                : discovered.pipe(
                    Stream.concat(Stream.fromEffect(markComplete).pipe(Stream.drain)),
                  ),
            ),
          ),
        );
      };

      const relocate = Effect.fn("SessionArchiveStorage.relocate")(
        (
          sessionId: string,
          from: SessionArchiveLocation,
          to: SessionArchiveLocation,
          resolved: boolean,
          metadata?: ProjectSessionArchiveMetadata,
        ) =>
          withUpdateLock(
            locatorPath(sessionId),
            indexUpdates.withPermits(1)(
              Effect.uninterruptibleMask((restore) =>
                Effect.gen(function* () {
                  const index = yield* restore(readIndex());
                  const previous = yield* restore(readProjectEntry("relocate", sessionId));
                  const sourceDirectory = sessionDirectoryPath(directoryInput(from, false));
                  const destinationDirectory = sessionDirectoryPath(directoryInput(to, false));
                  const directories = { ...index.directories };
                  const sourceIds = new Set(directories[sourceDirectory] ?? []);
                  sourceIds.delete(sessionId);
                  if (sourceIds.size) directories[sourceDirectory] = [...sourceIds];
                  else delete directories[sourceDirectory];
                  const destinationIds = new Set(directories[destinationDirectory] ?? []);
                  if (resolved) destinationIds.add(sessionId);
                  else destinationIds.delete(sessionId);
                  if (destinationIds.size) directories[destinationDirectory] = [...destinationIds];
                  else delete directories[destinationDirectory];
                  const original = previous ?? metadata;
                  const updated =
                    original && resolved
                      ? {
                          ...original,
                          workingDirectory: to.cwd,
                          activeRoot: to.activeRoot,
                          resolvedRoot: to.resolvedRoot,
                        }
                      : undefined;
                  yield* Effect.gen(function* () {
                    if (updated) yield* writeProjectEntryUnlocked("relocate", updated);
                    else if (previous) yield* removeProjectEntryUnlocked("relocate", previous);
                    yield* atomicWriteFile(
                      fileSystem,
                      path,
                      indexPath,
                      `${JSON.stringify({ version: 1, directories }, null, 2)}\n`,
                      (_stage, cause) => archiveError("relocate", sessionId, cause),
                    );
                  }).pipe(
                    Effect.onExit((exit) =>
                      Exit.isSuccess(exit)
                        ? Effect.void
                        : previous
                          ? writeProjectEntryUnlocked("relocateCompensation", previous)
                          : updated
                            ? removeProjectEntryUnlocked("relocateCompensation", updated)
                            : Effect.void,
                    ),
                  );
                }),
              ),
            ),
          ),
      );

      return SessionArchiveStorage.of({
        relocate,
        resolve: Effect.fn("SessionArchiveStorage.resolve")((sessionId, location) =>
          migrateLocation(location).pipe(
            Effect.andThen(
              withUpdateLock(
                locatorPath(sessionId),
                setResolvedUnlocked(sessionId, location, true),
              ),
            ),
          ),
        ),
        restore: Effect.fn("SessionArchiveStorage.restore")((sessionId, location) =>
          migrateLocation(location).pipe(
            Effect.andThen(
              withUpdateLock(
                locatorPath(sessionId),
                setResolvedUnlocked(sessionId, location, false),
              ),
            ),
          ),
        ),
        deleteResolved: Effect.fn("SessionArchiveStorage.deleteResolved")((sessionId, location) =>
          migrateLocation(location).pipe(
            Effect.andThen(
              withUpdateLock(
                locatorPath(sessionId),
                deleteAtUnlocked("deleteResolved", sessionId, location),
              ),
            ),
          ),
        ),
        delete: Effect.fn("SessionArchiveStorage.delete")((sessionId, location) =>
          migrateLocation(location).pipe(
            Effect.andThen(
              withUpdateLock(
                locatorPath(sessionId),
                deleteAtUnlocked("delete", sessionId, location),
              ),
            ),
          ),
        ),
        locate,
        resolvedIds,
        resolutionSnapshot: readIndex,
        resolved,
        resolvedEntry,
        resolveProject,
        restoreProject,
        deleteResolvedProject,
        resolvedProjects,
        projectMigrationComplete,
        migrateProject,
        resolvedProjectEntry,
      });
    }),
  );
