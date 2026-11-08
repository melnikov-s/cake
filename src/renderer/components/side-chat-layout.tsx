import { useContext, useId, type ReactNode } from "react";
import { ConversationFocusContext } from "../lib/conversation-focus-context";
import { observer } from "r-state-tree/react";
import { AccessoryPanelLayout } from "@/components/ui/accessory-panel-layout";
import { SidePanel } from "@/components/ui/side-panel";
import { PaneTabs } from "@/components/ui/pane-tabs";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import type { ChatStore } from "../stores/ChatStore";
import type { SideChatStore } from "../stores/SideChatStore";
import { SideChatContext } from "./side-chat-context";
import { ArtifactMenuSurface } from "./artifact-menu-surface";
import { ModelSummary } from "./model-summary";
import { SideChatsMenu } from "./side-chats-menu";
import { SessionChangesPanel } from "./session-changes-panel";
import { IconButton } from "./ui/icon-button";
import { CheckIcon, MergeResolveIcon, ReloadIcon } from "./ui/icons";

export const SideChatLayout = observer(function SideChatLayout({
  store,
  children,
  renderChat,
  hideArtifact = false,
}: {
  store: SideChatStore;
  children: ReactNode;
  renderChat(store: ChatStore, composerHeader: ReactNode): ReactNode;
  /** Fullscreen already hosts this artifact; do not recursively render it in its chat drawer. */
  hideArtifact?: boolean;
}) {
  const focusConversation = useContext(ConversationFocusContext);
  const target = hideArtifact && store.target?.artifact ? undefined : store.target;
  const tabId = useId();
  const panelId = `${tabId}-panel`;
  const tabs = store.tabs;
  const selectedTab =
    target?.navigationTarget?.kind === "side-chat" ? target.navigationTarget.threadId : undefined;
  const showTabs = tabs.length > 1 && selectedTab !== undefined;
  const model = target?.model?.();
  const title = target?.currentTitle?.() ?? target?.title ?? "";
  const isSideChat = Boolean(
    target && (target.pending || (target.chatStore && !target.key.startsWith("subagent:"))),
  );
  const showExitActions = isSideChat && Boolean(target?.resolve);
  const dockActions = Boolean(
    target?.chatStore?.composerVisible && (target.merge || showExitActions),
  );
  const mergeAction = target?.merge && (
    <Button
      variant={showExitActions ? "default" : "outline"}
      size="sm"
      className={showExitActions ? "flex-1 gap-1.5" : "gap-1.5"}
      disabled={store.resolving}
      aria-busy={target.merge.pending}
      onClick={async () => {
        const merged = await target.merge?.run();
        if (merged && store.target === target) store.close();
      }}
    >
      <MergeResolveIcon />
      {target.merge.label}
    </Button>
  );
  const actions = (
    <div
      data-slot="side-chat-actions"
      role="group"
      aria-label="Side chat actions"
      className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-border/65 bg-sidebar/30 px-3 py-2"
    >
      {mergeAction}
      {showExitActions && (
        <Button
          variant="outline"
          size="sm"
          className="flex-1 gap-1.5"
          disabled={store.resolving || target?.merge?.pending}
          onClick={() => void store.closeAndResolve()}
        >
          <CheckIcon />
          Close and resolve
        </Button>
      )}
    </div>
  );
  const composerHeader = dockActions && actions;
  // Subagents retain their focused presentation; user side chats use the responsive accessory.
  if (focusConversation && target?.chatStore && target.key.startsWith("subagent:"))
    return (
      <SideChatContext.Provider value={store}>
        <section
          data-slot="focused-secondary-conversation"
          aria-label={title}
          className="flex h-full min-h-0 min-w-0 flex-col"
        >
          {target.merge?.error && <Callout variant="error">{target.merge.error}</Callout>}
          <div className="min-h-0 flex-1">{renderChat(target.chatStore, composerHeader)}</div>
        </section>
      </SideChatContext.Provider>
    );
  return (
    <SideChatContext.Provider value={store}>
      <AccessoryPanelLayout
        dataSlot="side-chat-layout"
        open={Boolean(target)}
        width={target?.changes?.width ?? store.width}
        resizeLabel={target?.changes ? "Resize changes" : "Resize side chat"}
        onWidthChange={(width) =>
          target?.changes ? target.changes.setWidth(width) : store.setWidth(width)
        }
        panel={
          target?.artifact ? (
            <ArtifactMenuSurface paneStore={target.artifact} />
          ) : target ? (
            <SidePanel
              title={title}
              compact={isSideChat}
              eyebrow={isSideChat ? undefined : target.eyebrow?.()}
              closeLabel={isSideChat ? "Close side chat" : undefined}
              onClose={() => store.close()}
              headerActions={
                target.changes ? (
                  <IconButton
                    tooltip="Refresh changes"
                    disabled={target.changes.loading}
                    onClick={() => void target.changes?.refresh()}
                  >
                    <ReloadIcon />
                  </IconButton>
                ) : (
                  <>
                    {target.navigationTarget?.kind === "side-chat" && (
                      <SideChatsMenu store={{ sessionId: target.navigationTarget.sessionId }} />
                    )}
                    {model && <ModelSummary {...model} className="max-w-[65%]" />}
                    {!dockActions && !showExitActions && mergeAction}
                  </>
                )
              }
            >
              <div className="flex h-full min-h-0 min-w-0 flex-col">
                {showTabs && (
                  <PaneTabs
                    id={tabId}
                    label="Side chats"
                    items={tabs}
                    value={selectedTab}
                    panelId={panelId}
                    onValueChange={(threadId) => store.selectTab(threadId)}
                  />
                )}
                {showExitActions && !dockActions && actions}
                {store.resolutionError && (
                  <Callout variant="error">{store.resolutionError}</Callout>
                )}
                {target.merge?.error && <Callout variant="error">{target.merge.error}</Callout>}
                <div
                  key={target.key}
                  id={panelId}
                  role={showTabs ? "tabpanel" : undefined}
                  aria-labelledby={showTabs ? `${tabId}-${selectedTab}` : undefined}
                  className="min-h-0 min-w-0 flex-1"
                >
                  {target.pending ? (
                    <div className="flex flex-col gap-3 p-3">
                      <p role="status" className="text-xs text-muted-foreground">
                        {target.pending.message()}
                      </p>
                      {target.pending.retry && (
                        <Button variant="outline" size="sm" onClick={target.pending.retry}>
                          Retry opening
                        </Button>
                      )}
                    </div>
                  ) : target.changes ? (
                    <SessionChangesPanel store={target.changes} />
                  ) : (
                    renderChat(target.chatStore, composerHeader)
                  )}
                </div>
              </div>
            </SidePanel>
          ) : null
        }
      >
        {target?.chatStore && target.parentChatStore
          ? renderChat(target.parentChatStore, null)
          : children}
      </AccessoryPanelLayout>
    </SideChatContext.Provider>
  );
});
