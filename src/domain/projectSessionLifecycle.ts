import { Effect, Stream } from "effect";
import { ProjectSessionLifecycle } from "../services/project-sessions/ProjectSessionLifecycle";
import * as managedWorktrees from "./managedWorktrees";
import * as subagents from "./subagents";
import {
  getState,
  setProjectWorkflowSessionStatus,
  setSessionUnread,
  trustProject,
} from "./application";
import { defaultProjectWorkflow, type ProjectWorkflowSessionDestination } from "./application-data";
import { PiSessions } from "../services/pi/PiSessions";
import * as projectSessionLocations from "./projectSessionLocations";
import {
  ProjectSessionError,
  type ProjectSessionTarget,
  type WorkingDirectoryResolutionFailure,
} from "./project-session-data";
import { SessionArchiveStorage } from "../services/storage/SessionArchiveStorage";
import { SessionFamilyStorage } from "../services/storage/SessionFamilyStorage";
import {
  archiveLocation,
  asError,
  findLocation,
  publishCatalogChange,
  publishCatalogStatus,
} from "./projectSessionMetadata";

export const resolve = Effect.fn("ProjectSessions.resolve")(function* (
  target: ProjectSessionTarget,
) {
  const family = yield* Effect.flatMap(SessionFamilyStorage, (storage) =>
    storage.familyForMember(target.sessionId),
  ).pipe(asError("resolve"));
  if (family && family.parentSessionId !== target.sessionId)
    return yield* new ProjectSessionError({
      operation: "resolve",
      message: "Only the Session Family parent can resolve the family",
    });
  if (family) {
    const location = yield* findLocation(target, { includeInactive: true });
    const archive = yield* SessionArchiveStorage;
    const namespace = yield* archive
      .locate(target.sessionId, archiveLocation(location))
      .pipe(asError("resolve"));
    if (namespace === "resolved") return;
    if (!namespace)
      return yield* new ProjectSessionError({
        operation: "resolve",
        message: "Activate a Draft before resolving it",
      });
    const lifecycle = yield* ProjectSessionLifecycle;
    return yield* lifecycle
      .setProjectSessionResolved(target.sessionId, true)
      .pipe(asError("resolve"));
  }
  const storage = yield* SessionFamilyStorage;
  return yield* storage
    .withMemberLock(
      target.sessionId,
      Effect.gen(function* () {
        if (yield* storage.familyForMember(target.sessionId))
          return yield* new ProjectSessionError({
            operation: "resolve",
            message: "The session became a family parent; retry the family operation",
          });
        const location = yield* findLocation(target, { includeInactive: true });
        const archive = yield* SessionArchiveStorage;
        const namespace = yield* archive
          .locate(target.sessionId, archiveLocation(location))
          .pipe(asError("resolve"));
        if (namespace === "resolved") return;
        if (!namespace)
          return yield* new ProjectSessionError({
            operation: "resolve",
            message: "Activate a Draft before resolving it",
          });
        const sessions = yield* PiSessions;
        const status = yield* sessions.currentStatus({
          workingDirectory: location.workingDirectory,
          sessionDirectory: location.sessionDirectory,
          sessionId: target.sessionId,
        });
        if (status?.streaming || status?.pending)
          return yield* new ProjectSessionError({
            operation: "resolve",
            message:
              "Cake cannot resolve a Project Session while its turn is active or input is pending",
          });
        if (status && !status.persisted)
          return yield* new ProjectSessionError({
            operation: "resolve",
            message: "Cake cannot resolve an empty Project Session",
          });
        yield* subagents.releaseParent(target.sessionId).pipe(asError("resolve"));
        yield* projectSessionLocations.archive(target.sessionId, location).pipe(asError("resolve"));
        yield* managedWorktrees
          .cleanupResolved(location.workingDirectory, location.sessionDirectory)
          .pipe(asError("resolve"));
        yield* setSessionUnread(target.sessionId, false).pipe(asError("resolve"));
        yield* publishCatalogStatus(target.sessionId, location, true).pipe(asError("resolve"));
      }),
    )
    .pipe(asError("resolve"));
});

/**
 * Discovers every active Project Session in one authoritative Working Directory
 * and resolves standalone sessions or whole Session Families sequentially.
 */
export const resolveWorkingDirectory = Effect.fn("ProjectSessions.resolveWorkingDirectory")(
  function* (workingDirectory: string) {
    const locations = (yield* projectSessionLocations
      .locations({ includeInactive: true })
      .pipe(asError("resolveWorkingDirectory"))).filter(
      (location) => location.workingDirectory === workingDirectory,
    );
    const [location, ...collisions] = locations;
    if (!location || collisions.length > 0)
      return yield* new ProjectSessionError({
        operation: "resolveWorkingDirectory",
        message: !location
          ? `Cake could not find Working Directory ${workingDirectory}`
          : `Working Directory collision detected: ${workingDirectory}`,
      });

    const activeSessions = yield* (yield* PiSessions)
      .catalog({ workingDirectory, sessionDirectory: location.sessionDirectory })
      .pipe(
        Stream.runCollect,
        Effect.map((items) => Array.from(items)),
        asError("resolveWorkingDirectory"),
      );
    const activeSessionIds = new Set(activeSessions.map((session) => session.id));
    const families = yield* (yield* SessionFamilyStorage)
      .list()
      .pipe(asError("resolveWorkingDirectory"));
    const familyByMember = new Map(
      families.flatMap((family) => [
        [family.parentSessionId, family] as const,
        ...family.children.map((child) => [child.sessionId, family] as const),
      ]),
    );
    const targets: Array<{ sessionId: string; sessionIds: string[] }> = [];
    const selected = new Set<string>();
    for (const session of activeSessions) {
      const family = familyByMember.get(session.id);
      const sessionId = family?.parentSessionId ?? session.id;
      if (selected.has(sessionId)) continue;
      selected.add(sessionId);
      const sessionIds = family
        ? [family.parentSessionId, ...family.children.map((child) => child.sessionId)].filter(
            (id) => activeSessionIds.has(id),
          )
        : [session.id];
      targets.push({ sessionId, sessionIds });
    }

    const resolvedSessionIds: string[] = [];
    const failures: WorkingDirectoryResolutionFailure[] = [];
    for (const target of targets) {
      const outcome = yield* resolve({
        sessionId: target.sessionId,
        workingDirectory,
      }).pipe(
        Effect.match({
          onFailure: (error) => ({ _tag: "Failure" as const, error }),
          onSuccess: () => ({ _tag: "Success" as const }),
        }),
      );
      if (outcome._tag === "Failure")
        failures.push({ sessionIds: target.sessionIds, message: outcome.error.message });
      else resolvedSessionIds.push(...target.sessionIds);
    }
    return {
      projectPath: location.projectPath,
      workingDirectory,
      resolvedSessionIds,
      failures,
    };
  },
);

export const restore = Effect.fn("ProjectSessions.restore")(function* (
  target: ProjectSessionTarget,
) {
  const family = yield* Effect.flatMap(SessionFamilyStorage, (storage) =>
    storage.familyForMember(target.sessionId),
  ).pipe(asError("restore"));
  if (family && family.parentSessionId !== target.sessionId)
    return yield* new ProjectSessionError({
      operation: "restore",
      message: "Only the Session Family parent can restore the family",
    });
  if (family) {
    const location = yield* findLocation(target);
    const archive = yield* SessionArchiveStorage;
    const namespace = yield* archive
      .locate(target.sessionId, archiveLocation(location))
      .pipe(asError("restore"));
    if (namespace === "active") return;
    if (!namespace)
      return yield* new ProjectSessionError({
        operation: "restore",
        message: "Only a resolved Project Session can be restored",
      });
    const lifecycle = yield* ProjectSessionLifecycle;
    return yield* lifecycle
      .setProjectSessionResolved(target.sessionId, false)
      .pipe(asError("restore"));
  }
  const storage = yield* SessionFamilyStorage;
  return yield* storage
    .withMemberLock(
      target.sessionId,
      Effect.gen(function* () {
        if (yield* storage.familyForMember(target.sessionId))
          return yield* new ProjectSessionError({
            operation: "restore",
            message: "The session became a family parent; retry the family operation",
          });
        const location = yield* findLocation(target);
        const archive = yield* SessionArchiveStorage;
        const namespace = yield* archive
          .locate(target.sessionId, archiveLocation(location))
          .pipe(asError("restore"));
        if (namespace === "active") return;
        if (!namespace)
          return yield* new ProjectSessionError({
            operation: "restore",
            message: "Only a resolved Project Session can be restored",
          });
        yield* managedWorktrees.restoreResolved(location.workingDirectory).pipe(asError("restore"));
        const restored = yield* projectSessionLocations
          .restore(target.sessionId, location)
          .pipe(asError("restore"));
        yield* trustProject(restored.workingDirectory).pipe(asError("restore"));
        yield* publishCatalogStatus(target.sessionId, restored, false).pipe(asError("restore"));
        yield* publishCatalogChange(target.sessionId, restored, false).pipe(asError("restore"));
      }),
    )
    .pipe(asError("restore"));
});

/** Authoritative lifecycle/custom-column transition for one Project Session card. */
export const moveWorkflowSession = Effect.fn("ProjectSessions.moveWorkflowSession")(
  function* (input: {
    readonly projectPath: string;
    readonly sessionId: string;
    readonly workingDirectory: string;
    readonly destination: ProjectWorkflowSessionDestination;
  }) {
    const state = yield* getState().pipe(asError("moveWorkflowSession"));
    const project = state.projects.find((candidate) => candidate.path === input.projectPath);
    if (!project)
      return yield* new ProjectSessionError({
        operation: "moveWorkflowSession",
        message: "That Project is not registered",
      });
    const workflow = project.workflow ?? defaultProjectWorkflow();
    const destinationStatusId =
      input.destination._tag === "Custom" ? input.destination.statusId : undefined;
    if (
      destinationStatusId !== undefined &&
      !workflow.columns.some((column) => column.id === destinationStatusId)
    )
      return yield* new ProjectSessionError({
        operation: "moveWorkflowSession",
        message: "That custom status no longer exists",
      });

    const target = { sessionId: input.sessionId, workingDirectory: input.workingDirectory };
    const location = yield* findLocation(target, { includeInactive: true });
    if (location.projectPath !== input.projectPath)
      return yield* new ProjectSessionError({
        operation: "moveWorkflowSession",
        message: "That session does not belong to this Project",
      });
    const archive = yield* SessionArchiveStorage;
    const namespace = yield* archive
      .locate(input.sessionId, archiveLocation(location))
      .pipe(asError("moveWorkflowSession"));
    if (!namespace)
      return yield* new ProjectSessionError({
        operation: "moveWorkflowSession",
        message:
          input.destination._tag === "Resolved"
            ? "Activate a Draft before resolving it"
            : "Activate the Draft before assigning its workflow status",
      });

    const family = yield* Effect.flatMap(SessionFamilyStorage, (storage) =>
      storage.familyForMember(input.sessionId),
    ).pipe(asError("moveWorkflowSession"));
    const familyChild = family && family.parentSessionId !== input.sessionId;
    if (familyChild && (namespace === "resolved" || input.destination._tag === "Resolved"))
      return yield* new ProjectSessionError({
        operation: "moveWorkflowSession",
        message: "Resolve or restore this Session Family from its parent card",
      });

    if (input.destination._tag === "Resolved") {
      if (namespace === "active") yield* resolve(target);
      return workflow;
    }
    if (namespace === "resolved") yield* restore(target);
    return yield* setProjectWorkflowSessionStatus(
      input.projectPath,
      input.sessionId,
      destinationStatusId,
    ).pipe(asError("moveWorkflowSession"));
  },
);
