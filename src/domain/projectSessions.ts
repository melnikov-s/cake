import { Effect, Stream } from "effect";
import * as sessionTerminals from "./sessionTerminals";
import * as subagents from "./subagents";
import type {
  Annotation,
  Attachment,
  ChatConfiguration,
  PiSettingUpdate,
  SessionSummary,
} from "../ipc/session-contract";
import {
  getState,
  observeState,
  refreshProjection,
  setSessionFastMode,
  setSessionUnread,
  trustProject,
} from "./application";
import type { ApplicationState } from "./application-data";
import type { SessionCatalogUpdate } from "./catalog-data";
import { toJsonValue } from "../utils/to-json-value";
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
} from "./project-session-data";
import { SessionArchiveStorage } from "../services/storage/SessionArchiveStorage";
import { reconcileCatalogScans } from "../utils/reconcile-catalog-stream";

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
    Object.assign(projected, { managedWorktree: location.managedWorktree });
  return projected;
};

const archiveLocation = (location: ProjectSessionLocation) => ({
  cwd: location.workingDirectory,
  activeRoot: location.sessionDirectory,
  resolvedRoot: location.resolvedSessionDirectory,
});

const catalogForState = Effect.fn("ProjectSessions.catalogForState")(function* (
  query: ProjectSessionCatalogQuery,
  state: ApplicationState,
) {
  const environment = yield* ProjectSessionEnvironment;
  const sessions = yield* PiSessions;
  const archive = yield* SessionArchiveStorage;
  const locations = yield* environment.locations().pipe(asError("list"));
  const unread = new Set(state.unreadSessionIds);
  return Stream.fromIterable(
    locations.filter((location) => location.projectPath === query.projectPath),
  ).pipe(
    Stream.flatMap(
      (location) => {
        const source: Stream.Stream<SessionSummary, unknown> = query.resolved
          ? archive.resolved(archiveLocation(location))
          : sessions.catalog({
              workingDirectory: location.workingDirectory,
              sessionDirectory: location.sessionDirectory,
            });
        return source.pipe(
          Stream.map((item) => summary(item, location, query.resolved, unread)),
          Stream.catch(() => Stream.empty),
        );
      },
      { concurrency: 8 },
    ),
  );
});

/**
 * A scoped current-first metadata stream. Each application projection refresh interrupts the
 * prior filesystem walk and restarts only this requested project/state group.
 */
export const observeCatalog = Effect.fn("ProjectSessions.observeCatalog")(function* (
  query: ProjectSessionCatalogQuery,
) {
  const changes = yield* observeState();
  const events = reconcileCatalogScans(
    changes,
    (projection) => Stream.unwrap(catalogForState(query, projection.state)),
    {
      key: (session) => session.sessionId,
      equals: sameSessionSummary,
    },
  ).pipe(
    Stream.mapAccum(
      () => 1,
      (revision, reconciliation): readonly [number, ReadonlyArray<SessionCatalogUpdate>] => [
        revision + 1,
        [
          {
            _tag: "Event",
            revision: revision + 1,
            event:
              reconciliation._tag === "Upserted"
                ? { _tag: "Upserted", session: reconciliation.item }
                : { _tag: "Removed", sessionId: reconciliation.id },
          },
        ],
      ],
    ),
  );
  return Stream.make({
    _tag: "Snapshot",
    revision: 1,
    sessions: [],
  } satisfies SessionCatalogUpdate).pipe(Stream.concat(events));
});

const sameSessionSummary = (left: ProjectSessionSummary, right: ProjectSessionSummary) =>
  left.sessionId === right.sessionId &&
  left.title === right.title &&
  left.createdAt === right.createdAt &&
  left.modifiedAt === right.modifiedAt &&
  left.messageCount === right.messageCount &&
  left.parentSessionId === right.parentSessionId &&
  left.resolved === right.resolved &&
  left.unread === right.unread &&
  left.projectPath === right.projectPath &&
  left.projectName === right.projectName &&
  left.workingDirectory === right.workingDirectory &&
  JSON.stringify(left.managedWorktree) === JSON.stringify(right.managedWorktree);

const findLocation = Effect.fn("ProjectSessions.findLocation")(function* (
  target: ProjectSessionTarget,
) {
  const environment = yield* ProjectSessionEnvironment;
  const archive = yield* SessionArchiveStorage;
  const locations = yield* environment.locations().pipe(asError("resolve"));
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
  yield* refreshProjection();
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
  const environment = yield* ProjectSessionEnvironment;
  const restored = yield* environment.restore(target.sessionId, location).pipe(asError("restore"));
  yield* trustProject(restored.workingDirectory).pipe(asError("restore"));
  yield* refreshProjection().pipe(asError("restore"));
});

export const open = Effect.fn("ProjectSessions.open")(function* (target: ProjectSessionTarget) {
  const location = yield* findLocation(target);
  const archive = yield* SessionArchiveStorage;
  const namespace = yield* archive
    .locate(target.sessionId, archiveLocation(location))
    .pipe(asError("open"));
  if (!namespace)
    return yield* new ProjectSessionError({
      operation: "open",
      message: `Cake could not find Project Session ${target.sessionId}`,
    });
  // Selection starts observation in the renderer's Model synchronizer. Opening
  // validates durable transcript state, but resolved sessions remain archived
  // and are projected as read-only previews until an explicit restore or prompt.
});

const isSessionResolved = Effect.fn("ProjectSessions.isSessionResolved")(function* (
  target: ProjectSessionTarget,
) {
  const location = yield* findLocation(target);
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
  const states = yield* observeState();
  const updates = states.pipe(
    Stream.mapEffect(() => isSessionResolved(target)),
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
                    ? refreshProjection()
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
        input.text,
        runtimeAttachments(input.attachments),
        input.renderUserMessageAsMarkdown,
      ),
    ).pipe(asError("prompt")),
  );
  yield* refreshProjection();
  return turnId;
});

export const steer = Effect.fn("ProjectSessions.steer")(function* (
  input: ProjectSessionPromptInput,
) {
  const turnId = TurnId.make(
    yield* withHandle(promptTarget(input), (handle) =>
      handle.steer(input.text, runtimeAttachments(input.attachments)),
    ).pipe(asError("steer")),
  );
  yield* refreshProjection();
  return turnId;
});

export const followUp = Effect.fn("ProjectSessions.followUp")(function* (
  input: ProjectSessionPromptInput,
) {
  const turnId = TurnId.make(
    yield* withHandle(promptTarget(input), (handle) =>
      handle.followUp(input.text, runtimeAttachments(input.attachments)),
    ).pipe(asError("followUp")),
  );
  yield* refreshProjection();
  return turnId;
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
  const normalized = name.trim();
  if (!normalized)
    return yield* new ProjectSessionError({ operation: "rename", message: "Name is required" });
  yield* withHandle(target, (handle) => handle.rename(normalized)).pipe(asError("rename"));
  yield* refreshProjection();
});

export const fork = Effect.fn("ProjectSessions.fork")(function* (input: {
  readonly target: ProjectSessionTarget;
  readonly entryId: string;
  readonly destinationWorkingDirectory?: string;
  readonly resolveSource?: boolean;
}) {
  const source = yield* findLocation(input.target);
  let sessionId: string;
  if (
    input.destinationWorkingDirectory === undefined ||
    input.destinationWorkingDirectory === source.workingDirectory
  ) {
    const result = yield* withHandle(input.target, (handle) => handle.fork(input.entryId)).pipe(
      asError("fork"),
    );
    sessionId = result.sessionId;
  } else {
    const environment = yield* ProjectSessionEnvironment;
    const locations = yield* environment.locations().pipe(asError("fork"));
    const destination = locations.find(
      (item) => item.workingDirectory === input.destinationWorkingDirectory,
    );
    if (!destination)
      return yield* new ProjectSessionError({
        operation: "fork",
        message: "Cake could not find the destination Working Directory",
      });
    if (destination.projectPath !== source.projectPath)
      return yield* new ProjectSessionError({
        operation: "fork",
        message: "The source and destination belong to different Projects",
      });
    sessionId = yield* environment
      .forkToWorkingDirectory({
        sessionId: input.target.sessionId,
        entryId: input.entryId,
        source,
        destination,
      })
      .pipe(asError("fork"));
  }
  if (input.resolveSource) yield* resolve(input.target);
  else yield* refreshProjection();
  return { sessionId };
});

export const handoff = Effect.fn("ProjectSessions.handoff")(function* (input: {
  readonly target: ProjectSessionTarget;
  readonly entryId: string;
  readonly prompt?: string;
  readonly resolveSource?: boolean;
}) {
  const state = yield* getState();
  const inheritFastMode = state.fastModeSessionIds.includes(input.target.sessionId);
  const transition = yield* withHandle(input.target, (handle) =>
    handle.handoff(input.entryId),
  ).pipe(asError("handoff"));
  if (inheritFastMode)
    yield* setSessionFastMode(transition.sessionId, true).pipe(asError("handoff"));
  if (input.prompt?.trim())
    yield* prompt({
      sessionId: transition.sessionId,
      text: input.prompt.trim(),
      attachments: [],
      renderUserMessageAsMarkdown: false,
    });
  if (input.resolveSource) yield* resolve(input.target);
  else yield* refreshProjection();
  return { sessionId: transition.sessionId };
});

export const resolve = Effect.fn("ProjectSessions.resolve")(function* (
  target: ProjectSessionTarget,
) {
  const location = yield* findLocation(target);
  const sessions = yield* PiSessions;
  const status = yield* sessions.currentStatus({
    workingDirectory: location.workingDirectory,
    sessionDirectory: location.sessionDirectory,
    sessionId: target.sessionId,
  });
  if (status?.streaming)
    return yield* new ProjectSessionError({
      operation: "resolve",
      message: "Cake cannot resolve a Project Session while its turn is active",
    });
  if (status && !status.persisted)
    return yield* new ProjectSessionError({
      operation: "resolve",
      message: "Cake cannot resolve an empty Project Session",
    });
  yield* subagents.releaseParent(target.sessionId).pipe(asError("resolve"));
  yield* sessionTerminals.closeSession("project", target.sessionId).pipe(asError("resolve"));
  const environment = yield* ProjectSessionEnvironment;
  yield* environment.archive(target.sessionId, location).pipe(asError("resolve"));
  yield* setSessionUnread(target.sessionId, false).pipe(asError("resolve"));
  return yield* refreshProjection().pipe(asError("resolve"));
});

export const restore = Effect.fn("ProjectSessions.restore")(function* (
  target: ProjectSessionTarget,
) {
  const location = yield* findLocation(target);
  const environment = yield* ProjectSessionEnvironment;
  const restored = yield* environment.restore(target.sessionId, location).pipe(asError("restore"));
  yield* trustProject(restored.workingDirectory).pipe(asError("restore"));
  return yield* refreshProjection().pipe(asError("restore"));
});
