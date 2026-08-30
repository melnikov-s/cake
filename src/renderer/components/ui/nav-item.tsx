import { forwardRef, type HTMLAttributes, type ReactNode } from "react";
import { cn } from "@/lib/utils";

export interface NavItemProps extends HTMLAttributes<HTMLDivElement> {
  icon?: ReactNode;
  label: ReactNode;
  description?: ReactNode;
  badge?: ReactNode;
  trailing?: ReactNode;
  active?: boolean;
  disabled?: boolean;
}

export const NavItem = forwardRef<HTMLDivElement, NavItemProps>(function NavItem(
  {
    className,
    icon,
    label,
    description,
    badge,
    trailing,
    active = false,
    disabled = false,
    onClick,
    onContextMenu,
    onMouseEnter,
    children,
    ...props
  },
  ref,
) {
  return (
    <div
      ref={ref}
      className={cn(
        "group flex w-full min-w-0 items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors select-none [app-region:no-drag]",
        active
          ? "bg-sidebar-active text-primary font-semibold"
          : "text-muted-foreground hover:bg-sidebar-hover hover:text-foreground",
        disabled && "opacity-40 cursor-default hover:bg-transparent hover:text-muted-foreground",
        className,
      )}
      onMouseEnter={onMouseEnter}
      onContextMenu={onContextMenu}
      {...props}
    >
      <button
        type="button"
        disabled={disabled}
        aria-current={active ? "page" : undefined}
        className="flex min-w-0 flex-1 items-center gap-2 text-left bg-transparent border-0 p-0 text-inherit cursor-pointer disabled:cursor-default outline-none"
        onClick={onClick}
      >
        {icon && <span className="shrink-0 text-inherit">{icon}</span>}
        <div className="flex min-w-0 flex-1 flex-col justify-center">
          <div className="flex items-center gap-1.5">
            <span className="truncate">{label}</span>
            {badge}
          </div>
          {description && (
            <div className="mt-0.5 text-[10px] font-normal text-muted-foreground leading-none">
              {description}
            </div>
          )}
        </div>
      </button>
      {trailing && <div className="shrink-0 text-inherit">{trailing}</div>}
      {children}
    </div>
  );
});
