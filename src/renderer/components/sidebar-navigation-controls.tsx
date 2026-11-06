import { observer, useStore } from "r-state-tree/react";
import { RootStore } from "../stores/RootStore";
import { IconButton } from "./ui/icon-button";
import { SidebarIcon } from "./ui/icons";

/** A persistent Workspace reopen control for non-conversation surfaces. */
export const SidebarNavigationControls = observer(function SidebarNavigationControls({
  header = false,
  onToggle,
}: {
  header?: boolean;
  onToggle?(): void;
}) {
  const root = useStore(RootStore);
  return (
    <div className="flex shrink-0 items-center gap-1 [app-region:no-drag]">
      <IconButton
        data-slot={header ? "header-workspace-toggle" : undefined}
        data-cake-hint-key="s"
        tooltip="Toggle Workspace"
        hotkey="toggle-sidebar"
        aria-pressed={root.workspaceNavigatorStore.visible}
        onClick={onToggle ?? (() => root.workspaceNavigatorStore.toggle())}
      >
        <SidebarIcon />
      </IconButton>
    </div>
  );
});
