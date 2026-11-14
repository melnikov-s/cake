import type { ComponentProps, ReactNode } from "react";
import type { Store } from "r-state-tree";
import { observer, StoreProvider } from "r-state-tree/react";
import { Chat } from "./chat";
import { ConversationIdentityDock } from "./conversation-identity-dock";
import { NestedChat } from "./nested-chat";
import { SideChatLayout } from "./side-chat-layout";
import type { ChatStore } from "../stores/ChatStore";
import type { SideChatStore } from "../stores/SideChatStore";

export type ConversationChatProps = Omit<ComponentProps<typeof Chat>, "store">;

export type PrimarySessionStore = Store & {
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
  identitySessionId,
}: {
  session: T;
  identitySessionId?: string;
  chatProps(session: T): ConversationChatProps;
  wrapPane?(session: T, children: ReactNode): ReactNode;
}) {
  const props = chatProps(session);
  const conversation = (
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
      <ConversationIdentityDock sessionId={identitySessionId}>
        <Chat store={session.conversationSessionStore.chatStore} composerFocusEnabled {...props} />
      </ConversationIdentityDock>
    </SideChatLayout>
  );
  return (
    <StoreProvider store={session}>
      {wrapPane ? wrapPane(session, conversation) : conversation}
    </StoreProvider>
  );
});
