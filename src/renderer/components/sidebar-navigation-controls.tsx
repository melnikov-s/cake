import { observer, useStore } from "r-state-tree/react";
import { RootStore } from "../stores/RootStore";
import { cn } from "../lib/utils";
import { BrowserSharingMenu } from "./browser-sharing-menu";
import { IconButton } from "./ui/icon-button";
import { SidebarIcon } from "./ui/icons";

/** Keep the connection shortcut under the same visibility rules as navigation. */
export const SidebarNavigationControls = observer(function SidebarNavigationControls({
  header = false,
  onToggle,
}: {
  header?: boolean;
  onToggle?(): void;
}) {
  const root = useStore(RootStore);
  return (
    <div
      className={cn(
        "flex shrink-0 items-center gap-1 [app-region:no-drag]",
        header &&
          "absolute left-[84px] top-[9px] z-20 max-[620px]:left-2 phone:left-2 [@media(pointer:coarse)]:top-1",
        header && !root.sidebarStore.visible
          ? "flex"
          : header && "hidden max-[620px]:flex phone:flex",
      )}
    >
      <IconButton
        data-slot={header ? "header-sidebar-toggle" : undefined}
        data-cake-hint-key="s"
        tooltip="Toggle sidebar"
        hotkey="toggle-sidebar"
        onClick={onToggle ?? (() => root.sidebarStore.toggle())}
      >
        <SidebarIcon />
      </IconButton>
      <BrowserSharingMenu />
    </div>
  );
});
