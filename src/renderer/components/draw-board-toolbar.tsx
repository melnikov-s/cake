import { observer } from "r-state-tree/react";
import { cn } from "../lib/utils";
import type { DrawStore } from "../stores/DrawStore";
import { Button } from "./ui/button";
import { IconButton } from "./ui/icon-button";
import { BackIcon, ForwardIcon, SidebarIcon } from "./ui/icons";

export const DrawBoardToolbar = observer(function DrawBoardToolbar({
  store,
  sidebarCollapsed,
  canGoBack,
  canGoForward,
  onBackToAgent,
  onToggleSidebar,
  onGoBack,
  onGoForward,
}: {
  store: DrawStore;
  sidebarCollapsed: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  onBackToAgent(): void;
  onToggleSidebar(): void;
  onGoBack(): void;
  onGoForward(): void;
}) {
  return (
    <header
      className={cn(
        "flex h-[46px] shrink-0 items-center gap-1 border-b border-border bg-background px-3 [-webkit-app-region:drag]",
        sidebarCollapsed && "pl-[103px]",
      )}
    >
      {sidebarCollapsed ? (
        <div className="flex items-center gap-1 [-webkit-app-region:no-drag]">
          <IconButton
            data-slot="header-sidebar-toggle"
            data-cake-hint-key="s"
            tooltip="Toggle sidebar"
            onClick={onToggleSidebar}
          >
            <SidebarIcon />
          </IconButton>
          <IconButton
            data-cake-hint-key="b"
            tooltip="Back"
            disabled={!canGoBack}
            onClick={onGoBack}
            ariaLabel="Go back in session history"
          >
            <BackIcon />
          </IconButton>
          <IconButton
            data-cake-hint-key="f"
            tooltip="Forward"
            disabled={!canGoForward}
            onClick={onGoForward}
            ariaLabel="Go forward in session history"
          >
            <ForwardIcon />
          </IconButton>
          <div className="mx-1 h-4 w-px shrink-0 bg-border/60" aria-hidden="true" />
        </div>
      ) : null}
      <Button
        variant="ghost"
        size="sm"
        className="[-webkit-app-region:no-drag]"
        onClick={onBackToAgent}
      >
        <BackIcon />
        Back to agent
      </Button>
      <strong className="ml-1 shrink-0 text-xs">Cake Draw</strong>
      <span className="ml-auto text-[10px] text-muted-foreground" role="status">
        {store.loading ? "Loading…" : store.saving ? "Saving…" : store.error ? store.error : ""}
      </span>
    </header>
  );
});
