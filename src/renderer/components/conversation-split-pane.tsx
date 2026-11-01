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
import type { SessionLayoutStore, SessionPaneNode } from "../stores/SessionLayoutStore";

export type ConversationChatProps = Omit<ComponentProps<typeof Chat>, "store">;

export type PrimarySessionStore = Store & {
  readonly workflowRunStores?: readonly WorkflowRunStore[];
  readonly conversationSessionStore: {
    readonly chatStore: ChatStore;
    readonly sideChatStore: SideChatStore;
  };
};

/** Keep loading/readiness reads in this pane’s own observed render, not a layout callback. */
export const ConversationSplitPane = observer(function ConversationSplitPane<
  T extends PrimarySessionStore,
>({
  layout,
  pane,
  session,
  chatProps,
  wrapPane,
}: {
  layout: SessionLayoutStore;
  pane: SessionPaneNode;
  session: T;
  chatProps(session: T, pane: SessionPaneNode): ConversationChatProps;
  wrapPane?(session: T, children: ReactNode): ReactNode;
}) {
  const props = chatProps(session, pane);
  const workflows = session.workflowRunStores ?? [];
  const conversation = (
    <WorkflowConversationLayout stores={workflows}>
      <SideChatLayout
        store={session.conversationSessionStore.sideChatStore}
        renderChat={(sideChatStore, composerHeader) => (
          <NestedChat
            store={sideChatStore}
            composerHeader={composerHeader}
            composerFocusEnabled={layout.focusedPaneId === pane.paneId}
            parentBehavior={props.transcriptBehavior}
          />
        )}
      >
        <Chat
          store={session.conversationSessionStore.chatStore}
          composerFocusEnabled={layout.focusedPaneId === pane.paneId}
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
