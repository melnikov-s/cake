import type { ReactNode } from "react";

/** Quiet session-local actions, subordinate to the centered workspace modes. */
export function SessionToolsGroup({ children }: { children: ReactNode }) {
  // Keep the buttons full-height; inset their state fills inside the slimmer tray.
  return (
    <div
      role="group"
      aria-label="Session tools"
      data-slot="session-tools"
      className="flex shrink-0 items-center gap-1 rounded-md bg-muted/30 px-0.5 ring-1 ring-inset ring-border/25 [&_.icon-button]:border-y-2 [&_.icon-button]:border-transparent [&_.icon-button]:bg-clip-padding [&_.icon-button:focus-visible]:-outline-offset-3 [&_[data-slot=count-badge-anchor]]:flex [&_[data-slot=count-badge-anchor]]:-top-0.5 [&_[data-slot=count-badge-anchor]]:right-0"
    >
      {children}
    </div>
  );
}
