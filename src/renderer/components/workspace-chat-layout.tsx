import { useRef, useState, type CSSProperties, type ReactNode } from "react";
import { cn } from "../lib/utils";
import { ResizeHandle } from "./ui/resize-handle";

/** Shared VS Code/Draw shell: project navigation, primary workspace, and authoritative chat drawer. */
export function WorkspaceChatLayout({
  workspace,
  workspaceLabel,
  chatSidebar,
  chatSidebarVisible,
  chatSidebarWidth,
  onChatSidebarWidthChange,
  projectSidebar,
  projectSidebarVisible,
  projectSidebarWidth,
  onProjectSidebarWidthChange,
  terminalDock,
}: {
  workspace: ReactNode;
  workspaceLabel: string;
  chatSidebar: ReactNode;
  chatSidebarVisible: boolean;
  chatSidebarWidth: number;
  onChatSidebarWidthChange(width: number): void;
  projectSidebar: ReactNode;
  projectSidebarVisible: boolean;
  projectSidebarWidth: number;
  onProjectSidebarWidthChange(width: number): void;
  terminalDock?: ReactNode;
}) {
  const workspaceRef = useRef<HTMLElement>(null);
  const [resizing, setResizing] = useState(false);
  const chatSidebarMax = Math.max(
    320,
    window.innerWidth - (projectSidebarVisible ? projectSidebarWidth : 0) - 480,
  );
  const visibleChatSidebarWidth = Math.min(chatSidebarWidth, chatSidebarMax);
  const projectSidebarMax = Math.max(
    220,
    window.innerWidth - (chatSidebarVisible ? visibleChatSidebarWidth : 0) - 360,
  );
  const visibleProjectSidebarWidth = Math.min(projectSidebarWidth, projectSidebarMax);
  const workspaceStyle: CSSProperties &
    Record<"--workspace-chat-sidebar-width" | "--workspace-project-sidebar-width", string> = {
    "--workspace-chat-sidebar-width": `${visibleChatSidebarWidth}px`,
    "--workspace-project-sidebar-width": `${visibleProjectSidebarWidth}px`,
  };

  return (
    <main
      ref={workspaceRef}
      className={cn(
        "relative flex h-screen min-h-0 w-screen overflow-hidden bg-background text-foreground",
        resizing && "cursor-col-resize select-none",
      )}
      style={workspaceStyle}
    >
      {projectSidebarVisible ? (
        <>
          <div className="w-[var(--workspace-project-sidebar-width)] min-w-0 shrink-0">
            {projectSidebar}
          </div>
          <ResizeHandle
            className="left-[calc(var(--workspace-project-sidebar-width)-5px)]"
            label="Resize project sidebar"
            value={visibleProjectSidebarWidth}
            min={220}
            max={projectSidebarMax}
            edge="left"
            onChange={onProjectSidebarWidthChange}
            onDrag={(width) =>
              workspaceRef.current?.style.setProperty(
                "--workspace-project-sidebar-width",
                `${width}px`,
              )
            }
            onResizeStart={() => setResizing(true)}
            onResizeEnd={() => setResizing(false)}
          />
        </>
      ) : null}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="flex min-h-0 min-w-0 flex-1">
          <section className="min-w-0 flex-1" aria-label={workspaceLabel}>
            {workspace}
          </section>
          {chatSidebarVisible ? (
            <>
              <ResizeHandle
                className="right-[calc(var(--workspace-chat-sidebar-width)-5px)]"
                label="Resize current session sidebar"
                value={visibleChatSidebarWidth}
                min={320}
                max={chatSidebarMax}
                edge="right"
                onChange={onChatSidebarWidthChange}
                onDrag={(width) =>
                  workspaceRef.current?.style.setProperty(
                    "--workspace-chat-sidebar-width",
                    `${width}px`,
                  )
                }
                onResizeStart={() => setResizing(true)}
                onResizeEnd={() => setResizing(false)}
              />
              <aside
                data-popover-boundary
                className="flex w-[var(--workspace-chat-sidebar-width)] min-w-0 flex-col border-l border-border bg-background shadow-[-12px_0_32px_color-mix(in_oklab,var(--foreground)_8%,transparent)]"
              >
                {chatSidebar}
              </aside>
            </>
          ) : null}
        </div>
        {terminalDock}
      </div>
    </main>
  );
}
