import { Effect, Stream } from "effect";
import * as cakeChatMetadata from "../../domain/cake-chats/cakeChatMetadata";
import * as cakeChatOperations from "../../domain/cake-chats/cakeChatOperations";
import * as cakeChatSideChats from "../../domain/cake-chats/cakeChatSideChats";
import * as requestInspection from "../../domain/cake-chats/requestInspection";
import { CakeChatError } from "../../contracts/cake-chats/cake-chat-data";
import type { CakeChatRuntimeConfiguration } from "../../domain/cake-chats/cakeChatRuntime";
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
    "cakeChats.observeSideChats": () =>
      Stream.unwrap(cakeChatSideChats.observeCatalog(configuration.location)),
    "cakeChats.startSideChat": (input) => cakeChatSideChats.start(input, configuration.location),
    "cakeChats.setUnread": ({ unread }) => cakeChatMetadata.setUnread(unread),
    "cakeChats.respondControl": ({ controlRequestId, result }) =>
      withConnection((connectionId) =>
        cakeChatOperations.respondControl(connectionId, controlRequestId, result),
      ),
  });
