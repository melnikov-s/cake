import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

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
  return (
    <header
      data-slot="workspace-header"
      className={cn(
        "relative box-content flex h-title-bar min-w-0 shrink-0 items-center gap-3 border-b border-border/65 [app-region:drag]",
        compact
          ? "overflow-hidden px-5"
          : "pl-[46px] pr-[calc(2.75rem+var(--workspace-header-inset,0px))]",
      )}
    >
      {compact && titleLeading}
      <div data-slot="workspace-title" className="flex h-full min-w-0 flex-1 items-center">
        {title}
      </div>
      <div
        data-slot="workspace-actions"
        className="flex h-full max-w-[70%] min-w-0 shrink-0 items-center gap-1 overflow-x-auto [app-region:no-drag]"
      >
        {children}
      </div>
    </header>
  );
}
