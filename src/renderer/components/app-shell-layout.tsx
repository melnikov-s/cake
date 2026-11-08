import { useRef, useState, type CSSProperties, type ReactNode } from "react";
import { observer, useStore } from "r-state-tree/react";
import { ResizeHandle } from "@/components/ui/resize-handle";
import { CommandPane } from "@/components/command-pane";
import { QuakeTerminal } from "@/components/quake-terminal";
import { cn } from "@/lib/utils";
import { RootStore } from "../stores/RootStore";
import { ProjectRail } from "./project-rail";
import { SidebarNavigationControls } from "./sidebar-navigation-controls";
import { WorkspaceNavigator } from "./workspace-navigator";
import { AppSurfaceHeader } from "./app-surface-header";
import { ConversationFocusContext } from "../lib/conversation-focus-context";
import { FullscreenViewportContext } from "./fullscreen-viewport-context";
import { SessionChatHomeButton } from "./session-chat-home-button";
import { ShellHeaderContext } from "./ui/workspace-header";
import { useHoverPointer } from "../lib/hover-pointer";

export const AppShellLayout = observer(function AppShellLayout({
  children,
  overlays,
  workspaceControls,
  workspaceMode,
  commandPaneWidth,
  onCommandPaneWidthChange,
}: {
  children: ReactNode;
  overlays: ReactNode;
  workspaceControls?: ReactNode;
  workspaceMode?: "browser" | "vscode";
  commandPaneWidth: number;
  onCommandPaneWidthChange(width: number): void;
}) {
  const root = useStore(RootStore);
  const hoverPointer = useHoverPointer();
  const autoHideRail = workspaceMode === "vscode" && hoverPointer;
  const store = root.projectWorkbenchStore;
  const shell = root.appShellStore;
  const navigator = root.workspaceNavigatorStore;
  const terminal = root.terminalStore;
  const conversationPaneVisible = Boolean(root.workspaceSession) && !shell.applicationSurface;
  const navigatorVisible = navigator.visible && !navigator.inCompanion && !shell.applicationSurface;
  const applicationView = shell.surface === "settings" || shell.surface === "automations";
  const shellRef = useRef<HTMLElement>(null);
  const [resizingPanel, setResizingPanel] = useState(false);
  const [headerTarget, setHeaderTarget] = useState<HTMLDivElement | null>(null);
  const [fullscreenViewport, setFullscreenViewport] = useState<HTMLDivElement | null>(null);
  const commandVisible = Boolean(store.commandPaneStore.pane) && !shell.applicationSurface;
  const accessoryWidth = Math.min(navigator.width, Math.max(240, window.innerWidth - 414));
  const commandMax = Math.max(
    320,
    window.innerWidth - (navigatorVisible ? accessoryWidth : 0) - 414,
  );
  const shellStyle: CSSProperties & Record<"--navigator-width" | "--command-width", string> = {
    "--navigator-width": navigatorVisible ? `${accessoryWidth}px` : "0px",
    "--command-width": commandVisible ? `${Math.min(commandPaneWidth, commandMax)}px` : "0px",
  };
  return (
    <ShellHeaderContext value={headerTarget}>
      <main
        ref={shellRef}
        className={cn(
          "relative grid h-full w-full max-w-[100vw] grid-rows-[auto_minmax(0,1fr)] grid-cols-[var(--project-rail-width)_minmax(0,1fr)_var(--navigator-width)_var(--command-width)] overflow-hidden bg-background text-foreground [--project-rail-width:54px] max-[700px]:grid-cols-[var(--project-rail-width)_minmax(0,1fr)_0px_0px] max-[700px]:[--project-rail-width:44px]",
          applicationView &&
            "grid-cols-[0px_minmax(0,1fr)_0px_var(--command-width)] [--project-rail-width:0px] max-[700px]:grid-cols-[0px_minmax(0,1fr)_0px_0px] max-[700px]:[--project-rail-width:0px]",
          autoHideRail && "[--project-rail-width:0px] max-[700px]:[--project-rail-width:0px]",
          resizingPanel && "cursor-col-resize select-none",
        )}
        style={shellStyle}
      >
        <div
          aria-hidden="true"
          data-slot="window-controls-drag-region"
          className="absolute left-0 top-0 z-40 h-title-bar w-[100px] [app-region:drag]"
        />
        {!applicationView && <ProjectRail autoHide={autoHideRail} />}
        <div
          ref={setHeaderTarget}
          data-slot="shell-header"
          className={cn(
            "col-start-2 col-end-5 row-start-1 min-w-0",
            workspaceControls &&
              "[&_[data-slot=workspace-actions]]:mr-11 [&_[data-slot=workspace-actions]]:max-w-[calc(100%-2.75rem)]",
          )}
        />
        <section
          data-slot="workspace"
          className={cn(
            "relative col-start-2 row-start-2 grid h-full min-h-0 min-w-0 overflow-hidden [contain:inline-size]",
            conversationPaneVisible
              ? "grid-rows-[minmax(0,1fr)_auto]"
              : "grid-rows-[auto_minmax(0,1fr)_auto]",
          )}
          data-session-id={shell.activeConversation?.sessionId}
        >
          {!conversationPaneVisible && <AppSurfaceHeader />}
          <FullscreenViewportContext value={fullscreenViewport}>
            <ConversationFocusContext.Provider value={true}>
              {children}
            </ConversationFocusContext.Provider>
          </FullscreenViewportContext>
          <SessionChatHomeButton />
          {terminal.docked && (
            <QuakeTerminal store={terminal} retirement={root.workingDirectoryRetirementStore} />
          )}
        </section>
        {navigatorVisible && (
          <div className="col-start-3 row-start-2 min-h-0 min-w-0 max-[700px]:absolute max-[700px]:bottom-0 max-[700px]:top-[calc(var(--title-bar-height)+1px)] max-[700px]:left-[var(--project-rail-width)] max-[700px]:right-0 max-[700px]:z-30">
            <WorkspaceNavigator />
          </div>
        )}
        {navigatorVisible && (
          <ResizeHandle
            className={cn(
              "right-[calc(var(--command-width)+var(--navigator-width)-5px)] max-[700px]:hidden",
              conversationPaneVisible && "top-[calc(var(--title-bar-height)+1px)]",
            )}
            label="Resize Workspace"
            value={accessoryWidth}
            min={240}
            max={Math.min(520, Math.max(240, window.innerWidth - 414))}
            edge="right"
            onChange={(width) => navigator.setWidth(width)}
            onDrag={(width) =>
              shellRef.current?.style.setProperty("--navigator-width", `${width}px`)
            }
            onResizeStart={() => setResizingPanel(true)}
            onResizeEnd={() => setResizingPanel(false)}
          />
        )}
        {!shell.applicationSurface && (
          <div className="col-start-4 row-start-2 min-h-0 min-w-0">
            <CommandPane store={store} extensionUi={root.extensionUiStore} />
          </div>
        )}
        {commandVisible && (
          <ResizeHandle
            className={cn(
              "right-[calc(var(--command-width)-5px)] max-[700px]:hidden",
              conversationPaneVisible && "top-[calc(var(--title-bar-height)+1px)]",
            )}
            label="Resize command pane"
            value={commandPaneWidth}
            min={320}
            max={commandMax}
            edge="right"
            onChange={onCommandPaneWidthChange}
            onResizeStart={() => setResizingPanel(true)}
            onResizeEnd={() => setResizingPanel(false)}
          />
        )}
        {!applicationView && !shell.applicationSurface && (
          <div
            data-slot="shell-workspace-controls"
            className="absolute right-2 top-0 z-40 flex h-title-bar items-center gap-1 [app-region:no-drag]"
          >
            {workspaceControls}
            <SidebarNavigationControls />
          </div>
        )}
        {/* Use the shell's real grid tracks, including a hidden or narrow rail.
          Expanded navigation labels remain an overlay in ordinary workspaces,
          but presentations must also fit to their currently visible edge. */}
        <div
          ref={setFullscreenViewport}
          data-slot="fullscreen-viewport"
          className="pointer-events-none absolute inset-0 col-start-2 col-end-5 row-start-1 row-end-3 z-45 [&>*]:pointer-events-auto"
          style={{
            marginLeft: applicationView
              ? 0
              : `max(0px, calc(${root.projectRailStore.overlayRight}px - var(--project-rail-width)))`,
          }}
        />
        <FullscreenViewportContext value={fullscreenViewport}>{overlays}</FullscreenViewportContext>
      </main>
    </ShellHeaderContext>
  );
});
