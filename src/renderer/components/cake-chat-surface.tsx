import { observer, useStore } from "r-state-tree/react";
import { LoadingState } from "@/components/ui/loading-state";
import { ConversationSplitLayout } from "@/components/conversation-split-layout";
import { cn } from "@/lib/utils";
import { RootStore } from "../stores/RootStore";
import type { CakeChatSessionStore } from "../stores/CakeChatSessionStore";
import { CakeChatPaneHeader } from "./cake-chat-pane-header";
import { SessionArtifactPane } from "./session-artifact-pane";

export const CakeChatSurface = observer(function CakeChatSurface() {
  const root = useStore(RootStore);
  const cakeChatCollection = root.cakeChatCollectionStore;
  const shell = root.appShellStore;
  const cakeChatSession =
    shell.selection.kind === "cake-chat" && shell.selection.sessionId
      ? cakeChatCollection.registry.find(shell.selection.sessionId)
      : undefined;
  const sidebarCollapsed = !root.sidebarStore.visible;
  const cakeChatProps = (paneSession: CakeChatSessionStore) => ({
    showContextUsage: false,
    transcriptTransition: {
      ready:
        Boolean(paneSession.model.sessionFile) ||
        root.cakeChatCollectionStore.pendingSessions.isPending(paneSession.sessionId),
    },
    transcriptBehavior: {
      subagents: paneSession.subagentActivityStore,
      inlineWidgets: root.inlineWidgetStore,
      inlineArtifactPreviews: root.inlineArtifactPreviewStore,
    },
    empty: (
      <div className="grid min-h-[calc(100vh-330px)] place-items-center content-center p-10 text-center">
        <span className="grid size-14 rotate-3 place-items-center rounded-bl-[14px] rounded-br-[20px] rounded-tl-[20px] rounded-tr-[14px] border border-border bg-card/75 shadow-[0_20px_70px_-30px_hsl(var(--shadow)/0.5)]">
          <span className="grid size-[27px] select-none place-items-center rounded-bl-[6px] rounded-br-[9px] rounded-tl-[9px] rounded-tr-[6px] bg-foreground text-sm font-black tracking-tighter text-background -rotate-2">
            C
          </span>
        </span>
        <h1 className="mt-5 font-display text-2xl font-semibold tracking-tight">
          What can I help you find or do?
        </h1>
        <p className="mt-3 max-w-[470px] text-sm leading-relaxed text-muted-foreground">
          Ask about your tasks, open one, or delegate work to it.
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
      loadingLabel="Opening Cake Chat"
      headerClassName={(pane) =>
        cakeChatCollection.sessionLayoutStore.panes[0]?.paneId === pane.paneId
          ? cn("max-[620px]:pl-[84px]", sidebarCollapsed && "pl-[124px]")
          : undefined
      }
      renderHeader={(pane, session) => <CakeChatPaneHeader pane={pane} session={session} />}
      wrapPane={(session, children) => (
        <SessionArtifactPane sessionId={session.sessionId}>{children}</SessionArtifactPane>
      )}
      onFocus={(paneId) => root.navigationStore.focusCakeChatPane(paneId)}
      onClose={(paneId) => root.navigationStore.closeCakeChatPane(paneId)}
    />
  ) : (
    <div className="flex h-screen flex-col items-center justify-center gap-3.5 bg-background text-muted-foreground">
      <span className="grid size-[27px] select-none place-items-center rounded-bl-[6px] rounded-br-[9px] rounded-tl-[9px] rounded-tr-[6px] bg-foreground text-sm font-black tracking-tighter text-background -rotate-2">
        C
      </span>
      <LoadingState label="Opening Cake Chat" />
    </div>
  );
});
