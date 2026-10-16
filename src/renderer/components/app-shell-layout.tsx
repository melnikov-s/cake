import { useCallback, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { observer, useStore } from "r-state-tree/react";
import { IconButton } from "@/components/ui/icon-button";
import { Button } from "./ui/button";
import { SettingsIcon } from "@/components/ui/icons";
import { ResizeHandle } from "@/components/ui/resize-handle";
import { CommandPane } from "@/components/command-pane";
import { QuakeTerminal } from "@/components/quake-terminal";
import { cn } from "@/lib/utils";
import { RootStore } from "../stores/RootStore";
import { AppSidebar } from "./app-sidebar";
import { AppSurfaceHeader } from "./app-surface-header";

export const AppShellLayout = observer(function AppShellLayout({
  children,
  overlays,
  commandPaneWidth,
  onCommandPaneWidthChange,
}: {
  children: ReactNode;
  overlays: ReactNode;
  commandPaneWidth: number;
  onCommandPaneWidthChange(width: number): void;
}) {
  const root = useStore(RootStore);
  const store = root.projectWorkbenchStore;
  const sidebar = root.sidebarStore;
  const shell = root.appShellStore;
  const terminal = root.terminalStore;
  const extensionUi = root.extensionUiStore;
  const surface = shell.surface;
  const conversationPaneVisible =
    surface === "workbench"
      ? Boolean(store.activeSession)
      : surface === "cake-chat" &&
        shell.selection.kind === "cake-chat" &&
        Boolean(
          shell.selection.sessionId &&
          root.cakeChatCollectionStore.registry.find(shell.selection.sessionId),
        );
  const sidebarCollapsed = !sidebar.visible;
  const projectSidebarVisible = !sidebarCollapsed && surface !== "settings";
  const sidebarWidth = sidebar.width;
  const displayedSidebarWidth = sidebar.focusModeProjectPath
    ? Math.max(sidebarWidth, 360)
    : sidebarWidth;
  const shellRef = useRef<HTMLElement>(null);
  const [resizingPanel, setResizingPanel] = useState(false);
  const sidebarMax = Math.max(
    240,
    window.innerWidth - (store.commandPaneStore.pane ? commandPaneWidth : 0) - 360,
  );
  const commandPaneMax = Math.max(
    320,
    window.innerWidth - (sidebarCollapsed ? 0 : displayedSidebarWidth) - 360,
  );
  const setSidebarWidth = useCallback((width: number) => sidebar.setWidth(width), [sidebar]);
  const previewSidebarWidth = useCallback(
    (width: number) => {
      const displayedWidth = sidebar.focusModeProjectPath ? Math.max(width, 360) : width;
      shellRef.current?.style.setProperty(
        "--sidebar-width",
        `${Math.min(displayedWidth, sidebarMax)}px`,
      );
    },
    [sidebar.focusModeProjectPath, sidebarMax],
  );
  const shellStyle: CSSProperties & Record<"--sidebar-width" | "--right-pane-width", string> = {
    "--sidebar-width": projectSidebarVisible
      ? `${Math.min(displayedSidebarWidth, sidebarMax)}px`
      : "0px",
    "--right-pane-width": store.commandPaneStore.pane
      ? `${Math.min(commandPaneWidth, commandPaneMax)}px`
      : "0px",
  };
  return (
    <main
      ref={shellRef}
      className={cn(
        "relative grid h-full w-full max-w-[100vw] overflow-hidden bg-background text-foreground transition-[grid-template-columns] duration-180 ease-out",
        "grid-cols-[var(--sidebar-width)_minmax(0,1fr)_var(--right-pane-width)] max-[820px]:grid-cols-[min(var(--sidebar-width),230px)_minmax(0,1fr)_var(--right-pane-width)] max-[620px]:grid-cols-[0px_minmax(0,1fr)] phone:grid-cols-[0px_minmax(0,1fr)]",
        resizingPanel && "cursor-col-resize select-none transition-none",
      )}
      style={shellStyle}
    >
      {projectSidebarVisible && (
        <>
          <Button
            variant="ghost"
            aria-label="Close navigation"
            className="absolute inset-0 z-40 hidden h-full w-full rounded-none bg-foreground/28 max-[620px]:block phone:block"
            onClick={() => sidebar.toggle()}
          />
          <AppSidebar />
        </>
      )}
      {projectSidebarVisible && (
        <ResizeHandle
          className="left-[calc(var(--sidebar-width)-5px)] max-[820px]:left-[calc(min(var(--sidebar-width),230px)-5px)] max-[620px]:hidden phone:hidden"
          label="Resize project sidebar"
          value={displayedSidebarWidth}
          min={220}
          max={sidebarMax}
          edge="left"
          onChange={setSidebarWidth}
          onDrag={previewSidebarWidth}
          onResizeStart={() => setResizingPanel(true)}
          onResizeEnd={() => setResizingPanel(false)}
        />
      )}
      <section
        data-slot="workspace"
        className={cn(
          "relative col-start-2 grid h-full min-h-0 min-w-0 overflow-hidden [contain:inline-size]",
          conversationPaneVisible
            ? "grid-rows-[minmax(0,1fr)_auto]"
            : "grid-rows-[52px_minmax(0,1fr)_auto]",
        )}
        data-session-id={
          shell.selection.kind === "cake-chat"
            ? shell.selection.sessionId
            : shell.selection.kind === "project-session"
              ? shell.selection.sessionId
              : undefined
        }
      >
        {surface !== "settings" && (
          <IconButton
            className={cn(
              "absolute bottom-[9.5px] left-4 z-20 hidden phone:!hidden size-8 place-items-center rounded-lg bg-transparent text-muted-foreground hover:bg-muted hover:text-foreground max-[620px]:grid",
              sidebarCollapsed && "grid",
            )}
            data-slot="workspace-settings"
            data-cake-hint-key="g"
            tooltip="Open settings"
            hotkey="open-settings"
            onClick={() => root.navigationStore.showSettings()}
          >
            <SettingsIcon />
          </IconButton>
        )}
        {!conversationPaneVisible && <AppSurfaceHeader />}
        {children}
        {terminal.docked && (
          <QuakeTerminal store={terminal} retirement={root.workingDirectoryRetirementStore} />
        )}
      </section>
      <CommandPane store={store} extensionUi={extensionUi} />
      {store.commandPaneStore.pane && (
        <ResizeHandle
          className="right-[calc(var(--right-pane-width)-5px)] max-[620px]:hidden phone:hidden"
          label="Resize command pane"
          value={commandPaneWidth}
          min={320}
          max={commandPaneMax}
          edge="right"
          onChange={onCommandPaneWidthChange}
          onResizeStart={() => setResizingPanel(true)}
          onResizeEnd={() => setResizingPanel(false)}
        />
      )}
      {overlays}
    </main>
  );
});
