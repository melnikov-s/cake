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

export const makeSessionArchiveStorageLive = (archiveMetadataRoot: string) =>
  Layer.effect(
    SessionArchiveStorage,
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const updates = yield* RcMap.make({ lookup: () => Semaphore.make(1) });

      const projectDirectory = (projectPath: string) =>
        path.join(archiveMetadataRoot, "projects", digest(projectPath));
      const projectEntryPath = (projectPath: string, sessionId: string) =>
        path.join(projectDirectory(projectPath), `${digest(sessionId)}.json`);
      const projectMigrationPath = (projectPath: string) =>
        path.join(archiveMetadataRoot, "migrations", `${digest(projectPath)}.project-archives-v1`);
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
        const entry = yield* readDocument(
          operation,
          sessionId,
          projectEntryPath(locator.projectPath, sessionId),
          ProjectSessionArchiveMetadata,
        );
        if (entry?.sessionId !== sessionId)
          return yield* archiveError(
            operation,
            sessionId,
            new Error("Project archive identity mismatch"),
          );
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

      const prepareMoveUnlocked = Effect.fn("SessionArchiveStorage.prepareMoveUnlocked")(
        function* (sessionId: string, location: SessionArchiveLocation, resolved: boolean) {
          const activeDirectory = sessionDirectoryPath(directoryInput(location, false));
          const resolvedDirectory = sessionDirectoryPath(directoryInput(location, true));
          const destinationDirectory = resolved ? resolvedDirectory : activeDirectory;
          const source = yield* findAt(sessionId, location, !resolved);
          if (!source) {
            const alreadyMoved = yield* findAt(sessionId, location, resolved);
            if (alreadyMoved) return Effect.succeed(false);
            return yield* Effect.fail(new Error(`Cake could not find session ${sessionId}`));
          }
          yield* fileSystem.makeDirectory(destinationDirectory, { recursive: true, mode: 0o700 });
          const destination = path.join(destinationDirectory, path.basename(source));
          if (yield* fileSystem.exists(destination)) {
            if (!(yield* fileSystem.exists(source))) return Effect.succeed(false);
            return yield* Effect.fail(
              new Error(`Session archive destination already exists for ${sessionId}`),
            );
          }
          return fileSystem.rename(source, destination).pipe(
            Effect.result,
            Effect.flatMap((renamed) => {
              if (renamed._tag === "Success") return Effect.succeed(true);
              if (renamed.failure.reason._tag !== "NotFound") return renamed.failure;
              return fileSystem
                .exists(destination)
                .pipe(
                  Effect.flatMap((destinationExists) =>
                    destinationExists ? Effect.succeed(false) : renamed.failure,
                  ),
                );
            }),
            Effect.mapError((cause) =>
              archiveError(resolved ? "resolve" : "restore", sessionId, cause),
            ),
          );
        },
        (effect, sessionId, _location, resolved) =>
          effect.pipe(
            Effect.mapError((cause) =>
              archiveError(resolved ? "resolve" : "restore", sessionId, cause),
            ),
          ),
      );

      const moveUnlocked = Effect.fn("SessionArchiveStorage.moveUnlocked")(
        (sessionId: string, location: SessionArchiveLocation, resolved: boolean) =>
          prepareMoveUnlocked(sessionId, location, resolved).pipe(Effect.flatten),
      );

      const deleteAtUnlocked = Effect.fn("SessionArchiveStorage.deleteAtUnlocked")(
        function* (
          operation: "delete" | "deleteResolved",
          sessionId: string,
          location: SessionArchiveLocation,
        ) {
          if (operation === "deleteResolved") {
            const source = yield* findAt(sessionId, location, true);
            if (!source)
              return yield* Effect.fail(
                new Error(`Cake could not find resolved session ${sessionId}`),
              );
            yield* fileSystem.remove(source);
            return;
          }
          const active = yield* findAt(sessionId, location, false);
          const resolved = yield* findAt(sessionId, location, true);
          if (active && resolved)
            return yield* Effect.fail(new Error(`Session ${sessionId} exists in both namespaces`));
          const source = active ?? resolved;
          if (!source)
            return yield* Effect.fail(new Error(`Cake could not find session ${sessionId}`));
          yield* fileSystem.remove(source);
        },
        (effect, operation, sessionId) =>
          effect.pipe(Effect.mapError((cause) => archiveError(operation, sessionId, cause))),
      );

      const locate = Effect.fn("SessionArchiveStorage.locate")(
        function* (sessionId: string, location: SessionArchiveLocation) {
          const active = yield* findAt(sessionId, location, false);
          const resolved = yield* findAt(sessionId, location, true);
          if (active && resolved)
            return yield* Effect.fail(new Error(`Session ${sessionId} exists in both namespaces`));
          return active ? ("active" as const) : resolved ? ("resolved" as const) : undefined;
        },
        (effect, sessionId) =>
          effect.pipe(Effect.mapError((cause) => archiveError("locate", sessionId, cause))),
      );

      const resolved = (location: SessionArchiveLocation) =>
        streamSessionFiles(directoryInput(location, true)).pipe(
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
        const item = yield* findMetadataAt(sessionId, location, true).pipe(
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
          return yield* readProjectEntry("resolvedProjectEntry", sessionId);
        },
      );

      const resolveProject = Effect.fn("SessionArchiveStorage.resolveProject")(
        (
          sessionId: string,
          location: SessionArchiveLocation,
          context: ProjectSessionArchiveContext,
        ) =>
          withUpdateLock(
            locatorPath(sessionId),
            Effect.uninterruptibleMask((restore) =>
              Effect.gen(function* () {
                const item = yield* restore(
                  findMetadataAt(sessionId, location, false).pipe(
                    Effect.flatMap((active) =>
                      active ? Effect.succeed(active) : findMetadataAt(sessionId, location, true),
                    ),
                    Effect.mapError((cause) => archiveError("resolveProject", sessionId, cause)),
                  ),
                );
                if (!item)
                  return yield* archiveError(
                    "resolveProject",
                    sessionId,
                    new Error(`Cake could not find session ${sessionId}`),
                  );
                const commitMove = yield* restore(prepareMoveUnlocked(sessionId, location, true));
                const moved = yield* commitMove;
                const entryBase = {
                  version: 1 as const,
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
                    Exit.isSuccess(exit) || !moved
                      ? Effect.void
                      : Effect.all(
                          [
                            removeProjectEntryUnlocked("resolveProjectCompensation", entry),
                            moveUnlocked(sessionId, location, false).pipe(Effect.asVoid),
                          ],
                          { concurrency: "unbounded", discard: true },
                        ),
                  ),
                );
                return moved;
              }),
            ),
          ),
      );

      const restoreProject = Effect.fn("SessionArchiveStorage.restoreProject")(
        (sessionId: string) =>
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
                const commitMove = yield* restore(prepareMoveUnlocked(sessionId, location, false));
                const moved = yield* commitMove;
                yield* restore(removeProjectEntryUnlocked("restoreProject", entry)).pipe(
                  Effect.onExit((exit) =>
                    Exit.isSuccess(exit)
                      ? Effect.void
                      : Effect.all(
                          [
                            writeProjectEntryUnlocked("restoreProjectCompensation", entry),
                            moved
                              ? moveUnlocked(sessionId, location, true).pipe(Effect.asVoid)
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
      );

      const deleteResolvedProject = Effect.fn("SessionArchiveStorage.deleteResolvedProject")(
        (sessionId: string) =>
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
              yield* removeProjectEntryUnlocked("deleteResolvedProject", entry);
            }),
          ),
      );

      const resolvedProjects = (projectPath: string) =>
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
                    ProjectSessionArchiveMetadata,
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
        const discovered = Stream.fromIterable(sources).pipe(
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
                      version: 1 as const,
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

      return SessionArchiveStorage.of({
        resolve: Effect.fn("SessionArchiveStorage.resolve")((sessionId, location) =>
          withUpdateLock(locatorPath(sessionId), moveUnlocked(sessionId, location, true)),
        ),
        restore: Effect.fn("SessionArchiveStorage.restore")((sessionId, location) =>
          withUpdateLock(locatorPath(sessionId), moveUnlocked(sessionId, location, false)),
        ),
        deleteResolved: Effect.fn("SessionArchiveStorage.deleteResolved")((sessionId, location) =>
          withUpdateLock(
            locatorPath(sessionId),
            deleteAtUnlocked("deleteResolved", sessionId, location),
          ),
        ),
        delete: Effect.fn("SessionArchiveStorage.delete")((sessionId, location) =>
          withUpdateLock(locatorPath(sessionId), deleteAtUnlocked("delete", sessionId, location)),
        ),
        locate,
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
