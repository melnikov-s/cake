import { createHash } from "node:crypto";
import { access, mkdir, opendir, readFile, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { Effect, Layer, Schema, Stream } from "effect";
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
import { AtomicFileWriter } from "./internal/AtomicFileWriter";
import { KeyedSerialExecutor } from "../../utils/KeyedSerialExecutor";

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

const digest = (value: string) => createHash("sha256").update(value).digest("hex");

const isMissing = (error: unknown): error is NodeJS.ErrnoException =>
  error instanceof Error && "code" in error && error.code === "ENOENT";

export const makeSessionArchiveStorageLive = (archiveMetadataRoot: string) =>
  Layer.effect(
    SessionArchiveStorage,
    Effect.sync(() => {
      const writer = new AtomicFileWriter();
      const updates = new KeyedSerialExecutor<string>();
      const projectDirectory = (projectPath: string) =>
        join(archiveMetadataRoot, "projects", digest(projectPath));
      const projectEntryPath = (projectPath: string, sessionId: string) =>
        join(projectDirectory(projectPath), `${digest(sessionId)}.json`);
      const projectMigrationPath = (projectPath: string) =>
        join(archiveMetadataRoot, "migrations", `${digest(projectPath)}.project-archives-v1`);
      const locatorPath = (sessionId: string) =>
        join(
          archiveMetadataRoot,
          "sessions",
          digest(sessionId).slice(0, 2),
          `${digest(sessionId)}.json`,
        );
      const readDocument = async <S extends Schema.ConstraintDecoder<unknown>>(
        path: string,
        schema: S,
      ): Promise<S["Type"] | undefined> => {
        try {
          return Schema.decodeUnknownSync(schema)(JSON.parse(await readFile(path, "utf8")));
        } catch (error) {
          if (isMissing(error)) return undefined;
          throw error;
        }
      };
      const readProjectEntry = async (sessionId: string) => {
        const locator = await readDocument(locatorPath(sessionId), ProjectSessionArchiveLocator);
        if (!locator) return undefined;
        const entry = await readDocument(
          projectEntryPath(locator.projectPath, sessionId),
          ProjectSessionArchiveMetadata,
        );
        if (entry?.sessionId !== sessionId) throw new Error("Project archive identity mismatch");
        return entry;
      };
      const writeProjectEntry = async (entry: ProjectSessionArchiveMetadata) => {
        const target = projectEntryPath(entry.projectPath, entry.sessionId);
        const locator = locatorPath(entry.sessionId);
        await updates.run(locator, async () => {
          await mkdir(dirname(target), { recursive: true, mode: 0o700 });
          await mkdir(dirname(locator), { recursive: true, mode: 0o700 });
          await writer.write(target, `${JSON.stringify(entry, null, 2)}\n`);
          await writer.write(
            locator,
            `${JSON.stringify({ version: 1, projectPath: entry.projectPath }, null, 2)}\n`,
          );
        });
      };
      const removeProjectEntry = async (entry: ProjectSessionArchiveMetadata) => {
        const locator = locatorPath(entry.sessionId);
        await updates.run(locator, async () => {
          await rm(projectEntryPath(entry.projectPath, entry.sessionId), { force: true });
          await rm(locator, { force: true });
        });
      };
      const directoryInput = (location: SessionArchiveLocation, resolved: boolean) => ({
        workingDirectory: location.cwd,
        root: resolved ? location.resolvedRoot : location.activeRoot,
        direct: location.direct,
      });

      const findAt = (sessionId: string, location: SessionArchiveLocation, resolved: boolean) =>
        findSessionFileById(sessionId, directoryInput(location, resolved));

      const move = Effect.fn("SessionArchiveStorage.move")(function* (
        sessionId: string,
        location: SessionArchiveLocation,
        resolved: boolean,
      ) {
        return yield* Effect.tryPromise({
          try: async () => {
            const activeDirectory = sessionDirectoryPath(directoryInput(location, false));
            const resolvedDirectory = sessionDirectoryPath(directoryInput(location, true));
            const destinationDirectory = resolved ? resolvedDirectory : activeDirectory;
            const source = await findAt(sessionId, location, !resolved);
            if (!source) {
              const alreadyMoved = await findAt(sessionId, location, resolved);
              if (alreadyMoved) return false;
              throw new Error(`Cake could not find session ${sessionId}`);
            }
            await mkdir(destinationDirectory, { recursive: true });
            const destination = join(destinationDirectory, basename(source));
            try {
              await access(destination);
              try {
                await access(source);
              } catch (error) {
                if (error instanceof Error && "code" in error && error.code === "ENOENT")
                  return false;
                throw error;
              }
              throw new Error(`Session archive destination already exists for ${sessionId}`);
            } catch (error) {
              if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
                throw error;
            }
            try {
              await rename(source, destination);
            } catch (error) {
              if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
                throw error;
              try {
                await access(destination);
                return false;
              } catch {
                throw error;
              }
            }
            return true;
          },
          catch: (cause) => archiveError(resolved ? "resolve" : "restore", sessionId, cause),
        });
      });

      const deleteAt = Effect.fn("SessionArchiveStorage.deleteAt")(function* (
        operation: "delete" | "deleteResolved",
        sessionId: string,
        location: SessionArchiveLocation,
      ) {
        yield* Effect.tryPromise({
          try: async () => {
            if (operation === "deleteResolved") {
              const source = await findAt(sessionId, location, true);
              if (!source) throw new Error(`Cake could not find resolved session ${sessionId}`);
              await rm(source);
              return;
            }
            const active = await findAt(sessionId, location, false);
            const resolved = await findAt(sessionId, location, true);
            if (active && resolved)
              throw new Error(`Session ${sessionId} exists in both namespaces`);
            const source = active ?? resolved;
            if (!source) throw new Error(`Cake could not find session ${sessionId}`);
            await rm(source);
          },
          catch: (cause) => archiveError(operation, sessionId, cause),
        });
      });

      const locate = Effect.fn("SessionArchiveStorage.locate")(function* (
        sessionId: string,
        location: SessionArchiveLocation,
      ) {
        return yield* Effect.tryPromise({
          try: async () => {
            const active = await findAt(sessionId, location, false);
            const resolved = await findAt(sessionId, location, true);
            if (active && resolved)
              throw new Error(`Session ${sessionId} exists in both namespaces`);
            return active ? ("active" as const) : resolved ? ("resolved" as const) : undefined;
          },
          catch: (cause) => archiveError("locate", sessionId, cause),
        });
      });

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
        const item = yield* Effect.tryPromise({
          try: () => findSessionFileMetadataById(sessionId, directoryInput(location, true)),
          catch: (cause) => archiveError("resolvedEntry", sessionId, cause),
        });
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
          return yield* Effect.tryPromise({
            try: () => readProjectEntry(sessionId),
            catch: (cause) => archiveError("resolvedProjectEntry", sessionId, cause),
          });
        },
      );

      const resolveProject = Effect.fn("SessionArchiveStorage.resolveProject")(function* (
        sessionId: string,
        location: SessionArchiveLocation,
        context: ProjectSessionArchiveContext,
      ) {
        const item = yield* Effect.tryPromise({
          try: async () =>
            (await findSessionFileMetadataById(sessionId, directoryInput(location, false))) ??
            (await findSessionFileMetadataById(sessionId, directoryInput(location, true))),
          catch: (cause) => archiveError("resolveProject", sessionId, cause),
        });
        if (!item)
          return yield* archiveError(
            "resolveProject",
            sessionId,
            new Error(`Cake could not find session ${sessionId}`),
          );
        const moved = yield* move(sessionId, location, true);
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
          context.worktreeName ? { ...entryBase, worktreeName: context.worktreeName } : entryBase,
        );
        yield* Effect.tryPromise({
          try: () => writeProjectEntry(entry),
          catch: (cause) => archiveError("resolveProject", sessionId, cause),
        });
        return moved;
      });

      const restoreProject = Effect.fn("SessionArchiveStorage.restoreProject")(function* (
        sessionId: string,
      ) {
        const entry = yield* resolvedProjectEntry(sessionId);
        if (!entry) return undefined;
        yield* move(
          sessionId,
          {
            cwd: entry.workingDirectory,
            activeRoot: entry.activeRoot,
            resolvedRoot: entry.resolvedRoot,
          },
          false,
        );
        yield* Effect.tryPromise({
          try: () => removeProjectEntry(entry),
          catch: (cause) => archiveError("restoreProject", sessionId, cause),
        });
        return entry;
      });

      const deleteResolvedProject = Effect.fn("SessionArchiveStorage.deleteResolvedProject")(
        function* (sessionId: string) {
          const entry = yield* resolvedProjectEntry(sessionId);
          if (!entry)
            return yield* archiveError(
              "deleteResolvedProject",
              sessionId,
              new Error("Only resolved project sessions can be deleted"),
            );
          yield* deleteAt("deleteResolved", sessionId, {
            cwd: entry.workingDirectory,
            activeRoot: entry.activeRoot,
            resolvedRoot: entry.resolvedRoot,
          });
          yield* Effect.tryPromise({
            try: () => removeProjectEntry(entry),
            catch: (cause) => archiveError("deleteResolvedProject", sessionId, cause),
          });
        },
      );

      const resolvedProjects = (projectPath: string) => {
        async function* entries() {
          let directory;
          try {
            directory = await opendir(projectDirectory(projectPath));
          } catch (error) {
            if (isMissing(error)) return;
            throw error;
          }
          for await (const item of directory) {
            if (!item.isFile() || !item.name.endsWith(".json")) continue;
            const entry = await readDocument(
              join(projectDirectory(projectPath), item.name),
              ProjectSessionArchiveMetadata,
            );
            if (entry?.projectPath === projectPath) yield entry;
          }
        }
        return Stream.fromAsyncIterable(entries(), (cause) =>
          archiveError("resolvedProjects", "", cause),
        );
      };

      const projectMigrationComplete = (projectPath: string) =>
        Effect.tryPromise({
          try: async () => {
            try {
              await access(projectMigrationPath(projectPath));
              return true;
            } catch (error) {
              if (isMissing(error)) return false;
              throw error;
            }
          },
          catch: (cause) => archiveError("projectMigrationComplete", "", cause),
        });

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
                    return yield* Effect.tryPromise({
                      try: () => writeProjectEntry(entry).then(() => entry),
                      catch: (cause) => archiveError("migrateProject", item.id, cause),
                    });
                  }),
                ),
              ),
            { concurrency: 8 },
          ),
        );
        const markComplete = Effect.tryPromise({
          try: async () => {
            const path = projectMigrationPath(projectPath);
            await mkdir(dirname(path), { recursive: true, mode: 0o700 });
            await writer.write(path, `${JSON.stringify({ version: 1, projectPath })}\n`);
          },
          catch: (cause) => archiveError("migrateProject", "", cause),
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
        resolve: (sessionId, location) => move(sessionId, location, true),
        restore: (sessionId, location) => move(sessionId, location, false),
        deleteResolved: (sessionId, location) => deleteAt("deleteResolved", sessionId, location),
        delete: (sessionId, location) => deleteAt("delete", sessionId, location),
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
