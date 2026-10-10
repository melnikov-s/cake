import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/unstable/rpc";
import { ConversationUpdate, SessionChatError } from "../conversation-data";
import { CakeChatTarget } from "../cake-chat-data";
import { ProjectSessionTarget } from "../project-session-data";

/** Validated target needed to assemble the owning Cake Session runtime profile. */
const ConversationObservationTarget = Schema.TaggedUnion({
  ProjectSession: {
    ...ProjectSessionTarget.fields,
    /** A renderer-known new identity may not have a Pi transcript yet. */
    allowCreate: Schema.optionalKey(Schema.Boolean),
  },
  CakeChatSession: CakeChatTarget.fields,
});

export const ConversationRpc = RpcGroup.make(
  Rpc.make("conversations.observe", {
    payload: ConversationObservationTarget,
    success: ConversationUpdate,
    error: SessionChatError,
    stream: true,
  }),
);
