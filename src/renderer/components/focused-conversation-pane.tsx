import type { ComponentProps, ReactNode } from "react";
import type { Store } from "r-state-tree";
import { observer, StoreProvider } from "r-state-tree/react";
import { Chat } from "./chat";
import { NestedChat } from "./nested-chat";
import { SideChatLayout } from "./side-chat-layout";
import { WorkflowConversationLayout } from "./workflow-conversation-layout";
import { WorkflowProgress } from "./workflow-progress";
import type { ChatStore } from "../stores/ChatStore";
import type { SideChatStore } from "../stores/SideChatStore";
import type { WorkflowRunStore } from "../stores/WorkflowRunStore";

export type ConversationChatProps = Omit<ComponentProps<typeof Chat>, "store">;

export type PrimarySessionStore = Store & {
  readonly workflowRunStores?: readonly WorkflowRunStore[];
  readonly conversationSessionStore: {
    readonly chatStore: ChatStore;
    readonly sideChatStore: SideChatStore;
  };
};

/** Keep loading/readiness reads in this pane’s own observed render, not a layout callback. */
export const FocusedConversationPane = observer(function FocusedConversationPane<
  T extends PrimarySessionStore,
>({
  session,
  chatProps,
  wrapPane,
}: {
  session: T;
  chatProps(session: T): ConversationChatProps;
  wrapPane?(session: T, children: ReactNode): ReactNode;
}) {
  const props = chatProps(session);
  const workflows = session.workflowRunStores ?? [];
  const conversation = (
    <WorkflowConversationLayout stores={workflows}>
      <SideChatLayout
        store={session.conversationSessionStore.sideChatStore}
        renderChat={(sideChatStore, composerHeader) => (
          <NestedChat
            store={sideChatStore}
            composerHeader={composerHeader}
            composerFocusEnabled
            parentBehavior={props.transcriptBehavior}
          />
        )}
      >
        <Chat
          store={session.conversationSessionStore.chatStore}
          composerFocusEnabled
          {...props}
          footer={
            <>
              {props.footer}
              {workflows.map((workflow) => (
                <WorkflowProgress
                  key={workflow.sessionId}
                  store={workflow}
                  onDetails={() =>
                    workflows.forEach((other) => {
                      if (other !== workflow) other.close();
                    })
                  }
                />
              ))}
            </>
          }
        />
      </SideChatLayout>
    </WorkflowConversationLayout>
  );
  return (
    <StoreProvider store={session}>
      {wrapPane ? wrapPane(session, conversation) : conversation}
    </StoreProvider>
  );
});
