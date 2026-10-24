import type { ReactNode } from "react";
import { CloseIcon } from "@/components/ui/icons";
import { IconButton } from "@/components/ui/icon-button";
import { cn } from "@/lib/utils";

export function SidePanel({
  title,
  eyebrow,
  className,
  children,
  headerActions,
  onClose,
}: {
  title: string;
  eyebrow: string;
  className?: string;
  children: ReactNode;
  headerActions?: ReactNode;
  onClose(): void;
}) {
  return (
    <aside
      data-slot="side-panel"
      className={cn(
        "grid h-full min-h-0 min-w-0 grid-rows-[52px_minmax(0,1fr)] bg-background",
        className,
      )}
      aria-label={title}
    >
      <header className="flex min-w-0 items-center gap-3 border-b border-border/65 px-4">
        <div className="min-w-0 flex-1">
          <p className="truncate font-mono text-xs uppercase tracking-wider text-muted-foreground">
            {eyebrow}
          </p>
          <strong className="block truncate text-sm font-semibold">{title}</strong>
        </div>
        {headerActions}
        <IconButton tooltip={`Close ${title}`} ariaLabel={`Close ${title}`} onClick={onClose}>
          <CloseIcon size={14} />
        </IconButton>
      </header>
      <div className="h-full min-h-0 min-w-0 overflow-hidden">{children}</div>
    </aside>
  );
}
