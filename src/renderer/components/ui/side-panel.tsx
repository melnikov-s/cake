import type { ReactNode } from "react";
import { CloseIcon } from "@/components/ui/icons";
import { IconButton } from "@/components/ui/icon-button";
import { cn } from "@/lib/utils";

export function SidePanel({
  title,
  eyebrow,
  compact = false,
  className,
  children,
  headerActions,
  onClose,
  closeLabel,
  closeDisabled = false,
}: {
  title: string;
  eyebrow?: string;
  compact?: boolean;
  className?: string;
  children: ReactNode;
  headerActions?: ReactNode;
  onClose?(): void;
  closeLabel?: string;
  closeDisabled?: boolean;
}) {
  return (
    <aside
      data-slot="side-panel"
      className={cn(
        "grid h-full min-h-0 min-w-0 grid-rows-[auto_minmax(0,1fr)] bg-background",
        className,
      )}
      aria-label={title}
    >
      <header
        className={cn(
          "box-content flex min-w-0 items-center gap-3 border-b border-border/65 bg-sidebar/30",
          compact ? "h-9 px-3" : "h-title-bar px-4",
        )}
      >
        <div className="min-w-0 flex-1">
          <strong className="block truncate text-xs font-semibold text-foreground">{title}</strong>
          {eyebrow && <p className="mt-0.5 truncate text-xs text-muted-foreground">{eyebrow}</p>}
        </div>
        {headerActions}
        {onClose && (
          <IconButton
            tooltip={closeLabel ?? `Close ${title}`}
            ariaLabel={closeLabel ?? `Close ${title}`}
            disabled={closeDisabled}
            onClick={onClose}
          >
            <CloseIcon size={14} />
          </IconButton>
        )}
      </header>
      <div className="h-full min-h-0 min-w-0 overflow-hidden">{children}</div>
    </aside>
  );
}
