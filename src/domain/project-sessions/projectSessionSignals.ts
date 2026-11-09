import { Effect, Stream } from "effect";
import { isCakeChatSessionId } from "../../contracts/cake-chats/cake-chat-identity";
import { ProjectSessionError } from "../../contracts/project-sessions/project-session-data";
import type { ProjectSessionLocation } from "../../contracts/project-sessions/project-session-data";
import type {
  ProjectSessionSignal,
  ProjectSessionSignalsUpdate,
} from "../../contracts/project-sessions/project-session-signals";
import {
  familyMember,
  familyMemberIds,
} from "../../contracts/session-families/session-family-document";
import { CakeSessionRuntimes } from "../../services/pi/CakeSessionRuntimes";
import { ProjectSessionConfiguration } from "../../services/project-sessions/ProjectSessionConfiguration";
import {
  SessionCatalogChanges,
  type SessionCatalogChange,
} from "../../services/session-catalogs/SessionCatalogChanges";
import { ApplicationState } from "../../services/storage/ApplicationState";
import { SessionArchiveStorage } from "../../services/storage/SessionArchiveStorage";
import { SessionFamilyStorage } from "../../services/storage/SessionFamilyStorage";
import * as projectSessionLocations from "./projectSessionLocations";

const signalFor = Effect.fn("ProjectSessions.signalFor")(function* (
  sessionId: string,
  location: Pick<ProjectSessionLocation, "projectPath" | "workingDirectory" | "sessionDirectory">,
) {
  const sessions = yield* CakeSessionRuntimes;
  const application = yield* ApplicationState;
  const families = yield* (yield* SessionFamilyStorage).state();
  const family = families.families.find((family) => familyMember(family, sessionId));
  const spawn = families.spawnedSessions.find((spawn) => spawn.sessionId === sessionId);
  const status = yield* sessions.currentStatus({ ...location, sessionId });
  return {
    sessionId,
    projectPath: location.projectPath,
    workingDirectory: location.workingDirectory,
    running: status?.streaming ?? false,
    ...(status?.workingStartedAt !== undefined
      ? { workingStartedAt: status.workingStartedAt }
      : null),
    unread: application.snapshot().unreadSessionIds.includes(sessionId),
    ...(status?.recoveryIssue ? { recoveryIssue: status.recoveryIssue } : null),
    ...(status?.latestTurnOutcome ? { latestTurnOutcome: status.latestTurnOutcome } : null),
    ...(spawn?.requester.kind === "cake-chat"
      ? {
          cakeChatLaunch: {
            requesterSessionId: spawn.requester.sessionId,
            ...(spawn.launchedAt ? { launchedAt: spawn.launchedAt } : null),
            ...(spawn.lastReport ? { lastReport: spawn.lastReport } : null),
          },
        }
      : null),
    ...(family
      ? {
          familyParentSessionId: familyMember(family, sessionId)?.parentSessionId ?? sessionId,
          familyChildSessionIds: family.children
            .filter((child) => child.parentSessionId === sessionId)
            .map((child) => child.sessionId),
        }
      : null),
  } satisfies ProjectSessionSignal;
});

/** Filename membership and recovery/activity only. Never calls catalog, catalogEntry or inspect. */
const snapshot = Effect.fn("ProjectSessions.signalsSnapshot")(function* () {
  const runtimes = yield* CakeSessionRuntimes;
  const archive = yield* SessionArchiveStorage;
  const configuration = yield* ProjectSessionConfiguration;
  const locations = [...(yield* projectSessionLocations.locations({ includeInactive: true }))];
  const families = yield* (yield* SessionFamilyStorage).state();
  const registered = new Set(locations.map((location) => location.projectPath));
  const resolvedFamilies = new Set<string>();
  // A family can outlive its retired checkout's registration.
  for (const family of families.families) {
    if (!registered.has(family.projectPath)) continue;
    const namespace = yield* archive.locate(family.parentSessionId, {
      cwd: family.workingDirectory,
      activeRoot: configuration.sessionDirectory,
      resolvedRoot: configuration.resolvedSessionDirectory,
    });
    if (namespace === "resolved")
      for (const id of familyMemberIds(family)) resolvedFamilies.add(id);
    for (const id of familyMemberIds(family)) {
      const member = familyMember(family, id);
      if (
        member &&
        !locations.some((location) => location.workingDirectory === member.workingDirectory)
      )
        locations.push({
          projectPath: family.projectPath,
          projectName: family.projectPath,
          workingDirectory: member.workingDirectory,
          sessionDirectory: configuration.sessionDirectory,
          resolvedSessionDirectory: configuration.resolvedSessionDirectory,
        });
    }
  }
  const signals = new Map<string, ProjectSessionSignal>();
  for (const location of locations) {
    const resolved = yield* archive.resolvedIds({
      cwd: location.workingDirectory,
      activeRoot: location.sessionDirectory,
      resolvedRoot: location.resolvedSessionDirectory,
    });
    const ids = yield* runtimes.sessionIds(location).pipe(Stream.runCollect);
    for (const id of ids) {
      if (!resolved.has(id) && !resolvedFamilies.has(id) && !isCakeChatSessionId(id))
        signals.set(id, yield* signalFor(id, location));
    }
  }
  return {
    _tag: "Snapshot",
    sessions: [...signals.values()],
  } satisfies ProjectSessionSignalsUpdate;
});

/** Always-on summary signals are independent of the disposable Sessions list observation. */
export const observeSignals = Effect.fn("ProjectSessions.observeSignals")(function* () {
  const changes = yield* SessionCatalogChanges;
  const application = yield* ApplicationState;
  const configuration = yield* ProjectSessionConfiguration;
  const projects = application.changes().pipe(
    Stream.map((projection) =>
      JSON.stringify(projection.state.projects.map((project) => project.path)),
    ),
    Stream.changes,
    Stream.map(() => ({ _tag: "RefreshSignals" as const })),
  );
  // Subscribe before the current-first registration stream starts the filename scan.
  return changes.initialThenChanges(Stream.succeed({ _tag: "ObserveProjects" as const })).pipe(
    Stream.flatMap(
      (change): Stream.Stream<SessionCatalogChange | { readonly _tag: "RefreshSignals" }> =>
        change._tag === "ObserveProjects" ? projects : Stream.succeed(change),
      { concurrency: 2 },
    ),
    Stream.mapEffect((change) =>
      Effect.gen(function* () {
        if (
          change._tag === "RefreshSignals" ||
          change._tag === "ProjectSessionChanged" ||
          change._tag === "ProjectSessionsTransitioned"
        )
          return yield* snapshot();
        if (change._tag === "ProjectSessionRemoved")
          return { _tag: "Removed", sessionId: change.sessionId } as const;
        if (change._tag === "ProjectSessionTitleChanged")
          return {
            _tag: "TitleChanged",
            sessionId: change.sessionId,
            title: change.title,
          } as const;
        if (change._tag === "ProjectSessionStatusChanged" && change.resolved)
          return { _tag: "Removed", sessionId: change.sessionId } as const;
        if (
          change._tag === "ProjectSessionActivityChanged" ||
          change._tag === "ProjectSessionStatusChanged"
        ) {
          const archive = yield* SessionArchiveStorage;
          if (
            (yield* archive.locate(change.sessionId, {
              cwd: change.workingDirectory,
              activeRoot: configuration.sessionDirectory,
              resolvedRoot: configuration.resolvedSessionDirectory,
            })) === "resolved"
          )
            return { _tag: "Removed", sessionId: change.sessionId } as const;
          return {
            _tag: "Upserted" as const,
            session: yield* signalFor(change.sessionId, {
              ...change,
              sessionDirectory:
                change._tag === "ProjectSessionActivityChanged"
                  ? change.sessionDirectory
                  : configuration.sessionDirectory,
            }),
          };
        }
        return undefined;
      }),
    ),
    Stream.filter((update) => update !== undefined),
    Stream.mapError(
      (error) =>
        new ProjectSessionError({
          operation: "signals",
          message: error instanceof Error ? error.message : String(error),
        }),
    ),
  );
});
