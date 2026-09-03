import { access, mkdir, rename, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { Effect, Layer, Stream } from "effect";
import { SESSION_TITLE_MAX_LENGTH } from "../../ipc/session-contract";
import { findSessionFileById, sessionDirectoryPath, streamSessionFiles } from "./session-files";
import {
  SessionArchiveStorage,
  SessionArchiveStorageError,
  type SessionArchiveLocation,
} from "./SessionArchiveStorage";

const archiveError = (operation: string, sessionId: string, cause: unknown) =>
  new SessionArchiveStorageError({
    operation,
    sessionId,
    message: cause instanceof Error ? cause.message : String(cause),
  });

export const SessionArchiveStorageLive = Layer.sync(SessionArchiveStorage, () => {
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
            if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
            throw error;
          }
          throw new Error(`Session archive destination already exists for ${sessionId}`);
        } catch (error) {
          if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
        }
        try {
          await rename(source, destination);
        } catch (error) {
          if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
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
        if (active && resolved) throw new Error(`Session ${sessionId} exists in both namespaces`);
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
        if (active && resolved) throw new Error(`Session ${sessionId} exists in both namespaces`);
        return active ? ("active" as const) : resolved ? ("resolved" as const) : undefined;
      },
      catch: (cause) => archiveError("locate", sessionId, cause),
    });
  });

  const resolved = (location: SessionArchiveLocation) =>
    streamSessionFiles(directoryInput(location, true)).pipe(
      Stream.map((item) => ({
        id: item.id,
        title: item.id.slice(0, SESSION_TITLE_MAX_LENGTH),
        created: item.createdAt,
        modified: item.modifiedAt,
        messageCount: 0,
        resolved: true,
      })),
      Stream.mapError((cause) => archiveError("resolved", "", cause)),
    );

  return SessionArchiveStorage.of({
    resolve: (sessionId, location) => move(sessionId, location, true),
    restore: (sessionId, location) => move(sessionId, location, false),
    deleteResolved: (sessionId, location) => deleteAt("deleteResolved", sessionId, location),
    delete: (sessionId, location) => deleteAt("delete", sessionId, location),
    locate,
    resolved,
  });
});
