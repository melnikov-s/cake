import { createContext, useContext, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";

/** The shell owns the full-width header, independently of accessory pane widths. */
export const ShellHeaderContext = createContext<HTMLElement | null | undefined>(undefined);
const WorkspaceModeContext = createContext<HTMLElement | null | undefined>(undefined);

export function WorkspaceModeSlot({ children }: { children: ReactNode }) {
  const target = useContext(WorkspaceModeContext);
  return target === undefined ? children : target ? createPortal(children, target) : null;
}

/** One traffic-light-aligned row for the conversation and its Browser/VS Code surfaces. */
export function WorkspaceHeader({
  title,
  titleLeading,
  compact = false,
  children,
}: {
  title: ReactNode;
  titleLeading?: ReactNode;
  compact?: boolean;
  children: ReactNode;
}) {
  const shellHeader = useContext(ShellHeaderContext);
  const [modeTarget, setModeTarget] = useState<HTMLDivElement | null>(null);
  const header = (
    <WorkspaceModeContext value={compact ? undefined : modeTarget}>
      <header
        data-slot="workspace-header"
        className={cn(
          "relative box-content h-title-bar min-w-0 shrink-0 items-center gap-3 border-b border-border/65 [app-region:drag]",
          compact
            ? "flex overflow-hidden px-5"
            : "grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] pl-[max(46px,calc(var(--window-controls-width,0px)-var(--project-rail-width,0px)))] pr-11",
        )}
      >
        {compact && titleLeading}
        <div data-slot="workspace-title" className="flex h-full min-w-0 flex-1 items-center">
          {title}
        </div>
        {!compact && (
          <div
            ref={setModeTarget}
            data-slot="workspace-mode"
            className="flex items-center [app-region:no-drag]"
          />
        )}
        <div
          data-slot="workspace-actions"
          className={cn(
            "flex h-full min-w-0 items-center gap-1 overflow-x-auto [app-region:no-drag]",
            compact ? "max-w-[70%] shrink-0" : "w-max max-w-full justify-self-end",
          )}
        >
          {children}
        </div>
      </header>
    </WorkspaceModeContext>
  );
  if (compact || shellHeader === undefined) return header;
  return shellHeader ? createPortal(header, shellHeader) : null;
}
