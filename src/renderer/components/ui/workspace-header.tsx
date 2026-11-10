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

/**
 * One traffic-light-aligned row for the conversation and its Browser/VS Code surfaces.
 * In the shell, the mode group is centered on the window (under the notch), not on the
 * space between the title and actions: the first track runs from the content start to
 * the window's center line, and a zero-width track there lets the group overflow evenly.
 */
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
  const windowCentered = !compact && shellHeader !== undefined;
  const header = (
    <WorkspaceModeContext value={compact ? undefined : modeTarget}>
      <header
        data-slot="workspace-header"
        className={cn(
          "relative box-content h-title-bar min-w-0 shrink-0 items-center border-b border-border/65 [app-region:drag]",
          compact
            ? "flex gap-3 overflow-hidden px-5"
            : "grid pr-10 pl-(--workspace-header-start) [--workspace-header-start:max(46px,calc(var(--window-controls-width,0px)-var(--project-rail-width,0px)))] [--workspace-mode-clearance:3.75rem]",
          !compact &&
            (windowCentered
              ? "grid-cols-[minmax(0,calc(50vw-var(--project-rail-width,0px)-var(--workspace-header-start)))_0px_minmax(0,1fr)]"
              : "grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] gap-3"),
        )}
      >
        {compact && titleLeading}
        <div
          data-slot="workspace-title"
          className={cn(
            "flex h-full min-w-0 flex-1 items-center",
            windowCentered && "pr-(--workspace-mode-clearance)",
          )}
        >
          {title}
        </div>
        {!compact && (
          <div
            ref={setModeTarget}
            data-slot="workspace-mode"
            className="flex items-center justify-center [app-region:no-drag]"
          />
        )}
        <div
          data-slot="workspace-actions"
          className={cn(
            "flex h-full min-w-0 items-center gap-1 overflow-x-auto [app-region:no-drag]",
            compact
              ? "max-w-[70%] shrink-0"
              : cn(
                  "w-max justify-self-end",
                  windowCentered
                    ? "max-w-[calc(100%-var(--workspace-mode-clearance))]"
                    : "max-w-full",
                ),
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
