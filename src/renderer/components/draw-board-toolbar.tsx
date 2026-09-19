import { useState } from "react";
import { observer } from "r-state-tree/react";
import { cn } from "../lib/utils";
import type { DrawStore } from "../stores/DrawStore";
import { Button } from "./ui/button";
import { IconButton } from "./ui/icon-button";
import { BackIcon, ExportIcon, ForwardIcon, SidebarIcon } from "./ui/icons";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";

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
  const [exportOpen, setExportOpen] = useState(false);
  const exportBoard = (format: "png" | "svg" | "excalidraw") => {
    setExportOpen(false);
    void store.exportBoard(format);
  };

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
      <div className="ml-auto flex items-center gap-2 [-webkit-app-region:no-drag]">
        <span className="text-[10px] text-muted-foreground" role="status">
          {store.loading
            ? "Loading…"
            : store.saving
              ? "Saving…"
              : store.exportingFormat
                ? `Exporting ${store.exportingFormat.toUpperCase()}…`
                : store.error
                  ? store.error
                  : (store.exportMessage ?? "")}
        </span>
        <Popover open={exportOpen} onOpenChange={setExportOpen}>
          <PopoverTrigger
            variant="outline"
            size="sm"
            disabled={!store.documentLoaded || Boolean(store.exportingFormat)}
            aria-label="Export Cake Draw board"
          >
            <ExportIcon />
            Export
          </PopoverTrigger>
          <PopoverContent
            role="menu"
            aria-label="Export Cake Draw board"
            side="bottom"
            align="end"
            className="w-56 p-1.5"
          >
            <div className="flex flex-col gap-1">
              <Button
                role="menuitem"
                variant="ghost"
                size="sm"
                className="justify-start"
                onClick={() => exportBoard("png")}
              >
                PNG image
              </Button>
              <Button
                role="menuitem"
                variant="ghost"
                size="sm"
                className="justify-start"
                onClick={() => exportBoard("svg")}
              >
                SVG image
              </Button>
              <Button
                role="menuitem"
                variant="ghost"
                size="sm"
                className="justify-start"
                onClick={() => exportBoard("excalidraw")}
              >
                Editable Excalidraw
              </Button>
            </div>
          </PopoverContent>
        </Popover>
      </div>
    </header>
  );
});
