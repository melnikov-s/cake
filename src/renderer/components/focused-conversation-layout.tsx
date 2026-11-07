import type { ReactNode } from "react";
import { observer } from "r-state-tree/react";
import { LoadingState } from "@/components/ui/loading-state";
import { WorkspaceHeader } from "./ui/workspace-header";
import type { SessionLayoutStore } from "../stores/SessionLayoutStore";
import {
  FocusedConversationPane,
  type ConversationChatProps,
  type PrimarySessionStore,
} from "./focused-conversation-pane";

interface FocusedConversationLayoutProps<T extends PrimarySessionStore> {
  store: SessionLayoutStore;
  findSession(sessionId: string): T | undefined;
  chatProps(session: T): ConversationChatProps;
  title(sessionId: string): string;
  titleLeading?(sessionId: string): ReactNode;
  renderTitle?(sessionId: string): ReactNode;
  loadingLabel: string;
  /** The frameless drop-down retains its existing one-row destination/title chrome. */
  compactHeader?: boolean;
  renderHeader(session: T): ReactNode;
  wrapPane?(session: NoInfer<T>, children: ReactNode): ReactNode;
  onInteract?(sessionId: string): void;
}

export const FocusedConversationLayout = observer(function FocusedConversationLayout<
  T extends PrimarySessionStore,
>({
  store,
  findSession,
  chatProps,
  title,
  titleLeading,
  renderTitle,
  loadingLabel,
  compactHeader = false,
  renderHeader,
  wrapPane,
  onInteract,
}: FocusedConversationLayoutProps<T>) {
  const sessionId = store.focusedSessionId;
  if (!sessionId) return null;
  const session = findSession(sessionId);
  return (
    <section
      data-slot="session-pane"
      data-session-id={sessionId}
      data-focused="true"
      className="group/pane @container/session-pane relative grid h-full min-h-0 min-w-0 grid-rows-[auto_minmax(0,1fr)] overflow-hidden bg-background"
      onWheelCapture={() => onInteract?.(sessionId)}
      onKeyDownCapture={() => onInteract?.(sessionId)}
      onPointerDownCapture={() => onInteract?.(sessionId)}
    >
      <WorkspaceHeader
        compact={compactHeader}
        titleLeading={compactHeader ? titleLeading?.(sessionId) : undefined}
        title={
          renderTitle ? (
            renderTitle(sessionId)
          ) : (
            <strong className="min-w-0 flex-1 truncate text-sm font-semibold">
              {title(sessionId)}
            </strong>
          )
        }
      >
        {session && renderHeader(session)}
      </WorkspaceHeader>
      <div className="h-full min-h-0 min-w-0 overflow-hidden">
        {session ? (
          <FocusedConversationPane
            key={sessionId}
            session={session}
            chatProps={chatProps}
            wrapPane={wrapPane}
          />
        ) : (
          <LoadingState label={loadingLabel} />
        )}
      </div>
    </section>
  );
});
