import { observer, useStore } from "r-state-tree/react";
import { LoadingState } from "@/components/ui/loading-state";
import { ConversationSplitLayout } from "@/components/conversation-split-layout";
import { cn } from "@/lib/utils";
import { SidebarNavigationControls } from "./sidebar-navigation-controls";
import { cakeChatPropsFor } from "../lib/cake-chat-props";
import { RootStore } from "../stores/RootStore";
import { CakeChatPaneHeader, type CakeChatOverlayChrome } from "./cake-chat-pane-header";
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
  const sidebarCollapsed = !root.sidebarStore.visible;
  return cakeChatSession ? (
    <ConversationSplitLayout
      store={cakeChatCollection.sessionLayoutStore}
      findSession={(sessionId) => cakeChatCollection.registry.find(sessionId)}
      chatProps={(session) => cakeChatPropsFor(root, session, Boolean(overlay))}
      wrapPane={(session, conversation) => (
        <div className="flex h-full min-h-0 min-w-0 flex-col">
          <ProjectTodoSelectionBar todos={session.todos} />
          <div className="min-h-0 flex-1">{conversation}</div>
        </div>
      )}
      title={(sessionId) =>
        cakeChatCollection.summaries.find((summary) => summary.sessionId === sessionId)?.title ??
        "New chat"
      }
      titleLeading={(sessionId) => (
        <ProjectChatHeaderLink
          projectPath={
            cakeChatCollection.summaries.find((chat) => chat.sessionId === sessionId)?.projectPath
          }
        />
      )}
      loadingLabel="Opening Cake Chat"
      headerClassName={(pane) =>
        // The frameless overlay has no traffic lights or sidebar toggle to make room for.
        !overlay && cakeChatCollection.sessionLayoutStore.panes[0]?.paneId === pane.paneId
          ? cn("max-[620px]:pl-[88px] phone:pl-[88px]", sidebarCollapsed && "pl-[156px]")
          : undefined
      }
      renderNavigation={(pane) =>
        !overlay && cakeChatCollection.sessionLayoutStore.panes[0]?.paneId === pane.paneId ? (
          <SidebarNavigationControls header />
        ) : null
      }
      renderHeader={(pane, session) => (
        <CakeChatPaneHeader pane={pane} session={session} overlay={overlay} />
      )}
      onFocus={(paneId) => root.navigationStore.focusCakeChatPane(paneId)}
      onClose={(paneId) => root.navigationStore.closeCakeChatPane(paneId)}
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
