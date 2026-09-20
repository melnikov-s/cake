import { Stream } from "effect";
import * as cakeChatOperations from "../../domain/cake-chats/cakeChatOperations";
import type { CakeChatRuntimeConfiguration } from "../../domain/cake-chats/cakeChatRuntime";
import { SessionChatError } from "../../domain/conversations/conversation-data";
import * as projectSessionOperations from "../../domain/project-sessions/projectSessionOperations";
import { ConversationRpc } from "../protocol/ConversationRpc";

const asError = (operation: string) =>
  Stream.mapError(
    (cause: unknown) =>
      new SessionChatError({
        operation,
        message: cause instanceof Error ? cause.message : String(cause),
      }),
  );

export const makeConversationHandlers = (configuration: CakeChatRuntimeConfiguration) =>
  ConversationRpc.of({
    "conversations.observe": (target) =>
      target._tag === "ProjectSession"
        ? Stream.unwrap(projectSessionOperations.observeConversation(target)).pipe(
            asError("observeProjectSession"),
          )
        : Stream.unwrap(cakeChatOperations.observeConversation(target, configuration)).pipe(
            asError("observeCakeChatSession"),
          ),
  });
