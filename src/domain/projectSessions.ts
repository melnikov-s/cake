import { Effect, Schema, Stream } from "effect";
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
  setSessionsResolved,
  trustProject,
} from "./application";
import type { ApplicationState } from "./application-data";
import type { SessionCatalogUpdate } from "./catalog-data";
import {
  TurnId,
  acquire as acquireConversation,
  observe as observeConversation,
  projectSnapshot,
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
  type ProjectSessionPromptInput,
  type ProjectSessionSnapshot,
  type ProjectSessionStartInput,
  type ProjectSessionSummary,
  type ProjectSessionTarget,
  type ProjectSessionUpdate,
} from "./project-session-data";

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
  resolvedIds: ReadonlySet<string>,
  unreadIds: ReadonlySet<string>,
): ProjectSessionSummary => {
  const projected: ProjectSessionSummary = {
    sessionId: item.id,
    title: item.title,
    createdAt: item.created,
    modifiedAt: item.modified,
    messageCount: item.messageCount,
    resolved: item.resolved || resolvedIds.has(item.id),
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

const listForState = Effect.fn("ProjectSessions.listForState")(function* (state: ApplicationState) {
  const environment = yield* ProjectSessionEnvironment;
  const sessions = yield* PiSessions;
  const locations = yield* environment.locations().pipe(asError("list"));
  const resolved = new Set(state.resolvedSessionIds);
  const unread = new Set(state.unreadSessionIds);
  const groups = yield* Effect.forEach(
    locations,
    (location) =>
      sessions
        .list({
          workingDirectory: location.workingDirectory,
          sessionDirectory: location.sessionDirectory,
          resolvedSessionDirectory: location.resolvedSessionDirectory,
        })
        .pipe(
          Effect.map((items) => items.map((item) => summary(item, location, resolved, unread))),
          Effect.catchTag("PiSessionError", () => Effect.succeed([])),
        ),
    { concurrency: 8 },
  );
  const byId = new Map<string, ProjectSessionSummary>();
  for (const item of groups.flat()) {
    if (byId.has(item.sessionId))
      return yield* new ProjectSessionError({
        operation: "list",
        message: `Project Session ID collision detected: ${item.sessionId}`,
      });
    byId.set(item.sessionId, item);
  }
  return [...byId.values()].sort((left, right) => right.modifiedAt.localeCompare(left.modifiedAt));
});

export const list = Effect.fn("ProjectSessions.list")(function* () {
  return yield* listForState(yield* getState());
});

/**
 * Current-first catalog observation. Application projection revisions trigger a fresh Pi-owned
 * listing, so reconnect replaces the renderer projection without persisting a catalog copy.
 */
export const observeCatalog = Effect.fn("ProjectSessions.observeCatalog")(function* () {
  const changes = yield* observeState();
  let initialized = false;
  return changes.pipe(
    Stream.mapEffect((projection) =>
      listForState(projection.state).pipe(
        Effect.map((sessions): SessionCatalogUpdate => {
          if (!initialized) {
            initialized = true;
            return { _tag: "Snapshot", revision: projection.revision, sessions };
          }
          return {
            _tag: "Event",
            revision: projection.revision,
            event: { _tag: "Replaced", sessions },
          };
        }),
      ),
    ),
  );
});

const findLocation = Effect.fn("ProjectSessions.findLocation")(function* (
  target: ProjectSessionTarget,
) {
  const environment = yield* ProjectSessionEnvironment;
  const sessions = yield* PiSessions;
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
      sessions
        .list({
          workingDirectory: location.workingDirectory,
          sessionDirectory: location.sessionDirectory,
          resolvedSessionDirectory: location.resolvedSessionDirectory,
        })
        .pipe(
          Effect.map((items) =>
            items.some((item) => item.id === target.sessionId) ? location : undefined,
          ),
          Effect.catchTag("PiSessionError", () => Effect.succeed(undefined)),
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
  const state = yield* getState();
  const sessions = yield* PiSessions;
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
    parts: preview.parts.map((part) => Schema.decodeUnknownSync(Schema.Json)(part)),
    resolved: state.resolvedSessionIds.includes(target.sessionId),
  };
  if (location.managedWorktree !== undefined)
    Object.assign(projected, { managedWorktree: location.managedWorktree });
  return projected;
});

export const open = Effect.fn("ProjectSessions.open")(function* (target: ProjectSessionTarget) {
  let location = yield* findLocation(target);
  const state = yield* getState();
  if (state.resolvedSessionIds.includes(target.sessionId)) {
    const environment = yield* ProjectSessionEnvironment;
    location = yield* environment.restore(target.sessionId, location).pipe(asError("open"));
    yield* setSessionsResolved([target.sessionId], false).pipe(asError("open"));
  }
  const handle = yield* acquireTarget(location, target.sessionId, false);
  return projectSnapshot(yield* handle.snapshot().pipe(asError("open")));
});

export const observe = Effect.fn("ProjectSessions.observe")(function* (
  target: ProjectSessionTarget,
) {
  const location = yield* findLocation(target);
  const state = yield* getState();
  const handle = yield* acquireTarget(location, target.sessionId, target.newSession ?? false);
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
    Stream.mapError(
      (error) => new ProjectSessionError({ operation: "observe", message: error.message }),
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
        resolved: state.resolvedSessionIds.includes(target.sessionId),
        unread: state.unreadSessionIds.includes(target.sessionId),
        conversation: update.snapshot,
      };
      if (location.managedWorktree !== undefined)
        Object.assign(snapshot, { managedWorktree: location.managedWorktree });
      return { _tag: "Snapshot", revision: update.revision, snapshot };
    }),
  );
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
  if (input.newSession !== undefined) Object.assign(target, { newSession: input.newSession });
  return target;
};

export const prompt = Effect.fn("ProjectSessions.prompt")(function* (
  input: ProjectSessionPromptInput,
) {
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
  const transition = yield* withHandle(input.target, (handle) =>
    Effect.gen(function* () {
      const configuration = yield* handle.configuration();
      const handedOff = yield* handle.handoff(input.entryId);
      return { configuration, sessionId: handedOff.sessionId };
    }),
  ).pipe(asError("handoff"));
  const nextTarget = { sessionId: transition.sessionId };
  const configuration = transition.configuration;
  if (configuration)
    yield* withHandle(nextTarget, (handle) => handle.applyConfiguration(configuration)).pipe(
      asError("handoff"),
    );
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
  const snapshot = yield* Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* acquireTarget(location, target.sessionId, false);
      return yield* handle.snapshot().pipe(asError("resolve"));
    }),
  );
  if (snapshot.streaming)
    return yield* new ProjectSessionError({
      operation: "resolve",
      message: "Cake cannot resolve a Project Session while its turn is active",
    });
  if (!snapshot.sessionFile)
    return yield* new ProjectSessionError({
      operation: "resolve",
      message: "Cake cannot resolve an empty Project Session",
    });
  yield* subagents.releaseParent(target.sessionId).pipe(asError("resolve"));
  const environment = yield* ProjectSessionEnvironment;
  yield* environment.archive(target.sessionId, location).pipe(asError("resolve"));
  return yield* setSessionsResolved([target.sessionId], true).pipe(asError("resolve"));
});

export const restore = Effect.fn("ProjectSessions.restore")(function* (
  target: ProjectSessionTarget,
) {
  const location = yield* findLocation(target);
  const environment = yield* ProjectSessionEnvironment;
  const restored = yield* environment.restore(target.sessionId, location).pipe(asError("restore"));
  yield* trustProject(restored.workingDirectory).pipe(asError("restore"));
  return yield* setSessionsResolved([target.sessionId], false).pipe(asError("restore"));
});
