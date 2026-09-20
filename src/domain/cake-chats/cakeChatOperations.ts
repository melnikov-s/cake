import { Effect, Stream, type Schema } from "effect";
import { SESSION_TITLE_MAX_LENGTH } from "../../ipc/session-contract";
import { CakeSessionRuntimes } from "../../services/pi/CakeSessionRuntimes";
import { RendererRequestCoordinator } from "../../services/renderer-requests/RendererRequestCoordinator";
import { SessionCatalogChanges } from "../../services/session-catalogs/SessionCatalogChanges";
import * as cakeChatLifecycle from "./cakeChatLifecycle";
import type { CakeChatLocation } from "./cakeChatLocations";
import * as cakeChatRuntime from "./cakeChatRuntime";
import type { CakeChatRuntimeConfiguration } from "./cakeChatRuntime";
import {
  acquire as acquireConversation,
  deliverWhenAvailable,
  observe as observeConversationUpdates,
  projectAttachments,
  projectPreviewSnapshot,
  TurnId,
  use as useConversation,
} from "../conversations/conversations";
import { CakeChatError, type CakeChatStartInput, type CakeChatTarget } from "./cake-chat-data";
import { asError, inspect, publishCatalogChange, sessionNamespace } from "./cakeChatMetadata";

export const acquireTarget = Effect.fn("CakeChats.acquireTarget")(function* (
  target: CakeChatTarget,
  newSession: boolean,
  configuration: CakeChatRuntimeConfiguration,
) {
  const sessions = yield* CakeSessionRuntimes;
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
    yield* inspect(target.sessionId, location);
    return;
  }
  yield* acquireTarget(target, false, configuration);
});

export const observeConversation = Effect.fn("CakeChats.observeConversation")(function* (
  target: CakeChatTarget,
  configuration: CakeChatRuntimeConfiguration,
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
            inspect(target.sessionId, configuration.location).pipe(
              Effect.map(projectPreviewSnapshot),
            ),
          ).pipe(Stream.map((snapshot) => ({ _tag: "Snapshot" as const, revision: 0, snapshot })))
        : Stream.unwrap(
            acquireTarget(target, false, configuration).pipe(
              Effect.map((handle) => observeConversationUpdates(handle)),
            ),
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
        return [nextRevision, [{ ...update, revision: nextRevision }]] as const;
      },
    ),
    Stream.mapError(
      (error) => new CakeChatError({ operation: "observeConversation", message: String(error) }),
    ),
  );
});

/** Cake controls are application workflow, observed independently from the Conversation. */
export const observeControls = Effect.fn("CakeChats.observeControls")(function* (
  target: CakeChatTarget,
  connectionId?: number,
) {
  const rendererRequests = yield* RendererRequestCoordinator;
  return rendererRequests.cakeChatControlSnapshots(connectionId).pipe(
    Stream.map((requests) => ({
      _tag: "Snapshot" as const,
      requests: requests.filter((request) => request.sessionId === target.sessionId),
    })),
  );
});

export const acquireForUse = Effect.fn("CakeChats.acquireForUse")(function* (
  target: CakeChatTarget,
  configuration: CakeChatRuntimeConfiguration,
) {
  yield* restoreIfResolved(target.sessionId, configuration.location);
  return yield* acquireTarget(target, false, configuration);
});

export const start = Effect.fn("CakeChats.start")(function* (
  input: CakeChatStartInput,
  configuration: CakeChatRuntimeConfiguration,
) {
  const target: CakeChatTarget = {
    sessionId: input.sessionId,
    tools: input.tools,
  };
  const handle = yield* acquireTarget(target, true, configuration);
  if (input.newSession.configuration)
    yield* handle.applyConfiguration(input.newSession.configuration).pipe(asError("start"));
  if (input.newSession.name?.trim())
    yield* handle.rename(input.newSession.name.trim()).pipe(asError("start"));
  const turnId = TurnId.make(
    yield* deliverWhenAvailable(
      Effect.succeed(handle),
      input.text,
      projectAttachments(input.attachments),
      input.renderUserMessageAsMarkdown,
    ).pipe(asError("start")),
  );
  yield* publishCatalogChange(input.sessionId, false);
  return turnId;
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
