import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { cn } from "@/lib/utils";

export interface ActionCardProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "title"> {
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  descriptionClassName?: string;
  badge?: ReactNode;
  trailing?: ReactNode;
}

export const ActionCard = forwardRef<HTMLButtonElement, ActionCardProps>(function ActionCard(
  {
    className,
    icon,
    title,
    description,
    descriptionClassName,
    badge,
    trailing,
    type = "button",
    disabled,
    children,
    ...props
  },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled}
      className={cn(
        "flex w-full min-w-0 items-center justify-between gap-3 rounded-xl border border-border bg-card p-3 text-left transition-all select-none",
        disabled
          ? "opacity-40 cursor-default"
          : "cursor-pointer hover:border-accent/40 hover:bg-card/85 hover:shadow-xs",
        className,
      )}
      {...props}
    >
      <div className="flex min-w-0 flex-1 items-center gap-3">
        {icon && <div className="shrink-0 text-muted-foreground">{icon}</div>}
        <div className="flex min-w-0 flex-1 flex-col justify-center gap-0.5">
          <div className="flex items-center gap-2">
            <span className="truncate text-xs font-semibold text-foreground">{title}</span>
            {badge}
          </div>
          {description && (
            <span
              className={cn(
                "text-[11px] text-muted-foreground",
                descriptionClassName ?? "truncate",
              )}
            >
              {description}
            </span>
          )}
        </div>
      </div>
      {trailing && <div className="shrink-0 text-muted-foreground">{trailing}</div>}
      {children}
    </button>
  );
});
