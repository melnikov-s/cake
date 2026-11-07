import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/** Shared header geometry for the conversation and its Browser/VS Code surfaces. */
export function WorkspaceHeader({
  title,
  actionTitle,
  titleLeading,
  compact = false,
  children,
}: {
  title: ReactNode;
  actionTitle?: string;
  titleLeading?: ReactNode;
  compact?: boolean;
  children: ReactNode;
}) {
  return (
    <header
      data-slot="workspace-header"
      className={cn(
        "relative min-w-0 border-b border-border/65 [app-region:drag]",
        compact
          ? "box-content flex h-title-bar items-center gap-3 overflow-hidden px-5"
          : "flex min-h-workspace-title-bar shrink-0 flex-col",
      )}
    >
      {compact && titleLeading}
      <div
        className={cn("min-w-0", compact ? "flex-1" : "min-h-workspace-title-bar pl-[46px] pr-3")}
      >
        <div className="flex h-title-bar min-w-0 items-center">{title}</div>
      </div>
      <div
        data-slot="workspace-actions"
        className={cn(
          "flex min-w-0 items-center gap-1 overflow-x-auto [app-region:no-drag]",
          compact
            ? "-my-1 max-w-[70%] shrink-0 py-1"
            : "justify-end border-t border-border/40 px-3 py-1",
        )}
      >
        {!compact && actionTitle !== undefined && (
          <strong className="min-w-0 flex-1 truncate text-sm font-semibold" title={actionTitle}>
            {actionTitle}
          </strong>
        )}
        {children}
      </div>
    </header>
  );
}
