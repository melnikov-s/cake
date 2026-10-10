import { observer } from "r-state-tree/react";
import type { CakeChatCollectionStore } from "../stores/CakeChatCollectionStore";
import type { AppShellStore } from "../stores/AppShellStore";
import { NavItem } from "./ui/nav-item";
import { CakeIcon } from "./ui/icons";

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
      active={shell.selection.kind === "cake-chat"}
      className="mb-3"
      onClick={() => onOpenCakeChat(cakeChat.sessionId)}
    />
  );
});
