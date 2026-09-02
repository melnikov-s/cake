import { access, mkdir, rename, rm } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { Effect, Layer } from "effect";
import { cakeWorkspaceSessionDirectory, findSessionFile } from "../pi/runtime/session-discovery";
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
  const move = Effect.fn("SessionArchiveStorage.move")(function* (
    sessionId: string,
    location: SessionArchiveLocation,
    resolved: boolean,
  ) {
    return yield* Effect.tryPromise({
      try: async () => {
        const activeDirectory = location.direct
          ? resolve(location.activeRoot)
          : cakeWorkspaceSessionDirectory(location.cwd, location.activeRoot);
        const resolvedDirectory = location.direct
          ? resolve(location.resolvedRoot)
          : cakeWorkspaceSessionDirectory(location.cwd, location.resolvedRoot);
        const destinationDirectory = resolved ? resolvedDirectory : activeDirectory;
        const source = await findSessionFile(
          location.cwd,
          sessionId,
          resolved ? location.activeRoot : location.resolvedRoot,
          location.direct,
        );
        if (!source) {
          const alreadyMoved = await findSessionFile(
            location.cwd,
            sessionId,
            resolved ? location.resolvedRoot : location.activeRoot,
            location.direct,
          );
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
          const source = await findSessionFile(
            location.cwd,
            sessionId,
            location.resolvedRoot,
            location.direct,
          );
          if (!source) throw new Error(`Cake could not find resolved session ${sessionId}`);
          await rm(source);
          return;
        }
        const active = await findSessionFile(
          location.cwd,
          sessionId,
          location.activeRoot,
          location.direct,
        );
        const resolved = await findSessionFile(
          location.cwd,
          sessionId,
          location.resolvedRoot,
          location.direct,
        );
        if (active && resolved) throw new Error(`Session ${sessionId} exists in both namespaces`);
        const source = active ?? resolved;
        if (!source) throw new Error(`Cake could not find session ${sessionId}`);
        await rm(source);
      },
      catch: (cause) => archiveError(operation, sessionId, cause),
    });
  });

  return SessionArchiveStorage.of({
    resolve: (sessionId, location) => move(sessionId, location, true),
    restore: (sessionId, location) => move(sessionId, location, false),
    deleteResolved: (sessionId, location) => deleteAt("deleteResolved", sessionId, location),
    delete: (sessionId, location) => deleteAt("delete", sessionId, location),
  });
});
