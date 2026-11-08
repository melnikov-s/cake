import { observer } from "r-state-tree/react";
import type { CakeChatSessionStore } from "../stores/CakeChatSessionStore";
import { ConversationActivity } from "./conversation-activity";
import { ConversationAttention } from "./conversation-attention";

/** The owning durable chat's queue, shared by normal, Browser, VS Code and overlay surfaces. */
export const CakeChatComposerHeader = observer(function CakeChatComposerHeader({
  session,
}: {
  session: CakeChatSessionStore;
}) {
  return (
    <ConversationActivity
      placement="composer"
      sessionId={session.sessionId}
      subagents={session.subagentActivityStore}
      sideChat={session.conversationSessionStore.sideChatStore}
      composerFooter={
        session.todos.attentionItems.length ? (
          <ConversationAttention todos={session.todos} />
        ) : undefined
      }
    />
  );
});
