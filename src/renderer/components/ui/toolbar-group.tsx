import type { ReactNode } from "react";

/** A compact, framed set of related workspace toolbar actions. */
export function ToolbarGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <div className="mx-1 h-4 w-px shrink-0 bg-border/60" aria-hidden="true" />
      <div
        role="group"
        aria-label={label}
        className="flex shrink-0 items-center gap-1 rounded-lg border border-border/65 bg-muted/30 p-1"
      >
        {children}
      </div>
    </>
  );
}
