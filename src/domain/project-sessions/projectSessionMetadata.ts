import { Effect, Stream } from "effect";
import {
  SESSION_TITLE_MAX_LENGTH,
  type PiSessionSummary,
} from "../../contracts/conversations/session-contract";
import { getState } from "../application/application";
import type { ApplicationState } from "../../contracts/application/application-data";
import type { SessionCatalogUpdate } from "../../contracts/application/catalog-data";
import { toJsonValue } from "../../utils/to-json-value";
import { compareSessionSummariesForSidebar } from "../../utils/session-summary-order";
import { PiSessionError, CakeSessionRuntimes } from "../../services/pi/CakeSessionRuntimes";
import type { ProjectSessionLocation } from "../../contracts/project-sessions/project-session-data";
import * as projectSessionLocations from "./projectSessionLocations";
import type { discover } from "./sessionReferences";
import type { SavedDraft } from "../../contracts/project-sessions/saved-draft-data";
import { isCakeChatSessionId } from "../../contracts/cake-chats/cake-chat-identity";
import { resolutionNamespace } from "./projectSessionResolution";
import { ProjectSessionConfiguration } from "../../services/project-sessions/ProjectSessionConfiguration";
import {
  ProjectSessionError,
  type ProjectSessionPreview,
  type ProjectSessionCatalogQuery,
  type ProjectSessionSummary,
  type ProjectSessionTarget,
} from "../../contracts/project-sessions/project-session-data";
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
  type SpawnedSession,
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
  running: boolean,
  family?: SessionFamily,
  spawn?: SpawnedSession,
  recoveryIssue?: string,
  latestTurnOutcome?: ProjectSessionSummary["latestTurnOutcome"],
): ProjectSessionSummary => {
  const projected: ProjectSessionSummary = {
    sessionId: item.id,
    title: item.title,
    createdAt: item.created,
    modifiedAt: item.modified,
    messageCount: item.messageCount,
    resolved,
    unread: unreadIds.has(item.id),
    running,
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
  if (recoveryIssue !== undefined) Object.assign(projected, { recoveryIssue });
  if (latestTurnOutcome !== undefined) Object.assign(projected, { latestTurnOutcome });
  applyFamilySummary(projected, family);
  if (spawn?.requester.kind === "cake-chat")
    Object.assign(projected, {
      cakeChatLaunch: {
        requesterSessionId: spawn.requester.sessionId,
        ...(spawn.launchedAt ? { launchedAt: spawn.launchedAt } : null),
        ...(spawn.lastReport ? { lastReport: spawn.lastReport } : null),
      },
    });
  return projected;
};

/** Cake Chat launch records keyed by session, for active catalog summaries. */
const spawnedSessions = Effect.fn("ProjectSessions.spawnedSessions")(function* () {
  const storage = yield* SessionFamilyStorage;
  const state = yield* storage.state().pipe(asError("catalog"));
  return new Map(state.spawnedSessions.map((spawn) => [spawn.sessionId, spawn] as const));
});

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
    running: false,
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

/** Shared metadata belongs to one projection, never a retained cross-request cache. */
const catalogMetadata = Effect.fn("ProjectSessions.catalogMetadata")(function* () {
  const familyState = yield* (yield* SessionFamilyStorage).state().pipe(asError("catalog"));
  const locations = yield* Effect.cached(
    projectSessionLocations.locations({ includeInactive: true }).pipe(asError("catalog")),
  );
  return {
    families: familyState.families,
    spawns: new Map(familyState.spawnedSessions.map((spawn) => [spawn.sessionId, spawn])),
    locations,
  };
});

type CatalogMetadata = Effect.Success<ReturnType<typeof catalogMetadata>>;

const familyCatalog = Effect.fn("ProjectSessions.familyCatalog")(function* (
  family: SessionFamily,
  state: ApplicationState,
  metadata: CatalogMetadata,
  resolvedFilter?: boolean,
) {
  const configuration = yield* ProjectSessionConfiguration;
  const archive = yield* SessionArchiveStorage;
  // The supplied family already identifies the lifecycle authority. Do not reload
  // the complete family state to rediscover that authority for every root.
  const namespace = yield* archive
    .locate(family.parentSessionId, {
      cwd: family.workingDirectory,
      activeRoot: configuration.sessionDirectory,
      resolvedRoot: configuration.resolvedSessionDirectory,
    })
    .pipe(asError("catalog"));
  const resolved = namespace === "resolved";
  if (resolvedFilter !== undefined && resolved !== resolvedFilter)
    return { resolved, sessions: [] };
  const unread = new Set(state.unreadSessionIds);
  const sessions = yield* CakeSessionRuntimes;
  const locations = yield* metadata.locations;
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
      const status = yield* sessions.currentStatus({ ...location, sessionId });
      return item
        ? summary(
            item,
            location,
            resolved,
            unread,
            status?.streaming ?? false,
            family,
            metadata.spawns.get(sessionId),
            status?.recoveryIssue,
            status?.latestTurnOutcome,
          )
        : undefined;
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
  const metadata = yield* catalogMetadata();
  const families = metadata.families;
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
    Stream.mapEffect((family) => familyCatalog(family, state, metadata, query.resolved)),
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
      const locations = yield* metadata.locations;
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
  const spawns = metadata.spawns;
  // Checkout retirement does not retire Pi history. Include inactive routes so
  // active transcripts left by an interrupted/older restore survive reconnect.
  const locations = yield* metadata.locations;
  const familyIds = [...familyByMember.keys()];
  const locationCatalogs = Stream.fromIterable(
    locations.filter((location) => location.projectPath === query.projectPath),
  ).pipe(
    Stream.flatMap(
      (location) => {
        const source: Stream.Stream<PiSessionSummary, unknown> = Stream.unwrap(
          archive.resolvedIds(archiveLocation(location)).pipe(
            Effect.map((resolvedIds) =>
              sessions.catalog({
                workingDirectory: location.workingDirectory,
                sessionDirectory: location.sessionDirectory,
                // Skip family titles before opening files; the family projection
                // below is their sole reader, including cross-checkout members.
                excludedSessionIds: [...resolvedIds, ...familyIds],
              }),
            ),
          ),
        );
        return source.pipe(
          Stream.filter((item) => !familyByMember.has(item.id)),
          Stream.mapEffect((item) =>
            sessions
              .currentStatus({ ...location, sessionId: item.id })
              .pipe(
                Effect.map((status) =>
                  summary(
                    item,
                    location,
                    false,
                    unread,
                    status?.streaming ?? false,
                    undefined,
                    spawns.get(item.id),
                    status?.recoveryIssue,
                    status?.latestTurnOutcome,
                  ),
                ),
              ),
          ),
          // An unreadable checkout must not hide the Project's other locations.
          Stream.catch((cause) =>
            Stream.fromEffect(
              Effect.logWarning(
                "Skipping unreadable Project Session location",
                location.workingDirectory,
                cause,
              ),
            ).pipe(Stream.drain),
          ),
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

/** One authoritative projection for catalog reconciliation and exact-ID recovery. */
const discoverSessionAt = Effect.fn("ProjectSessions.discoverSessionAt")(function* (
  location: ProjectSessionLocation,
  sessionId: string,
) {
  const state = yield* getState();
  const archive = yield* SessionArchiveStorage;
  const family = yield* (yield* SessionFamilyStorage)
    .familyForMember(sessionId)
    .pipe(asError("catalog"));
  const namespace = yield* resolutionNamespace(sessionId, archiveLocation(location)).pipe(
    asError("catalog"),
  );
  const entry = yield* archive.resolvedProjectEntry(sessionId).pipe(asError("catalog"));
  if (entry) {
    const item = yield* archive
      .resolvedEntry(sessionId, archivedStorageLocation(entry))
      .pipe(asError("catalog"));
    return {
      ...archivedSummary(entry, item?.title ?? sessionId, new Set(state.unreadSessionIds), family),
      resolved: family ? namespace === "resolved" : true,
    };
  }
  const sessions = yield* CakeSessionRuntimes;
  const item = yield* sessions
    .catalogEntry(
      { workingDirectory: location.workingDirectory, sessionDirectory: location.sessionDirectory },
      sessionId,
    )
    .pipe(asError("catalog"));
  if (!item) return undefined;
  const status = yield* sessions.currentStatus({ ...location, sessionId });
  return summary(
    item,
    location,
    namespace === "resolved",
    new Set(state.unreadSessionIds),
    status?.streaming ?? false,
    family,
    (yield* spawnedSessions()).get(sessionId),
    status?.recoveryIssue,
    status?.latestTurnOutcome,
  );
});

/** One invocation's authoritative discovery evidence; no runtime or retained transcript cache.
 * Keep routes through filtering instead of rediscovering each identity across every checkout.
 */
export const listing = Effect.fn("ProjectSessions.listing")(function* (
  discovery: Effect.Success<ReturnType<typeof discover>>,
  inScope: (projectPath: string) => boolean,
) {
  const state = yield* getState();
  const configuration = yield* ProjectSessionConfiguration;
  const runtimes = yield* CakeSessionRuntimes;
  const archive = yield* SessionArchiveStorage;
  const unread = new Set(state.unreadSessionIds);
  const families = new Map(
    discovery.familyState.families.flatMap((family) =>
      familyMemberIds(family).map((id) => [id, family] as const),
    ),
  );
  const spawns = new Map(
    discovery.familyState.spawnedSessions.map((spawn) => [spawn.sessionId, spawn]),
  );
  const drafts = new Map(
    discovery.drafts
      .filter((draft) => draft.status !== "activated")
      .map((draft) => [draft.sessionId, draft]),
  );
  const key = (location: ProjectSessionLocation) =>
    JSON.stringify([
      location.projectPath,
      location.workingDirectory,
      location.sessionDirectory,
      location.resolvedSessionDirectory,
    ]);
  const knownLocations = new Map(discovery.locations.map((location) => [key(location), location]));
  const groups = new Map<string, { location: ProjectSessionLocation; ids: Set<string> }>();
  const resolutionLocations = new Map<string, ProjectSessionLocation>();
  const routes = new Map<string, ProjectSessionLocation>();
  const fallbackDrafts: SavedDraft[] = [];
  for (const { sessionId } of discovery.roster) {
    if (isCakeChatSessionId(sessionId)) continue;
    const entry = discovery.archives.get(sessionId);
    const family = families.get(sessionId);
    const member = family && familyMember(family, sessionId);
    const candidates = discovery.routes.get(sessionId) ?? [];
    const location = entry
      ? archivedLocation(entry)
      : family && member
        ? (discovery.locations.find(
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
          })
        : candidates.length === 1
          ? candidates[0]
          : undefined;
    const draft = drafts.get(sessionId);
    if (draft && inScope(draft.projectPath) && (!location || inScope(location.projectPath)))
      fallbackDrafts.push(draft);
    if (!location || !inScope(location.projectPath)) continue;
    const routeKey = key(location);
    routes.set(sessionId, location);
    const group = groups.get(routeKey) ?? { location, ids: new Set<string>() };
    group.ids.add(sessionId);
    groups.set(routeKey, group);
    // Family resolution belongs to the root, even when a child's transcript is elsewhere.
    const resolutionLocation = family
      ? { ...location, workingDirectory: family.workingDirectory }
      : location;
    resolutionLocations.set(key(resolutionLocation), resolutionLocation);
  }
  const resolutions = new Map<string, ReadonlySet<string>>();
  for (const [routeKey, location] of resolutionLocations) {
    const resolved = yield* archive
      .resolvedIds(archiveLocation(location))
      .pipe(Effect.catch(() => Effect.succeed(undefined)));
    if (!resolved) continue;
    const knownLocation = knownLocations.get(routeKey);
    const ids = knownLocation ? discovery.idsByLocation.get(knownLocation) : undefined;
    // resolvedIds may migrate old archived files back in place after discovery.
    // Re-enumerate only when that snapshot cannot account for a resolved identity.
    const present =
      ids && [...resolved].every((id) => ids.has(id))
        ? ids
        : yield* Stream.runCollect(runtimes.sessionIds(location)).pipe(
            Effect.map((items) => new Set(items)),
            Effect.catch(() => Effect.succeed(undefined)),
          );
    if (present) resolutions.set(routeKey, new Set([...resolved].filter((id) => present.has(id))));
  }
  const sessions: Array<ProjectSessionSummary & { readonly savedDraft?: SavedDraft }> = [];
  for (const [routeKey, { location, ids }] of groups) {
    const knownLocation = knownLocations.get(routeKey);
    const knownIds = knownLocation && discovery.idsByLocation.get(knownLocation);
    const items = yield* Stream.runCollect(
      runtimes.catalog({
        workingDirectory: location.workingDirectory,
        sessionDirectory: location.sessionDirectory,
        excludedSessionIds: knownIds ? [...knownIds].filter((id) => !ids.has(id)) : [],
      }),
    ).pipe(Effect.catch(() => Effect.succeed<PiSessionSummary[]>([])));
    const byId = new Map(items.map((item) => [item.id, item]));
    const seen = new Set<string>();
    const duplicates = new Set<string>();
    for (const item of items) {
      if (seen.has(item.id)) duplicates.add(item.id);
      seen.add(item.id);
    }
    for (const sessionId of ids) {
      const family = families.get(sessionId);
      const entry = discovery.archives.get(sessionId);
      let item = byId.get(sessionId);
      if (duplicates.has(sessionId)) continue;
      if (entry && !item) {
        // A missing archived file keeps its ID title; a corrupt/unreadable file must
        // still fail exact lookup rather than being silently revived by the bulk stream.
        const exact = yield* Effect.result(runtimes.catalogEntry(location, sessionId));
        if (exact._tag === "Failure") continue;
        item = exact.success;
      }
      if (!entry && !item) continue;
      const namespaceLocation = family
        ? { ...location, workingDirectory: family.workingDirectory }
        : location;
      const resolution = resolutions.get(key(namespaceLocation));
      if (!resolution) continue;
      const resolved = resolution.has(family?.parentSessionId ?? sessionId);
      if (entry) {
        sessions.push({
          ...archivedSummary(entry, item?.title ?? sessionId, unread, family),
          resolved: family ? resolved : true,
        });
      } else if (item) {
        const projected = yield* runtimes.currentStatus({ ...location, sessionId }).pipe(
          Effect.map((status) =>
            summary(
              item,
              location,
              resolved,
              unread,
              status?.streaming ?? false,
              family,
              spawns.get(sessionId),
              status?.recoveryIssue,
              status?.latestTurnOutcome,
            ),
          ),
          Effect.catch(() => Effect.succeed(undefined)),
        );
        if (projected) sessions.push(projected);
      }
    }
  }
  const found = new Set(sessions.map((session) => session.sessionId));
  for (const draft of fallbackDrafts) {
    const project = state.projects.find((project) => project.path === draft.projectPath);
    if (found.has(draft.sessionId) || !project) continue;
    sessions.push({
      sessionId: draft.sessionId,
      title: draft.title,
      createdAt: draft.createdAt,
      modifiedAt: draft.modifiedAt,
      messageCount: 0,
      resolved: draft.resolved,
      unread: false,
      running: false,
      projectPath: draft.projectPath,
      projectName: project.name,
      workingDirectory: draft.workingDirectory,
      savedDraft: draft,
    });
  }
  return { sessions, routes };
});

/** Keep the authoritative route with the summary for multi-step, request-local inspection. */
export const lookupWithLocation = Effect.fn("ProjectSessions.lookupWithLocation")(function* (
  target: ProjectSessionTarget,
) {
  let location = yield* findLocation(target).pipe(
    Effect.catchTag("ProjectSessionError", (error) =>
      target.workingDirectory !== undefined && error.operation === "resolve"
        ? findLocation({ sessionId: target.sessionId })
        : Effect.fail(error),
    ),
  );
  let session = yield* discoverSessionAt(location, target.sessionId);
  if (!session && target.workingDirectory !== undefined) {
    location = yield* findLocation({ sessionId: target.sessionId });
    session = yield* discoverSessionAt(location, target.sessionId);
  }
  if (!session)
    return yield* new ProjectSessionError({
      operation: "lookup",
      message: `Cake could not find Project Session ${target.sessionId}`,
    });
  return { session, location };
});

/** Explicit lookup never relies on the renderer's disposable catalog or loads a runtime. */
export const lookup = Effect.fn("ProjectSessions.lookup")(function* (target: ProjectSessionTarget) {
  return (yield* lookupWithLocation(target)).session;
});

const catalogEventForSessionChange = Effect.fn("ProjectSessions.catalogEventForSessionChange")(
  function* (query: ProjectSessionCatalogQuery, change: ProjectSessionChanged) {
    if (change.projectPath !== query.projectPath) return undefined;
    const archive = yield* SessionArchiveStorage;
    const entry = yield* archive.resolvedProjectEntry(change.sessionId).pipe(asError("catalog"));
    const location = entry
      ? archivedLocation(entry)
      : (yield* projectSessionLocations.locations().pipe(asError("catalog"))).find(
          (candidate) => candidate.workingDirectory === change.workingDirectory,
        );
    if (!location || location.projectPath !== query.projectPath) return undefined;
    const session = yield* discoverSessionAt(location, change.sessionId);
    return session && session.resolved === query.resolved
      ? ({ _tag: "Upserted", session } as const)
      : ({ _tag: "Removed", sessionId: change.sessionId } as const);
  },
);

const catalogEventForChange = Effect.fn("ProjectSessions.catalogEventForChange")(function* (
  query: ProjectSessionCatalogQuery,
  change: SessionCatalogChange,
) {
  if (change._tag === "ProjectSessionActivityChanged") {
    if (change.projectPath !== query.projectPath || query.resolved) return undefined;
    const sessions = yield* CakeSessionRuntimes;
    const status = yield* sessions.currentStatus(change);
    const modifiedAt = yield* sessions.currentModifiedAt(change);
    const state = yield* getState();
    return {
      _tag: "ActivityChanged",
      sessionId: change.sessionId,
      running: status?.streaming ?? false,
      recoveryIssue: status?.recoveryIssue ?? null,
      latestTurnOutcome: status?.latestTurnOutcome ?? null,
      unread: state.unreadSessionIds.includes(change.sessionId),
      ...(modifiedAt ? { modifiedAt } : null),
    } as const;
  }
  if (change._tag === "ProjectSessionRemoved")
    return { _tag: "Removed", sessionId: change.sessionId } as const;
  if (change._tag === "ProjectSessionTitleChanged")
    return change.projectPath === query.projectPath && !query.resolved
      ? ({ _tag: "TitleChanged", sessionId: change.sessionId, title: change.title } as const)
      : undefined;
  if (
    (change._tag === "ProjectSessionStatusChanged" || change._tag === "ProjectSessionChanged") &&
    change.projectPath === query.projectPath
  ) {
    const metadata = yield* catalogMetadata();
    const family = metadata.families.find((family) => familyMember(family, change.sessionId));
    if (family) {
      const catalog = yield* familyCatalog(family, yield* getState(), metadata, query.resolved);
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
    const metadata = yield* catalogMetadata();
    const affected = new Set(change.sessions.map(({ sessionId }) => sessionId));
    const affectedFamilies = metadata.families.filter((family) =>
      familyMemberIds(family).some((id) => affected.has(id)),
    );
    const state = yield* getState();
    const catalogs = yield* Effect.forEach(affectedFamilies, (family) =>
      familyCatalog(family, state, metadata, query.resolved).pipe(
        Effect.map((catalog) => ({ family, catalog })),
      ),
    );
    const removedIds: string[] = [];
    const summaries: ProjectSessionSummary[] = [];
    for (const { family, catalog } of catalogs) {
      if (catalog.resolved === query.resolved) summaries.push(...catalog.sessions);
      else removedIds.push(...familyMemberIds(family));
    }
    for (const { sessionId, workingDirectory } of change.sessions) {
      if (affectedFamilies.some((family) => familyMember(family, sessionId))) continue;
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
  // A retired checkout remains a valid history route, not a new session binding.
  const locations = yield* projectSessionLocations
    .locations({ includeInactive: true })
    .pipe(asError("resolve"));
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

/** The caller must retain a route from findLocation/lookupWithLocation in this request. */
export const inspectAt = Effect.fn("ProjectSessions.inspectAt")(function* (
  location: ProjectSessionLocation,
  sessionId: string,
  options?: { readonly includeParts?: boolean },
) {
  const sessions = yield* CakeSessionRuntimes;
  const namespace = yield* resolutionNamespace(sessionId, archiveLocation(location)).pipe(
    asError("inspect"),
  );
  const preview = yield* sessions
    .inspect(
      {
        workingDirectory: location.workingDirectory,
        sessionId,
        sessionDirectory: location.sessionDirectory,
      },
      options,
    )
    .pipe(asError("inspect"));
  const projected: ProjectSessionPreview = {
    sessionId: preview.sessionId,
    projectPath: location.projectPath,
    workingDirectory: location.workingDirectory,
    sessionFile: preview.sessionFile,
    parts: preview.parts.map(toJsonValue),
    ...(preview.contextMetadata ? { contextMetadata: preview.contextMetadata } : null),
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

export const inspect = Effect.fn("ProjectSessions.inspect")(function* (
  target: ProjectSessionTarget,
  options?: { readonly includeParts?: boolean },
) {
  return yield* inspectAt(yield* findLocation(target), target.sessionId, options);
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
