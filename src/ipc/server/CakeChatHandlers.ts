import { Effect, Stream } from "effect";
import { CAKE_CHAT_SESSION_ID } from "../../contracts/cake-chats/cake-chat-identity";
import * as locations from "../../domain/cake-chats/cakeChatLocations";
import * as cakeChatMetadata from "../../domain/cake-chats/cakeChatMetadata";
import * as cakeChatOperations from "../../domain/cake-chats/cakeChatOperations";
import * as cakeChatSideChats from "../../domain/cake-chats/cakeChatSideChats";
import * as requestInspection from "../../domain/cake-chats/requestInspection";
import { CakeChatError } from "../../contracts/cake-chats/cake-chat-data";
import type { CakeChatRuntimeConfiguration } from "../../services/pi-durable/CakeChatConfiguration";
import { CakeChatComposerPresence } from "../../services/session-catalogs/CakeChatComposerPresence";
import { RendererRequestCoordinator } from "../../services/renderer-requests/RendererRequestCoordinator";
import { CakeChatRpc } from "../protocol/CakeChatRpc";
import { RendererConnection } from "../protocol/RendererConnectionMiddleware";
import { admitTurnAttachments } from "./AttachmentUploadHandlers";

const withConnection = <A, E, R>(operation: (connectionId: number) => Effect.Effect<A, E, R>) =>
  Effect.flatMap(RendererConnection, ({ connectionId }) => operation(connectionId));

const bindRenderer = (connectionId: number, sessionId: string) =>
  Effect.flatMap(RendererRequestCoordinator, (rendererRequests) =>
    rendererRequests.bind({ _tag: "CakeChatSession", sessionId }, connectionId),
  ).pipe(
    Effect.mapError(
      (error) => new CakeChatError({ operation: "bindRenderer", message: error.message }),
    ),
  );

export const makeCakeChatHandlers = (configuration: CakeChatRuntimeConfiguration) =>
  CakeChatRpc.of({
    "cakeChats.requestInspection": (input) => requestInspection.inspect(input),
    "cakeChats.observeCatalog": (query) =>
      Stream.unwrap(cakeChatMetadata.observeCatalog(query, configuration.location)),
    "cakeChats.inspect": ({ sessionId }) =>
      cakeChatMetadata.inspect(sessionId, configuration.location),
    "cakeChats.open": (target) =>
      withConnection((connectionId) =>
        cakeChatOperations.open(target, configuration).pipe(
          Effect.tap(() => bindRenderer(connectionId, target.sessionId)),
          Effect.asVoid,
        ),
      ),
    "cakeChats.observeControls": (target) =>
      Stream.unwrap(
        withConnection((connectionId) => cakeChatOperations.observeControls(target, connectionId)),
      ),
    "cakeChats.start": (input) =>
      withConnection((connectionId) =>
        bindRenderer(connectionId, input.sessionId).pipe(
          Effect.andThen(
            admitTurnAttachments(input).pipe(
              Effect.mapError(
                (error) => new CakeChatError({ operation: "start", message: error.message }),
              ),
              Effect.flatMap((admitted) => cakeChatOperations.start(admitted, configuration)),
            ),
          ),
        ),
      ),
    "cakeChats.observeSideChats": ({ sessionId = CAKE_CHAT_SESSION_ID }) =>
      Stream.unwrap(
        Effect.flatMap(locations.resolve(configuration.location, sessionId), (location) =>
          cakeChatSideChats.observeCatalog(location, sessionId),
        ),
      ),
    "cakeChats.startSideChat": (input) =>
      Effect.flatMap(
        locations.resolve(configuration.location, input.parentSessionId ?? CAKE_CHAT_SESSION_ID),
        (location) => cakeChatSideChats.start(input, location),
      ),
    "cakeChats.setUnread": ({ unread, sessionId = CAKE_CHAT_SESSION_ID }) =>
      locations
        .resolve(configuration.location, sessionId)
        .pipe(Effect.andThen(cakeChatMetadata.setUnread(unread, sessionId))),
    // Advisory presence: hosts without the service simply never hold deliveries.
    "cakeChats.setComposing": ({ composing, sessionId }) =>
      Effect.serviceOption(CakeChatComposerPresence).pipe(
        Effect.flatMap((presence) =>
          presence._tag === "Some"
            ? presence.value.setComposing(composing, sessionId)
            : Effect.void,
        ),
      ),
    "cakeChats.respondControl": ({ controlRequestId, result }) =>
      withConnection((connectionId) =>
        cakeChatOperations.respondControl(connectionId, controlRequestId, result),
      ),
  });
