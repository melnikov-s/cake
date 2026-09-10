import type { ComponentProps, ReactNode } from "react";
import type { Store } from "r-state-tree";
import { StoreProvider } from "r-state-tree/react";
import { Chat } from "@/components/chat";
import { LoadingState } from "@/components/ui/loading-state";
import type { ChatStore } from "../stores/ChatStore";
import type {
  SessionLayoutStore,
  SessionPaneNode,
  SessionSplitAxis,
} from "../stores/SessionLayoutStore";
import { SessionSplitLayout } from "./session-split-layout";

type ConversationChatProps = Omit<ComponentProps<typeof Chat>, "store">;

type PrimarySessionStore = Store & {
  readonly conversationSessionStore: { readonly chatStore: ChatStore };
};

interface ConversationSplitLayoutProps<T extends PrimarySessionStore> {
  store: SessionLayoutStore;
  findSession(sessionId: string): T | undefined;
  chatProps(session: T, pane: SessionPaneNode): ConversationChatProps;
  title(sessionId: string): string;
  loadingLabel: string;
  headerClassName?(pane: SessionPaneNode): string | undefined;
  renderHeader(pane: SessionPaneNode, session: T): ReactNode;
  onFocus(paneId: string): void;
  onSplit(axis: SessionSplitAxis): void;
  onClose(paneId: string): void;
}

export function ConversationSplitLayout<T extends PrimarySessionStore>({
  store,
  findSession,
  chatProps,
  title,
  loadingLabel,
  headerClassName,
  renderHeader,
  onFocus,
  onSplit,
  onClose,
}: ConversationSplitLayoutProps<T>) {
  const sessionForPane = (pane: SessionPaneNode) => {
    const sessionId = pane.history[pane.historyCursor];
    return sessionId ? findSession(sessionId) : undefined;
  };

  return (
    <SessionSplitLayout
      store={store}
      title={title}
      headerClassName={headerClassName}
      renderHeader={(pane) => {
        const session = sessionForPane(pane);
        return session ? renderHeader(pane, session) : null;
      }}
      renderPane={(pane) => {
        const session = sessionForPane(pane);
        if (!session) return <LoadingState label={loadingLabel} />;
        return (
          <StoreProvider key={pane.paneId} store={session}>
            <Chat
              store={session.conversationSessionStore.chatStore}
              composerFocusEnabled={store.focusedPaneId === pane.paneId}
              {...chatProps(session, pane)}
            />
          </StoreProvider>
        );
      }}
      onFocus={onFocus}
      onSplit={onSplit}
      onClose={onClose}
    />
  );
}
