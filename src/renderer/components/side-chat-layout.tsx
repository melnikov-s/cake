import { useContext, type ReactNode } from "react";
import { ConversationFocusContext } from "../lib/conversation-focus-context";
import { observer } from "r-state-tree/react";
import { AccessoryPanelLayout } from "@/components/ui/accessory-panel-layout";
import { SidePanel } from "@/components/ui/side-panel";
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
import { ReloadIcon } from "./ui/icons";

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
  const model = target?.model?.();
  const title = target?.currentTitle?.() ?? target?.title ?? "";
  const isSideChat = Boolean(target?.chatStore && !target.key.startsWith("subagent:"));
  // Keep merge near the composer; pane dismissal always belongs in the header.
  const dockMergeAction = Boolean(target?.chatStore?.composerVisible && target.merge);
  const mergeAction = target?.merge && (
    <Button
      variant="outline"
      size="sm"
      disabled={target.merge.disabled || store.resolving}
      onClick={() => void target.merge?.run()}
    >
      {target.merge.label}
    </Button>
  );
  const composerHeader = dockMergeAction && (
    <div
      data-slot="side-chat-actions"
      className="flex shrink-0 items-center justify-end gap-3 px-3 py-2"
    >
      {mergeAction}
    </div>
  );
  // Subagents retain their focused presentation; user side chats always keep their origin visible.
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
        keepParentVisible={Boolean(target?.chatStore && !target.key.startsWith("subagent:"))}
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
              closeLabel={target.resolve ? "Close and resolve" : undefined}
              closeDisabled={store.resolving || target.merge?.pending}
              onClose={() => (target.resolve ? void store.closeAndResolve() : store.close())}
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
                    {!dockMergeAction && mergeAction}
                  </>
                )
              }
            >
              <div className="flex h-full min-h-0 flex-col">
                {store.resolutionError && (
                  <Callout variant="error">{store.resolutionError}</Callout>
                )}
                {target.merge?.error && <Callout variant="error">{target.merge.error}</Callout>}
                <div className="min-h-0 flex-1">
                  {target.changes ? (
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
