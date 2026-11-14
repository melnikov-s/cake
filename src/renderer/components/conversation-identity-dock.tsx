import type { ReactNode } from "react";
import { observer, useStore } from "r-state-tree/react";
import { RootStore } from "../stores/RootStore";
import { ConversationBreadcrumb } from "./conversation-breadcrumb";

/** Reserve a compact bottom row only for the displayed Project Session chat. */
export const ConversationIdentityDock = observer(function ConversationIdentityDock({
  sessionId,
  children,
}: {
  sessionId?: string;
  children: ReactNode;
}) {
  const root = useStore(RootStore);
  const active = root.appShellStore.activeConversation;
  if (
    !sessionId ||
    active?.kind !== "project-session" ||
    active.sessionId !== sessionId ||
    !root.settingsStore.appearance.conversationIdentityEnabled
  )
    return children;
  return (
    <div data-slot="conversation-identity-layout" className="flex h-full min-h-0 min-w-0 flex-col">
      <div className="min-h-0 min-w-0 flex-1">{children}</div>
      <div className="flex min-w-0 shrink-0 justify-center px-4">
        <div
          data-slot="conversation-identity-tab"
          className="h-7 min-w-0 max-w-full rounded-t-lg border border-b-0 border-border/65 bg-sidebar/60 px-2"
        >
          <ConversationBreadcrumb
            sessionId={sessionId}
            ariaLabel="Conversation identity"
            includeChatTitle
          />
        </div>
      </div>
    </div>
  );
});
