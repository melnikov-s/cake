import { observer, useStore } from "r-state-tree/react";
import { RootStore } from "../stores/RootStore";
import { IconButton } from "./ui/icon-button";
import { ChatSidebarIcon } from "./ui/icons";

/** One shell-owned Workspace control, retained in place when the accessory closes. */
export const SidebarNavigationControls = observer(function SidebarNavigationControls() {
  const navigator = useStore(RootStore).workspaceNavigatorStore;
  const label = navigator.paneVisible ? "Close Workspace" : "Open Workspace";
  return (
    <IconButton
      data-slot="shell-workspace-toggle"
      data-cake-hint-key="s"
      tooltip={label}
      hotkey="toggle-sidebar"
      aria-expanded={navigator.paneVisible}
      aria-controls={navigator.inCompanion ? "workspace-companion" : "workspace-navigator"}
      onClick={() => navigator.togglePane()}
    >
      <ChatSidebarIcon />
    </IconButton>
  );
});
