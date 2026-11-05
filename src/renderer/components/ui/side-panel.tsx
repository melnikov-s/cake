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
  eyebrow?: string;
  className?: string;
  children: ReactNode;
  headerActions?: ReactNode;
  onClose?(): void;
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
      <header className="box-content flex h-title-bar min-w-0 items-center gap-3 border-b border-border/65 bg-sidebar/30 px-4">
        <div className="min-w-0 flex-1">
          <strong className="block truncate text-xs font-semibold text-foreground">{title}</strong>
          {eyebrow && <p className="mt-0.5 truncate text-xs text-muted-foreground">{eyebrow}</p>}
        </div>
        {headerActions}
        {onClose && (
          <IconButton tooltip={`Close ${title}`} ariaLabel={`Close ${title}`} onClick={onClose}>
            <CloseIcon size={14} />
          </IconButton>
        )}
      </header>
      <div className="h-full min-h-0 min-w-0 overflow-hidden">{children}</div>
    </aside>
  );
}
