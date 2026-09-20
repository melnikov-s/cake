import { Effect, Stream } from "effect";
import { SESSION_TITLE_MAX_LENGTH, type PiSessionSummary } from "../../ipc/session-contract";
import { getState } from "../application/application";
import type { ApplicationState } from "../application/application-data";
import type { SessionCatalogUpdate } from "../application/catalog-data";
import { toJsonValue } from "../../utils/to-json-value";
import { compareSessionSummariesForSidebar } from "../../utils/session-summary-order";
import { PiSessionError, CakeSessionRuntimes } from "../../services/pi/CakeSessionRuntimes";
import type { ProjectSessionLocation } from "./project-session-data";
import * as projectSessionLocations from "./projectSessionLocations";
import { resolutionNamespace } from "./projectSessionResolution";
import { ProjectSessionConfiguration } from "../../services/project-sessions/ProjectSessionConfiguration";
import {
  ProjectSessionError,
  type ProjectSessionPreview,
  type ProjectSessionCatalogQuery,
  type ProjectSessionSummary,
  type ProjectSessionTarget,
} from "./project-session-data";
import {
  SessionArchiveStorage,
  type ProjectSessionArchiveMetadata,
} from "../../services/storage/SessionArchiveStorage";
import {
  SessionFamilyStorage,
  familyChildren,
  familyDepth,
  familyMember,
  familyMemberIds,
  type SessionFamily,
} from "../../services/storage/SessionFamilyStorage";
import {
  SessionCatalogChanges,
  type SessionCatalogChange,
} from "../../services/session-catalogs/SessionCatalogChanges";

type ProjectSessionCatalogEvent = Extract<SessionCatalogUpdate, { _tag: "Event" }>["event"];
type InitialCatalogItem = {
  readonly _tag: "InitialBatch";
  readonly sessions: ProjectSessionSummary[];
  readonly hasMore?: boolean;
};
type CatalogStreamItem = InitialCatalogItem | ProjectSessionCatalogEvent;

export const asError = (operation: string) =>
  Effect.mapError(
    (error: PiSessionError | unknown) =>
      new ProjectSessionError({
        operation,
        message:
          error instanceof PiSessionError
            ? error.message
            : error instanceof Error
              ? error.message
              : String(error),
      }),
  );

const summary = (
  item: PiSessionSummary,
  location: ProjectSessionLocation,
  resolved: boolean,
  unreadIds: ReadonlySet<string>,
  family?: SessionFamily,
): ProjectSessionSummary => {
  const projected: ProjectSessionSummary = {
    sessionId: item.id,
    title: item.title,
    createdAt: item.created,
    modifiedAt: item.modified,
    messageCount: item.messageCount,
    resolved,
    unread: unreadIds.has(item.id),
    projectPath: location.projectPath,
    projectName: location.projectName,
    workingDirectory: location.workingDirectory,
  };
  if (item.parentSessionId !== undefined)
    Object.assign(projected, { parentSessionId: item.parentSessionId });
  if (location.managedWorktree !== undefined)
    Object.assign(projected, {
      worktreeName: location.managedWorktree.branch.replace(/^agent\//, ""),
    });
  applyFamilySummary(projected, family);
  return projected;
};

function applyFamilySummary(projected: ProjectSessionSummary, family?: SessionFamily) {
  if (!family) return;
  const member = familyMember(family, projected.sessionId);
  const depth = familyDepth(family, projected.sessionId);
  if (!member || depth === undefined) return;
  Object.assign(projected, {
    familyId: family.familyId,
    familyParentSessionId: member.parentSessionId ?? member.sessionId,
    familyChildSessionIds: familyChildren(family, member.sessionId).map((child) => child.sessionId),
    familyDepth: depth,
  });
  if (member.parentSessionId) {
    const order = familyChildren(family, member.parentSessionId).findIndex(
      (sibling) => sibling.sessionId === member.sessionId,
    );
    Object.assign(projected, { familyChildOrder: order });
  }
}

const archivedStorageLocation = (entry: ProjectSessionArchiveMetadata) => ({
  cwd: entry.workingDirectory,
  activeRoot: entry.activeRoot,
  resolvedRoot: entry.resolvedRoot,
});

const archivedLocation = (entry: ProjectSessionArchiveMetadata): ProjectSessionLocation => {
  const location: ProjectSessionLocation = {
    projectPath: entry.projectPath,
    projectName: entry.projectName,
    workingDirectory: entry.workingDirectory,
    sessionDirectory: entry.activeRoot,
    resolvedSessionDirectory: entry.resolvedRoot,
  };
  if (entry.worktreeName !== undefined)
    Object.assign(location, { worktreeName: entry.worktreeName });
  return location;
};

const archivedSummary = (
  entry: ProjectSessionArchiveMetadata,
  title: string,
  unreadIds: ReadonlySet<string>,
  family?: SessionFamily,
): ProjectSessionSummary => {
  const projected: ProjectSessionSummary = {
    sessionId: entry.sessionId,
    title: title.slice(0, SESSION_TITLE_MAX_LENGTH),
    createdAt: entry.createdAt,
    modifiedAt: entry.modifiedAt,
    messageCount: 0,
    resolved: true,
    unread: unreadIds.has(entry.sessionId),
    projectPath: entry.projectPath,
    projectName: entry.projectName,
    workingDirectory: entry.workingDirectory,
  };
  if (entry.worktreeName) Object.assign(projected, { worktreeName: entry.worktreeName });
  applyFamilySummary(projected, family);
  return projected;
};

export const archiveLocation = (location: ProjectSessionLocation) => ({
  cwd: location.workingDirectory,
  activeRoot: location.sessionDirectory,
  resolvedRoot: location.resolvedSessionDirectory,
});

export const publishCatalogChange = Effect.fn("ProjectSessions.publishCatalogChange")(function* (
  sessionId: string,
  location: ProjectSessionLocation,
  resolved: boolean,
) {
  const catalogs = yield* SessionCatalogChanges;
  yield* catalogs.publish({
    _tag: "ProjectSessionChanged",
    sessionId,
    projectPath: location.projectPath,
    workingDirectory: location.workingDirectory,
    resolved,
  });
});

export const publishTargetCatalogChange = Effect.fn("ProjectSessions.publishTargetCatalogChange")(
  function* (target: ProjectSessionTarget, resolved = false) {
    yield* publishCatalogChange(target.sessionId, yield* findLocation(target), resolved);
  },
);

export const publishCatalogStatus = Effect.fn("ProjectSessions.publishCatalogStatus")(function* (
  sessionId: string,
  location: ProjectSessionLocation,
  resolved: boolean,
) {
  const catalogs = yield* SessionCatalogChanges;
  const state = yield* getState();
  yield* catalogs.publish({
    _tag: "ProjectSessionStatusChanged",
    sessionId,
    projectPath: location.projectPath,
    workingDirectory: location.workingDirectory,
    resolved,
    unread: state.unreadSessionIds.includes(sessionId),
  });
});

const ACTIVE_CATALOG_LOCATION_CONCURRENCY = 32;
const COPY_TITLE_SUFFIX = /^(.*) \((\d+)\)$/;

const formatCopyTitle = (baseTitle: string, copyNumber: number) => {
  const suffix = ` (${copyNumber})`;
  return `${baseTitle.slice(0, SESSION_TITLE_MAX_LENGTH - suffix.length)}${suffix}`;
};

const copyTitleParts = (title: string) => {
  const match = COPY_TITLE_SUFFIX.exec(title);
  if (!match) return undefined;
  const [, baseTitle = "", rawCopyNumber = ""] = match;
  const copyNumber = Number(rawCopyNumber);
  return Number.isSafeInteger(copyNumber) && copyNumber > 0 ? { baseTitle, copyNumber } : undefined;
};

export const nextCopyTitle = (sourceTitle: string, existingTitles: ReadonlySet<string>) => {
  const sourceParts = copyTitleParts(sourceTitle);
  const baseTitle = sourceParts?.baseTitle ?? sourceTitle;
  let copyNumber = (sourceParts?.copyNumber ?? 0) + 1;
  for (const title of existingTitles) {
    const parts = copyTitleParts(title);
    if (
      parts &&
      parts.copyNumber >= copyNumber &&
      formatCopyTitle(baseTitle, parts.copyNumber) === title
    )
      copyNumber = parts.copyNumber + 1;
  }
  return formatCopyTitle(baseTitle, copyNumber);
};

const familyCatalog = Effect.fn("ProjectSessions.familyCatalog")(function* (
  family: SessionFamily,
  state: ApplicationState,
) {
  const configuration = yield* ProjectSessionConfiguration;
  const archive = yield* SessionArchiveStorage;
  const namespace = yield* resolutionNamespace(family.parentSessionId, {
    cwd: family.workingDirectory,
    activeRoot: configuration.sessionDirectory,
    resolvedRoot: configuration.resolvedSessionDirectory,
  }).pipe(asError("catalog"));
  const resolved = namespace === "resolved";
  const unread = new Set(state.unreadSessionIds);
  const sessions = yield* CakeSessionRuntimes;
  const locations = yield* projectSessionLocations
    .locations({ includeInactive: true })
    .pipe(asError("catalog"));
  const summaries = yield* Effect.forEach(familyMemberIds(family), (sessionId) =>
    Effect.gen(function* () {
      const member = familyMember(family, sessionId);
      if (!member) return undefined;
      const entry = yield* archive.resolvedProjectEntry(sessionId).pipe(asError("catalog"));
      if (entry) {
        const item = yield* archive
          .resolvedEntry(sessionId, archivedStorageLocation(entry))
          .pipe(asError("catalog"));
        return { ...archivedSummary(entry, item?.title ?? sessionId, unread, family), resolved };
      }
      // Family membership retains routing even after an isolated checkout is retired.
      const location: ProjectSessionLocation = locations.find(
        (candidate) =>
          candidate.workingDirectory === member.workingDirectory &&
          candidate.projectPath === family.projectPath,
      ) ?? {
        projectPath: family.projectPath,
        projectName:
          state.projects.find((project) => project.path === family.projectPath)?.name ??
          family.projectPath,
        workingDirectory: member.workingDirectory,
        sessionDirectory: configuration.sessionDirectory,
        resolvedSessionDirectory: configuration.resolvedSessionDirectory,
      };
      const item = yield* sessions
        .catalogEntry(
          {
            workingDirectory: member.workingDirectory,
            sessionDirectory: configuration.sessionDirectory,
          },
          sessionId,
        )
        .pipe(asError("catalog"));
      return item ? summary(item, location, resolved, unread, family) : undefined;
    }),
  );
  return {
    resolved,
    sessions: summaries.filter((item): item is ProjectSessionSummary => item !== undefined),
  };
});

const catalogForState = Effect.fn("ProjectSessions.catalogForState")(function* (
  query: ProjectSessionCatalogQuery,
  state: ApplicationState,
) {
  const archive = yield* SessionArchiveStorage;
  const familyStorage = yield* SessionFamilyStorage;
  const families = yield* familyStorage.list().pipe(asError("list"));
  const familyByMember = new Map(
    families.flatMap((family) => [
      [family.parentSessionId, family] as const,
      ...family.children.map((child) => [child.sessionId, family] as const),
    ]),
  );
  const unread = new Set(state.unreadSessionIds);
  const familySummaries = Stream.fromIterable(
    families.filter((family) => family.projectPath === query.projectPath),
  ).pipe(
    Stream.mapEffect((family) => familyCatalog(family, state)),
    Stream.filter((catalog) => catalog.resolved === query.resolved),
    Stream.flatMap((catalog) => Stream.fromIterable(catalog.sessions)),
  );
  if (query.resolved) {
    const migrationComplete = yield* archive
      .projectMigrationComplete(query.projectPath)
      .pipe(asError("list"));
    let source: ReturnType<typeof archive.resolvedProjects>;
    if (migrationComplete) {
      source = archive.resolvedProjects(query.projectPath);
    } else {
      const locations = yield* projectSessionLocations
        .locations({ includeInactive: true })
        .pipe(asError("list"));
      const projectName =
        state.projects.find((project) => project.path === query.projectPath)?.name ??
        query.projectPath;
      source = archive.migrateProject(
        query.projectPath,
        projectName,
        locations
          .filter((location) => location.projectPath === query.projectPath)
          .map((location) => {
            const migrationSource = { location: archiveLocation(location) };
            return location.managedWorktree
              ? {
                  ...migrationSource,
                  worktreeName: location.managedWorktree.branch.replace(/^agent\//, ""),
                }
              : migrationSource;
          }),
      );
    }
    return source.pipe(
      Stream.filter((entry) => !familyByMember.has(entry.sessionId)),
      Stream.mapEffect((entry) =>
        archive
          .resolvedEntry(entry.sessionId, archivedStorageLocation(entry))
          .pipe(
            Effect.map((item) =>
              archivedSummary(
                entry,
                item?.title ?? entry.sessionId,
                unread,
                familyByMember.get(entry.sessionId),
              ),
            ),
          ),
      ),
      Stream.mapError(
        (error) => new ProjectSessionError({ operation: "list", message: error.message }),
      ),
      Stream.concat(familySummaries),
    );
  }
  const sessions = yield* CakeSessionRuntimes;
  const locations = yield* projectSessionLocations.locations().pipe(asError("list"));
  const locationCatalogs = Stream.fromIterable(
    locations.filter((location) => location.projectPath === query.projectPath),
  ).pipe(
    Stream.flatMap(
      (location) => {
        const source: Stream.Stream<PiSessionSummary, unknown> = sessions.catalog({
          workingDirectory: location.workingDirectory,
          sessionDirectory: location.sessionDirectory,
        });
        return source.pipe(
          Stream.filter((item) => !familyByMember.has(item.id)),
          Stream.map((item) => summary(item, location, false, unread)),
          Stream.catch(() => Stream.empty),
        );
      },
      { concurrency: ACTIVE_CATALOG_LOCATION_CONCURRENCY },
    ),
  );
  // Project-root and Managed Worktree catalogs form one initial projection. Scan
  // their lightweight metadata concurrently before publishing one coherent snapshot.
  return Stream.fromEffect(Stream.runCollect(locationCatalogs)).pipe(
    Stream.flatMap(Stream.fromIterable),
    Stream.concat(familySummaries),
  );
});

type ProjectSessionChanged = Extract<SessionCatalogChange, { _tag: "ProjectSessionChanged" }>;

const catalogEventForSessionChange = Effect.fn("ProjectSessions.catalogEventForSessionChange")(
  function* (query: ProjectSessionCatalogQuery, change: ProjectSessionChanged) {
    if (change.projectPath !== query.projectPath) return undefined;
    const state = yield* getState();
    const archive = yield* SessionArchiveStorage;
    if (change.resolved) {
      if (!query.resolved) return undefined;
      const entry = yield* archive.resolvedProjectEntry(change.sessionId).pipe(asError("catalog"));
      const family = yield* Effect.flatMap(SessionFamilyStorage, (storage) =>
        storage.familyForMember(change.sessionId),
      ).pipe(asError("catalog"));
      if (!entry) return { _tag: "Removed", sessionId: change.sessionId } as const;
      const item = yield* archive
        .resolvedEntry(entry.sessionId, archivedStorageLocation(entry))
        .pipe(asError("catalog"));
      return {
        _tag: "Upserted",
        session: archivedSummary(
          entry,
          item?.title ?? entry.sessionId,
          new Set(state.unreadSessionIds),
          family,
        ),
      } as const;
    }
    if (query.resolved) return undefined;
    const location = (yield* projectSessionLocations.locations().pipe(asError("catalog"))).find(
      (candidate) => candidate.workingDirectory === change.workingDirectory,
    );
    if (!location || location.projectPath !== query.projectPath) return undefined;
    const sessions = yield* CakeSessionRuntimes;
    const family = yield* Effect.flatMap(SessionFamilyStorage, (storage) =>
      storage.familyForMember(change.sessionId),
    ).pipe(asError("catalog"));
    const item = yield* sessions.catalogEntry(
      {
        workingDirectory: location.workingDirectory,
        sessionDirectory: location.sessionDirectory,
      },
      change.sessionId,
    );
    return item
      ? ({
          _tag: "Upserted",
          session: summary(item, location, false, new Set(state.unreadSessionIds), family),
        } as const)
      : ({ _tag: "Removed", sessionId: change.sessionId } as const);
  },
);

const catalogEventForChange = Effect.fn("ProjectSessions.catalogEventForChange")(function* (
  query: ProjectSessionCatalogQuery,
  change: SessionCatalogChange,
) {
  if (change._tag === "ProjectSessionRemoved")
    return { _tag: "Removed", sessionId: change.sessionId } as const;
  if (
    (change._tag === "ProjectSessionStatusChanged" || change._tag === "ProjectSessionChanged") &&
    change.projectPath === query.projectPath
  ) {
    const family = yield* (yield* SessionFamilyStorage)
      .familyForMember(change.sessionId)
      .pipe(asError("catalog"));
    if (family) {
      const catalog = yield* familyCatalog(family, yield* getState());
      return catalog.resolved === query.resolved
        ? ({ _tag: "UpsertedBatch", sessions: catalog.sessions } as const)
        : ({ _tag: "RemovedBatch", sessionIds: familyMemberIds(family) } as const);
    }
  }
  if (change._tag === "ProjectSessionStatusChanged") {
    if (change.projectPath !== query.projectPath) return undefined;
    if (change.resolved !== query.resolved)
      return {
        _tag: "StatusChanged" as const,
        sessionId: change.sessionId,
        resolved: change.resolved,
        unread: change.unread,
      };
    if (query.resolved) {
      const archive = yield* SessionArchiveStorage;
      const family = yield* Effect.flatMap(SessionFamilyStorage, (storage) =>
        storage.familyForMember(change.sessionId),
      ).pipe(asError("catalog"));
      const entry = yield* archive.resolvedProjectEntry(change.sessionId).pipe(asError("catalog"));
      if (!entry) return undefined;
      const item = yield* archive
        .resolvedEntry(entry.sessionId, archivedStorageLocation(entry))
        .pipe(asError("catalog"));
      return {
        _tag: "Upserted",
        session: archivedSummary(
          entry,
          item?.title ?? entry.sessionId,
          change.unread ? new Set([change.sessionId]) : new Set(),
          family,
        ),
      } as const;
    }
    return {
      _tag: "StatusChanged" as const,
      sessionId: change.sessionId,
      resolved: change.resolved,
      unread: change.unread,
    };
  }
  if (change._tag !== "ProjectSessionChanged") return undefined;
  return yield* catalogEventForSessionChange(query, change);
});

const catalogEventsForTransition = Effect.fn("ProjectSessions.catalogEventsForTransition")(
  function* (
    query: ProjectSessionCatalogQuery,
    change: Extract<SessionCatalogChange, { _tag: "ProjectSessionsTransitioned" }>,
  ) {
    const events: ProjectSessionCatalogEvent[] = [];
    if (change.projectPath !== query.projectPath) return events;
    const families = yield* (yield* SessionFamilyStorage).list().pipe(asError("catalog"));
    const affected = new Set(change.sessions.map(({ sessionId }) => sessionId));
    const affectedFamilies = families.filter((family) =>
      familyMemberIds(family).some((id) => affected.has(id)),
    );
    const state = yield* getState();
    const catalogs = yield* Effect.forEach(affectedFamilies, (family) =>
      familyCatalog(family, state).pipe(Effect.map((catalog) => ({ family, catalog }))),
    );
    const removedIds: string[] = [];
    const summaries: ProjectSessionSummary[] = [];
    for (const { family, catalog } of catalogs) {
      if (catalog.resolved === query.resolved) summaries.push(...catalog.sessions);
      else removedIds.push(...familyMemberIds(family));
    }
    for (const { sessionId, workingDirectory } of change.sessions) {
      if (affectedFamilies.some((family) => familyMember(family, sessionId))) continue;
      if (change.resolved !== query.resolved) {
        removedIds.push(sessionId);
        continue;
      }
      const event = yield* catalogEventForSessionChange(query, {
        _tag: "ProjectSessionChanged",
        sessionId,
        workingDirectory,
        projectPath: change.projectPath,
        resolved: change.resolved,
      });
      if (event?._tag === "Upserted") summaries.push(event.session);
      else if (event?._tag === "Removed") removedIds.push(event.sessionId);
    }
    if (removedIds.length > 0) events.push({ _tag: "RemovedBatch", sessionIds: removedIds });
    if (summaries.length > 0) events.push({ _tag: "UpsertedBatch", sessions: summaries });
    return events;
  },
);

/** A scoped metadata stream: one lazy initial scan followed by targeted session mutations. */
export const observeCatalog = Effect.fn("ProjectSessions.observeCatalog")(function* (
  query: ProjectSessionCatalogQuery,
) {
  const catalogs = yield* SessionCatalogChanges;
  const state = yield* getState();
  const catalog = Stream.unwrap(catalogForState(query, state));
  const initial = Stream.fromEffect(
    catalog.pipe(
      Stream.runCollect,
      Effect.map((sessions) => {
        const collected = Array.from(sessions);
        if (query.resolved) collected.sort(compareSessionSummariesForSidebar);
        return { _tag: "InitialBatch" as const, sessions: collected };
      }),
    ),
  );
  return catalogs.initialThenChanges(initial).pipe(
    Stream.mapEffect((item) =>
      item._tag === "InitialBatch"
        ? Effect.succeed<ReadonlyArray<CatalogStreamItem>>([item])
        : item._tag === "ProjectSessionsTransitioned"
          ? catalogEventsForTransition(query, item)
          : catalogEventForChange(query, item).pipe(Effect.map((event) => (event ? [event] : []))),
    ),
    Stream.flatMap(Stream.fromIterable),
    Stream.mapError((error) =>
      error instanceof ProjectSessionError
        ? error
        : new ProjectSessionError({
            operation: "catalog",
            message: error instanceof Error ? error.message : String(error),
          }),
    ),
    Stream.mapAccum<
      { revision: number; initialized: boolean },
      CatalogStreamItem,
      SessionCatalogUpdate
    >(
      () => ({ revision: 0, initialized: false }),
      (state, item) => {
        const revision = state.revision + 1;
        if (item._tag === "InitialBatch") {
          const update: SessionCatalogUpdate = state.initialized
            ? {
                _tag: "Event",
                revision,
                event: { _tag: "UpsertedBatch", sessions: item.sessions },
              }
            : item.hasMore === undefined
              ? { _tag: "Snapshot", revision, sessions: item.sessions }
              : {
                  _tag: "Snapshot",
                  revision,
                  sessions: item.sessions,
                  hasMore: item.hasMore,
                };
          return [{ revision, initialized: true }, [update]];
        }
        return [{ revision, initialized: true }, [{ _tag: "Event", revision, event: item }]];
      },
    ),
  );
});

export const findLocation = Effect.fn("ProjectSessions.findLocation")(function* (
  target: ProjectSessionTarget,
  options?: { readonly includeInactive?: boolean },
) {
  const archive = yield* SessionArchiveStorage;
  const archived = yield* archive
    .resolvedProjectEntry(target.sessionId)
    .pipe(asError("findLocation"));
  if (
    archived &&
    (target.workingDirectory === undefined || target.workingDirectory === archived.workingDirectory)
  )
    return archivedLocation(archived);
  const family = yield* (yield* SessionFamilyStorage)
    .familyForMember(target.sessionId)
    .pipe(asError("findLocation"));
  const member = family && familyMember(family, target.sessionId);
  if (
    family &&
    member &&
    (target.workingDirectory === undefined || target.workingDirectory === member.workingDirectory)
  ) {
    const registered = (yield* projectSessionLocations
      .locations({ includeInactive: true })
      .pipe(asError("findLocation"))).find(
      (candidate) =>
        candidate.workingDirectory === member.workingDirectory &&
        candidate.projectPath === family.projectPath,
    );
    if (registered) return registered;
    const configuration = yield* ProjectSessionConfiguration;
    const state = yield* getState();
    return {
      projectPath: family.projectPath,
      projectName:
        state.projects.find((project) => project.path === family.projectPath)?.name ??
        family.projectPath,
      workingDirectory: member.workingDirectory,
      sessionDirectory: configuration.sessionDirectory,
      resolvedSessionDirectory: configuration.resolvedSessionDirectory,
    } satisfies ProjectSessionLocation;
  }
  const locations = yield* projectSessionLocations.locations(options).pipe(asError("resolve"));
  const candidates = target.workingDirectory
    ? locations.filter((item) => item.workingDirectory === target.workingDirectory)
    : locations;
  const [directCandidate, ...directCollisions] = candidates;
  if (target.workingDirectory && directCandidate && directCollisions.length === 0)
    return directCandidate;
  const matches = yield* Effect.forEach(
    candidates,
    (location) =>
      archive.locate(target.sessionId, archiveLocation(location)).pipe(
        Effect.map((namespace) => (namespace ? location : undefined)),
        Effect.catchTag("SessionArchiveStorageError", () => Effect.succeed(undefined)),
      ),
    { concurrency: 8 },
  );
  const found = matches.filter((item): item is ProjectSessionLocation => item !== undefined);
  const [location, ...collisions] = found;
  if (!location || collisions.length > 0)
    return yield* new ProjectSessionError({
      operation: "resolve",
      message: !location
        ? `Cake could not find Project Session ${target.sessionId}`
        : `Project Session ID collision detected: ${target.sessionId}`,
    });
  return location;
});

export const inspect = Effect.fn("ProjectSessions.inspect")(function* (
  target: ProjectSessionTarget,
) {
  const location = yield* findLocation(target);
  const sessions = yield* CakeSessionRuntimes;
  const namespace = yield* resolutionNamespace(target.sessionId, archiveLocation(location)).pipe(
    asError("inspect"),
  );
  const preview = yield* sessions
    .inspect({
      workingDirectory: location.workingDirectory,
      sessionId: target.sessionId,
      sessionDirectory: location.sessionDirectory,
      resolvedSessionDirectory: location.resolvedSessionDirectory,
    })
    .pipe(asError("inspect"));
  const projected: ProjectSessionPreview = {
    sessionId: preview.sessionId,
    projectPath: location.projectPath,
    workingDirectory: location.workingDirectory,
    sessionFile: preview.sessionFile,
    parts: preview.parts.map(toJsonValue),
    resolved: namespace === "resolved",
  };
  const firstUserMessage = preview.parts.find(
    (part) => part.kind === "text" && part.role === "user",
  );
  if (firstUserMessage?.kind === "text")
    Object.assign(projected, { firstUserMessage: firstUserMessage.text });
  if (preview.currentModel !== undefined) Object.assign(projected, { model: preview.currentModel });
  if (location.managedWorktree !== undefined)
    Object.assign(projected, { managedWorktree: location.managedWorktree });
  return projected;
});

export const open = Effect.fn("ProjectSessions.open")(function* (target: ProjectSessionTarget) {
  const location = yield* findLocation(target);
  const archive = yield* SessionArchiveStorage;
  const namespace = yield* archive
    .locate(target.sessionId, archiveLocation(location))
    .pipe(asError("open"));
  if (!namespace) {
    const sessions = yield* CakeSessionRuntimes;
    const activeRuntime = yield* sessions.currentStatus({
      sessionId: target.sessionId,
      workingDirectory: location.workingDirectory,
      sessionDirectory: location.sessionDirectory,
    });
    if (!activeRuntime)
      return yield* new ProjectSessionError({
        operation: "open",
        message: `Cake could not find Project Session ${target.sessionId}`,
      });
  }
  // Selection starts observation in the renderer's Model observer. Opening only
  // validates durable transcript state; catalog mutations publish their own changes.
});
