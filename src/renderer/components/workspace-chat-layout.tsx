import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { cn } from "../lib/utils";
import { ResizeHandle } from "./ui/resize-handle";
import { WorkspaceCompanion } from "./workspace-companion";

/** Primary tool surface and its authoritative same-conversation companion. */
export function WorkspaceChatLayout({
  workspace,
  workspaceHeader,
  className,
  workspaceLabel,
  chatSidebar,
  chatSidebarVisible,
  chatSidebarWidth,
  onChatSidebarWidthChange,
  terminalDock,
}: {
  workspace: ReactNode;
  workspaceHeader?: ReactNode;
  className?: string;
  workspaceLabel: string;
  chatSidebar: ReactNode;
  chatSidebarVisible: boolean;
  chatSidebarWidth: number;
  onChatSidebarWidthChange(width: number): void;
  terminalDock?: ReactNode;
}) {
  const workspaceRef = useRef<HTMLElement>(null);
  const [resizing, setResizing] = useState(false);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const element = workspaceRef.current;
    if (!element) return;
    const measure = () => setWidth(element.getBoundingClientRect().width);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const chatSidebarMax = Math.max(320, width - 360);
  const visibleChatSidebarWidth = Math.min(chatSidebarWidth, chatSidebarMax);
  const workspaceStyle: CSSProperties & Record<"--workspace-chat-sidebar-width", string> = {
    "--workspace-chat-sidebar-width": `${visibleChatSidebarWidth}px`,
  };

  return (
    <main
      ref={workspaceRef}
      className={cn(
        "relative flex h-full min-h-0 w-full overflow-hidden bg-background text-foreground",
        // Cross-origin widget frames otherwise swallow drag events even after
        // pointer capture. Restore their interaction as soon as resizing ends.
        resizing && "cursor-col-resize select-none [&_iframe]:pointer-events-none",
        className,
      )}
      style={workspaceStyle}
    >
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {workspaceHeader}
        <div className="relative flex min-h-0 min-w-0 flex-1">
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
                id="workspace-companion"
                data-popover-boundary
                aria-label="Current conversation companion"
                className="@container/session-pane flex w-[var(--workspace-chat-sidebar-width)] min-w-0 shrink-0 flex-col border-l border-border/65 bg-background"
              >
                <WorkspaceCompanion>{chatSidebar}</WorkspaceCompanion>
              </aside>
            </>
          ) : null}
        </div>
        {terminalDock}
      </div>
    </main>
  );
}
