import { Effect, Layer } from "effect";
import {
  forgetProjectSessions,
  reconcileResolvedSessions,
  setCakeChatSessionResolved,
  setSessionsResolved,
  trustProject,
} from "../domain/application";
import * as artifacts from "../domain/artifacts";
import * as reviews from "../domain/reviews";
import * as sessionTerminals from "../domain/sessionTerminals";
import type { WorktreeRecord } from "../ipc/worktree-contract";
import { listWorkspaceSessions } from "../services/pi/runtime/session-discovery";
import { ProjectAccess } from "../services/projects/ProjectAccess";
import { ApplicationState } from "../services/storage/ApplicationState";
import type { ArtifactStorage } from "../services/storage/ArtifactStorage";
import type { ReviewStorage } from "../services/storage/ReviewStorage";
import { SessionArchiveStorage } from "../services/storage/SessionArchiveStorage";
import type { Terminal } from "../services/terminal/Terminal";
import { ManagedWorktrees } from "../services/worktrees/ManagedWorktrees";
import {
  ProjectSessionLifecycle,
  ProjectSessionLifecycleError,
} from "../services/project-sessions/ProjectSessionLifecycle";

export interface ProjectSessionLifecycleLiveOptions {
  readonly homeDirectory: string;
  readonly projectSessionDirectory: string;
  readonly resolvedProjectSessionDirectory: string;
  readonly cakeChatSessionDirectory: string;
  readonly resolvedCakeChatSessionDirectory: string;
}

const lifecycleError = (operation: string, cause: unknown) =>
  new ProjectSessionLifecycleError({
    operation,
    message: cause instanceof Error ? cause.message : String(cause),
  });

export const makeProjectSessionLifecycleLive = (
  options: ProjectSessionLifecycleLiveOptions,
): Layer.Layer<
  ProjectSessionLifecycle,
  never,
  | ApplicationState
  | ArtifactStorage
  | ManagedWorktrees
  | ProjectAccess
  | ReviewStorage
  | SessionArchiveStorage
  | Terminal
> =>
  Layer.effect(
    ProjectSessionLifecycle,
    Effect.gen(function* () {
      const access = yield* ProjectAccess;
      const application = yield* ApplicationState;
      const archive = yield* SessionArchiveStorage;
      const worktrees = yield* ManagedWorktrees;
      const context = yield* Effect.context<
        | ApplicationState
        | ArtifactStorage
        | ManagedWorktrees
        | ProjectAccess
        | ReviewStorage
        | SessionArchiveStorage
        | Terminal
      >();
      const run = <A, E, R>(operation: string, effect: Effect.Effect<A, E, R>) =>
        effect.pipe(
          Effect.provide(context),
          Effect.mapError((cause) => lifecycleError(operation, cause)),
        );
      const list = (
        workingDirectory: string,
        input?: { includeResolved?: boolean; cakeChat?: boolean },
      ) =>
        Effect.tryPromise({
          try: () =>
            listWorkspaceSessions(
              workingDirectory,
              input?.cakeChat ? options.cakeChatSessionDirectory : options.projectSessionDirectory,
              {
                direct: input?.cakeChat,
                resolvedSessionDir: input?.includeResolved
                  ? input.cakeChat
                    ? options.resolvedCakeChatSessionDirectory
                    : options.resolvedProjectSessionDirectory
                  : undefined,
              },
            ),
          catch: (cause) => lifecycleError("listSessions", cause),
        });
      const setCakeChatResolved = Effect.fn("ProjectSessionLifecycle.setCakeChatResolved")(
        function* (sessionId: string, resolved: boolean) {
          const location = {
            cwd: options.homeDirectory,
            activeRoot: options.cakeChatSessionDirectory,
            resolvedRoot: options.resolvedCakeChatSessionDirectory,
            direct: true as const,
          };
          if (resolved) {
            yield* run(
              "setCakeChatResolved",
              sessionTerminals.closeSession("cake-chat", sessionId),
            );
            yield* run("setCakeChatResolved", archive.resolve(sessionId, location));
          } else yield* run("setCakeChatResolved", archive.restore(sessionId, location));
          yield* run("setCakeChatResolved", setCakeChatSessionResolved(sessionId, resolved));
        },
      );

      const setProjectSessionResolved = Effect.fn(
        "ProjectSessionLifecycle.setProjectSessionResolved",
      )(function* (sessionId: string, resolved: boolean, knownWorkingDirectory?: string) {
        const workingDirectory =
          knownWorkingDirectory ??
          (yield* run(
            "setProjectSessionResolved",
            access.resolveSessionWorkingDirectory(sessionId),
          ));
        if (resolved) {
          yield* run(
            "setProjectSessionResolved",
            sessionTerminals.closeSession("project", sessionId),
          );
          yield* run(
            "setProjectSessionResolved",
            archive.resolve(sessionId, {
              cwd: workingDirectory,
              activeRoot: options.projectSessionDirectory,
              resolvedRoot: options.resolvedProjectSessionDirectory,
            }),
          );
          const remaining = yield* list(workingDirectory);
          if (remaining.length === 0)
            yield* run("setProjectSessionResolved", worktrees.cleanupResolved(workingDirectory));
        } else {
          const restored = yield* run(
            "setProjectSessionResolved",
            worktrees.restoreResolved(workingDirectory),
          );
          if (restored) {
            yield* access.allow(restored.worktreePath);
            if (application.snapshot().trustedProjectPaths.includes(restored.projectPath))
              yield* run("setProjectSessionResolved", trustProject(restored.worktreePath));
          }
          yield* run(
            "setProjectSessionResolved",
            archive.restore(sessionId, {
              cwd: workingDirectory,
              activeRoot: options.projectSessionDirectory,
              resolvedRoot: options.resolvedProjectSessionDirectory,
            }),
          );
        }
        yield* run("setProjectSessionResolved", setSessionsResolved([sessionId], resolved));
      });

      const deleteResolvedProjectSession = Effect.fn(
        "ProjectSessionLifecycle.deleteResolvedProjectSession",
      )(function* (sessionId: string) {
        if (!application.snapshot().resolvedSessionIds.includes(sessionId))
          return yield* new ProjectSessionLifecycleError({
            operation: "deleteResolvedProjectSession",
            message: "Only resolved project sessions can be deleted",
          });
        const workingDirectory = yield* run(
          "deleteResolvedProjectSession",
          access.resolveSessionWorkingDirectory(sessionId),
        );
        yield* run(
          "deleteResolvedProjectSession",
          artifacts.deleteSession(workingDirectory, sessionId),
        );
        yield* run(
          "deleteResolvedProjectSession",
          reviews.deleteSession(workingDirectory, sessionId),
        );
        yield* run(
          "deleteResolvedProjectSession",
          archive.deleteResolved(sessionId, {
            cwd: workingDirectory,
            activeRoot: options.projectSessionDirectory,
            resolvedRoot: options.resolvedProjectSessionDirectory,
          }),
        );
        yield* access.forgetSessionLocation(sessionId);
        yield* run("deleteResolvedProjectSession", forgetProjectSessions([sessionId]));
      });

      const deleteProjectSessions = Effect.fn("ProjectSessionLifecycle.deleteProjectSessions")(
        function* (projectPath: string, records: ReadonlyArray<WorktreeRecord>) {
          const workingDirectories = [
            projectPath,
            ...records
              .filter((record) => record.projectPath === projectPath)
              .map((record) => record.worktreePath),
          ];
          const forgotten: string[] = [];
          for (const workingDirectory of workingDirectories) {
            const sessions = yield* list(workingDirectory, { includeResolved: true });
            for (const session of sessions) {
              yield* run(
                "deleteProjectSessions",
                artifacts.deleteSession(workingDirectory, session.id),
              );
              yield* run(
                "deleteProjectSessions",
                reviews.deleteSession(workingDirectory, session.id),
              );
              yield* run(
                "deleteProjectSessions",
                archive.delete(session.id, {
                  cwd: workingDirectory,
                  activeRoot: options.projectSessionDirectory,
                  resolvedRoot: options.resolvedProjectSessionDirectory,
                }),
              );
              forgotten.push(session.id);
            }
          }
          if (forgotten.length > 0)
            yield* run("deleteProjectSessions", forgetProjectSessions(forgotten));
          yield* Effect.forEach(forgotten, (sessionId) => access.forgetSessionLocation(sessionId));
        },
      );

      const reconcile = Effect.fn("ProjectSessionLifecycle.reconcile")(function* () {
        const state = application.snapshot();
        const records = yield* run("reconcile", worktrees.records());
        for (const project of state.projects) {
          yield* access.allow(project.path);
          for (const record of records)
            if (record.projectPath === project.path) yield* access.allow(record.worktreePath);
        }
        const workingDirectories = yield* access.allowedWorkingDirectories();
        const projectLists = yield* Effect.forEach(workingDirectories, (workingDirectory) =>
          list(workingDirectory, { includeResolved: true }).pipe(
            Effect.catch(() => Effect.succeed([])),
          ),
        );
        const cakeChats = yield* list(options.homeDirectory, {
          includeResolved: true,
          cakeChat: true,
        }).pipe(Effect.catch(() => Effect.succeed([])));
        const projectIds = projectLists
          .flat()
          .filter((session) => session.resolved)
          .map((session) => session.id);
        const cakeChatIds = cakeChats
          .filter((session) => session.resolved)
          .map((session) => session.id);
        const changed =
          [...state.resolvedSessionIds].sort().join("\n") !== [...projectIds].sort().join("\n") ||
          [...state.resolvedCakeChatSessionIds].sort().join("\n") !==
            [...cakeChatIds].sort().join("\n");
        if (changed) yield* run("reconcile", reconcileResolvedSessions(projectIds, cakeChatIds));
      });

      return ProjectSessionLifecycle.of({
        setCakeChatResolved,
        setProjectSessionResolved,
        deleteResolvedProjectSession,
        deleteProjectSessions,
        reconcile,
      });
    }),
  );
