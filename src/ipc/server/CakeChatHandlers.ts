import { Effect, Stream } from "effect";
import * as cakeChats from "../../domain/cakeChats";
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
  "cakeChats.observeCatalog": (query) => Stream.unwrap(cakeChats.observeCatalog(query)),
  "cakeChats.inspect": ({ sessionId }) => cakeChats.inspect(sessionId),
  "cakeChats.open": (target) =>
    withConnection((connectionId) =>
      bindRenderer(connectionId, target.sessionId).pipe(Effect.andThen(cakeChats.open(target))),
    ),
  "cakeChats.observe": (target) =>
    Stream.unwrap(
      withConnection((connectionId) =>
        bindRenderer(connectionId, target.sessionId).pipe(
          Effect.andThen(cakeChats.observe(target, connectionId)),
        ),
      ),
    ),
  "cakeChats.prompt": (input) =>
    withConnection((connectionId) =>
      bindRenderer(connectionId, input.sessionId).pipe(Effect.andThen(cakeChats.prompt(input))),
    ),
  "cakeChats.abort": (target) => cakeChats.abort(target),
  "cakeChats.compact": ({ instructions, ...target }) => cakeChats.compact(target, instructions),
  "cakeChats.editMessage": (input) => cakeChats.editMessage(input),
  "cakeChats.setUserMessageMarkdown": ({ entryId, renderAsMarkdown, ...target }) =>
    cakeChats.setUserMessageMarkdown(target, entryId, renderAsMarkdown),
  "cakeChats.applyConfiguration": ({ configuration, ...target }) =>
    cakeChats.applyConfiguration(target, configuration),
  "cakeChats.setModel": ({ provider, modelId, ...target }) =>
    cakeChats.setModel(target, provider, modelId),
  "cakeChats.setThinkingLevel": ({ level, ...target }) => cakeChats.setThinkingLevel(target, level),
  "cakeChats.setFastMode": ({ enabled, ...target }) => cakeChats.setFastMode(target, enabled),
  "cakeChats.setPiSetting": ({ update, ...target }) => cakeChats.setPiSetting(target, update),
  "cakeChats.reload": (target) => cakeChats.reload(target),
  "cakeChats.login": ({ provider, authType, ...target }) =>
    cakeChats.login(target, provider, authType),
  "cakeChats.logout": ({ provider, ...target }) => cakeChats.logout(target, provider),
  "cakeChats.rename": ({ name, ...target }) => cakeChats.rename(target, name),
  "cakeChats.handoff": ({ entryId, prompt, resolveSource, ...target }) => {
    const input: Parameters<typeof cakeChats.handoff>[0] = { target, entryId };
    if (prompt !== undefined) Object.assign(input, { prompt });
    if (resolveSource !== undefined) Object.assign(input, { resolveSource });
    return cakeChats.handoff(input);
  },
  "cakeChats.resolve": (target) => cakeChats.resolve(target),
  "cakeChats.restore": (target) => cakeChats.restore(target),
  "cakeChats.deleteResolved": (target) => cakeChats.deleteResolved(target),
  "cakeChats.respondControl": ({ controlRequestId, result }) =>
    withConnection((connectionId) =>
      cakeChats.respondControl(connectionId, controlRequestId, result),
    ),
});
