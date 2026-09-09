import { ProjectSessionLifecycle } from "../services/project-sessions/ProjectSessionLifecycle";
import { Effect, Schedule, Stream } from "effect";
import * as managedWorktrees from "./managedWorktrees";
import * as subagents from "./subagents";
import {
  SESSION_TITLE_MAX_LENGTH,
  type Annotation,
  type Attachment,
  type ChatConfiguration,
  type PiSettingUpdate,
  type SessionSummary,
} from "../ipc/session-contract";
import {
  getState,
  setProjectWorkflowSessionStatus,
  setSessionFastMode,
  setSessionUnread,
  trustProject,
} from "./application";
import {
  defaultProjectWorkflow,
  type ApplicationState,
  type ProjectWorkflowSessionDestination,
} from "./application-data";
import type { SessionCatalogUpdate } from "./catalog-data";
import { toJsonValue } from "../utils/to-json-value";
import { compareSessionSummariesForSidebar } from "../utils/session-summary-order";
import {
  TurnId,
  acquire as acquireConversation,
  observe as observeConversation,
  projectPreviewSnapshot,
} from "./conversations";
import { PiSessionError, PiSessions, type PiSessionHandle } from "../services/pi/PiSessions";
import {
  ProjectSessionEnvironment,
  ProjectSessionEnvironmentError,
  type ProjectSessionLocation,
} from "../services/project-sessions/ProjectSessionEnvironment";

export {
  ProjectSessionPromptInput,
  ProjectSessionStartInput,
  ProjectSessionTarget,
  ProjectSessionUpdate,
} from "./project-session-data";
import {
  ProjectSessionError,
  type ProjectSessionPreview,
  type ProjectSessionCatalogQuery,
  type ProjectSessionPromptInput,
  type ProjectSessionSnapshot,
  type ProjectSessionStartInput,
  type ProjectSessionSummary,
  type ProjectSessionTarget,
  type ProjectSessionUpdate,
  type WorkingDirectoryResolutionFailure,
} from "./project-session-data";
import { SessionArchiveStorage } from "../services/storage/SessionArchiveStorage";
import { SessionFamilyStorage, type SessionFamily } from "../services/storage/SessionFamilyStorage";
import { encodeCrossSessionMessage } from "./cross-session-coordination";
import type { ProjectSessionArchiveMetadata } from "../services/storage/SessionArchiveStorage";
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

const asError = (operation: string) =>
  Effect.mapError(
    (error: PiSessionError | ProjectSessionEnvironmentError | unknown) =>
      new ProjectSessionError({
        operation,
        message:
          error instanceof PiSessionError || error instanceof ProjectSessionEnvironmentError
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
  unreadIds: ReadonlySet<string>,
  family?: SessionFamily,
): ProjectSessionSummary => {
  const projected: ProjectSessionSummary = {
    sessionId: entry.sessionId,
    title: entry.title.slice(0, SESSION_TITLE_MAX_LENGTH),
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

const archiveLocation = (location: ProjectSessionLocation) => ({
  cwd: location.workingDirectory,
  activeRoot: location.sessionDirectory,
  resolvedRoot: location.resolvedSessionDirectory,
});

const publishCatalogChange = Effect.fn("ProjectSessions.publishCatalogChange")(function* (
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

const publishTargetCatalogChange = Effect.fn("ProjectSessions.publishTargetCatalogChange")(
  function* (target: ProjectSessionTarget, resolved = false) {
    yield* publishCatalogChange(target.sessionId, yield* findLocation(target), resolved);
  },
);

const publishCatalogStatus = Effect.fn("ProjectSessions.publishCatalogStatus")(function* (
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

const nextCopyTitle = (sourceTitle: string, existingTitles: ReadonlySet<string>) => {
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
  if (query.resolved) {
    const migrationComplete = yield* archive
      .projectMigrationComplete(query.projectPath)
      .pipe(asError("list"));
    let source: ReturnType<typeof archive.resolvedProjects>;
    if (migrationComplete) {
      source = archive.resolvedProjects(query.projectPath);
    } else {
      const environment = yield* ProjectSessionEnvironment;
      const locations = yield* environment
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
      Stream.map((entry) => archivedSummary(entry, unread, familyByMember.get(entry.sessionId))),
      Stream.mapError(
        (error) => new ProjectSessionError({ operation: "list", message: error.message }),
      ),
    );
  }
  const environment = yield* ProjectSessionEnvironment;
  const sessions = yield* PiSessions;
  const locations = yield* environment.locations().pipe(asError("list"));
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
      return entry
        ? ({
            _tag: "Upserted",
            session: archivedSummary(
              entry,
              change.unread ? new Set([change.sessionId]) : new Set(),
              family,
            ),
          } as const)
        : undefined;
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
    return entry
      ? ({
          _tag: "Upserted",
          session: archivedSummary(entry, new Set(state.unreadSessionIds), family),
        } as const)
      : ({ _tag: "Removed", sessionId: change.sessionId } as const);
  }
  if (query.resolved) return undefined;
  const environment = yield* ProjectSessionEnvironment;
  const location = (yield* environment.locations().pipe(asError("catalog"))).find(
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

const findLocation = Effect.fn("ProjectSessions.findLocation")(function* (
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
  const environment = yield* ProjectSessionEnvironment;
  const locations = yield* environment.locations(options).pipe(asError("resolve"));
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

const acquireTarget = Effect.fn("ProjectSessions.acquireTarget")(function* (
  location: ProjectSessionLocation,
  sessionId: string,
  newSession: boolean,
) {
  const environment = yield* ProjectSessionEnvironment;
  const sessions = yield* PiSessions;
  const options = yield* environment
    .runtimeOptions({ location, sessionId, newSession })
    .pipe(asError("acquire"));
  return yield* acquireConversation(sessions, options).pipe(asError("acquire"));
});

export const start = Effect.fn("ProjectSessions.start")(function* (
  input: ProjectSessionStartInput,
) {
  const environment = yield* ProjectSessionEnvironment;
  const locations = yield* environment.locations().pipe(asError("start"));
  const location = locations.find(
    (item) =>
      (input.projectPath === undefined || item.projectPath === input.projectPath) &&
      item.workingDirectory === input.workingDirectory,
  );
  if (!location)
    return yield* new ProjectSessionError({
      operation: "start",
      message: "The Working Directory is not associated with that Project",
    });
  const handle = yield* acquireTarget(location, input.sessionId, true);
  if (input.configuration)
    yield* handle.applyConfiguration(input.configuration).pipe(asError("start"));
  if (input.name?.trim()) yield* handle.rename(input.name.trim()).pipe(asError("start"));
  const turnId = TurnId.make(
    yield* handle
      .prompt(input.text, runtimeAttachments(input.attachments), input.renderUserMessageAsMarkdown)
      .pipe(asError("start")),
  );
  yield* publishCatalogChange(input.sessionId, location, false).pipe(asError("start"));
  return turnId;
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

const restoreIfResolved = Effect.fn("ProjectSessions.restoreIfResolved")(function* (
  target: ProjectSessionTarget,
) {
  const location = yield* findLocation(target);
  const archive = yield* SessionArchiveStorage;
  if (
    (yield* archive
      .locate(target.sessionId, archiveLocation(location))
      .pipe(asError("restore"))) !== "resolved"
  )
    return;
  const family = yield* Effect.flatMap(SessionFamilyStorage, (storage) =>
    storage.familyForMember(target.sessionId),
  ).pipe(asError("restore"));
  if (family)
    return yield* new ProjectSessionError({
      operation: "restore",
      message: `Session Family ${family.familyId} is resolved; restore it explicitly from parent ${family.parentSessionId} before messaging`,
    });
  const environment = yield* ProjectSessionEnvironment;
  const restored = yield* environment.restore(target.sessionId, location).pipe(asError("restore"));
  yield* trustProject(restored.workingDirectory).pipe(asError("restore"));
  yield* publishCatalogStatus(target.sessionId, restored, false).pipe(asError("restore"));
  yield* publishCatalogChange(target.sessionId, restored, false).pipe(asError("restore"));
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

const isSessionResolved = Effect.fn("ProjectSessions.isSessionResolved")(function* (
  target: ProjectSessionTarget,
) {
  const location = yield* findLocation(target);
  const sessions = yield* PiSessions;
  const activeRuntime = yield* sessions.currentStatus({
    workingDirectory: location.workingDirectory,
    sessionDirectory: location.sessionDirectory,
    sessionId: target.sessionId,
  });
  // A newly started Pi runtime can accept its first turn before its JSONL file
  // is discoverable. The live runtime is authoritative that this is an active
  // session; consulting storage first would permanently reject observation.
  if (activeRuntime) return false;
  const archive = yield* SessionArchiveStorage;
  const namespace = yield* archive
    .locate(target.sessionId, archiveLocation(location))
    .pipe(asError("observe"));
  if (!namespace)
    return yield* new ProjectSessionError({
      operation: "observe",
      message: "That session is no longer available",
    });
  return namespace === "resolved";
});

export const observe = Effect.fn("ProjectSessions.observe")(function* (
  target: ProjectSessionTarget,
) {
  const catalogs = yield* SessionCatalogChanges;
  const resolvedStates = catalogs
    .initialThenChanges(
      Stream.fromEffect(isSessionResolved(target)).pipe(
        Stream.map((resolved) => ({ _tag: "InitialResolved" as const, resolved })),
      ),
    )
    .pipe(
      Stream.map((item) =>
        item._tag === "InitialResolved"
          ? item.resolved
          : item._tag === "ProjectSessionStatusChanged" && item.sessionId === target.sessionId
            ? item.resolved
            : undefined,
      ),
      Stream.filter((resolved): resolved is boolean => resolved !== undefined),
    );
  const updates = resolvedStates.pipe(
    Stream.changes,
    Stream.switchMap((resolved) =>
      resolved
        ? Stream.fromEffect(
            Effect.gen(function* () {
              const preview = yield* inspect(target);
              const snapshot: ProjectSessionSnapshot = {
                identity: {
                  _tag: "ProjectSession",
                  sessionId: target.sessionId,
                  projectPath: preview.projectPath,
                  workingDirectory: preview.workingDirectory,
                },
                projectName: (yield* findLocation(target)).projectName,
                resolved: true,
                unread: false,
                conversation: projectPreviewSnapshot({
                  ...preview,
                  workspacePath: preview.workingDirectory,
                }),
              };
              if (preview.managedWorktree !== undefined)
                Object.assign(snapshot, { managedWorktree: preview.managedWorktree });
              return { _tag: "Snapshot", revision: 0, snapshot } satisfies ProjectSessionUpdate;
            }),
          )
        : Stream.unwrap(
            Effect.gen(function* () {
              const location = yield* findLocation(target);
              const state = yield* getState();
              const handle = yield* acquireTarget(location, target.sessionId, false);
              const identity = {
                _tag: "ProjectSession" as const,
                sessionId: target.sessionId,
                projectPath: location.projectPath,
                workingDirectory: location.workingDirectory,
              };
              return observeConversation(handle).pipe(
                Stream.tap((update) =>
                  update._tag === "Event" && update.event._tag === "TurnSettled"
                    ? catalogs.publish({
                        _tag: "ProjectSessionChanged",
                        sessionId: target.sessionId,
                        projectPath: location.projectPath,
                        workingDirectory: location.workingDirectory,
                        resolved: false,
                      })
                    : Effect.void,
                ),
                Stream.map((update): ProjectSessionUpdate => {
                  if (update._tag === "Event")
                    return {
                      _tag: "Event",
                      revision: update.revision,
                      sessionId: target.sessionId,
                      event: update.event,
                    };
                  const snapshot: ProjectSessionSnapshot = {
                    identity,
                    projectName: location.projectName,
                    resolved: false,
                    unread: state.unreadSessionIds.includes(target.sessionId),
                    conversation: update.snapshot,
                  };
                  if (location.managedWorktree !== undefined)
                    Object.assign(snapshot, { managedWorktree: location.managedWorktree });
                  return { _tag: "Snapshot", revision: update.revision, snapshot };
                }),
              );
            }),
          ),
    ),
    Stream.mapError((error) =>
      error instanceof ProjectSessionError
        ? error
        : new ProjectSessionError({
            operation: "observe",
            message: error instanceof Error ? error.message : String(error),
          }),
    ),
    Stream.mapAccum(
      () => 0,
      (revision, update) => {
        const nextRevision = revision + 1;
        const revised: ProjectSessionUpdate = { ...update, revision: nextRevision };
        return [nextRevision, [revised]] as const;
      },
    ),
  );
  return updates;
});

const withHandle = Effect.fn("ProjectSessions.withHandle")(function* <A, E>(
  target: ProjectSessionTarget,
  use: (handle: PiSessionHandle) => Effect.Effect<A, E>,
) {
  const location = yield* findLocation(target);
  const handle = yield* acquireTarget(location, target.sessionId, false);
  return yield* use(handle);
});

/** Delivers an unattended message now, queueing it as a follow-up when the target is busy. */
export const sendAutomatically = Effect.fn("ProjectSessions.sendAutomatically")(function* (
  input: ProjectSessionPromptInput,
) {
  yield* restoreIfResolved(promptTarget(input));
  const turnId = TurnId.make(
    yield* withHandle(promptTarget(input), (handle) =>
      handle
        .snapshot()
        .pipe(
          Effect.flatMap((snapshot) =>
            snapshot.streaming
              ? handle.followUp(
                  input.text,
                  runtimeAttachments(input.attachments),
                  input.renderUserMessageAsMarkdown,
                )
              : handle.prompt(
                  input.text,
                  runtimeAttachments(input.attachments),
                  input.renderUserMessageAsMarkdown,
                ),
          ),
        ),
    ).pipe(asError("sendAutomatically")),
  );
  yield* publishTargetCatalogChange(promptTarget(input));
  return turnId;
});

const withContinuationSource = Effect.fn("ProjectSessions.withContinuationSource")(function* <
  A,
  E,
  R,
>(
  target: ProjectSessionTarget,
  operation: "fork" | "handoff",
  use: (location: ProjectSessionLocation) => Effect.Effect<A, E, R>,
) {
  const source = yield* findLocation(target);
  const archive = yield* SessionArchiveStorage;
  const namespace = yield* archive
    .locate(target.sessionId, archiveLocation(source))
    .pipe(asError(operation));
  if (namespace !== "resolved")
    return { result: yield* use(source), source, sourceWasResolved: false };

  // Resolved transcripts are read-only. Move the source back only for the
  // duration of the copy operation, then archive it again without publishing
  // an intermediate active state. The new transcript stays in the active
  // namespace while the source remains resolved from the user's perspective.
  const environment = yield* ProjectSessionEnvironment;
  const restored = yield* environment.restore(target.sessionId, source).pipe(asError(operation));
  const result = yield* use(restored).pipe(
    Effect.ensuring(
      environment.archive(target.sessionId, restored).pipe(asError(operation), Effect.orDie),
    ),
  );
  return { result, source: restored, sourceWasResolved: true };
});

const runtimeAttachments = (
  values: ProjectSessionPromptInput["attachments"],
): ReadonlyArray<Attachment> =>
  values.map((value): Attachment => {
    switch (value.kind) {
      case "file":
        return { kind: "file", name: value.name, path: value.path };
      case "image":
        return {
          kind: "image",
          name: value.name,
          mimeType: value.mimeType,
          data: value.data,
        };
      case "source":
        return {
          kind: "source",
          name: value.name,
          location: {
            path: value.location.path,
            range: {
              start: { line: value.location.range.start.line },
              end: { line: value.location.range.end.line },
            },
          },
        };
      case "annotation":
        return {
          kind: "annotation",
          annotations: value.annotations.map((annotation) => {
            const projected: Annotation = {
              id: annotation.id,
              messageId: annotation.messageId,
              selectedText: annotation.selectedText,
              startOffset: annotation.startOffset,
              endOffset: annotation.endOffset,
              contextBefore: annotation.contextBefore,
              contextAfter: annotation.contextAfter,
            };
            if (annotation.entryId !== undefined)
              Object.assign(projected, { entryId: annotation.entryId });
            if (annotation.comment !== undefined)
              Object.assign(projected, { comment: annotation.comment });
            return projected;
          }),
        };
    }
  });

const promptTarget = (input: ProjectSessionPromptInput): ProjectSessionTarget => {
  const target: ProjectSessionTarget = { sessionId: input.sessionId };
  if (input.workingDirectory !== undefined)
    Object.assign(target, { workingDirectory: input.workingDirectory });
  return target;
};

export const prompt = Effect.fn("ProjectSessions.prompt")(function* (
  input: ProjectSessionPromptInput,
) {
  yield* restoreIfResolved(promptTarget(input));
  const turnId = TurnId.make(
    yield* withHandle(promptTarget(input), (handle) =>
      handle.prompt(
        input.crossSession ? encodeCrossSessionMessage(input.text, input.crossSession) : input.text,
        runtimeAttachments(input.attachments),
        input.renderUserMessageAsMarkdown,
      ),
    ).pipe(asError("prompt")),
  );
  yield* publishTargetCatalogChange(promptTarget(input));
  return turnId;
});

export const awaitTurnSettled = Effect.fn("ProjectSessions.awaitTurnSettled")(function* (
  target: ProjectSessionTarget,
  turnId: TurnId,
) {
  const location = yield* findLocation(target);
  const sessions = yield* PiSessions;
  const pending = () =>
    sessions
      .currentTurnIds({
        workingDirectory: location.workingDirectory,
        sessionDirectory: location.sessionDirectory,
        sessionId: target.sessionId,
      })
      .pipe(Effect.map((turnIds) => turnIds.includes(turnId)));
  yield* pending().pipe(
    Effect.repeat({ while: (running) => running, schedule: Schedule.spaced("250 millis") }),
  );
});

export const steer = Effect.fn("ProjectSessions.steer")(function* (
  input: ProjectSessionPromptInput,
) {
  const turnId = TurnId.make(
    yield* withHandle(promptTarget(input), (handle) =>
      handle.steer(
        input.crossSession ? encodeCrossSessionMessage(input.text, input.crossSession) : input.text,
        runtimeAttachments(input.attachments),
        input.renderUserMessageAsMarkdown,
      ),
    ).pipe(asError("steer")),
  );
  yield* publishTargetCatalogChange(promptTarget(input));
  return turnId;
});

export const followUp = Effect.fn("ProjectSessions.followUp")(function* (
  input: ProjectSessionPromptInput,
) {
  const turnId = TurnId.make(
    yield* withHandle(promptTarget(input), (handle) =>
      handle.followUp(
        input.crossSession ? encodeCrossSessionMessage(input.text, input.crossSession) : input.text,
        runtimeAttachments(input.attachments),
        input.renderUserMessageAsMarkdown,
      ),
    ).pipe(asError("followUp")),
  );
  yield* publishTargetCatalogChange(promptTarget(input));
  return turnId;
});

export const listQueuedMessages = Effect.fn("ProjectSessions.listQueuedMessages")(function* (
  target: ProjectSessionTarget,
) {
  return yield* withHandle(target, (handle) => handle.listQueuedMessages()).pipe(
    asError("listQueuedMessages"),
  );
});

export const clearQueue = Effect.fn("ProjectSessions.clearQueue")(function* (
  target: ProjectSessionTarget,
) {
  return yield* withHandle(target, (handle) => handle.clearQueue()).pipe(asError("clearQueue"));
});

export const getChangelog = Effect.fn("ProjectSessions.getChangelog")(function* (
  target: ProjectSessionTarget,
) {
  return yield* withHandle(target, (handle) => handle.executeCommand("changelog", "")).pipe(
    asError("getChangelog"),
    Effect.map((markdown) => markdown ?? ""),
  );
});

export const navigate = Effect.fn("ProjectSessions.navigate")(function* (
  target: ProjectSessionTarget,
  entryId: string,
) {
  yield* withHandle(target, (handle) => handle.navigate(entryId)).pipe(asError("navigate"));
});

export const setPiSetting = Effect.fn("ProjectSessions.setPiSetting")(function* (
  target: ProjectSessionTarget,
  update: PiSettingUpdate,
) {
  yield* withHandle(target, (handle) => handle.setPiSetting(update)).pipe(asError("setPiSetting"));
});

export const reload = Effect.fn("ProjectSessions.reload")(function* (target: ProjectSessionTarget) {
  yield* withHandle(target, (handle) => handle.reload()).pipe(asError("reload"));
});

export const login = Effect.fn("ProjectSessions.login")(function* (
  target: ProjectSessionTarget,
  provider: string,
  authType: "api_key" | "oauth",
) {
  yield* withHandle(target, (handle) => handle.login(provider, authType)).pipe(asError("login"));
});

export const logout = Effect.fn("ProjectSessions.logout")(function* (
  target: ProjectSessionTarget,
  provider: string,
) {
  yield* withHandle(target, (handle) => handle.logout(provider)).pipe(asError("logout"));
});

export const compact = Effect.fn("ProjectSessions.compact")(function* (
  target: ProjectSessionTarget,
  instructions?: string,
) {
  yield* withHandle(target, (handle) => handle.compact(instructions)).pipe(asError("compact"));
});

export const editMessage = Effect.fn("ProjectSessions.editMessage")(function* (
  input: ProjectSessionTarget & {
    readonly entryId: string;
    readonly text: ProjectSessionPromptInput["text"];
    readonly attachments: ProjectSessionPromptInput["attachments"];
    readonly renderUserMessageAsMarkdown: ProjectSessionPromptInput["renderUserMessageAsMarkdown"];
  },
) {
  yield* withHandle(input, (handle) =>
    handle.editMessage(
      input.entryId,
      input.text,
      runtimeAttachments(input.attachments),
      input.renderUserMessageAsMarkdown,
    ),
  ).pipe(asError("editMessage"));
});

export const setUserMessageMarkdown = Effect.fn("ProjectSessions.setUserMessageMarkdown")(
  function* (target: ProjectSessionTarget, entryId: string, renderAsMarkdown: boolean) {
    yield* withHandle(target, (handle) =>
      handle.setUserMessageMarkdown(entryId, renderAsMarkdown),
    ).pipe(asError("setUserMessageMarkdown"));
  },
);

export const applyConfiguration = Effect.fn("ProjectSessions.applyConfiguration")(function* (
  target: ProjectSessionTarget,
  configuration: ChatConfiguration,
) {
  yield* withHandle(target, (handle) => handle.applyConfiguration(configuration)).pipe(
    asError("applyConfiguration"),
  );
});

export const setModel = Effect.fn("ProjectSessions.setModel")(function* (
  target: ProjectSessionTarget,
  provider: string,
  modelId: string,
) {
  yield* withHandle(target, (handle) => handle.setModel(provider, modelId)).pipe(
    asError("setModel"),
  );
});

export const setThinkingLevel = Effect.fn("ProjectSessions.setThinkingLevel")(function* (
  target: ProjectSessionTarget,
  level: Parameters<PiSessionHandle["setThinkingLevel"]>[0],
) {
  yield* withHandle(target, (handle) => handle.setThinkingLevel(level)).pipe(
    asError("setThinkingLevel"),
  );
});

export const setFastMode = Effect.fn("ProjectSessions.setFastMode")(function* (
  target: ProjectSessionTarget,
  enabled: boolean,
) {
  yield* withHandle(target, (handle) => handle.setFastMode(enabled)).pipe(asError("setFastMode"));
});

export const abort = Effect.fn("ProjectSessions.abort")(function* (target: ProjectSessionTarget) {
  yield* subagents.abortParentChildren(target.sessionId).pipe(asError("abort"));
  yield* withHandle(target, (handle) => handle.abort()).pipe(asError("abort"));
});

export const rename = Effect.fn("ProjectSessions.rename")(function* (
  target: ProjectSessionTarget,
  name: string,
) {
  const normalized = name.trim().slice(0, SESSION_TITLE_MAX_LENGTH);
  if (!normalized)
    return yield* new ProjectSessionError({ operation: "rename", message: "Name is required" });
  yield* withHandle(target, (handle) => handle.rename(normalized)).pipe(asError("rename"));
});

export const fork = Effect.fn("ProjectSessions.fork")(function* (input: {
  readonly target: ProjectSessionTarget;
  readonly entryId: string;
  readonly destinationWorkingDirectory?: string;
  readonly resolveSource?: boolean;
}) {
  const family = yield* Effect.flatMap(SessionFamilyStorage, (storage) =>
    storage.familyForMember(input.target.sessionId),
  ).pipe(asError("fork"));
  if (family && input.resolveSource)
    return yield* new ProjectSessionError({
      operation: "fork",
      message: "Forks from Session Family members must leave the source family active",
    });
  const continuation = yield* withContinuationSource(input.target, "fork", (source) =>
    Effect.gen(function* () {
      const state = yield* getState();
      const projectCatalogs = yield* Effect.all(
        [false, true].map((resolved) =>
          catalogForState({ projectPath: source.projectPath, resolved }, state).pipe(
            Effect.flatMap(Stream.runCollect),
          ),
        ),
      );
      const projectSessions = projectCatalogs.flatMap((catalog) => Array.from(catalog));
      const sourceTitle =
        projectSessions.find(
          (session) =>
            session.sessionId === input.target.sessionId &&
            session.workingDirectory === source.workingDirectory,
        )?.title ?? input.target.sessionId;
      const forkTitle = nextCopyTitle(
        sourceTitle,
        new Set(projectSessions.map((session) => session.title)),
      );

      let destination = source;
      let sessionId: string;
      if (
        input.destinationWorkingDirectory === undefined ||
        input.destinationWorkingDirectory === source.workingDirectory
      ) {
        const handle = yield* acquireTarget(source, input.target.sessionId, false);
        const result = yield* handle.fork(input.entryId, forkTitle).pipe(asError("fork"));
        sessionId = result.sessionId;
      } else {
        const environment = yield* ProjectSessionEnvironment;
        const locations = yield* environment.locations().pipe(asError("fork"));
        const selectedDestination = locations.find(
          (item) => item.workingDirectory === input.destinationWorkingDirectory,
        );
        if (!selectedDestination)
          return yield* new ProjectSessionError({
            operation: "fork",
            message: "Cake could not find the destination Working Directory",
          });
        if (selectedDestination.projectPath !== source.projectPath)
          return yield* new ProjectSessionError({
            operation: "fork",
            message: "The source and destination belong to different Projects",
          });
        sessionId = yield* environment
          .forkToWorkingDirectory({
            sessionId: input.target.sessionId,
            entryId: input.entryId,
            title: forkTitle,
            source,
            destination: selectedDestination,
          })
          .pipe(asError("fork"));
        destination = selectedDestination;
      }
      return { sessionId, destination };
    }),
  );
  if (input.resolveSource && !continuation.sourceWasResolved) yield* resolve(input.target);
  yield* publishCatalogChange(
    continuation.result.sessionId,
    continuation.result.destination,
    false,
  );
  return { sessionId: continuation.result.sessionId };
});

export const handoff = Effect.fn("ProjectSessions.handoff")(function* (input: {
  readonly target: ProjectSessionTarget;
  readonly entryId: string;
  readonly prompt?: string;
  readonly destinationWorkingDirectory?: string;
  readonly resolveSource?: boolean;
}) {
  const family = yield* Effect.flatMap(SessionFamilyStorage, (storage) =>
    storage.familyForMember(input.target.sessionId),
  ).pipe(asError("handoff"));
  if (family)
    return yield* new ProjectSessionError({
      operation: "handoff",
      message: "Session Family members cannot be handed off or relocated",
    });
  const state = yield* getState();
  const inheritFastMode = state.fastModeSessionIds.includes(input.target.sessionId);
  const continuation = yield* withContinuationSource(input.target, "handoff", (source) =>
    Effect.gen(function* () {
      let destination = source;
      if (
        input.destinationWorkingDirectory !== undefined &&
        input.destinationWorkingDirectory !== source.workingDirectory
      ) {
        const environment = yield* ProjectSessionEnvironment;
        const locations = yield* environment.locations().pipe(asError("handoff"));
        const selectedDestination = locations.find(
          (item) => item.workingDirectory === input.destinationWorkingDirectory,
        );
        if (!selectedDestination)
          return yield* new ProjectSessionError({
            operation: "handoff",
            message: "Cake could not find the destination Working Directory",
          });
        if (selectedDestination.projectPath !== source.projectPath)
          return yield* new ProjectSessionError({
            operation: "handoff",
            message: "The source and destination belong to different Projects",
          });
        destination = selectedDestination;
      }
      const handle = yield* acquireTarget(source, input.target.sessionId, false);
      const result = yield* handle
        .handoff(
          input.entryId,
          destination === source
            ? undefined
            : {
                workingDirectory: destination.workingDirectory,
                sessionRoot: destination.sessionDirectory,
              },
        )
        .pipe(asError("handoff"));
      return { result, destination };
    }),
  );
  if (inheritFastMode)
    yield* setSessionFastMode(continuation.result.result.sessionId, true).pipe(asError("handoff"));
  if (input.prompt?.trim())
    yield* prompt({
      sessionId: continuation.result.result.sessionId,
      workingDirectory: continuation.result.destination.workingDirectory,
      text: input.prompt.trim(),
      attachments: [],
      renderUserMessageAsMarkdown: false,
    });
  if (input.resolveSource && !continuation.sourceWasResolved) yield* resolve(input.target);
  yield* publishCatalogChange(
    continuation.result.result.sessionId,
    continuation.result.destination,
    false,
  );
  return { sessionId: continuation.result.result.sessionId };
});

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
        const environment = yield* ProjectSessionEnvironment;
        yield* subagents.releaseParent(target.sessionId).pipe(asError("resolve"));
        yield* environment.archive(target.sessionId, location).pipe(asError("resolve"));
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
    const environment = yield* ProjectSessionEnvironment;
    const locations = (yield* environment
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
        const environment = yield* ProjectSessionEnvironment;
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
        const restored = yield* environment
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
