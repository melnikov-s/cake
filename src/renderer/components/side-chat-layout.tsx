import type { ReactNode } from "react";
import { observer } from "r-state-tree/react";
import { AccessoryPanelLayout } from "@/components/ui/accessory-panel-layout";
import { SidePanel } from "@/components/ui/side-panel";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { CloseIcon } from "@/components/ui/icons";
import { Callout } from "@/components/ui/callout";
import { SearchInput } from "@/components/ui/search-input";
import type { ChatStore } from "../stores/ChatStore";
import type { SideChatStore } from "../stores/SideChatStore";
import { SideChatContext } from "./side-chat-context";
import { ProjectTodosPanel } from "./project-todos-panel";
import { ArtifactMenuSurface } from "./artifact-menu-surface";
import { ModelSummary } from "./model-summary";

export const SideChatLayout = observer(function SideChatLayout({
  store,
  children,
  renderChat,
  hideTodos = false,
  hideArtifact = false,
}: {
  store: SideChatStore;
  children: ReactNode;
  renderChat(store: ChatStore, composerHeader: ReactNode): ReactNode;
  /** Workspace chat drawers keep the conversation visible without clearing the to-do selection. */
  hideTodos?: boolean;
  /** Fullscreen already hosts this artifact; do not recursively render it in its chat drawer. */
  hideArtifact?: boolean;
}) {
  const target =
    (hideTodos && store.target?.todos) || (hideArtifact && store.target?.artifact)
      ? undefined
      : store.target;
  const model = target?.model?.();
  // Read-only conversations and non-chat panels retain their header controls.
  const dockActions = Boolean(target?.chatStore?.composerVisible);
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
  const composerHeader = dockActions && target && (
    <div
      data-slot="side-chat-actions"
      className="flex shrink-0 items-center justify-end gap-3 px-3 py-2"
    >
      {mergeAction}
      <IconButton
        tooltip={`Close ${target.title}`}
        ariaLabel={`Close ${target.title}`}
        onClick={() => store.close()}
      >
        <CloseIcon size={14} />
      </IconButton>
    </div>
  );
  return (
    <SideChatContext.Provider value={store}>
      <AccessoryPanelLayout
        dataSlot="side-chat-layout"
        open={Boolean(target)}
        width={store.width}
        resizeLabel="Resize side chat"
        onWidthChange={(width) => store.setWidth(width)}
        panel={
          target?.artifact ? (
            <ArtifactMenuSurface paneStore={target.artifact} />
          ) : target ? (
            <SidePanel
              title={target.title}
              eyebrow={target.eyebrow?.()}
              onClose={dockActions ? undefined : () => store.close()}
              headerActions={
                target.todos ? (
                  <SearchInput
                    label="Search to-dos"
                    value={target.todos.query}
                    onValueChange={(query) => target.todos?.setQuery(query)}
                    className="w-36 max-w-[50%] shrink-0"
                  />
                ) : (
                  <>
                    {model && <ModelSummary {...model} className="max-w-[65%]" />}
                    {!dockActions && mergeAction}
                  </>
                )
              }
            >
              <div className="flex h-full min-h-0 flex-col">
                {target.merge?.error && <Callout variant="error">{target.merge.error}</Callout>}
                <div className="min-h-0 flex-1">
                  {target.todos ? (
                    <ProjectTodosPanel store={target.todos} />
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
