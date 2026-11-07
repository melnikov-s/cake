import { useRef, useState, type CSSProperties, type ReactNode } from "react";
import { observer, useStore } from "r-state-tree/react";
import { ResizeHandle } from "@/components/ui/resize-handle";
import { CommandPane } from "@/components/command-pane";
import { QuakeTerminal } from "@/components/quake-terminal";
import { cn } from "@/lib/utils";
import { RootStore } from "../stores/RootStore";
import { ProjectRail } from "./project-rail";
import { WorkspaceNavigator } from "./workspace-navigator";
import { AppSurfaceHeader } from "./app-surface-header";
import { ConversationFocusContext } from "../lib/conversation-focus-context";

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
  const shell = root.appShellStore;
  const navigator = root.workspaceNavigatorStore;
  const terminal = root.terminalStore;
  const conversationPaneVisible = Boolean(root.workspaceSession) && !shell.coveringSurface;
  const navigatorVisible = navigator.visible && !navigator.inCompanion && !shell.coveringSurface;
  const applicationView = shell.surface === "settings" || shell.surface === "automations";
  const shellRef = useRef<HTMLElement>(null);
  const [resizingPanel, setResizingPanel] = useState(false);
  const commandVisible = Boolean(store.commandPaneStore.pane) && !applicationView;
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
    <main
      ref={shellRef}
      className={cn(
        "relative grid h-full w-full max-w-[100vw] grid-cols-[54px_minmax(0,1fr)_var(--navigator-width)_var(--command-width)] overflow-hidden bg-background text-foreground max-[700px]:grid-cols-[44px_minmax(0,1fr)_0px_0px]",
        applicationView &&
          "grid-cols-[0px_minmax(0,1fr)_0px_var(--command-width)] max-[700px]:grid-cols-[0px_minmax(0,1fr)_0px_0px]",
        resizingPanel && "cursor-col-resize select-none",
      )}
      style={shellStyle}
    >
      <div
        aria-hidden="true"
        data-slot="window-controls-drag-region"
        className="absolute left-0 top-0 z-40 h-title-bar w-[100px] [app-region:drag]"
      />
      {!applicationView && <ProjectRail />}
      <section
        data-slot="workspace"
        className={cn(
          "relative col-start-2 grid h-full min-h-0 min-w-0 overflow-hidden [contain:inline-size]",
          conversationPaneVisible
            ? "grid-rows-[minmax(0,1fr)_auto]"
            : "grid-rows-[auto_minmax(0,1fr)_auto]",
        )}
        data-session-id={shell.activeConversation?.sessionId}
      >
        {!conversationPaneVisible && <AppSurfaceHeader />}
        <ConversationFocusContext.Provider value={true}>
          {children}
        </ConversationFocusContext.Provider>
        {terminal.docked && (
          <QuakeTerminal store={terminal} retirement={root.workingDirectoryRetirementStore} />
        )}
      </section>
      {navigatorVisible && (
        <div className="col-start-3 min-h-0 min-w-0 max-[700px]:absolute max-[700px]:inset-y-0 max-[700px]:left-11 max-[700px]:right-0 max-[700px]:z-30">
          <WorkspaceNavigator />
        </div>
      )}
      {navigatorVisible && (
        <ResizeHandle
          className="right-[calc(var(--command-width)+var(--navigator-width)-5px)] max-[700px]:hidden"
          label="Resize Workspace"
          value={accessoryWidth}
          min={240}
          max={Math.min(520, Math.max(240, window.innerWidth - 414))}
          edge="right"
          onChange={(width) => navigator.setWidth(width)}
          onDrag={(width) => shellRef.current?.style.setProperty("--navigator-width", `${width}px`)}
          onResizeStart={() => setResizingPanel(true)}
          onResizeEnd={() => setResizingPanel(false)}
        />
      )}
      {!applicationView && <CommandPane store={store} extensionUi={root.extensionUiStore} />}
      {commandVisible && (
        <ResizeHandle
          className="right-[calc(var(--command-width)-5px)] max-[700px]:hidden"
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
      {overlays}
    </main>
  );
});
