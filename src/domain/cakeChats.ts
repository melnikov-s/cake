import { Effect, Stream, type Schema } from "effect";
import * as subagents from "./subagents";
import {
  SESSION_TITLE_MAX_LENGTH,
  type Annotation,
  type Attachment,
  type PiSettingUpdate,
  type SessionSummary,
} from "../ipc/session-contract";
import { PiSessionError, PiSessions, type PiSessionHandle } from "../services/pi/PiSessions";
import {
  CakeChatEnvironment,
  CakeChatEnvironmentError,
} from "../services/cake-chats/CakeChatEnvironment";
import { getState, setSessionFastMode } from "./application";
import type { CakeChatCatalogUpdate } from "./catalog-data";
import { SessionArchiveStorage } from "../services/storage/SessionArchiveStorage";
import { toJsonValue } from "../utils/to-json-value";
import { compareSessionSummariesForSidebar } from "../utils/session-summary-order";
import {
  SessionCatalogChanges,
  type SessionCatalogChange,
} from "../services/session-catalogs/SessionCatalogChanges";

type CakeChatCatalogEvent = Extract<CakeChatCatalogUpdate, { _tag: "Event" }>["event"];
import {
  acquire as acquireConversation,
  observe as observeConversation,
  projectPreviewSnapshot,
  projectSnapshot,
  TurnId,
} from "./conversations";
import {
  CakeChatError,
  type CakeChatCatalogQuery,
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

const errorValue = (operation: string, error: unknown) =>
  new CakeChatError({
    operation,
    message:
      error instanceof PiSessionError || error instanceof CakeChatEnvironmentError
        ? error.message
        : error instanceof Error
          ? error.message
          : String(error),
  });

const summary = (item: SessionSummary, resolved: boolean): CakeChatSummary => {
  const projected: CakeChatSummary = {
    sessionId: item.id,
    title: item.title,
    createdAt: item.created,
    modifiedAt: item.modified,
    messageCount: item.messageCount,
    resolved,
  };
  if (item.parentSessionId !== undefined)
    Object.assign(projected, { parentSessionId: item.parentSessionId });
  return projected;
};

const sessionNamespace = Effect.fn("CakeChats.sessionNamespace")(function* (sessionId: string) {
  const environment = yield* CakeChatEnvironment;
  const archive = yield* SessionArchiveStorage;
  const location = yield* environment.location().pipe(asError("locate"));
  return yield* archive
    .locate(sessionId, {
      cwd: location.workingDirectory,
      activeRoot: location.sessionDirectory,
      resolvedRoot: location.resolvedSessionDirectory,
      direct: true,
    })
    .pipe(asError("locate"));
});

const publishCatalogChange = Effect.fn("CakeChats.publishCatalogChange")(function* (
  sessionId: string,
  resolved: boolean,
) {
  const catalogs = yield* SessionCatalogChanges;
  yield* catalogs.publish({ _tag: "CakeChatSessionChanged", sessionId, resolved });
});

const catalogForState = Effect.fn("CakeChats.catalogForState")(function* (
  query: CakeChatCatalogQuery,
) {
  const environment = yield* CakeChatEnvironment;
  const sessions = yield* PiSessions;
  const archive = yield* SessionArchiveStorage;
  const location = yield* environment.location().pipe(asError("list"));
  const source: Stream.Stream<SessionSummary, unknown> = query.resolved
    ? archive.resolved({
        cwd: location.workingDirectory,
        activeRoot: location.sessionDirectory,
        resolvedRoot: location.resolvedSessionDirectory,
        direct: true,
      })
    : sessions.catalog({
        workingDirectory: location.workingDirectory,
        sessionDirectory: location.sessionDirectory,
        direct: true,
      });
  return source.pipe(
    Stream.map((item) => summary(item, query.resolved)),
    Stream.mapError((error) => errorValue("catalog", error)),
  );
});

const catalogEventForChange = Effect.fn("CakeChats.catalogEventForChange")(function* (
  query: CakeChatCatalogQuery,
  change: SessionCatalogChange,
) {
  if (change._tag === "CakeChatSessionRemoved")
    return { _tag: "Removed", sessionId: change.sessionId } as const;
  if (change._tag === "CakeChatSessionStatusChanged")
    return {
      _tag: "StatusChanged" as const,
      sessionId: change.sessionId,
      resolved: change.resolved,
    };
  if (change._tag !== "CakeChatSessionChanged") return undefined;
  if (change.resolved !== query.resolved) return undefined;
  const environment = yield* CakeChatEnvironment;
  const sessions = yield* PiSessions;
  const archive = yield* SessionArchiveStorage;
  const location = yield* environment.location().pipe(asError("catalog"));
  const item = change.resolved
    ? yield* archive.resolvedEntry(change.sessionId, {
        cwd: location.workingDirectory,
        activeRoot: location.sessionDirectory,
        resolvedRoot: location.resolvedSessionDirectory,
        direct: true,
      })
    : yield* sessions.catalogEntry(
        {
          workingDirectory: location.workingDirectory,
          sessionDirectory: location.sessionDirectory,
          direct: true,
        },
        change.sessionId,
      );
  return item
    ? ({ _tag: "Upserted", session: summary(item, change.resolved) } as const)
    : ({ _tag: "Removed", sessionId: change.sessionId } as const);
});

/** Scoped Cake Chat metadata observation: one lazy scan, then targeted mutations. */
export const observeCatalog = Effect.fn("CakeChats.observeCatalog")(function* (
  query: CakeChatCatalogQuery,
) {
  const catalogs = yield* SessionCatalogChanges;
  const initial = Stream.fromEffect(
    Stream.unwrap(catalogForState(query)).pipe(
      Stream.runCollect,
      Effect.map((sessions) => {
        const all = Array.from(sessions);
        if (!query.resolved) return { _tag: "InitialSnapshot" as const, sessions: all };
        const sorted = all.sort(compareSessionSummariesForSidebar);
        return {
          _tag: "InitialSnapshot" as const,
          sessions: sorted.slice(0, query.limit),
          hasMore: sorted.length > query.limit,
        };
      }),
    ),
  );
  return catalogs.initialThenChanges(initial).pipe(
    Stream.mapEffect((item) =>
      item._tag === "InitialSnapshot"
        ? Effect.succeed<
            | {
                readonly _tag: "InitialSnapshot";
                readonly sessions: CakeChatSummary[];
                readonly hasMore?: boolean;
              }
            | CakeChatCatalogEvent
            | undefined
          >(item)
        : catalogEventForChange(query, item),
    ),
    Stream.filter(
      (
        item,
      ): item is
        | {
            readonly _tag: "InitialSnapshot";
            readonly sessions: CakeChatSummary[];
            readonly hasMore?: boolean;
          }
        | CakeChatCatalogEvent => item !== undefined,
    ),
    Stream.mapError((error) => errorValue("catalog", error)),
    Stream.mapAccum(
      () => 0,
      (revision, item): readonly [number, ReadonlyArray<CakeChatCatalogUpdate>] => {
        const nextRevision = revision + 1;
        return [
          nextRevision,
          [
            item._tag !== "InitialSnapshot"
              ? { _tag: "Event", revision: nextRevision, event: item }
              : item.hasMore === undefined
                ? { _tag: "Snapshot", revision: nextRevision, sessions: item.sessions }
                : {
                    _tag: "Snapshot",
                    revision: nextRevision,
                    sessions: item.sessions,
                    hasMore: item.hasMore,
                  },
          ],
        ];
      },
    ),
  );
});

export const inspect = Effect.fn("CakeChats.inspect")(function* (sessionId: string) {
  const environment = yield* CakeChatEnvironment;
  const sessions = yield* PiSessions;
  const namespace = yield* sessionNamespace(sessionId);
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
    parts: preview.parts.map(toJsonValue),
    resolved: namespace === "resolved",
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
  if ((yield* sessionNamespace(sessionId)) !== "resolved") return;
  const environment = yield* CakeChatEnvironment;
  yield* environment.restore(sessionId).pipe(asError("restore"));
});

export const open = Effect.fn("CakeChats.open")(function* (target: CakeChatTarget) {
  if ((yield* sessionNamespace(target.sessionId)) === "resolved") {
    const preview = yield* inspect(target.sessionId);
    const environment = yield* CakeChatEnvironment;
    const location = yield* environment.location().pipe(asError("open"));
    return projectPreviewSnapshot({ ...preview, workspacePath: location.workingDirectory });
  }
  const handle = yield* acquireTarget(target, false);
  return projectSnapshot(yield* handle.snapshot().pipe(asError("open")));
});

type UnrevisionedCakeChatUpdate =
  | { readonly _tag: "Snapshot"; readonly snapshot: CakeChatSnapshot }
  | { readonly _tag: "Event"; readonly sessionId: string; readonly event: CakeChatEvent };

export const observe = Effect.fn("CakeChats.observe")(function* (target: CakeChatTarget) {
  const catalogs = yield* SessionCatalogChanges;
  const initialResolved = Stream.fromEffect(sessionNamespace(target.sessionId)).pipe(
    Stream.map((namespace) => ({
      _tag: "InitialResolved" as const,
      resolved: namespace === "resolved",
    })),
  );
  return catalogs.initialThenChanges(initialResolved).pipe(
    Stream.map((item) =>
      item._tag === "InitialResolved"
        ? item.resolved
        : item._tag === "CakeChatSessionStatusChanged" && item.sessionId === target.sessionId
          ? item.resolved
          : undefined,
    ),
    Stream.filter((resolved): resolved is boolean => resolved !== undefined),
    Stream.changes,
    Stream.switchMap((resolved) =>
      resolved
        ? Stream.fromEffect(
            Effect.gen(function* () {
              const preview = yield* inspect(target.sessionId);
              const environment = yield* CakeChatEnvironment;
              const location = yield* environment.location().pipe(asError("observe"));
              return {
                _tag: "Snapshot",
                snapshot: {
                  identity: { _tag: "CakeChatSession", sessionId: target.sessionId },
                  resolved: true,
                  conversation: projectPreviewSnapshot({
                    ...preview,
                    workspacePath: location.workingDirectory,
                  }),
                },
              } satisfies UnrevisionedCakeChatUpdate;
            }),
          )
        : Stream.unwrap(
            Effect.gen(function* () {
              const environment = yield* CakeChatEnvironment;
              const handle = yield* acquireTarget(target, false);
              const conversation = observeConversation(handle).pipe(
                Stream.map((update): UnrevisionedCakeChatUpdate => {
                  if (update._tag === "Event")
                    return { _tag: "Event", sessionId: target.sessionId, event: update.event };
                  const snapshot: CakeChatSnapshot = {
                    identity: { _tag: "CakeChatSession", sessionId: target.sessionId },
                    resolved: false,
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
              return conversation.pipe(Stream.merge(controls));
            }),
          ),
    ),
    Stream.tap((update) =>
      update._tag === "Event" && update.event._tag === "TurnSettled"
        ? catalogs.publish({
            _tag: "CakeChatSessionChanged",
            sessionId: target.sessionId,
            resolved: false,
          })
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
    ? handle.followUp(input.text, attachments, input.renderUserMessageAsMarkdown)
    : handle.prompt(input.text, attachments, input.renderUserMessageAsMarkdown);
  const turnId = TurnId.make(yield* accepted.pipe(asError("prompt")));
  if (!input.newSession) yield* publishCatalogChange(input.sessionId, false);
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
  yield* publishCatalogChange(target.sessionId, false);
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
  yield* publishCatalogChange(input.sessionId, false);
});

export const setUserMessageMarkdown = Effect.fn("CakeChats.setUserMessageMarkdown")(function* (
  target: CakeChatTarget,
  entryId: string,
  renderAsMarkdown: boolean,
) {
  yield* withHandle(target, (handle) =>
    handle.setUserMessageMarkdown(entryId, renderAsMarkdown),
  ).pipe(asError("setUserMessageMarkdown"));
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

export const setPiSetting = Effect.fn("CakeChats.setPiSetting")(function* (
  target: CakeChatTarget,
  update: PiSettingUpdate,
) {
  yield* withHandle(target, (handle) => handle.setPiSetting(update)).pipe(asError("setPiSetting"));
});

export const reload = Effect.fn("CakeChats.reload")(function* (target: CakeChatTarget) {
  yield* withHandle(target, (handle) => handle.reload()).pipe(asError("reload"));
});

export const login = Effect.fn("CakeChats.login")(function* (
  target: CakeChatTarget,
  provider: string,
  authType: "api_key" | "oauth",
) {
  yield* withHandle(target, (handle) => handle.login(provider, authType)).pipe(asError("login"));
});

export const logout = Effect.fn("CakeChats.logout")(function* (
  target: CakeChatTarget,
  provider: string,
) {
  yield* withHandle(target, (handle) => handle.logout(provider)).pipe(asError("logout"));
});

export const rename = Effect.fn("CakeChats.rename")(function* (
  target: CakeChatTarget,
  name: string,
) {
  const normalized = name.trim().slice(0, SESSION_TITLE_MAX_LENGTH);
  if (!normalized)
    return yield* new CakeChatError({ operation: "rename", message: "Name is required" });
  const namespace = yield* sessionNamespace(target.sessionId);
  yield* withHandle(target, (handle) => handle.rename(normalized)).pipe(asError("rename"));
  yield* publishCatalogChange(target.sessionId, namespace === "resolved").pipe(asError("rename"));
});

export const handoff = Effect.fn("CakeChats.handoff")(function* (input: {
  readonly target: CakeChatTarget;
  readonly entryId: string;
  readonly prompt?: string;
  readonly resolveSource?: boolean;
}) {
  const state = yield* getState();
  const inheritFastMode = state.fastModeSessionIds.includes(input.target.sessionId);
  const handedOff = yield* withHandle(input.target, (handle) => handle.handoff(input.entryId)).pipe(
    asError("handoff"),
  );
  if (inheritFastMode)
    yield* setSessionFastMode(handedOff.sessionId, true).pipe(asError("handoff"));
  let turnId: TurnId | undefined;
  if (input.prompt?.trim()) {
    const target = { ...input.target, sessionId: handedOff.sessionId };
    const next = yield* acquireTarget(target, false);
    turnId = TurnId.make(yield* next.prompt(input.prompt.trim()).pipe(asError("handoff")));
  }
  if (input.resolveSource) yield* resolve(input.target);
  yield* publishCatalogChange(handedOff.sessionId, false);
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
  const catalogs = yield* SessionCatalogChanges;
  yield* catalogs
    .publish({ _tag: "CakeChatSessionStatusChanged", sessionId: target.sessionId, resolved: true })
    .pipe(asError("resolve"));
});

export const restore = Effect.fn("CakeChats.restore")(function* (target: CakeChatTarget) {
  const environment = yield* CakeChatEnvironment;
  yield* environment.restore(target.sessionId).pipe(asError("restore"));
  const catalogs = yield* SessionCatalogChanges;
  yield* catalogs
    .publish({ _tag: "CakeChatSessionStatusChanged", sessionId: target.sessionId, resolved: false })
    .pipe(asError("restore"));
});

export const deleteResolved = Effect.fn("CakeChats.deleteResolved")(function* (
  target: CakeChatTarget,
) {
  if ((yield* sessionNamespace(target.sessionId)) !== "resolved")
    return yield* new CakeChatError({
      operation: "deleteResolved",
      message: "Only resolved Cake Chat sessions can be deleted",
    });
  const environment = yield* CakeChatEnvironment;
  yield* environment.deleteResolved(target.sessionId).pipe(asError("deleteResolved"));
  const catalogs = yield* SessionCatalogChanges;
  yield* catalogs.publish({ _tag: "CakeChatSessionRemoved", sessionId: target.sessionId });
});

export const respondControl = Effect.fn("CakeChats.respondControl")(function* (
  controlRequestId: string,
  result: Schema.Schema.Type<typeof Schema.Json>,
) {
  const environment = yield* CakeChatEnvironment;
  yield* environment.respondControl(controlRequestId, result).pipe(asError("respondControl"));
});
