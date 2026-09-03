import { Effect, Layer } from "effect";
import { findSessionFileById } from "../storage/session-files";
import { ApplicationState } from "../storage/ApplicationState";
import { ManagedWorktrees } from "../worktrees/ManagedWorktrees";
import { ProjectAccess, ProjectAccessError } from "./ProjectAccess";

export interface ProjectAccessLiveOptions {
  readonly projectSessionDirectory: string;
  readonly resolvedProjectSessionDirectory: string;
}

const accessError = (operation: string, cause: unknown) =>
  new ProjectAccessError({
    operation,
    message: cause instanceof Error ? cause.message : String(cause),
  });

export const makeProjectAccessLive = (
  options: ProjectAccessLiveOptions,
): Layer.Layer<ProjectAccess, never, ApplicationState | ManagedWorktrees> =>
  Layer.effect(
    ProjectAccess,
    Effect.gen(function* () {
      const application = yield* ApplicationState;
      const worktrees = yield* ManagedWorktrees;
      const allowed = new Set<string>();
      const sessionLocations = new Map<string, string>();
      const pendingTrustRequests = new Map<string, string>();
      const trustKey = (ownerId: number, requestId: string) => `${ownerId}:${requestId}`;

      const rememberSessionLocation = Effect.fn("ProjectAccess.rememberSessionLocation")(function* (
        workingDirectory: string,
        sessionId: string,
      ) {
        const existing = sessionLocations.get(sessionId);
        if (existing && existing !== workingDirectory)
          return yield* new ProjectAccessError({
            operation: "rememberSessionLocation",
            message: `Session ID collision detected: ${sessionId}`,
          });
        sessionLocations.set(sessionId, workingDirectory);
      });

      const resolveSessionWorkingDirectory = Effect.fn(
        "ProjectAccess.resolveSessionWorkingDirectory",
      )(function* (sessionId: string) {
        const cached = sessionLocations.get(sessionId);
        if (cached && allowed.has(cached)) return cached;
        const records = yield* worktrees
          .records()
          .pipe(Effect.mapError((cause) => accessError("resolveSessionWorkingDirectory", cause)));
        const candidates = [
          ...application.snapshot().projects.map((project) => project.path),
          ...records.map((record) => record.worktreePath),
        ];
        const matches = yield* Effect.forEach(
          [...new Set(candidates)].filter((workingDirectory) => allowed.has(workingDirectory)),
          (workingDirectory) =>
            Effect.tryPromise({
              try: async () => {
                const active = await findSessionFileById(sessionId, {
                  workingDirectory,
                  root: options.projectSessionDirectory,
                });
                const resolved = await findSessionFileById(sessionId, {
                  workingDirectory,
                  root: options.resolvedProjectSessionDirectory,
                });
                if (active && resolved)
                  throw new Error(`Session ID collision detected: ${sessionId}`);
                return active ?? resolved;
              },
              catch: (cause) => accessError("resolveSessionWorkingDirectory", cause),
            }).pipe(
              Effect.map((sessionFile) => (sessionFile ? workingDirectory : undefined)),
              Effect.catchTag("ProjectAccessError", () => Effect.succeed(undefined)),
            ),
          { concurrency: 8 },
        );
        const found = matches.filter((path): path is string => path !== undefined);
        if (found.length === 0)
          return yield* new ProjectAccessError({
            operation: "resolveSessionWorkingDirectory",
            message: `Cake could not find session ${sessionId}`,
          });
        if (new Set(found).size > 1)
          return yield* new ProjectAccessError({
            operation: "resolveSessionWorkingDirectory",
            message: `Session ID collision detected: ${sessionId}`,
          });
        const workingDirectory = found[0];
        if (workingDirectory === undefined)
          return yield* new ProjectAccessError({
            operation: "resolveSessionWorkingDirectory",
            message: `Cake could not find session ${sessionId}`,
          });
        yield* rememberSessionLocation(workingDirectory, sessionId);
        return workingDirectory;
      });

      return ProjectAccess.of({
        allow: Effect.fn("ProjectAccess.allow")((workingDirectory) =>
          Effect.sync(() => allowed.add(workingDirectory)),
        ),
        revoke: Effect.fn("ProjectAccess.revoke")((workingDirectory) =>
          Effect.sync(() => allowed.delete(workingDirectory)),
        ),
        isAllowed: Effect.fn("ProjectAccess.isAllowed")((workingDirectory) =>
          Effect.sync(() => allowed.has(workingDirectory)),
        ),
        allowedWorkingDirectories: Effect.fn("ProjectAccess.allowedWorkingDirectories")(() =>
          Effect.sync(() => [...allowed]),
        ),
        rememberSessionLocation,
        forgetSessionLocation: Effect.fn("ProjectAccess.forgetSessionLocation")((sessionId) =>
          Effect.sync(() => sessionLocations.delete(sessionId)),
        ),
        forgetWorkingDirectories: Effect.fn("ProjectAccess.forgetWorkingDirectories")(
          (workingDirectories) =>
            Effect.sync(() => {
              for (const [sessionId, workingDirectory] of sessionLocations)
                if (workingDirectories.has(workingDirectory)) sessionLocations.delete(sessionId);
            }),
        ),
        resolveSessionWorkingDirectory,
        requestTrust: Effect.fn("ProjectAccess.requestTrust")(
          (ownerId, requestId, workingDirectory) =>
            Effect.sync(() => {
              for (const key of pendingTrustRequests.keys())
                if (key.startsWith(`${ownerId}:`)) pendingTrustRequests.delete(key);
              pendingTrustRequests.set(trustKey(ownerId, requestId), workingDirectory);
            }),
        ),
        consumeTrustRequest: Effect.fn("ProjectAccess.consumeTrustRequest")(
          function* (ownerId, requestId, workingDirectory) {
            const key = trustKey(ownerId, requestId);
            if (pendingTrustRequests.get(key) !== workingDirectory)
              return yield* new ProjectAccessError({
                operation: "consumeTrustRequest",
                message: "Workspace trust request is no longer pending",
              });
            pendingTrustRequests.delete(key);
          },
        ),
        clearOwner: Effect.fn("ProjectAccess.clearOwner")((ownerId) =>
          Effect.sync(() => {
            for (const key of pendingTrustRequests.keys())
              if (key.startsWith(`${ownerId}:`)) pendingTrustRequests.delete(key);
          }),
        ),
      });
    }),
  );
