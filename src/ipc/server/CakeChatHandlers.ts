import { Effect, Stream } from "effect";
import * as cakeChatMetadata from "../../domain/cakeChatMetadata";
import * as cakeChatOperations from "../../domain/cakeChatOperations";
import * as cakeChatContinuations from "../../domain/cakeChatContinuations";
import * as cakeChatLifecycle from "../../domain/cakeChatLifecycle";
import { CakeChatError } from "../../domain/cake-chat-data";
import { CakeChatEnvironment } from "../../services/cake-chats/CakeChatEnvironment";
import { CakeChatRpc } from "../protocol/CakeChatRpc";
import { RendererConnection } from "../protocol/RendererConnectionMiddleware";

const withConnection = <A, E, R>(operation: (connectionId: number) => Effect.Effect<A, E, R>) =>
  Effect.flatMap(RendererConnection, ({ connectionId }) => operation(connectionId));

const bindRenderer = (connectionId: number, sessionId: string) =>
  Effect.flatMap(CakeChatEnvironment, (environment) =>
    environment.bindRenderer(sessionId, connectionId),
  ).pipe(
    Effect.mapError(
      (error) => new CakeChatError({ operation: "bindRenderer", message: error.message }),
    ),
  );

export const cakeChatHandlers = CakeChatRpc.of({
  "cakeChats.observeCatalog": (query) => Stream.unwrap(cakeChatMetadata.observeCatalog(query)),
  "cakeChats.inspect": ({ sessionId }) => cakeChatMetadata.inspect(sessionId),
  "cakeChats.open": (target) =>
    withConnection((connectionId) =>
      bindRenderer(connectionId, target.sessionId).pipe(
        Effect.andThen(cakeChatOperations.open(target)),
      ),
    ),
  "cakeChats.observe": (target) =>
    Stream.unwrap(
      withConnection((connectionId) =>
        bindRenderer(connectionId, target.sessionId).pipe(
          Effect.andThen(cakeChatOperations.observe(target, connectionId)),
        ),
      ),
    ),
  "cakeChats.prompt": (input) =>
    withConnection((connectionId) =>
      bindRenderer(connectionId, input.sessionId).pipe(
        Effect.andThen(cakeChatOperations.prompt(input)),
      ),
    ),
  "cakeChats.abort": (target) => cakeChatOperations.abort(target),
  "cakeChats.compact": ({ instructions, ...target }) =>
    cakeChatOperations.compact(target, instructions),
  "cakeChats.editMessage": (input) => cakeChatOperations.editMessage(input),
  "cakeChats.setUserMessageMarkdown": ({ entryId, renderAsMarkdown, ...target }) =>
    cakeChatOperations.setUserMessageMarkdown(target, entryId, renderAsMarkdown),
  "cakeChats.applyConfiguration": ({ configuration, ...target }) =>
    cakeChatOperations.applyConfiguration(target, configuration),
  "cakeChats.setModel": ({ provider, modelId, ...target }) =>
    cakeChatOperations.setModel(target, provider, modelId),
  "cakeChats.setThinkingLevel": ({ level, ...target }) =>
    cakeChatOperations.setThinkingLevel(target, level),
  "cakeChats.setFastMode": ({ enabled, ...target }) =>
    cakeChatOperations.setFastMode(target, enabled),
  "cakeChats.setPiSetting": ({ update, ...target }) =>
    cakeChatOperations.setPiSetting(target, update),
  "cakeChats.reload": (target) => cakeChatOperations.reload(target),
  "cakeChats.login": ({ provider, authType, ...target }) =>
    cakeChatOperations.login(target, provider, authType),
  "cakeChats.logout": ({ provider, ...target }) => cakeChatOperations.logout(target, provider),
  "cakeChats.rename": ({ name, ...target }) => cakeChatOperations.rename(target, name),
  "cakeChats.handoff": ({ entryId, prompt, resolveSource, ...target }) => {
    const input: Parameters<typeof cakeChatContinuations.handoff>[0] = { target, entryId };
    if (prompt !== undefined) Object.assign(input, { prompt });
    if (resolveSource !== undefined) Object.assign(input, { resolveSource });
    return cakeChatContinuations.handoff(input);
  },
  "cakeChats.resolve": (target) => cakeChatLifecycle.resolve(target),
  "cakeChats.restore": (target) => cakeChatLifecycle.restore(target),
  "cakeChats.deleteResolved": (target) => cakeChatLifecycle.deleteResolved(target),
  "cakeChats.respondControl": ({ controlRequestId, result }) =>
    withConnection((connectionId) =>
      cakeChatOperations.respondControl(connectionId, controlRequestId, result),
    ),
});
