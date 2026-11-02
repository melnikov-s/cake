import { Effect } from "effect";
import * as sessionChats from "../../domain/conversations/sessionChats";
import * as cakeChatTargets from "../../domain/cake-chats/cakeChatTargets";
import { isProjectChatSessionId } from "../../contracts/cake-chats/cake-chat-identity";
import { RendererConnection } from "../protocol/RendererConnectionMiddleware";
import { SessionChatRpc } from "../protocol/SessionChatRpc";
import { SessionChatError } from "../../contracts/conversations/conversation-data";
import { admitTurnAttachments } from "./AttachmentUploadHandlers";

const deliverFromRenderer = (
  input: Parameters<typeof sessionChats.deliver>[0],
  delivery: Parameters<typeof sessionChats.deliver>[1],
) =>
  Effect.flatMap(RendererConnection, ({ connectionId }) =>
    // A saved Project Chat preview can accept input while its observer is still
    // assembling the runtime. Join that ordinary shared profile before binding it.
    (isProjectChatSessionId(input.sessionId)
      ? cakeChatTargets
          .acquireAvailable(input.sessionId)
          .pipe(
            Effect.mapError(
              (error) => new SessionChatError({ operation: "deliver", message: error.message }),
            ),
          )
      : Effect.void
    ).pipe(
      Effect.andThen(sessionChats.bindRenderer(input.sessionId, connectionId)),
      Effect.andThen(
        admitTurnAttachments(input).pipe(
          Effect.mapError(
            (error) => new SessionChatError({ operation: "deliver", message: error.message }),
          ),
          Effect.flatMap((admitted) => sessionChats.deliver(admitted, delivery)),
        ),
      ),
    ),
  );

export const sessionChatHandlers = SessionChatRpc.of({
  "sessionChats.prompt": (input) => deliverFromRenderer(input, "prompt"),
  "sessionChats.steer": (input) => deliverFromRenderer(input, "steer"),
  "sessionChats.followUp": (input) => deliverFromRenderer(input, "follow-up"),
  "sessionChats.abort": sessionChats.abort,
  "sessionChats.history": sessionChats.history,
  "sessionChats.listQueuedMessages": sessionChats.listQueuedMessages,
  "sessionChats.reorderQueuedMessage": sessionChats.reorderQueuedMessage,
  "sessionChats.clearQueue": sessionChats.clearQueue,
  "sessionChats.cancelSteering": sessionChats.cancelSteering,
  "sessionChats.removeQueuedMessage": ({ partId, ...target }) =>
    sessionChats.removeQueuedMessage(target, partId),
  "sessionChats.steerQueuedMessage": ({ partId, ...target }) =>
    sessionChats.steerQueuedMessage(target, partId),
  "sessionChats.sendQueuedMessageNow": ({ partId, ...target }) =>
    sessionChats.sendQueuedMessageNow(target, partId),
  "sessionChats.queueCommand": sessionChats.queueCommand,
  "sessionChats.inspect": sessionChats.inspect,
  "sessionChats.readAttachment": sessionChats.readAttachment,
  "sessionChats.compactMemory": sessionChats.compactMemory,
  "sessionChats.compact": ({ instructions, ...target }) =>
    sessionChats.compact(target, instructions),
  "sessionChats.editMessage": (input) =>
    admitTurnAttachments(input).pipe(
      Effect.mapError(
        (error) => new SessionChatError({ operation: "editMessage", message: error.message }),
      ),
      Effect.flatMap(sessionChats.editMessage),
    ),
  "sessionChats.setUserMessageMarkdown": ({ entryId, renderAsMarkdown, ...target }) =>
    sessionChats.setUserMessageMarkdown(target, entryId, renderAsMarkdown),
  "sessionChats.applyConfiguration": ({ configuration, ...target }) =>
    sessionChats.applyConfiguration(target, configuration),
  "sessionChats.setModel": ({ provider, modelId, ...target }) =>
    sessionChats.setModel(target, provider, modelId),
  "sessionChats.setThinkingLevel": ({ level, ...target }) =>
    sessionChats.setThinkingLevel(target, level),
  "sessionChats.setFastMode": ({ enabled, ...target }) => sessionChats.setFastMode(target, enabled),
});
