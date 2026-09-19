import { Effect } from "effect";
import * as sessionChats from "../../domain/conversations/sessionChats";
import { RendererConnection } from "../protocol/RendererConnectionMiddleware";
import { SessionChatRpc } from "../protocol/SessionChatRpc";

const deliverFromRenderer = (
  input: Parameters<typeof sessionChats.deliver>[0],
  delivery: Parameters<typeof sessionChats.deliver>[1],
) =>
  Effect.flatMap(RendererConnection, ({ connectionId }) =>
    sessionChats
      .bindRenderer(input.sessionId, connectionId)
      .pipe(Effect.andThen(sessionChats.deliver(input, delivery))),
  );

export const sessionChatHandlers = SessionChatRpc.of({
  "sessionChats.prompt": (input) => deliverFromRenderer(input, "prompt"),
  "sessionChats.steer": (input) => deliverFromRenderer(input, "steer"),
  "sessionChats.followUp": (input) => deliverFromRenderer(input, "follow-up"),
  "sessionChats.abort": sessionChats.abort,
  "sessionChats.listQueuedMessages": sessionChats.listQueuedMessages,
  "sessionChats.clearQueue": sessionChats.clearQueue,
  "sessionChats.cancelSteering": sessionChats.cancelSteering,
  "sessionChats.removeQueuedMessage": ({ partId, ...target }) =>
    sessionChats.removeQueuedMessage(target, partId),
  "sessionChats.steerQueuedMessage": ({ partId, ...target }) =>
    sessionChats.steerQueuedMessage(target, partId),
  "sessionChats.sendQueuedMessageNow": ({ partId, ...target }) =>
    sessionChats.sendQueuedMessageNow(target, partId),
  "sessionChats.compact": ({ instructions, ...target }) =>
    sessionChats.compact(target, instructions),
  "sessionChats.editMessage": sessionChats.editMessage,
  "sessionChats.setUserMessageMarkdown": ({ entryId, renderAsMarkdown, ...target }) =>
    sessionChats.setUserMessageMarkdown(target, entryId, renderAsMarkdown),
  "sessionChats.applyConfiguration": ({ configuration, ...target }) =>
    sessionChats.applyConfiguration(target, configuration),
  "sessionChats.setModel": ({ provider, modelId, ...target }) =>
    sessionChats.setModel(target, provider, modelId),
  "sessionChats.setThinkingLevel": ({ level, ...target }) =>
    sessionChats.setThinkingLevel(target, level),
  "sessionChats.setFastMode": ({ enabled, ...target }) => sessionChats.setFastMode(target, enabled),
  "sessionChats.login": ({ provider, authType, ...target }) =>
    sessionChats.login(target, provider, authType),
  "sessionChats.logout": ({ provider, ...target }) => sessionChats.logout(target, provider),
});
