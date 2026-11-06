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
  // Keep merge near the composer; pane dismissal always belongs in the header.
  const dockMergeAction = Boolean(target?.chatStore?.composerVisible && target.merge);
  const mergeAction = target?.merge && (
    <Button
      variant="outline"
      size="sm"
      disabled={target.merge.disabled}
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
  // A selected Side chat/Subagent is the focused conversation, not an independent split.
  // Preserve its existing ChatStore and Pi transcript; only presentation changes.
  if (focusConversation && target?.chatStore)
    return (
      <SideChatContext.Provider value={store}>
        <section
          data-slot="focused-secondary-conversation"
          aria-label={target.title}
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
              title={target.title}
              eyebrow={target.eyebrow?.()}
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
                    {model && <ModelSummary {...model} className="max-w-[65%]" />}
                    {!dockMergeAction && mergeAction}
                  </>
                )
              }
            >
              <div className="flex h-full min-h-0 flex-col">
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
        {children}
      </AccessoryPanelLayout>
    </SideChatContext.Provider>
  );
});
