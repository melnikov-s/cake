import type { ReactNode } from "react";
import { observer } from "r-state-tree/react";
import { AccessoryPanelLayout } from "@/components/ui/accessory-panel-layout";
import { SidePanel } from "@/components/ui/side-panel";
import type { ChatStore } from "../stores/ChatStore";
import type { SideChatStore } from "../stores/SideChatStore";
import { SideChatContext } from "./side-chat-context";

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
              eyebrow={target.eyebrow()}
              onClose={() => store.close()}
            >
              {renderChat(target.chatStore)}
            </SidePanel>
          ) : null
        }
      >
        {children}
      </AccessoryPanelLayout>
    </SideChatContext.Provider>
  );
});
