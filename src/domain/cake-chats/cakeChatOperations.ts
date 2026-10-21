import { Effect, Stream, type Schema } from "effect";
import { prepareForChat } from "../projects/projectTodos";
import { CakeSessionRuntimes } from "../../services/pi/CakeSessionRuntimes";
import { RendererRequestCoordinator } from "../../services/renderer-requests/RendererRequestCoordinator";
import { SessionCatalogChanges } from "../../services/session-catalogs/SessionCatalogChanges";
import * as cakeChatRuntime from "./cakeChatRuntime";
import type { CakeChatRuntimeConfiguration } from "../../services/pi-durable/CakeChatConfiguration";
import {
  acquire as acquireConversation,
  deliverWhenAvailable,
  observe as observeConversationUpdates,
  projectAttachments,
  TurnId,
} from "../conversations/conversations";
import {
  CakeChatError,
  type CakeChatStartInput,
  type CakeChatTarget,
} from "../../contracts/cake-chats/cake-chat-data";
import * as cakeChatLocations from "./cakeChatLocations";
import { asError, publishCatalogChange, sessionNamespace } from "./cakeChatMetadata";
import { prepareTaskInputs } from "../conversations/taskInputs";

export const acquireTarget = Effect.fn("CakeChats.acquireTarget")(function* (
  target: CakeChatTarget,
  newSession: boolean,
  configuration: CakeChatRuntimeConfiguration,
) {
  const location = yield* cakeChatLocations.resolve(configuration.location, target.sessionId);
  const sessions = yield* CakeSessionRuntimes;
  const options = yield* cakeChatRuntime
    .acquireOptions({ configuration: { ...configuration, location }, target, newSession })
    .pipe(asError("acquire"));
  return yield* acquireConversation(sessions, options).pipe(asError("acquire"));
});

export const open = Effect.fn("CakeChats.open")(function* (
  target: CakeChatTarget,
  configuration: CakeChatRuntimeConfiguration,
) {
  yield* acquireTarget(target, false, configuration);
});

export const observeConversation = Effect.fn("CakeChats.observeConversation")(function* (
  target: CakeChatTarget,
  configuration: CakeChatRuntimeConfiguration,
) {
  const catalogs = yield* SessionCatalogChanges;
  const handle = yield* acquireTarget(target, false, configuration);
  return observeConversationUpdates(handle).pipe(
    Stream.tap((update) =>
      update._tag === "Event" && update.event._tag === "TurnSettled"
        ? catalogs.publish({
            _tag: "CakeChatSessionChanged",
            sessionId: target.sessionId,
            resolved: false,
          })
        : Effect.void,
    ),
    Stream.mapError(
      (error) => new CakeChatError({ operation: "observeConversation", message: String(error) }),
    ),
  );
});

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

export const start = Effect.fn("CakeChats.start")(function* (
  input: CakeChatStartInput,
  configuration: CakeChatRuntimeConfiguration,
) {
  const target: CakeChatTarget = { sessionId: input.sessionId, tools: input.tools };
  const exists = yield* sessionNamespace(
    target.sessionId,
    yield* cakeChatLocations.resolve(configuration.location, target.sessionId),
  );
  const handle = yield* acquireTarget(target, !exists, configuration);
  if (input.newSession.configuration)
    yield* handle.applyConfiguration(input.newSession.configuration).pipe(asError("start"));
  const turnId = TurnId.make(
    yield* deliverWhenAvailable(
      Effect.succeed(handle),
      yield* prepareForChat(input.sessionId, input.text).pipe(asError("start")),
      projectAttachments(
        yield* prepareTaskInputs(input.sessionId, true, input.attachments).pipe(asError("start")),
      ),
      input.renderUserMessageAsMarkdown,
    ).pipe(asError("start")),
  );
  yield* publishCatalogChange(input.sessionId, false);
  return turnId;
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
