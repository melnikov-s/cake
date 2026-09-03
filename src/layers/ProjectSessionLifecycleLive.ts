import { Effect, Layer, Stream } from "effect";
import { forgetProjectSessions, setSessionUnread } from "../domain/application";
import * as artifacts from "../domain/artifacts";
import * as reviews from "../domain/reviews";
import * as sessionTerminals from "../domain/sessionTerminals";
import type { WorktreeRecord } from "../ipc/worktree-contract";
import { streamWorkspaceSessions } from "../services/pi/runtime/session-discovery";
import { ProjectAccess } from "../services/projects/ProjectAccess";
import { ApplicationState } from "../services/storage/ApplicationState";
import type { ArtifactStorage } from "../services/storage/ArtifactStorage";
import type { ReviewStorage } from "../services/storage/ReviewStorage";
import {
  SessionArchiveStorage,
  type ProjectSessionArchiveContext,
} from "../services/storage/SessionArchiveStorage";
import type { Terminal } from "../services/terminal/Terminal";
import { ManagedWorktrees } from "../services/worktrees/ManagedWorktrees";
import {
  ProjectSessionLifecycle,
  ProjectSessionLifecycleError,
} from "../services/project-sessions/ProjectSessionLifecycle";
import { SessionCatalogChanges } from "../services/session-catalogs/SessionCatalogChanges";

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
  | SessionCatalogChanges
  | Terminal
> =>
  Layer.effect(
    ProjectSessionLifecycle,
    Effect.gen(function* () {
      const access = yield* ProjectAccess;
      const application = yield* ApplicationState;
      const archive = yield* SessionArchiveStorage;
      const catalogs = yield* SessionCatalogChanges;
      const worktrees = yield* ManagedWorktrees;
      const context = yield* Effect.context<
        | ApplicationState
        | ArtifactStorage
        | ManagedWorktrees
        | ProjectAccess
        | ReviewStorage
        | SessionArchiveStorage
        | SessionCatalogChanges
        | Terminal
      >();
      const run = <A, E, R>(operation: string, effect: Effect.Effect<A, E, R>) =>
        effect.pipe(
          Effect.provide(context),
          Effect.mapError((cause) => lifecycleError(operation, cause)),
        );
      const catalog = (workingDirectory: string) =>
        streamWorkspaceSessions(workingDirectory, options.projectSessionDirectory).pipe(
          Stream.mapError((cause) => lifecycleError("catalogSessions", cause)),
        );
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
          yield* catalogs.publish({ _tag: "CakeChatSessionStatusChanged", sessionId, resolved });
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
        const records = yield* run("setProjectSessionResolved", worktrees.records());
        const worktree = records.find((record) => record.worktreePath === workingDirectory);
        const projectPath = worktree?.projectPath ?? workingDirectory;
        const projectName =
          application.snapshot().projects.find((project) => project.path === projectPath)?.name ??
          projectPath;
        const archiveContext: ProjectSessionArchiveContext = worktree
          ? { projectPath, projectName, worktreeName: worktree.branch.replace(/^agent\//, "") }
          : { projectPath, projectName };
        if (resolved) {
          yield* run(
            "setProjectSessionResolved",
            sessionTerminals.closeSession("project", sessionId),
          );
          yield* run(
            "setProjectSessionResolved",
            archive.resolveProject(
              sessionId,
              {
                cwd: workingDirectory,
                activeRoot: options.projectSessionDirectory,
                resolvedRoot: options.resolvedProjectSessionDirectory,
              },
              archiveContext,
            ),
          );
        } else yield* run("setProjectSessionResolved", archive.restoreProject(sessionId));
        if (resolved) yield* run("setProjectSessionResolved", setSessionUnread(sessionId, false));
        yield* catalogs.publish({
          _tag: "ProjectSessionStatusChanged",
          sessionId,
          projectPath,
          workingDirectory,
          resolved,
          unread: resolved ? false : application.snapshot().unreadSessionIds.includes(sessionId),
        });
        if (!resolved)
          yield* catalogs.publish({
            _tag: "ProjectSessionChanged",
            sessionId,
            projectPath,
            workingDirectory,
            resolved: false,
          });
      });

      const deleteResolvedProjectSession = Effect.fn(
        "ProjectSessionLifecycle.deleteResolvedProjectSession",
      )(function* (sessionId: string) {
        const entry = yield* run(
          "deleteResolvedProjectSession",
          archive.resolvedProjectEntry(sessionId),
        );
        if (!entry)
          return yield* new ProjectSessionLifecycleError({
            operation: "deleteResolvedProjectSession",
            message: "Only resolved project sessions can be deleted",
          });
        yield* run(
          "deleteResolvedProjectSession",
          artifacts.deleteSession(entry.workingDirectory, sessionId),
        );
        yield* run(
          "deleteResolvedProjectSession",
          reviews.deleteSession(entry.workingDirectory, sessionId),
        );
        yield* run("deleteResolvedProjectSession", archive.deleteResolvedProject(sessionId));
        yield* access.forgetSessionLocation(sessionId);
        yield* run("deleteResolvedProjectSession", forgetProjectSessions([sessionId]));
        yield* catalogs.publish({ _tag: "ProjectSessionRemoved", sessionId });
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
          const deleteRelated = Effect.fn("ProjectSessionLifecycle.deleteRelated")(function* (
            workingDirectory: string,
            sessionId: string,
          ) {
            yield* run(
              "deleteProjectSessions",
              artifacts.deleteSession(workingDirectory, sessionId),
            );
            yield* run("deleteProjectSessions", reviews.deleteSession(workingDirectory, sessionId));
            forgotten.push(sessionId);
            yield* catalogs.publish({ _tag: "ProjectSessionRemoved", sessionId });
          });
          for (const workingDirectory of workingDirectories) {
            yield* catalog(workingDirectory).pipe(
              Stream.runForEach((session) =>
                Effect.gen(function* () {
                  yield* deleteRelated(workingDirectory, session.id);
                  yield* run(
                    "deleteProjectSessions",
                    archive.delete(session.id, {
                      cwd: workingDirectory,
                      activeRoot: options.projectSessionDirectory,
                      resolvedRoot: options.resolvedProjectSessionDirectory,
                    }),
                  );
                }),
              ),
            );
          }
          yield* archive.resolvedProjects(projectPath).pipe(
            Stream.runForEach((entry) =>
              Effect.gen(function* () {
                yield* deleteRelated(entry.workingDirectory, entry.sessionId);
                yield* run("deleteProjectSessions", archive.deleteResolvedProject(entry.sessionId));
              }),
            ),
            Effect.mapError((cause) => lifecycleError("deleteProjectSessions", cause)),
          );
          if (forgotten.length > 0)
            yield* run("deleteProjectSessions", forgetProjectSessions(forgotten));
          yield* Effect.forEach(forgotten, (sessionId) => access.forgetSessionLocation(sessionId));
        },
      );

      return ProjectSessionLifecycle.of({
        setCakeChatResolved,
        setProjectSessionResolved,
        deleteResolvedProjectSession,
        deleteProjectSessions,
      });
    }),
  );
