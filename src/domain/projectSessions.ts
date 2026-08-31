import { Effect, Schema, Stream } from "effect";
import type {
  Annotation,
  Attachment,
  ChatConfiguration,
  SessionSummary,
} from "../ipc/session-contract";
import { getState, setSessionsResolved, trustProject } from "./application";
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
  ProjectSessionCreateInput,
  ProjectSessionPromptInput,
  ProjectSessionSummary,
  ProjectSessionTarget,
  ProjectSessionUpdate,
} from "./project-session-data";
import {
  ProjectSessionError,
  type ProjectSessionCreateInput,
  type ProjectSessionPreview,
  type ProjectSessionPromptInput,
  type ProjectSessionSnapshot,
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

export const list = Effect.fn("ProjectSessions.list")(function* () {
  const state = yield* getState();
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

export const create = Effect.fn("ProjectSessions.create")(function* (
  input: ProjectSessionCreateInput,
) {
  const environment = yield* ProjectSessionEnvironment;
  const locations = yield* environment.locations().pipe(asError("create"));
  const location = locations.find(
    (item) =>
      (input.projectPath === undefined || item.projectPath === input.projectPath) &&
      item.workingDirectory === input.workingDirectory,
  );
  if (!location)
    return yield* new ProjectSessionError({
      operation: "create",
      message: "The Working Directory is not associated with that Project",
    });
  const handle = yield* acquireTarget(location, input.sessionId, true);
  if (input.configuration)
    yield* handle
      .applyConfiguration(input.configuration satisfies ChatConfiguration)
      .pipe(asError("create"));
  if (input.name?.trim()) yield* handle.rename(input.name.trim()).pipe(asError("create"));
  return projectSnapshot(yield* handle.snapshot().pipe(asError("create")));
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

export const prompt = Effect.fn("ProjectSessions.prompt")(function* (
  input: ProjectSessionPromptInput,
) {
  return TurnId.make(
    yield* withHandle({ sessionId: input.sessionId }, (handle) =>
      handle.prompt(
        input.text,
        runtimeAttachments(input.attachments),
        input.renderUserMessageAsMarkdown,
      ),
    ).pipe(asError("prompt")),
  );
});

export const steer = Effect.fn("ProjectSessions.steer")(function* (
  input: ProjectSessionPromptInput,
) {
  return TurnId.make(
    yield* withHandle({ sessionId: input.sessionId }, (handle) =>
      handle.steer(input.text, runtimeAttachments(input.attachments)),
    ).pipe(asError("steer")),
  );
});

export const followUp = Effect.fn("ProjectSessions.followUp")(function* (
  input: ProjectSessionPromptInput,
) {
  return TurnId.make(
    yield* withHandle({ sessionId: input.sessionId }, (handle) =>
      handle.followUp(input.text, runtimeAttachments(input.attachments)),
    ).pipe(asError("followUp")),
  );
});

export const abort = Effect.fn("ProjectSessions.abort")(function* (target: ProjectSessionTarget) {
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
  return { sessionId };
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
