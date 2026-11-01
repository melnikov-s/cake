import type { ReactNode } from "react";
import { LoadingState } from "@/components/ui/loading-state";
import type {
  SessionLayoutStore,
  SessionPaneNode,
  SessionSplitAxis,
} from "../stores/SessionLayoutStore";
import { SessionSplitLayout } from "./session-split-layout";
import {
  ConversationSplitPane,
  type ConversationChatProps,
  type PrimarySessionStore,
} from "./conversation-split-pane";

interface ConversationSplitLayoutProps<T extends PrimarySessionStore> {
  store: SessionLayoutStore;
  findSession(sessionId: string): T | undefined;
  chatProps(session: T, pane: SessionPaneNode): ConversationChatProps;
  title(sessionId: string): string;
  titleLeading?(sessionId: string): ReactNode;
  loadingLabel: string;
  headerClassName?(pane: SessionPaneNode): string | undefined;
  renderHeader(pane: SessionPaneNode, session: T): ReactNode;
  renderNavigation?(pane: SessionPaneNode): ReactNode;
  wrapPane?(session: NoInfer<T>, children: ReactNode): ReactNode;
  onFocus(paneId: string): void;
  onSplit?(axis: SessionSplitAxis): void;
  onClose(paneId: string): void;
}

export function ConversationSplitLayout<T extends PrimarySessionStore>({
  store,
  findSession,
  chatProps,
  title,
  titleLeading,
  loadingLabel,
  headerClassName,
  renderHeader,
  renderNavigation,
  wrapPane,
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
      titleLeading={titleLeading}
      headerClassName={headerClassName}
      renderNavigation={renderNavigation}
      renderHeader={(pane) => {
        const session = sessionForPane(pane);
        return session ? renderHeader(pane, session) : null;
      }}
      renderPane={(pane) => {
        const session = sessionForPane(pane);
        if (!session) return <LoadingState label={loadingLabel} />;
        return (
          <ConversationSplitPane
            key={pane.paneId}
            layout={store}
            pane={pane}
            session={session}
            chatProps={chatProps}
            wrapPane={wrapPane}
          />
        );
      }}
      onFocus={onFocus}
      onSplit={onSplit}
      onClose={onClose}
    />
  );
}
