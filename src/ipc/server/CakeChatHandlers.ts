import { Effect, Stream } from "effect";
import * as cakeChatMetadata from "../../domain/cake-chats/cakeChatMetadata";
import * as cakeChatOperations from "../../domain/cake-chats/cakeChatOperations";
import * as cakeChatContinuations from "../../domain/cake-chats/cakeChatContinuations";
import * as cakeChatLifecycle from "../../domain/cake-chats/cakeChatLifecycle";
import { CakeChatError } from "../../domain/cake-chats/cake-chat-data";
import type { CakeChatRuntimeConfiguration } from "../../domain/cake-chats/cakeChatRuntime";
import { RendererRequestCoordinator } from "../../services/renderer-requests/RendererRequestCoordinator";
import { CakeChatRpc } from "../protocol/CakeChatRpc";
import { RendererConnection } from "../protocol/RendererConnectionMiddleware";

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
    "cakeChats.observeCatalog": (query) =>
      Stream.unwrap(cakeChatMetadata.observeCatalog(query, configuration.location)),
    "cakeChats.inspect": ({ sessionId }) =>
      cakeChatMetadata.inspect(sessionId, configuration.location),
    "cakeChats.open": (target) =>
      withConnection((connectionId) =>
        bindRenderer(connectionId, target.sessionId).pipe(
          Effect.andThen(cakeChatOperations.open(target, configuration)),
        ),
      ),
    "cakeChats.observe": (target) =>
      Stream.unwrap(
        withConnection((connectionId) =>
          bindRenderer(connectionId, target.sessionId).pipe(
            Effect.andThen(cakeChatOperations.observe(target, configuration, connectionId)),
          ),
        ),
      ),
    "cakeChats.prompt": (input) =>
      withConnection((connectionId) =>
        bindRenderer(connectionId, input.sessionId).pipe(
          Effect.andThen(cakeChatOperations.prompt(input, configuration)),
        ),
      ),
    "cakeChats.abort": (target) => cakeChatOperations.abort(target, configuration),
    "cakeChats.compact": ({ instructions, ...target }) =>
      cakeChatOperations.compact(target, instructions, configuration),
    "cakeChats.editMessage": (input) => cakeChatOperations.editMessage(input, configuration),
    "cakeChats.setUserMessageMarkdown": ({ entryId, renderAsMarkdown, ...target }) =>
      cakeChatOperations.setUserMessageMarkdown(target, entryId, renderAsMarkdown, configuration),
    "cakeChats.applyConfiguration": ({ configuration: sessionConfiguration, ...target }) =>
      cakeChatOperations.applyConfiguration(target, sessionConfiguration, configuration),
    "cakeChats.setModel": ({ provider, modelId, ...target }) =>
      cakeChatOperations.setModel(target, provider, modelId, configuration),
    "cakeChats.setThinkingLevel": ({ level, ...target }) =>
      cakeChatOperations.setThinkingLevel(target, level, configuration),
    "cakeChats.setFastMode": ({ enabled, ...target }) =>
      cakeChatOperations.setFastMode(target, enabled, configuration),
    "cakeChats.setPiSetting": ({ update, ...target }) =>
      cakeChatOperations.setPiSetting(target, update, configuration),
    "cakeChats.reload": (target) => cakeChatOperations.reload(target, configuration),
    "cakeChats.login": ({ provider, authType, ...target }) =>
      cakeChatOperations.login(target, provider, authType, configuration),
    "cakeChats.logout": ({ provider, ...target }) =>
      cakeChatOperations.logout(target, provider, configuration),
    "cakeChats.rename": ({ name, ...target }) =>
      cakeChatOperations.rename(target, name, configuration),
    "cakeChats.handoff": ({ entryId, prompt, resolveSource, ...target }) => {
      const input: Parameters<typeof cakeChatContinuations.handoff>[0] = {
        target,
        entryId,
        configuration,
      };
      if (prompt !== undefined) Object.assign(input, { prompt });
      if (resolveSource !== undefined) Object.assign(input, { resolveSource });
      return cakeChatContinuations.handoff(input);
    },
    "cakeChats.resolve": (target) => cakeChatLifecycle.resolve(target, configuration),
    "cakeChats.restore": (target) => cakeChatLifecycle.restore(target, configuration.location),
    "cakeChats.deleteResolved": (target) =>
      cakeChatLifecycle.deleteResolved(target, configuration.location),
    "cakeChats.respondControl": ({ controlRequestId, result }) =>
      withConnection((connectionId) =>
        cakeChatOperations.respondControl(connectionId, controlRequestId, result),
      ),
  });
