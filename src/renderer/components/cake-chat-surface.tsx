import { observer, useStore } from "r-state-tree/react";
import { LoadingState } from "@/components/ui/loading-state";
import { ConversationSplitLayout } from "@/components/conversation-split-layout";
import { cn } from "@/lib/utils";
import { SidebarNavigationControls } from "./sidebar-navigation-controls";
import { cakeChatTranscriptBehaviorFor } from "../lib/cake-chat-transcript-behavior";
import { RootStore } from "../stores/RootStore";
import type { CakeChatSessionStore } from "../stores/CakeChatSessionStore";
import { CakeChatPaneHeader, type CakeChatOverlayChrome } from "./cake-chat-pane-header";
import { SessionArtifactPane } from "./session-artifact-pane";
import { ConversationActivity } from "./conversation-activity";
import { ProjectChatHeaderLink } from "./project-chat-header-link";

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
  const cakeChatProps = (paneSession: CakeChatSessionStore) => ({
    composerHeader: (
      <ConversationActivity
        placement="composer"
        sessionId={paneSession.sessionId}
        subagents={paneSession.subagentActivityStore}
        sideChat={paneSession.conversationSessionStore.sideChatStore}
      />
    ),
    parkComposerFocusWhileDictating: !overlay,
    transcriptTransition: {
      ready:
        Boolean(paneSession.model.sessionFile) ||
        root.cakeChatCollectionStore.pendingSessions.isPending(paneSession.sessionId),
    },
    transcriptBehavior: cakeChatTranscriptBehaviorFor(root, paneSession),
    empty: (
      <div className="grid min-h-[calc(100vh-330px)] place-items-center content-center p-10 text-center">
        <span className="grid size-14 rotate-3 place-items-center rounded-bl-[14px] rounded-br-[20px] rounded-tl-[20px] rounded-tr-[14px] border border-border bg-card/75 shadow-[0_20px_70px_-30px_hsl(var(--shadow)/0.5)]">
          <span className="grid size-[27px] select-none place-items-center rounded-bl-[6px] rounded-br-[9px] rounded-tl-[9px] rounded-tr-[6px] bg-foreground text-sm font-black tracking-tighter text-background -rotate-2">
            C
          </span>
        </span>
        <h1 className="mt-5 font-display text-2xl font-semibold tracking-tight">
          {paneSession.sessionId.startsWith("project-chat:")
            ? "Let’s talk about this project"
            : "What can I help you find or do?"}
        </h1>
        <p className="mt-3 max-w-[470px] text-sm leading-relaxed text-muted-foreground">
          {paneSession.sessionId.startsWith("project-chat:")
            ? "Explore ideas, remember decisions, or delegate work—all in one ongoing project conversation."
            : "Ask about your tasks, open one, or delegate work to it."}
        </p>
      </div>
    ),
  });
  return cakeChatSession ? (
    <ConversationSplitLayout
      store={cakeChatCollection.sessionLayoutStore}
      findSession={(sessionId) => cakeChatCollection.registry.find(sessionId)}
      chatProps={cakeChatProps}
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
      wrapPane={(session, children) => (
        <SessionArtifactPane sessionId={session.sessionId}>{children}</SessionArtifactPane>
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
