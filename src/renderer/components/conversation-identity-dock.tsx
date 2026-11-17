import type { ReactNode } from "react";
import { observer, useStore } from "r-state-tree/react";
import { RootStore } from "../stores/RootStore";
import { ConversationBreadcrumb } from "./conversation-breadcrumb";

/** Float only the displayed Project Session's identity, with clear space below its composer. */
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
    <div
      data-slot="conversation-identity-layout"
      className="relative h-full min-h-0 min-w-0 bg-background"
    >
      <div className="h-full min-h-0 min-w-0 pb-10">{children}</div>
      <div
        data-slot="conversation-identity-positioner"
        className="pointer-events-none absolute inset-x-0 bottom-2 flex min-w-0 justify-center px-4"
      >
        <div
          data-slot="conversation-identity-tab"
          className="pointer-events-auto h-7 min-w-0 max-w-full rounded-lg border border-border/65 bg-popover/95 px-2 shadow-sm backdrop-blur-md"
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
