import { transition } from "../domain/sessionFamilies";
import { Effect, Layer, Stream } from "effect";
import { forgetProjectSessions, setSessionUnread } from "../domain/application";
import * as artifacts from "../domain/artifacts";
import * as managedWorktrees from "../domain/managedWorktrees";
import * as reviews from "../domain/reviews";
import type { WorktreeRecord } from "../domain/managed-worktree-data";
import { PiSessions } from "../services/pi/PiSessions";
import { streamWorkspaceSessions } from "../services/pi/runtime/session-discovery";
import { ProjectAccess } from "../services/projects/ProjectAccess";
import { ApplicationState } from "../services/storage/ApplicationState";
import type { Terminal } from "../services/terminal/Terminal";
import type { ArtifactStorage } from "../services/storage/ArtifactStorage";
import type { ReviewStorage } from "../services/storage/ReviewStorage";
import {
  SessionArchiveStorage,
  type ProjectSessionArchiveContext,
} from "../services/storage/SessionArchiveStorage";
import { ManagedWorktrees } from "../services/worktrees/ManagedWorktrees";
import {
  ProjectSessionLifecycle,
  ProjectSessionLifecycleError,
} from "../services/project-sessions/ProjectSessionLifecycle";
import { SessionCatalogChanges } from "../services/session-catalogs/SessionCatalogChanges";
import { SessionFamilyStorage } from "../services/storage/SessionFamilyStorage";

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
  | PiSessions
  | ProjectAccess
  | ReviewStorage
  | SessionArchiveStorage
  | SessionCatalogChanges
  | SessionFamilyStorage
  | Terminal
> =>
  Layer.effect(
    ProjectSessionLifecycle,
    Effect.gen(function* () {
      const access = yield* ProjectAccess;
      const application = yield* ApplicationState;
      const archive = yield* SessionArchiveStorage;
      const catalogs = yield* SessionCatalogChanges;
      const families = yield* SessionFamilyStorage;
      const sessions = yield* PiSessions;
      const worktrees = yield* ManagedWorktrees;
      const context = yield* Effect.context<
        | ApplicationState
        | ArtifactStorage
        | ManagedWorktrees
        | PiSessions
        | ProjectAccess
        | ReviewStorage
        | SessionArchiveStorage
        | SessionCatalogChanges
        | SessionFamilyStorage
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
          if (resolved) yield* run("setCakeChatResolved", archive.resolve(sessionId, location));
          else yield* run("setCakeChatResolved", archive.restore(sessionId, location));
          yield* catalogs.publish({ _tag: "CakeChatSessionStatusChanged", sessionId, resolved });
        },
      );

      const setOneProjectSessionResolved = Effect.fn(
        "ProjectSessionLifecycle.setOneProjectSessionResolved",
      )(function* (sessionId: string, resolved: boolean, workingDirectory: string) {
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
          yield* run(
            "setProjectSessionResolved",
            managedWorktrees.cleanupResolved(workingDirectory, options.projectSessionDirectory),
          );
          yield* run("setProjectSessionResolved", setSessionUnread(sessionId, false));
        } else {
          yield* run(
            "setProjectSessionResolved",
            managedWorktrees.restoreResolved(workingDirectory),
          );
          yield* run("setProjectSessionResolved", archive.restoreProject(sessionId));
        }
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

      const setProjectSessionResolved = Effect.fn(
        "ProjectSessionLifecycle.setProjectSessionResolved",
      )(function* (sessionId: string, resolved: boolean, knownWorkingDirectory?: string) {
        const family = yield* families
          .familyForMember(sessionId)
          .pipe(Effect.mapError((cause) => lifecycleError("setProjectSessionResolved", cause)));
        if (family && family.parentSessionId !== sessionId)
          return yield* new ProjectSessionLifecycleError({
            operation: "setProjectSessionResolved",
            message: `${resolved ? "Resolve" : "Restore"} is available only on the family parent`,
          });
        if (family) {
          yield* transition(
            family,
            resolved,
            options.projectSessionDirectory,
            (memberId, targetResolved) =>
              setOneProjectSessionResolved(memberId, targetResolved, family.workingDirectory),
          ).pipe(
            Effect.provideService(SessionFamilyStorage, families),
            Effect.provideService(PiSessions, sessions),
            Effect.mapError((cause) => lifecycleError("setProjectSessionResolved", cause)),
          );
          return;
        }
        yield* families
          .withMemberLock(
            sessionId,
            Effect.gen(function* () {
              if (yield* families.familyForMember(sessionId))
                return yield* new ProjectSessionLifecycleError({
                  operation: "setProjectSessionResolved",
                  message: "The session became a family parent; retry the family operation",
                });
              const workingDirectory =
                knownWorkingDirectory ??
                (yield* run(
                  "setProjectSessionResolved",
                  access.resolveSessionWorkingDirectory(sessionId),
                ));
              const memberIds = [sessionId];
              if (resolved) {
                const activeMembers: string[] = [];
                for (const memberId of memberIds) {
                  const status = yield* sessions.currentStatus({
                    workingDirectory,
                    sessionDirectory: options.projectSessionDirectory,
                    sessionId: memberId,
                  });
                  if (status?.streaming || status?.pending) activeMembers.push(memberId);
                }
                if (activeMembers.length > 0)
                  return yield* new ProjectSessionLifecycleError({
                    operation: "setProjectSessionResolved",
                    message: `Cake cannot resolve this family while these sessions are active: ${activeMembers.join(", ")}`,
                  });
              }
              for (const memberId of memberIds)
                yield* setOneProjectSessionResolved(memberId, resolved, workingDirectory);
            }),
          )
          .pipe(Effect.mapError((cause) => lifecycleError("setProjectSessionResolved", cause)));
      });

      const deleteResolvedProjectSession = Effect.fn(
        "ProjectSessionLifecycle.deleteResolvedProjectSession",
      )(function* (sessionId: string) {
        if (
          yield* families
            .familyForMember(sessionId)
            .pipe(Effect.mapError((cause) => lifecycleError("deleteResolvedProjectSession", cause)))
        )
          return yield* new ProjectSessionLifecycleError({
            operation: "deleteResolvedProjectSession",
            message: "Individual Session Family members cannot be deleted",
          });
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
