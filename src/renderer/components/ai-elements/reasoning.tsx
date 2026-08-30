import type { ReactNode } from "react";
import { StatusDot } from "../ui/status-dot";

export function Reasoning({
  open,
  onToggle,
  children,
  streaming,
  hasContent = true,
}: {
  open: boolean;
  onToggle(): void;
  children: ReactNode;
  streaming?: boolean;
  hasContent?: boolean;
}) {
  const label = streaming
    ? "Thinking…"
    : hasContent
      ? "Reasoning"
      : "Reasoning details not exposed";
  return (
    <div className="rounded-xl border border-border/80 bg-muted/45 px-4 py-3">
      {hasContent ? (
        <>
          <button
            type="button"
            className="flex cursor-pointer items-center gap-2 text-left font-mono text-xs font-semibold text-foreground"
            onClick={onToggle}
            aria-expanded={open}
          >
            <StatusDot status={streaming ? "running" : "complete"} />
            <span className="truncate">{label}</span>
          </button>
          {open && <div className="mt-3 text-sm leading-6 text-muted-foreground">{children}</div>}
        </>
      ) : (
        <div
          className="flex items-center gap-2 font-mono text-xs font-semibold text-foreground"
          role="status"
        >
          <StatusDot status={streaming ? "running" : "complete"} />
          <span className="truncate">{label}</span>
        </div>
      )}
    </div>
  );
}
