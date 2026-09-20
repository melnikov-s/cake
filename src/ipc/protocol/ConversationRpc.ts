import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/unstable/rpc";
import { ConversationUpdate, SessionChatError } from "../../domain/conversations/conversation-data";
import { CakeChatTarget } from "../../domain/cake-chats/cake-chat-data";
import { ProjectSessionTarget } from "../../domain/project-sessions/project-session-data";

/** Validated target needed to assemble the owning Cake Session runtime profile. */
export const ConversationObservationTarget = Schema.TaggedUnion({
  ProjectSession: ProjectSessionTarget.fields,
  CakeChatSession: CakeChatTarget.fields,
});
export type ConversationObservationTarget = Schema.Schema.Type<
  typeof ConversationObservationTarget
>;

export const ConversationRpc = RpcGroup.make(
  Rpc.make("conversations.observe", {
    payload: ConversationObservationTarget,
    success: ConversationUpdate,
    error: SessionChatError,
    stream: true,
  }),
);
