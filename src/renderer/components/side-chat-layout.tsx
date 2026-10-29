import type { ReactNode } from "react";
import { observer } from "r-state-tree/react";
import { AccessoryPanelLayout } from "@/components/ui/accessory-panel-layout";
import { SidePanel } from "@/components/ui/side-panel";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { SearchInput } from "@/components/ui/search-input";
import type { ChatStore } from "../stores/ChatStore";
import type { SideChatStore } from "../stores/SideChatStore";
import { SideChatContext } from "./side-chat-context";
import { ProjectTodosPanel } from "./project-todos-panel";
import { ModelSummary } from "./model-summary";

export const SideChatLayout = observer(function SideChatLayout({
  store,
  children,
  renderChat,
  hideTodos = false,
}: {
  store: SideChatStore;
  children: ReactNode;
  renderChat(store: ChatStore): ReactNode;
  /** Workspace chat drawers keep the conversation visible without clearing the to-do selection. */
  hideTodos?: boolean;
}) {
  const target = hideTodos && store.target?.todos ? undefined : store.target;
  const model = target?.model?.();
  return (
    <SideChatContext.Provider value={store}>
      <AccessoryPanelLayout
        dataSlot="side-chat-layout"
        open={Boolean(target)}
        width={store.width}
        resizeLabel="Resize side chat"
        onWidthChange={(width) => store.setWidth(width)}
        panel={
          target ? (
            <SidePanel
              title={target.title}
              eyebrow={target.eyebrow?.()}
              onClose={() => store.close()}
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
                    {target.merge && (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={target.merge.disabled}
                        onClick={() => void target.merge?.run()}
                      >
                        {target.merge.label}
                      </Button>
                    )}
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
                    renderChat(target.chatStore)
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
