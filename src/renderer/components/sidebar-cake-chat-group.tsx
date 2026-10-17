import { CAKE_CHAT_SESSION_ID } from "../../contracts/cake-chats/cake-chat-identity";
import { observer } from "r-state-tree/react";
import type { CakeChatCollectionStore } from "../stores/CakeChatCollectionStore";
import type { AppShellStore } from "../stores/AppShellStore";
import { NavItem } from "./ui/nav-item";
import { CakeIcon } from "./ui/icons";
import { SessionActivityIndicator } from "./session-activity-indicator";

export const SidebarCakeChatGroup = observer(function SidebarCakeChatGroup({
  cakeChat,
  shell,
  onOpenCakeChat,
}: {
  cakeChat: CakeChatCollectionStore;
  shell: AppShellStore;
  onOpenCakeChat(sessionId?: string): void;
}) {
  return (
    <NavItem
      data-slot="cake-chat-group"
      label="Cake Chat"
      icon={<CakeIcon aria-hidden />}
      active={
        shell.selection.kind === "cake-chat" && shell.selection.sessionId === CAKE_CHAT_SESSION_ID
      }
      className="mb-3"
      trailing={
        cakeChat.activity && (
          <span className="flex w-8 shrink-0 items-center justify-center">
            <SessionActivityIndicator activity={cakeChat.activity} />
          </span>
        )
      }
      onClick={() => onOpenCakeChat(CAKE_CHAT_SESSION_ID)}
      onContextMenu={(event) => {
        event.preventDefault();
        const { clientX, clientY } = event;
        requestAnimationFrame(() => void cakeChat.showContextMenu(clientX, clientY));
      }}
    />
  );
});
