import type { ReactNode } from "react";

/** Quiet session-local actions, subordinate to the centered workspace modes. */
export function SessionToolsGroup({ children }: { children: ReactNode }) {
  return (
    <div
      role="group"
      aria-label="Session tools"
      data-slot="session-tools"
      className="flex shrink-0 items-center gap-0.5"
    >
      {children}
    </div>
  );
}
