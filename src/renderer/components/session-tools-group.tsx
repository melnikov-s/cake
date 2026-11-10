import type { ReactNode } from "react";

/** Quiet session-local actions, subordinate to the centered workspace modes. */
export function SessionToolsGroup({ children }: { children: ReactNode }) {
  return (
    <div
      role="group"
      aria-label="Session tools"
      data-slot="session-tools"
      className="flex shrink-0 items-center gap-1 rounded-md bg-muted/30 p-0.5 ring-1 ring-inset ring-border/25 [&_[data-slot=count-badge-anchor]]:flex [&_[data-slot=count-badge-anchor]]:top-0 [&_[data-slot=count-badge-anchor]]:right-0"
    >
      {children}
    </div>
  );
}
