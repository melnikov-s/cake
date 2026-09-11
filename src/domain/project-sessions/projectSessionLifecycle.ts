import { Effect, Stream } from "effect";
import * as artifacts from "../artifacts/artifacts";
import * as managedWorktrees from "../worktrees/managedWorktrees";
import * as projectSessionLocations from "./projectSessionLocations";
import * as reviews from "../reviews/reviews";
import * as subagents from "../subagents/subagents";
import {
  forgetProjectSessions,
  getState,
  setProjectWorkflowSessionStatus,
  setSessionUnread,
  trustProject,
} from "../application/application";
import {
  defaultProjectWorkflow,
  type ProjectWorkflowSessionDestination,
} from "../application/application-data";
import type { WorktreeRecord } from "../worktrees/managed-worktree-data";
import {
  ProjectSessionError,
  type ProjectSessionLocation,
  type ProjectSessionTarget,
  type WorkingDirectoryResolutionFailure,
} from "./project-session-data";
import {
  archiveLocation,
  asError,
  findLocation,
  publishCatalogChange,
  publishCatalogStatus,
} from "./projectSessionMetadata";
import { PiSessions } from "../../services/pi/PiSessions";
import { ProjectAccess } from "../../services/projects/ProjectAccess";
import { ProjectSessionConfiguration } from "../../services/project-sessions/ProjectSessionConfiguration";
import { SessionCatalogChanges } from "../../services/session-catalogs/SessionCatalogChanges";
import { SessionArchiveStorage } from "../../services/storage/SessionArchiveStorage";
import {
  SessionFamilyStorage,
  type SessionFamily,
} from "../../services/storage/SessionFamilyStorage";

const error = (operation: string, message: string) =>
  new ProjectSessionError({ operation, message });

const familyMembers = (family: SessionFamily) => [
  family.parentSessionId,
  ...family.children.map((child) => child.sessionId),
];

const assertResolvable = Effect.fn("ProjectSessions.assertResolvable")(function* (
  sessionId: string,
  workingDirectory: string,
  sessionDirectory: string,
  operation: string,
) {
  const status = yield* (yield* PiSessions)
    .currentStatus({ sessionId, workingDirectory, sessionDirectory })
    .pipe(asError(operation));
  if (status?.streaming || status?.pending)
    return yield* error(
      operation,
      "Cake cannot resolve a Project Session while its turn is active or input is pending",
    );
  if (status && !status.persisted)
    return yield* error(operation, "Cake cannot resolve an empty Project Session");
});

const archiveMember = Effect.fn("ProjectSessions.archiveMember")(function* (
  sessionId: string,
  location: ProjectSessionLocation,
  operation: string,
  publish = true,
) {
  const archive = yield* SessionArchiveStorage;
  const namespace = yield* archive
    .locate(sessionId, archiveLocation(location))
    .pipe(asError(operation));
  if (!namespace) return yield* error(operation, "Activate a Draft before resolving it");
  yield* subagents.releaseParent(sessionId).pipe(asError(operation));
  if (namespace === "active")
    yield* projectSessionLocations.archive(sessionId, location).pipe(asError(operation));
  yield* setSessionUnread(sessionId, false).pipe(asError(operation));
  if (publish) yield* publishCatalogStatus(sessionId, location, true).pipe(asError(operation));
});

const restoreMember = Effect.fn("ProjectSessions.restoreMember")(function* (
  sessionId: string,
  location: ProjectSessionLocation,
  operation: string,
  publish = true,
) {
  const archive = yield* SessionArchiveStorage;
  const namespace = yield* archive
    .locate(sessionId, archiveLocation(location))
    .pipe(asError(operation));
  if (!namespace) return yield* error(operation, "Only a resolved Project Session can be restored");
  const restored =
    namespace === "resolved"
      ? yield* projectSessionLocations.restore(sessionId, location).pipe(asError(operation))
      : location;
  if (publish) {
    yield* publishCatalogStatus(sessionId, restored, false).pipe(asError(operation));
    yield* publishCatalogChange(sessionId, restored, false).pipe(asError(operation));
  }
  return restored;
});

const transitionFamily = Effect.fn("ProjectSessions.transitionFamily")(function* (
  family: SessionFamily,
  resolved: boolean,
  location: ProjectSessionLocation,
  operation: string,
) {
  const storage = yield* SessionFamilyStorage;
  yield* storage
    .withMemberLock(
      family.parentSessionId,
      Effect.gen(function* () {
        const current = yield* storage.familyForMember(family.parentSessionId);
        if (!current) return yield* error(operation, "The Session Family no longer exists");
        const state = yield* storage.state();
        const journal = state.transitions.find(
          (item) => item.parentSessionId === current.parentSessionId,
        );
        if (journal && journal.resolved !== resolved)
          return yield* error(
            operation,
            "Complete the pending family lifecycle operation before reversing it",
          );
        const members = familyMembers(current);
        if (resolved) {
          for (const sessionId of members)
            yield* assertResolvable(
              sessionId,
              current.workingDirectory,
              location.sessionDirectory,
              operation,
            );
          if (
            state.turns.some(
              (turn) => turn.parentSessionId === current.parentSessionId && !turn.reported,
            )
          )
            return yield* error(operation, "The Session Family has an undelivered child outcome");
        }
        if (!journal) yield* storage.beginTransition(current.parentSessionId, resolved);
        if (resolved) {
          for (const sessionId of members)
            yield* archiveMember(sessionId, location, operation, false);
          yield* managedWorktrees
            .cleanupResolved(location.workingDirectory, location.sessionDirectory)
            .pipe(asError(operation));
        } else {
          yield* managedWorktrees
            .restoreResolved(location.workingDirectory)
            .pipe(asError(operation));
          for (const sessionId of members)
            yield* restoreMember(sessionId, location, operation, false);
          yield* trustProject(location.workingDirectory).pipe(asError(operation));
        }
        yield* (yield* SessionCatalogChanges)
          .publish({
            _tag: "ProjectSessionsTransitioned",
            sessionIds: members,
            projectPath: location.projectPath,
            workingDirectory: location.workingDirectory,
            resolved,
          })
          .pipe(asError(operation));
        yield* storage.finishTransition(current.parentSessionId);
      }),
    )
    .pipe(asError(operation));
});

const transitionStandalone = Effect.fn("ProjectSessions.transitionStandalone")(function* (
  target: ProjectSessionTarget,
  resolved: boolean,
  operation: string,
) {
  const storage = yield* SessionFamilyStorage;
  yield* storage
    .withMemberLock(
      target.sessionId,
      Effect.gen(function* () {
        if (yield* storage.familyForMember(target.sessionId))
          return yield* error(
            operation,
            "The session became a family parent; retry the family operation",
          );
        const location = yield* findLocation(target, { includeInactive: true }).pipe(
          asError(operation),
        );
        const archive = yield* SessionArchiveStorage;
        const namespace = yield* archive
          .locate(target.sessionId, archiveLocation(location))
          .pipe(asError(operation));
        if (resolved) {
          if (!namespace) return yield* error(operation, "Activate a Draft before resolving it");
          if (namespace === "active")
            yield* assertResolvable(
              target.sessionId,
              location.workingDirectory,
              location.sessionDirectory,
              operation,
            );
          yield* archiveMember(target.sessionId, location, operation);
          yield* managedWorktrees
            .cleanupResolved(location.workingDirectory, location.sessionDirectory)
            .pipe(asError(operation));
        } else {
          if (!namespace)
            return yield* error(operation, "Only a resolved Project Session can be restored");
          yield* managedWorktrees
            .restoreResolved(location.workingDirectory)
            .pipe(asError(operation));
          const restored = yield* restoreMember(target.sessionId, location, operation);
          yield* trustProject(restored.workingDirectory).pipe(asError(operation));
        }
      }),
    )
    .pipe(asError(operation));
});

const transition = Effect.fn("ProjectSessions.transitionLifecycle")(function* (
  target: ProjectSessionTarget,
  resolved: boolean,
  operation: string,
) {
  const storage = yield* SessionFamilyStorage;
  const family = yield* storage.familyForMember(target.sessionId).pipe(asError(operation));
  if (family && family.parentSessionId !== target.sessionId)
    return yield* error(
      operation,
      `Only the Session Family parent can ${resolved ? "resolve" : "restore"} the family`,
    );
  if (!family) return yield* transitionStandalone(target, resolved, operation);
  const location = yield* findLocation(target, { includeInactive: true }).pipe(asError(operation));
  const archive = yield* SessionArchiveStorage;
  const namespace = yield* archive
    .locate(target.sessionId, archiveLocation(location))
    .pipe(asError(operation));
  if (!namespace)
    return yield* error(
      operation,
      resolved
        ? "Activate a Draft before resolving it"
        : "Only a resolved Project Session can be restored",
    );
  // Even when the parent already reached the requested namespace, another
  // member may still need the persisted family journal replayed.
  yield* transitionFamily(family, resolved, location, operation);
});

export const resolve = Effect.fn("ProjectSessions.resolve")((target: ProjectSessionTarget) =>
  transition(target, true, "resolve"),
);

export const restore = Effect.fn("ProjectSessions.restore")((target: ProjectSessionTarget) =>
  transition(target, false, "restore"),
);

/** Replays an incomplete family archive/restore journal during startup. */
export const recoverFamilyTransition = Effect.fn("ProjectSessions.recoverFamilyTransition")(
  function* (parentSessionId: string, resolved: boolean) {
    yield* transition({ sessionId: parentSessionId }, resolved, resolved ? "resolve" : "restore");
  },
);

/** Discovers and resolves every active Project Session in one Working Directory sequentially. */
export const resolveWorkingDirectory = Effect.fn("ProjectSessions.resolveWorkingDirectory")(
  function* (workingDirectory: string) {
    const locations = (yield* projectSessionLocations
      .locations({ includeInactive: true })
      .pipe(asError("resolveWorkingDirectory"))).filter(
      (location) => location.workingDirectory === workingDirectory,
    );
    const [location, ...collisions] = locations;
    if (!location || collisions.length > 0)
      return yield* error(
        "resolveWorkingDirectory",
        !location
          ? `Cake could not find Working Directory ${workingDirectory}`
          : `Working Directory collision detected: ${workingDirectory}`,
      );
    const activeSessions = yield* (yield* PiSessions)
      .catalog({ workingDirectory, sessionDirectory: location.sessionDirectory })
      .pipe(
        Stream.runCollect,
        Effect.map((items) => Array.from(items)),
        asError("resolveWorkingDirectory"),
      );
    const activeIds = new Set(activeSessions.map((session) => session.id));
    const families = yield* (yield* SessionFamilyStorage)
      .list()
      .pipe(asError("resolveWorkingDirectory"));
    const familyByMember = new Map(
      families.flatMap((family) => familyMembers(family).map((id) => [id, family] as const)),
    );
    const targets: Array<{ sessionId: string; sessionIds: string[] }> = [];
    const selected = new Set<string>();
    for (const session of activeSessions) {
      const family = familyByMember.get(session.id);
      const sessionId = family?.parentSessionId ?? session.id;
      if (selected.has(sessionId)) continue;
      selected.add(sessionId);
      targets.push({
        sessionId,
        sessionIds: family ? familyMembers(family).filter((id) => activeIds.has(id)) : [session.id],
      });
    }
    const resolvedSessionIds: string[] = [];
    const failures: WorkingDirectoryResolutionFailure[] = [];
    for (const target of targets) {
      const outcome = yield* resolve({ sessionId: target.sessionId, workingDirectory }).pipe(
        Effect.result,
      );
      if (outcome._tag === "Failure")
        failures.push({ sessionIds: target.sessionIds, message: outcome.failure.message });
      else resolvedSessionIds.push(...target.sessionIds);
    }
    return { projectPath: location.projectPath, workingDirectory, resolvedSessionIds, failures };
  },
);

export const deleteResolved = Effect.fn("ProjectSessions.deleteResolved")(function* (
  sessionId: string,
) {
  const operation = "deleteResolved";
  const families = yield* SessionFamilyStorage;
  if (yield* families.familyForMember(sessionId).pipe(asError(operation)))
    return yield* error(operation, "Individual Session Family members cannot be deleted");
  const archive = yield* SessionArchiveStorage;
  const entry = yield* archive.resolvedProjectEntry(sessionId).pipe(asError(operation));
  if (!entry) return yield* error(operation, "Only resolved project sessions can be deleted");
  yield* artifacts.deleteSession(entry.workingDirectory, sessionId).pipe(asError(operation));
  yield* reviews.deleteSession(entry.workingDirectory, sessionId).pipe(asError(operation));
  yield* archive.deleteResolvedProject(sessionId).pipe(asError(operation));
  yield* (yield* ProjectAccess).forgetSessionLocation(sessionId).pipe(asError(operation));
  yield* forgetProjectSessions([sessionId]).pipe(asError(operation));
  yield* (yield* SessionCatalogChanges)
    .publish({ _tag: "ProjectSessionRemoved", sessionId })
    .pipe(asError(operation));
});

export const deleteProjectSessions = Effect.fn("ProjectSessions.deleteProjectSessions")(function* (
  projectPath: string,
  records: ReadonlyArray<WorktreeRecord>,
) {
  const operation = "deleteProjectSessions";
  const archive = yield* SessionArchiveStorage;
  const sessions = yield* PiSessions;
  const catalogs = yield* SessionCatalogChanges;
  const access = yield* ProjectAccess;
  const configuration = yield* ProjectSessionConfiguration;
  const families = yield* SessionFamilyStorage;
  const workingDirectories = [
    projectPath,
    ...records
      .filter((record) => record.projectPath === projectPath)
      .map((record) => record.worktreePath),
  ];
  const forgotten = new Set<string>();
  const deleteRelated = Effect.fn("ProjectSessions.deleteRelated")(function* (
    workingDirectory: string,
    sessionId: string,
  ) {
    yield* subagents.releaseParent(sessionId).pipe(asError(operation));
    yield* artifacts.deleteSession(workingDirectory, sessionId).pipe(asError(operation));
    yield* reviews.deleteSession(workingDirectory, sessionId).pipe(asError(operation));
    forgotten.add(sessionId);
    yield* catalogs.publish({ _tag: "ProjectSessionRemoved", sessionId }).pipe(asError(operation));
  });
  for (const workingDirectory of workingDirectories) {
    yield* sessions
      .catalog({ workingDirectory, sessionDirectory: configuration.sessionDirectory })
      .pipe(
        Stream.runForEach((session) =>
          Effect.gen(function* () {
            yield* deleteRelated(workingDirectory, session.id);
            yield* archive
              .delete(session.id, {
                cwd: workingDirectory,
                activeRoot: configuration.sessionDirectory,
                resolvedRoot: configuration.resolvedSessionDirectory,
              })
              .pipe(asError(operation));
          }),
        ),
        asError(operation),
      );
  }
  yield* archive.resolvedProjects(projectPath).pipe(
    Stream.runForEach((entry) =>
      Effect.gen(function* () {
        yield* deleteRelated(entry.workingDirectory, entry.sessionId);
        yield* archive.deleteResolvedProject(entry.sessionId).pipe(asError(operation));
      }),
    ),
    asError(operation),
  );
  if (forgotten.size > 0) {
    const sessionIds = [...forgotten];
    yield* forgetProjectSessions(sessionIds).pipe(asError(operation));
    yield* Effect.forEach(sessionIds, (id) =>
      access.forgetSessionLocation(id).pipe(asError(operation)),
    );
  }
  yield* families.removeProject(projectPath).pipe(asError(operation));
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
    if (!project) return yield* error("moveWorkflowSession", "That Project is not registered");
    const workflow = project.workflow ?? defaultProjectWorkflow();
    const destinationStatusId =
      input.destination._tag === "Custom" ? input.destination.statusId : undefined;
    if (
      destinationStatusId !== undefined &&
      ![...state.globalWorkflowStatuses, ...workflow.columns].some(
        (column) => column.id === destinationStatusId,
      )
    )
      return yield* error("moveWorkflowSession", "That custom status no longer exists");
    const target = { sessionId: input.sessionId, workingDirectory: input.workingDirectory };
    const location = yield* findLocation(target, { includeInactive: true }).pipe(
      asError("moveWorkflowSession"),
    );
    if (location.projectPath !== input.projectPath)
      return yield* error("moveWorkflowSession", "That session does not belong to this Project");
    const namespace = yield* (yield* SessionArchiveStorage)
      .locate(input.sessionId, archiveLocation(location))
      .pipe(asError("moveWorkflowSession"));
    if (!namespace)
      return yield* error(
        "moveWorkflowSession",
        input.destination._tag === "Resolved"
          ? "Activate a Draft before resolving it"
          : "Activate the Draft before assigning its workflow status",
      );
    const family = yield* (yield* SessionFamilyStorage)
      .familyForMember(input.sessionId)
      .pipe(asError("moveWorkflowSession"));
    const familyChild = family && family.parentSessionId !== input.sessionId;
    if (familyChild && (namespace === "resolved" || input.destination._tag === "Resolved"))
      return yield* error(
        "moveWorkflowSession",
        "Resolve or restore this Session Family from its parent card",
      );
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
