import { Effect, Stream, type Schema } from "effect";
import * as subagents from "./subagents";
import { SESSION_TITLE_MAX_LENGTH, type PiSettingUpdate } from "../ipc/session-contract";
import { PiSessions, type PiSessionHandle } from "../services/pi/PiSessions";
import { RendererRequestCoordinator } from "../services/renderer-requests/RendererRequestCoordinator";
import { SessionCatalogChanges } from "../services/session-catalogs/SessionCatalogChanges";
import * as cakeChatLifecycle from "./cakeChatLifecycle";
import type { CakeChatLocation } from "./cakeChatLocations";
import * as cakeChatRuntime from "./cakeChatRuntime";
import type { CakeChatRuntimeConfiguration } from "./cakeChatRuntime";
import {
  abort as abortConversation,
  acquire as acquireConversation,
  applyConfiguration as applyConversationConfiguration,
  authenticate as authenticateConversation,
  compact as compactConversation,
  deliverWhenAvailable,
  editMessage as editConversationMessage,
  observe as observeConversation,
  projectAttachments,
  projectPreviewSnapshot,
  projectSnapshot,
  setFastMode as setConversationFastMode,
  setModel as setConversationModel,
  setPiSetting as setConversationPiSetting,
  setThinkingLevel as setConversationThinkingLevel,
  TurnId,
  use as useConversation,
} from "./conversations";
import {
  CakeChatError,
  type CakeChatEvent,
  type CakeChatPromptInput,
  type CakeChatSnapshot,
  type CakeChatTarget,
  type CakeChatUpdate,
} from "./cake-chat-data";
import { asError, inspect, publishCatalogChange, sessionNamespace } from "./cakeChatMetadata";

export const acquireTarget = Effect.fn("CakeChats.acquireTarget")(function* (
  target: CakeChatTarget,
  newSession: boolean,
  configuration: CakeChatRuntimeConfiguration,
) {
  const sessions = yield* PiSessions;
  const options = yield* cakeChatRuntime
    .acquireOptions({ configuration, target, newSession })
    .pipe(asError("acquire"));
  return yield* acquireConversation(sessions, options).pipe(asError("acquire"));
});

const restoreIfResolved = Effect.fn("CakeChats.restoreIfResolved")(function* (
  sessionId: string,
  location: CakeChatLocation,
) {
  if ((yield* sessionNamespace(sessionId, location)) !== "resolved") return;
  yield* cakeChatLifecycle.setResolved(sessionId, false, location);
});

export const open = Effect.fn("CakeChats.open")(function* (
  target: CakeChatTarget,
  configuration: CakeChatRuntimeConfiguration,
) {
  const location = configuration.location;
  if ((yield* sessionNamespace(target.sessionId, location)) === "resolved") {
    const preview = yield* inspect(target.sessionId, location);
    return projectPreviewSnapshot({ ...preview, workspacePath: location.workingDirectory });
  }
  const handle = yield* acquireTarget(target, false, configuration);
  return projectSnapshot(yield* handle.snapshot().pipe(asError("open")));
});

type UnrevisionedCakeChatUpdate =
  | { readonly _tag: "Snapshot"; readonly snapshot: CakeChatSnapshot }
  | { readonly _tag: "Event"; readonly sessionId: string; readonly event: CakeChatEvent };

export const observe = Effect.fn("CakeChats.observe")(function* (
  target: CakeChatTarget,
  configuration: CakeChatRuntimeConfiguration,
  connectionId?: number,
) {
  const catalogs = yield* SessionCatalogChanges;
  const initialResolved = Stream.fromEffect(
    sessionNamespace(target.sessionId, configuration.location),
  ).pipe(
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
              const preview = yield* inspect(target.sessionId, configuration.location);
              const location = configuration.location;
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
              const rendererRequests = yield* RendererRequestCoordinator;
              const handle = yield* acquireTarget(target, false, configuration);
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
              const controls = rendererRequests.cakeChatControlRequests(connectionId).pipe(
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

export const acquireForUse = Effect.fn("CakeChats.acquireForUse")(function* (
  target: CakeChatTarget,
  configuration: CakeChatRuntimeConfiguration,
) {
  yield* restoreIfResolved(target.sessionId, configuration.location);
  return yield* acquireTarget(target, false, configuration);
});

export const prompt = Effect.fn("CakeChats.prompt")(function* (
  input: CakeChatPromptInput,
  configuration: CakeChatRuntimeConfiguration,
) {
  const target: CakeChatTarget = {
    sessionId: input.sessionId,
    tools: input.tools,
  };
  const handle = input.newSession
    ? yield* acquireTarget(target, true, configuration)
    : yield* acquireForUse(target, configuration);
  if (input.newSession?.configuration)
    yield* handle.applyConfiguration(input.newSession.configuration).pipe(asError("prompt"));
  if (input.newSession?.name?.trim())
    yield* handle.rename(input.newSession.name.trim()).pipe(asError("prompt"));
  const turnId = TurnId.make(
    yield* deliverWhenAvailable(
      Effect.succeed(handle),
      input.text,
      projectAttachments(input.attachments),
      input.renderUserMessageAsMarkdown,
    ).pipe(asError("prompt")),
  );
  if (!input.newSession) yield* publishCatalogChange(input.sessionId, false);
  return turnId;
});

export const abort = Effect.fn("CakeChats.abort")(function* (
  target: CakeChatTarget,
  configuration: CakeChatRuntimeConfiguration,
) {
  yield* subagents.abortParentChildren(target.sessionId).pipe(asError("abort"));
  yield* abortConversation(acquireForUse(target, configuration)).pipe(asError("abort"));
});

export const compact = Effect.fn("CakeChats.compact")(function* (
  target: CakeChatTarget,
  instructions: string | undefined,
  configuration: CakeChatRuntimeConfiguration,
) {
  yield* compactConversation(acquireForUse(target, configuration), instructions).pipe(
    asError("compact"),
  );
  yield* publishCatalogChange(target.sessionId, false);
});

export const editMessage = Effect.fn("CakeChats.editMessage")(function* (
  input: CakeChatPromptInput & { readonly entryId: string },
  configuration: CakeChatRuntimeConfiguration,
) {
  yield* editConversationMessage(
    acquireForUse({ sessionId: input.sessionId, tools: input.tools }, configuration),
    input.entryId,
    input.text,
    projectAttachments(input.attachments),
    input.renderUserMessageAsMarkdown,
  ).pipe(asError("editMessage"));
  yield* publishCatalogChange(input.sessionId, false);
});

export const setUserMessageMarkdown = Effect.fn("CakeChats.setUserMessageMarkdown")(function* (
  target: CakeChatTarget,
  entryId: string,
  renderAsMarkdown: boolean,
  configuration: CakeChatRuntimeConfiguration,
) {
  yield* useConversation(acquireForUse(target, configuration), (handle) =>
    handle.setUserMessageMarkdown(entryId, renderAsMarkdown),
  ).pipe(asError("setUserMessageMarkdown"));
});

export const applyConfiguration = Effect.fn("CakeChats.applyConfiguration")(function* (
  target: CakeChatTarget,
  sessionConfiguration: Parameters<PiSessionHandle["applyConfiguration"]>[0],
  runtimeConfiguration: CakeChatRuntimeConfiguration,
) {
  yield* applyConversationConfiguration(
    acquireForUse(target, runtimeConfiguration),
    sessionConfiguration,
  ).pipe(asError("applyConfiguration"));
});

export const setModel = Effect.fn("CakeChats.setModel")(function* (
  target: CakeChatTarget,
  provider: string,
  modelId: string,
  configuration: CakeChatRuntimeConfiguration,
) {
  yield* setConversationModel(acquireForUse(target, configuration), provider, modelId).pipe(
    asError("setModel"),
  );
});

export const setThinkingLevel = Effect.fn("CakeChats.setThinkingLevel")(function* (
  target: CakeChatTarget,
  level: Parameters<PiSessionHandle["setThinkingLevel"]>[0],
  configuration: CakeChatRuntimeConfiguration,
) {
  yield* setConversationThinkingLevel(acquireForUse(target, configuration), level).pipe(
    asError("setThinkingLevel"),
  );
});

export const setFastMode = Effect.fn("CakeChats.setFastMode")(function* (
  target: CakeChatTarget,
  enabled: boolean,
  configuration: CakeChatRuntimeConfiguration,
) {
  yield* setConversationFastMode(acquireForUse(target, configuration), enabled).pipe(
    asError("setFastMode"),
  );
});

export const setPiSetting = Effect.fn("CakeChats.setPiSetting")(function* (
  target: CakeChatTarget,
  update: PiSettingUpdate,
  configuration: CakeChatRuntimeConfiguration,
) {
  yield* setConversationPiSetting(acquireForUse(target, configuration), update).pipe(
    asError("setPiSetting"),
  );
});

export const reload = Effect.fn("CakeChats.reload")(function* (
  target: CakeChatTarget,
  configuration: CakeChatRuntimeConfiguration,
) {
  yield* useConversation(acquireForUse(target, configuration), (handle) => handle.reload()).pipe(
    asError("reload"),
  );
});

export const login = Effect.fn("CakeChats.login")(function* (
  target: CakeChatTarget,
  provider: string,
  authType: "api_key" | "oauth",
  configuration: CakeChatRuntimeConfiguration,
) {
  yield* authenticateConversation(acquireForUse(target, configuration), {
    _tag: "Login",
    provider,
    authType,
  }).pipe(asError("login"));
});

export const logout = Effect.fn("CakeChats.logout")(function* (
  target: CakeChatTarget,
  provider: string,
  configuration: CakeChatRuntimeConfiguration,
) {
  yield* authenticateConversation(acquireForUse(target, configuration), {
    _tag: "Logout",
    provider,
  }).pipe(asError("logout"));
});

export const rename = Effect.fn("CakeChats.rename")(function* (
  target: CakeChatTarget,
  name: string,
  configuration: CakeChatRuntimeConfiguration,
) {
  const normalized = name.trim().slice(0, SESSION_TITLE_MAX_LENGTH);
  if (!normalized)
    return yield* new CakeChatError({ operation: "rename", message: "Name is required" });
  const namespace = yield* sessionNamespace(target.sessionId, configuration.location);
  yield* useConversation(acquireForUse(target, configuration), (handle) =>
    handle.rename(normalized),
  ).pipe(asError("rename"));
  yield* publishCatalogChange(target.sessionId, namespace === "resolved").pipe(asError("rename"));
});

export const respondControl = Effect.fn("CakeChats.respondControl")(function* (
  connectionId: number,
  controlRequestId: string,
  result: Schema.Schema.Type<typeof Schema.Json>,
) {
  const rendererRequests = yield* RendererRequestCoordinator;
  yield* rendererRequests
    .respondCakeChatControl(connectionId, controlRequestId, result)
    .pipe(asError("respondControl"));
});
