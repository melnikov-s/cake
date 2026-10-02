import { IconButton } from "./icon-button";
import { ChatSidebarIcon, SidebarIcon } from "./icons";

/** Matching left-navigation and right-chat panel controls for workspace headers. */
export function WorkspacePanelToggle({
  panel,
  visible,
  onToggle,
}: {
  panel: "sidebar" | "chat";
  visible: boolean;
  onToggle(): void;
}) {
  return (
    <IconButton
      data-slot={panel === "sidebar" ? "header-sidebar-toggle" : "header-chat-toggle"}
      data-cake-hint-key={panel === "sidebar" ? "s" : undefined}
      tooltip={`${visible ? "Close" : "Open"} ${panel}`}
      hotkey={panel === "sidebar" ? "toggle-sidebar" : undefined}
      aria-expanded={visible}
      onClick={onToggle}
    >
      {panel === "sidebar" ? <SidebarIcon /> : <ChatSidebarIcon />}
    </IconButton>
  );
}
