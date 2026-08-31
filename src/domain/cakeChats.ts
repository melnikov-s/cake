import { Effect, Schema, Stream } from "effect";
import * as subagents from "./subagents";
import type { Annotation, Attachment, SessionSummary } from "../ipc/session-contract";
import { jsonValueSchema } from "../ipc/json-contract";
import { PiSessionError, PiSessions, type PiSessionHandle } from "../services/pi/PiSessions";
import {
  CakeChatEnvironment,
  CakeChatEnvironmentError,
} from "../services/cake-chats/CakeChatEnvironment";
import {
  getState,
  observeState,
  refreshProjection,
  setCakeChatSessionResolved,
} from "./application";
import type { CakeChatCatalogUpdate } from "./catalog-data";
import {
  acquire as acquireConversation,
  observe as observeConversation,
  projectSnapshot,
  TurnId,
} from "./conversations";
import {
  CakeChatError,
  type CakeChatEvent,
  type CakeChatPreview,
  type CakeChatPromptInput,
  type CakeChatSnapshot,
  type CakeChatSummary,
  type CakeChatTarget,
  type CakeChatUpdate,
} from "./cake-chat-data";

export * from "./cake-chat-data";

const asError = (operation: string) =>
  Effect.mapError(
    (error: PiSessionError | CakeChatEnvironmentError | unknown) =>
      new CakeChatError({
        operation,
        message:
          error instanceof PiSessionError || error instanceof CakeChatEnvironmentError
            ? error.message
            : error instanceof Error
              ? error.message
              : String(error),
      }),
  );

const summary = (item: SessionSummary, resolvedIds: ReadonlySet<string>): CakeChatSummary => {
  const projected: CakeChatSummary = {
    sessionId: item.id,
    title: item.title,
    createdAt: item.created,
    modifiedAt: item.modified,
    messageCount: item.messageCount,
    resolved: item.resolved || resolvedIds.has(item.id),
  };
  if (item.parentSessionId !== undefined)
    Object.assign(projected, { parentSessionId: item.parentSessionId });
  return projected;
};

export const list = Effect.fn("CakeChats.list")(function* () {
  const environment = yield* CakeChatEnvironment;
  const sessions = yield* PiSessions;
  const state = yield* getState();
  const location = yield* environment.location().pipe(asError("list"));
  const resolved = new Set(state.resolvedCakeChatSessionIds);
  const items = yield* sessions
    .list({
      workingDirectory: location.workingDirectory,
      sessionDirectory: location.sessionDirectory,
      resolvedSessionDirectory: location.resolvedSessionDirectory,
      direct: true,
    })
    .pipe(asError("list"));
  return items
    .map((item) => summary(item, resolved))
    .sort((left, right) => right.modifiedAt.localeCompare(left.modifiedAt));
});

/** Current-first Cake Chat catalog observation driven by main-owned application revisions. */
export const observeCatalog = Effect.fn("CakeChats.observeCatalog")(function* () {
  const changes = yield* observeState();
  let initialized = false;
  return changes.pipe(
    Stream.mapEffect((projection) =>
      list().pipe(
        Effect.map((sessions): CakeChatCatalogUpdate => {
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

export const inspect = Effect.fn("CakeChats.inspect")(function* (sessionId: string) {
  const environment = yield* CakeChatEnvironment;
  const sessions = yield* PiSessions;
  const state = yield* getState();
  const location = yield* environment.location().pipe(asError("inspect"));
  const preview = yield* sessions
    .inspect({
      workingDirectory: location.workingDirectory,
      sessionDirectory: location.sessionDirectory,
      resolvedSessionDirectory: location.resolvedSessionDirectory,
      sessionId,
      direct: true,
    })
    .pipe(asError("inspect"));
  return {
    sessionId: preview.sessionId,
    sessionFile: preview.sessionFile,
    parts: preview.parts.map((part) => Schema.decodeUnknownSync(Schema.Json)(part)),
    resolved: state.resolvedCakeChatSessionIds.includes(sessionId),
  } satisfies CakeChatPreview;
});

const acquireTarget = Effect.fn("CakeChats.acquireTarget")(function* (
  target: CakeChatTarget,
  newSession: boolean,
) {
  const environment = yield* CakeChatEnvironment;
  const sessions = yield* PiSessions;
  const options = yield* environment
    .runtimeOptions({ sessionId: target.sessionId, newSession, tools: target.tools })
    .pipe(asError("acquire"));
  return yield* acquireConversation(sessions, options).pipe(asError("acquire"));
});

const restoreIfResolved = Effect.fn("CakeChats.restoreIfResolved")(function* (sessionId: string) {
  const state = yield* getState();
  if (!state.resolvedCakeChatSessionIds.includes(sessionId)) return;
  const environment = yield* CakeChatEnvironment;
  yield* environment.restore(sessionId).pipe(asError("restore"));
  yield* setCakeChatSessionResolved(sessionId, false).pipe(asError("restore"));
});

export const open = Effect.fn("CakeChats.open")(function* (target: CakeChatTarget) {
  yield* restoreIfResolved(target.sessionId);
  const handle = yield* acquireTarget(target, false);
  return projectSnapshot(yield* handle.snapshot().pipe(asError("open")));
});

type UnrevisionedCakeChatUpdate =
  | { readonly _tag: "Snapshot"; readonly snapshot: CakeChatSnapshot }
  | { readonly _tag: "Event"; readonly sessionId: string; readonly event: CakeChatEvent };

export const observe = Effect.fn("CakeChats.observe")(function* (target: CakeChatTarget) {
  yield* restoreIfResolved(target.sessionId);
  const state = yield* getState();
  const environment = yield* CakeChatEnvironment;
  const handle = yield* acquireTarget(target, false);
  const conversation = observeConversation(handle).pipe(
    Stream.map((update): UnrevisionedCakeChatUpdate => {
      if (update._tag === "Event")
        return { _tag: "Event", sessionId: target.sessionId, event: update.event };
      const snapshot: CakeChatSnapshot = {
        identity: { _tag: "CakeChatSession", sessionId: target.sessionId },
        resolved: state.resolvedCakeChatSessionIds.includes(target.sessionId),
        conversation: update.snapshot,
      };
      return { _tag: "Snapshot", snapshot };
    }),
  );
  const controls = environment.controlRequests().pipe(
    Stream.filter((request) => request.sessionId === target.sessionId),
    Stream.map((event): UnrevisionedCakeChatUpdate => ({
      _tag: "Event",
      sessionId: target.sessionId,
      event,
    })),
  );
  return conversation.pipe(
    Stream.merge(controls),
    Stream.tap((update) =>
      update._tag === "Event" && update.event._tag === "TurnSettled"
        ? refreshProjection()
        : Effect.void,
    ),
    Stream.mapAccum(
      () => 0,
      (revision, update) => {
        const nextRevision = revision + 1;
        const revised: CakeChatUpdate =
          update._tag === "Snapshot"
            ? { _tag: "Snapshot", revision: nextRevision, snapshot: update.snapshot }
            : {
                _tag: "Event",
                revision: nextRevision,
                sessionId: update.sessionId,
                event: update.event,
              };
        return [nextRevision, [revised]] as const;
      },
    ),
    Stream.mapError((error) => new CakeChatError({ operation: "observe", message: String(error) })),
  );
});

const withHandle = Effect.fn("CakeChats.withHandle")(function* <A, E>(
  target: CakeChatTarget,
  use: (handle: PiSessionHandle) => Effect.Effect<A, E>,
) {
  yield* restoreIfResolved(target.sessionId);
  const handle = yield* acquireTarget(target, false);
  return yield* use(handle);
});

const runtimeAttachments = (
  values: CakeChatPromptInput["attachments"],
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

export const prompt = Effect.fn("CakeChats.prompt")(function* (input: CakeChatPromptInput) {
  const target: CakeChatTarget = {
    sessionId: input.sessionId,
    tools: input.newSession?.tools ?? [],
  };
  const handle = input.newSession
    ? yield* acquireTarget(target, true)
    : yield* withHandle(target, (current) => Effect.succeed(current));
  if (input.newSession?.configuration)
    yield* handle.applyConfiguration(input.newSession.configuration).pipe(asError("prompt"));
  if (input.newSession?.name?.trim())
    yield* handle.rename(input.newSession.name.trim()).pipe(asError("prompt"));
  const attachments = runtimeAttachments(input.attachments);
  const snapshot = yield* handle.snapshot().pipe(asError("prompt"));
  const accepted = snapshot.streaming
    ? handle.followUp(input.text, attachments)
    : handle.prompt(input.text, attachments, input.renderUserMessageAsMarkdown);
  const turnId = TurnId.make(yield* accepted.pipe(asError("prompt")));
  yield* refreshProjection();
  return turnId;
});

export const abort = Effect.fn("CakeChats.abort")(function* (target: CakeChatTarget) {
  yield* subagents.abortParentChildren(target.sessionId).pipe(asError("abort"));
  yield* withHandle(target, (handle) => handle.abort()).pipe(asError("abort"));
});

export const compact = Effect.fn("CakeChats.compact")(function* (
  target: CakeChatTarget,
  instructions?: string,
) {
  yield* withHandle(target, (handle) => handle.compact(instructions)).pipe(asError("compact"));
  yield* refreshProjection();
});

export const editMessage = Effect.fn("CakeChats.editMessage")(function* (
  input: CakeChatPromptInput & { readonly entryId: string },
) {
  yield* withHandle({ sessionId: input.sessionId, tools: [] }, (handle) =>
    handle.editMessage(
      input.entryId,
      input.text,
      runtimeAttachments(input.attachments),
      input.renderUserMessageAsMarkdown,
    ),
  ).pipe(asError("editMessage"));
  yield* refreshProjection();
});

export const applyConfiguration = Effect.fn("CakeChats.applyConfiguration")(function* (
  target: CakeChatTarget,
  configuration: Parameters<PiSessionHandle["applyConfiguration"]>[0],
) {
  yield* withHandle(target, (handle) => handle.applyConfiguration(configuration)).pipe(
    asError("applyConfiguration"),
  );
});

export const setModel = Effect.fn("CakeChats.setModel")(function* (
  target: CakeChatTarget,
  provider: string,
  modelId: string,
) {
  yield* withHandle(target, (handle) => handle.setModel(provider, modelId)).pipe(
    asError("setModel"),
  );
});

export const setThinkingLevel = Effect.fn("CakeChats.setThinkingLevel")(function* (
  target: CakeChatTarget,
  level: Parameters<PiSessionHandle["setThinkingLevel"]>[0],
) {
  yield* withHandle(target, (handle) => handle.setThinkingLevel(level)).pipe(
    asError("setThinkingLevel"),
  );
});

export const setFastMode = Effect.fn("CakeChats.setFastMode")(function* (
  target: CakeChatTarget,
  enabled: boolean,
) {
  yield* withHandle(target, (handle) => handle.setFastMode(enabled)).pipe(asError("setFastMode"));
});

export const rename = Effect.fn("CakeChats.rename")(function* (
  target: CakeChatTarget,
  name: string,
) {
  const normalized = name.trim();
  if (!normalized)
    return yield* new CakeChatError({ operation: "rename", message: "Name is required" });
  yield* withHandle(target, (handle) => handle.rename(normalized)).pipe(asError("rename"));
  yield* refreshProjection();
});

export const handoff = Effect.fn("CakeChats.handoff")(function* (input: {
  readonly target: CakeChatTarget;
  readonly entryId: string;
  readonly prompt?: string;
  readonly resolveSource?: boolean;
}) {
  const configuration = yield* withHandle(input.target, (handle) => handle.configuration()).pipe(
    asError("handoff"),
  );
  const handedOff = yield* withHandle(input.target, (handle) => handle.handoff(input.entryId)).pipe(
    asError("handoff"),
  );
  const target = { ...input.target, sessionId: handedOff.sessionId };
  const next = yield* acquireTarget(target, false);
  if (configuration) yield* next.applyConfiguration(configuration).pipe(asError("handoff"));
  let turnId: TurnId | undefined;
  if (input.prompt?.trim())
    turnId = TurnId.make(yield* next.prompt(input.prompt.trim()).pipe(asError("handoff")));
  if (input.resolveSource) yield* resolve(input.target);
  else yield* refreshProjection();
  return turnId ? { sessionId: handedOff.sessionId, turnId } : { sessionId: handedOff.sessionId };
});

export const resolve = Effect.fn("CakeChats.resolve")(function* (target: CakeChatTarget) {
  const snapshot = yield* Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* acquireTarget(target, false);
      return yield* handle.snapshot().pipe(asError("resolve"));
    }),
  );
  if (snapshot.streaming)
    return yield* new CakeChatError({
      operation: "resolve",
      message: "Cake Chat cannot resolve a session while it is running",
    });
  if (!snapshot.sessionFile)
    return yield* new CakeChatError({
      operation: "resolve",
      message: "Cake Chat cannot resolve an empty session before it has been persisted",
    });
  yield* subagents.releaseParent(target.sessionId).pipe(asError("resolve"));
  const environment = yield* CakeChatEnvironment;
  yield* environment.archive(target.sessionId).pipe(asError("resolve"));
  yield* setCakeChatSessionResolved(target.sessionId, true).pipe(asError("resolve"));
});

export const restore = Effect.fn("CakeChats.restore")(function* (target: CakeChatTarget) {
  const environment = yield* CakeChatEnvironment;
  yield* environment.restore(target.sessionId).pipe(asError("restore"));
  yield* setCakeChatSessionResolved(target.sessionId, false).pipe(asError("restore"));
});

export const deleteResolved = Effect.fn("CakeChats.deleteResolved")(function* (
  target: CakeChatTarget,
) {
  const state = yield* getState();
  if (!state.resolvedCakeChatSessionIds.includes(target.sessionId))
    return yield* new CakeChatError({
      operation: "deleteResolved",
      message: "Only resolved Cake Chat sessions can be deleted",
    });
  const environment = yield* CakeChatEnvironment;
  yield* environment.deleteResolved(target.sessionId).pipe(asError("deleteResolved"));
  yield* setCakeChatSessionResolved(target.sessionId, false).pipe(asError("deleteResolved"));
});

export const respondControl = Effect.fn("CakeChats.respondControl")(function* (
  controlRequestId: string,
  result: Schema.Schema.Type<typeof Schema.Json>,
) {
  const environment = yield* CakeChatEnvironment;
  const parsed = jsonValueSchema.safeParse(result);
  if (!parsed.success)
    return yield* new CakeChatError({
      operation: "respondControl",
      message: "The Cake Chat control response is not valid JSON",
    });
  yield* environment.respondControl(controlRequestId, parsed.data).pipe(asError("respondControl"));
});
