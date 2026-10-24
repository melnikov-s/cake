import type { ReactNode } from "react";
import { observer } from "r-state-tree/react";
import { AccessoryPanelLayout } from "@/components/ui/accessory-panel-layout";
import { SidePanel } from "@/components/ui/side-panel";
import { SearchInput } from "@/components/ui/search-input";
import type { ChatStore } from "../stores/ChatStore";
import type { SideChatStore } from "../stores/SideChatStore";
import { SideChatContext } from "./side-chat-context";
import { ProjectTodosPanel } from "./project-todos-panel";

export const SideChatLayout = observer(function SideChatLayout({
  store,
  children,
  renderChat,
}: {
  store: SideChatStore;
  children: ReactNode;
  renderChat(store: ChatStore): ReactNode;
}) {
  const target = store.target;
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
                target.todos && (
                  <SearchInput
                    label="Search to-dos"
                    value={target.todos.query}
                    onValueChange={(query) => target.todos?.setQuery(query)}
                    className="w-36 max-w-[50%] shrink-0"
                  />
                )
              }
            >
              {target.todos ? (
                <ProjectTodosPanel store={target.todos} />
              ) : (
                renderChat(target.chatStore)
              )}
            </SidePanel>
          ) : null
        }
      >
        {children}
      </AccessoryPanelLayout>
    </SideChatContext.Provider>
  );
});
