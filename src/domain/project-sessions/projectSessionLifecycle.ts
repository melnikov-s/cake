import { Effect, Stream } from "effect";
import * as artifacts from "../artifacts/artifacts";
import * as managedWorktrees from "../worktrees/managedWorktrees";
import * as projectSessionLocations from "./projectSessionLocations";
import { resolutionNamespace } from "./projectSessionResolution";
import * as reviews from "../reviews/reviews";
import * as subagents from "../subagents/subagents";
import {
  forgetProjectSessions,
  getState,
  setProjectSessionLabels,
  setSessionUnread,
  trustProject,
} from "../application/application";
import { defaultProjectWorkflow } from "../application/application-data";
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
  familyMember,
  familyMemberIds,
  type SessionFamily,
} from "../../services/storage/SessionFamilyStorage";

const error = (operation: string, message: string) =>
  new ProjectSessionError({ operation, message });

const familyMembers = familyMemberIds;

const familyMemberLocation = Effect.fn("ProjectSessions.familyMemberLocation")(function* (
  family: SessionFamily,
  sessionId: string,
  operation: string,
) {
  const member = familyMember(family, sessionId);
  if (!member) return yield* error(operation, `Session ${sessionId} is not in that family`);
  return yield* findLocation(
    { sessionId, workingDirectory: member.workingDirectory },
    { includeInactive: true },
  ).pipe(asError(operation));
});

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

const archiveAuthority = Effect.fn("ProjectSessions.archiveAuthority")(function* (
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

const restoreAuthority = Effect.fn("ProjectSessions.restoreAuthority")(function* (
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

        const members = yield* Effect.forEach(familyMembers(current), (sessionId) =>
          familyMemberLocation(current, sessionId, operation).pipe(
            Effect.map((location) => ({ sessionId, location })),
          ),
        );
        if (resolved) {
          for (const { sessionId, location } of members)
            yield* assertResolvable(
              sessionId,
              location.workingDirectory,
              location.sessionDirectory,
              operation,
            );
          const memberIds = new Set(members.map(({ sessionId }) => sessionId));
          if (state.turns.some((turn) => memberIds.has(turn.sessionId) && !turn.reported))
            return yield* error(operation, "The Session Family has an undelivered child outcome");
        }
        const rootLocation = yield* familyMemberLocation(
          current,
          current.parentSessionId,
          operation,
        );
        const publishResolution = (yield* SessionCatalogChanges)
          .publish({
            _tag: "ProjectSessionsTransitioned",
            sessions: [
              { sessionId: current.parentSessionId, workingDirectory: current.workingDirectory },
            ],
            projectPath: current.projectPath,
            resolved,
          })
          .pipe(asError(operation));
        if (resolved) {
          for (const { sessionId } of members) {
            if (sessionId === current.parentSessionId) continue;
            yield* subagents.releaseParent(sessionId).pipe(asError(operation));
            yield* setSessionUnread(sessionId, false).pipe(asError(operation));
          }
          // One durable authority change resolves the whole tree. Children stay
          // in place; no member-by-member lifecycle synchronization is needed.
          yield* archiveAuthority(current.parentSessionId, rootLocation, operation, false);
          yield* publishResolution;
          for (const location of [...members]
            .reverse()
            .filter(
              ({ location }, index, all) =>
                all.findIndex(
                  (candidate) => candidate.location.workingDirectory === location.workingDirectory,
                ) === index,
            )
            .map(({ location }) => location))
            yield* managedWorktrees
              .cleanupResolved(location.workingDirectory, location.sessionDirectory)
              .pipe(asError(operation));
        } else {
          const restoredDirectories = new Set<string>();
          for (const { sessionId, location } of members) {
            if (!restoredDirectories.has(location.workingDirectory)) {
              yield* managedWorktrees
                .restoreResolved(location.workingDirectory)
                .pipe(asError(operation));
              restoredDirectories.add(location.workingDirectory);
            }
            // Older installations may have archived child transcripts. Normalize
            // their storage without assigning them any lifecycle state.
            if (sessionId !== current.parentSessionId)
              yield* projectSessionLocations.restore(sessionId, location).pipe(asError(operation));
            yield* trustProject(location.workingDirectory).pipe(asError(operation));
          }
          // Keep the family resolved until every required checkout is ready.
          yield* restoreAuthority(current.parentSessionId, rootLocation, operation, false);
          yield* publishResolution;
        }
      }),
    )
    .pipe(asError(operation));
});

const transitionStandalone = Effect.fn("ProjectSessions.transitionStandalone")(function* (
  target: ProjectSessionTarget,
  resolved: boolean,
  operation: string,
  publish = true,
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
          yield* archiveAuthority(target.sessionId, location, operation, publish);
          yield* managedWorktrees
            .cleanupResolved(location.workingDirectory, location.sessionDirectory)
            .pipe(asError(operation));
        } else {
          if (!namespace)
            return yield* error(operation, "Only a resolved Project Session can be restored");
          yield* managedWorktrees
            .restoreResolved(location.workingDirectory)
            .pipe(asError(operation));
          const restored = yield* restoreAuthority(target.sessionId, location, operation, publish);
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
  publish = true,
) {
  const storage = yield* SessionFamilyStorage;
  const family = yield* storage.familyForMember(target.sessionId).pipe(asError(operation));
  if (!family) return yield* transitionStandalone(target, resolved, operation, publish);
  const location = yield* familyMemberLocation(family, family.parentSessionId, operation);
  const archive = yield* SessionArchiveStorage;
  const namespace = yield* archive
    .locate(family.parentSessionId, archiveLocation(location))
    .pipe(asError(operation));
  if (!namespace)
    return yield* error(
      operation,
      resolved
        ? "Activate a Draft before resolving it"
        : "Only a resolved Project Session can be restored",
    );
  yield* transitionFamily(family, resolved, operation);
});

export const resolve = Effect.fn("ProjectSessions.resolve")((target: ProjectSessionTarget) =>
  transition(target, true, "resolve"),
);

export const restore = Effect.fn("ProjectSessions.restore")((target: ProjectSessionTarget) =>
  transition(target, false, "restore"),
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
    const activeSessionIds = yield* (yield* PiSessions)
      .sessionIds({ workingDirectory, sessionDirectory: location.sessionDirectory })
      .pipe(
        Stream.runCollect,
        Effect.map((items) => Array.from(items)),
        asError("resolveWorkingDirectory"),
      );
    const families = yield* (yield* SessionFamilyStorage)
      .list()
      .pipe(asError("resolveWorkingDirectory"));
    const familyByMember = new Map(
      families.flatMap((family) => familyMembers(family).map((id) => [id, family] as const)),
    );
    const targets: Array<{
      sessionId: string;
      sessionIds: string[];
      workingDirectory: string;
      family: boolean;
    }> = [];
    const selected = new Set<string>();
    for (const activeSessionId of activeSessionIds) {
      const family = familyByMember.get(activeSessionId);
      const sessionId = family?.parentSessionId ?? activeSessionId;
      if (selected.has(sessionId)) continue;
      const sessionIds = family ? familyMembers(family) : [sessionId];
      for (const id of sessionIds) selected.add(id);
      targets.push({
        sessionId,
        sessionIds,
        workingDirectory: family?.workingDirectory ?? workingDirectory,
        family: family !== undefined,
      });
    }
    const resolvedSessionIds: string[] = [];
    const standaloneResolvedIds: string[] = [];
    const failures: WorkingDirectoryResolutionFailure[] = [];
    for (const target of targets) {
      const outcome = yield* transition(
        { sessionId: target.sessionId, workingDirectory: target.workingDirectory },
        true,
        "resolveWorkingDirectory",
        false,
      ).pipe(Effect.result);
      if (outcome._tag === "Failure")
        failures.push({ sessionIds: target.sessionIds, message: outcome.failure.message });
      else {
        resolvedSessionIds.push(...target.sessionIds);
        if (!target.family) standaloneResolvedIds.push(target.sessionId);
      }
    }
    if (standaloneResolvedIds.length > 0)
      yield* (yield* SessionCatalogChanges)
        .publish({
          _tag: "ProjectSessionsTransitioned",
          sessions: standaloneResolvedIds.map((sessionId) => ({ sessionId, workingDirectory })),
          projectPath: location.projectPath,
          resolved: true,
        })
        .pipe(asError("resolveWorkingDirectory"));
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

/** Validates and assigns the ordered labels for one active Project Session. */
export const setWorkflowSessionLabels = Effect.fn("ProjectSessions.setWorkflowSessionLabels")(
  function* (input: {
    readonly projectPath: string;
    readonly sessionId: string;
    readonly workingDirectory: string;
    readonly labelIds: ReadonlyArray<string>;
  }) {
    const state = yield* getState().pipe(asError("setWorkflowSessionLabels"));
    const project = state.projects.find((candidate) => candidate.path === input.projectPath);
    if (!project) return yield* error("setWorkflowSessionLabels", "That Project is not registered");
    const workflow = project.workflow ?? defaultProjectWorkflow();
    const availableIds = new Set(
      [...state.globalSessionLabels, ...workflow.labels].map((label) => label.id),
    );
    if (input.labelIds.some((labelId) => !availableIds.has(labelId)))
      return yield* error("setWorkflowSessionLabels", "A selected label no longer exists");
    const target = { sessionId: input.sessionId, workingDirectory: input.workingDirectory };
    const location = yield* findLocation(target, { includeInactive: true }).pipe(
      asError("setWorkflowSessionLabels"),
    );
    if (location.projectPath !== input.projectPath)
      return yield* error(
        "setWorkflowSessionLabels",
        "That session does not belong to this Project",
      );
    const namespace = yield* resolutionNamespace(input.sessionId, archiveLocation(location)).pipe(
      asError("setWorkflowSessionLabels"),
    );
    if (namespace !== "active")
      return yield* error(
        "setWorkflowSessionLabels",
        "Only active sessions can have their labels changed",
      );
    return yield* setProjectSessionLabels(input.projectPath, input.sessionId, input.labelIds).pipe(
      asError("setWorkflowSessionLabels"),
    );
  },
);
