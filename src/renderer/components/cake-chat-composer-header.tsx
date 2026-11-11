import { observer } from "r-state-tree/react";
import type { CakeChatSessionStore } from "../stores/CakeChatSessionStore";
import { ConversationActivity } from "./conversation-activity";
import { ConversationAttention } from "./conversation-attention";
import { AttentionIcon } from "./ui/icons";

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
      composerSections={
        session.todos.attentionItems.length
          ? [
              {
                id: "attention",
                label: "Needs attention",
                count: session.todos.attentionItems.length,
                icon: (
                  <span className="text-attention">
                    <AttentionIcon />
                  </span>
                ),
                summary: "to-dos",
                accessibleLabel: `Needs attention · ${session.todos.attentionItems.length} to-dos`,
                regionLabel: "Needs attention",
                busy: session.todos.busy,
                renderContent: () => (
                  <ConversationAttention
                    todos={session.todos}
                    activate={(item) => session.activateAttention(item)}
                  />
                ),
              },
            ]
          : []
      }
    />
  );
});
