import { Effect, Stream } from "effect";
import { SESSION_TITLE_MAX_LENGTH, type SessionSummary } from "../ipc/session-contract";
import { getState } from "./application";
import type { ApplicationState } from "./application-data";
import type { SessionCatalogUpdate } from "./catalog-data";
import { toJsonValue } from "../utils/to-json-value";
import { compareSessionSummariesForSidebar } from "../utils/session-summary-order";
import { PiSessionError, PiSessions } from "../services/pi/PiSessions";
import type { ProjectSessionLocation } from "./project-session-data";
import * as projectSessionLocations from "./projectSessionLocations";
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
} from "../services/storage/SessionArchiveStorage";
import { SessionFamilyStorage, type SessionFamily } from "../services/storage/SessionFamilyStorage";
import {
  SessionCatalogChanges,
  type SessionCatalogChange,
} from "../services/session-catalogs/SessionCatalogChanges";

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
  item: SessionSummary,
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
  Object.assign(projected, {
    familyId: family.familyId,
    familyParentSessionId: family.parentSessionId,
  });
  if (projected.sessionId === family.parentSessionId)
    Object.assign(projected, {
      familyChildSessionIds: family.children.map((child) => child.sessionId),
    });
  else {
    const order = family.children.findIndex((child) => child.sessionId === projected.sessionId);
    if (order >= 0) Object.assign(projected, { familyChildOrder: order });
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

export const catalogForState = Effect.fn("ProjectSessions.catalogForState")(function* (
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
    );
  }
  const sessions = yield* PiSessions;
  const locations = yield* projectSessionLocations.locations().pipe(asError("list"));
  const locationCatalogs = Stream.fromIterable(
    locations.filter((location) => location.projectPath === query.projectPath),
  ).pipe(
    Stream.flatMap(
      (location) => {
        const source: Stream.Stream<SessionSummary, unknown> = sessions.catalog({
          workingDirectory: location.workingDirectory,
          sessionDirectory: location.sessionDirectory,
        });
        return source.pipe(
          Stream.map((item) => summary(item, location, false, unread, familyByMember.get(item.id))),
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
  );
});

const catalogEventForChange = Effect.fn("ProjectSessions.catalogEventForChange")(function* (
  query: ProjectSessionCatalogQuery,
  change: SessionCatalogChange,
) {
  if (change._tag === "ProjectSessionRemoved")
    return { _tag: "Removed", sessionId: change.sessionId } as const;
  if (change._tag === "ProjectSessionStatusChanged") {
    if (change.projectPath !== query.projectPath) return undefined;
    if (change.resolved !== query.resolved)
      return { _tag: "Removed", sessionId: change.sessionId } as const;
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
  const sessions = yield* PiSessions;
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
});

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
        ? Effect.succeed<typeof item | ProjectSessionCatalogEvent | undefined>(item)
        : catalogEventForChange(query, item),
    ),
    Stream.filter(
      (item): item is InitialCatalogItem | ProjectSessionCatalogEvent => item !== undefined,
    ),
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
  const archive = yield* SessionArchiveStorage;
  const sessions = yield* PiSessions;
  const namespace = yield* archive
    .locate(target.sessionId, archiveLocation(location))
    .pipe(asError("inspect"));
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
    const sessions = yield* PiSessions;
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
  // Selection starts observation in the renderer's Model observer. Opening
  // validates durable transcript state, but resolved sessions remain archived
  // and are projected as read-only previews until an explicit restore or prompt.
  if (namespace)
    yield* publishCatalogChange(target.sessionId, location, namespace === "resolved").pipe(
      asError("open"),
    );
});
