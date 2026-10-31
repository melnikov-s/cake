import type { ReactNode } from "react";
import { DisclosureTrigger } from "../ui/disclosure-trigger";
import { StatusDot, statusDotGapClassName } from "../ui/status-dot";
import { cn } from "@/lib/utils";

export function Reasoning({
  open,
  onToggle,
  children,
  streaming,
  hasContent = true,
  timer,
}: {
  open: boolean;
  onToggle(): void;
  children: ReactNode;
  streaming?: boolean;
  hasContent?: boolean;
  timer?: ReactNode;
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
          <div className="flex min-w-0 items-center justify-between gap-3">
            <DisclosureTrigger
              className="flex-1"
              title={label}
              status={streaming ? "running" : "complete"}
              onClick={onToggle}
              open={open}
              showChevron={false}
            />
            {timer}
          </div>
          {open && <div className="mt-3 text-sm leading-6 text-muted-foreground">{children}</div>}
        </>
      ) : (
        <div
          className={cn(
            "flex items-center font-mono text-xs font-semibold text-foreground",
            statusDotGapClassName,
          )}
          role="status"
        >
          <StatusDot status={streaming ? "running" : "complete"} />
          <span className="min-w-0 flex-1 truncate">{label}</span>
          {timer}
        </div>
      )}
    </div>
  );
}
