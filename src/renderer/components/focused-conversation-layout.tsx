import type { ReactNode } from "react";
import { observer } from "r-state-tree/react";
import { LoadingState } from "@/components/ui/loading-state";
import { cn } from "@/lib/utils";
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
      <header
        data-slot="workspace-header"
        className={cn(
          "relative min-w-0 border-b border-border/65 [app-region:drag]",
          compactHeader
            ? "box-content flex h-title-bar items-center gap-3 overflow-hidden px-5"
            : "flex min-h-title-bar flex-col",
        )}
      >
        {compactHeader && titleLeading?.(sessionId)}
        <div
          className={cn(
            "flex min-w-0 items-center",
            compactHeader ? "flex-1" : "min-h-title-bar pl-10 pr-3 py-1.5",
          )}
        >
          {renderTitle ? (
            renderTitle(sessionId)
          ) : (
            <strong className="min-w-0 flex-1 truncate text-sm font-semibold">
              {title(sessionId)}
            </strong>
          )}
        </div>
        <div
          data-slot="workspace-actions"
          className={cn(
            "flex min-w-0 items-center gap-1 overflow-x-auto [app-region:no-drag]",
            compactHeader
              ? "-my-1 max-w-[70%] shrink-0 py-1"
              : "justify-end border-t border-border/40 px-3 py-1",
          )}
        >
          {!compactHeader && renderTitle && (
            <strong
              className="min-w-0 flex-1 truncate text-sm font-semibold"
              title={title(sessionId)}
            >
              {title(sessionId)}
            </strong>
          )}
          {session && renderHeader(session)}
        </div>
      </header>
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
