import { observer, StoreProvider, useStore } from "r-state-tree/react";
import { LoadingState } from "@/components/ui/loading-state";
import { FocusedConversationLayout } from "@/components/focused-conversation-layout";
import { cn } from "@/lib/utils";
import { cakeChatPropsFor } from "../lib/cake-chat-props";
import { RootStore } from "../stores/RootStore";
import { CakeChatPaneHeader, type CakeChatOverlayChrome } from "./cake-chat-pane-header";
import { CaptureDestinationPicker } from "./capture-destination-picker";
import { ConversationBreadcrumb } from "./conversation-breadcrumb";
import { ProjectChatHeaderLink } from "./project-chat-header-link";
import { ProjectTodoSelectionBar } from "./project-todo-selection-bar";

export const CakeChatSurface = observer(function CakeChatSurface({
  overlay,
}: {
  /** Present when the surface is hosted by the frameless drop-down overlay. */
  overlay?: CakeChatOverlayChrome;
} = {}) {
  const root = useStore(RootStore);
  const cakeChatCollection = root.cakeChatCollectionStore;
  const shell = root.appShellStore;
  const cakeChatSession =
    shell.selection.kind === "cake-chat" && shell.selection.sessionId
      ? cakeChatCollection.registry.find(shell.selection.sessionId)
      : undefined;
  const layout = cakeChatSession
    ? cakeChatCollection.layoutFor(cakeChatSession.sessionId)
    : cakeChatCollection.sessionLayoutStore;
  return cakeChatSession ? (
    <FocusedConversationLayout
      store={layout}
      findSession={(sessionId) => cakeChatCollection.registry.find(sessionId)}
      chatProps={(session) => cakeChatPropsFor(root, session, Boolean(overlay))}
      wrapPane={(session, conversation) => (
        <div className="flex h-full min-h-0 min-w-0 flex-col">
          <ProjectTodoSelectionBar todos={session.todos} />
          <div className="min-h-0 flex-1">{conversation}</div>
        </div>
      )}
      title={(sessionId) =>
        (!overlay
          ? root.conversationNavigatorStore.lineageFor(sessionId).at(-1)?.title
          : undefined) ??
        cakeChatCollection.summaries.find((summary) => summary.sessionId === sessionId)?.title ??
        "New chat"
      }
      renderTitle={
        overlay
          ? () => (
              <StoreProvider store={root.cakeChatOverlayStore.destinationPicker}>
                <CaptureDestinationPicker
                  disabled={false}
                  ariaLabel="Chat destination"
                  variant="title"
                />
              </StoreProvider>
            )
          : (sessionId) => <ConversationBreadcrumb sessionId={sessionId} />
      }
      titleLeading={
        overlay
          ? (sessionId) => (
              <ProjectChatHeaderLink
                projectPath={
                  cakeChatCollection.summaries.find((chat) => chat.sessionId === sessionId)
                    ?.projectPath
                }
              />
            )
          : undefined
      }
      compactHeader={Boolean(overlay)}
      loadingLabel="Opening Cake Chat"
      renderHeader={(session) => <CakeChatPaneHeader session={session} overlay={overlay} />}
      onInteract={(sessionId) =>
        root.appShellStore.recordConversationInteraction({ kind: "cake-chat", sessionId })
      }
    />
  ) : (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-3.5 bg-background text-muted-foreground",
        overlay ? "h-full" : "h-screen",
      )}
    >
      <span className="grid size-[27px] select-none place-items-center rounded-bl-[6px] rounded-br-[9px] rounded-tl-[9px] rounded-tr-[6px] bg-foreground text-sm font-black tracking-tighter text-background -rotate-2">
        C
      </span>
      <LoadingState label="Opening Cake Chat" />
    </div>
  );
});
