import { forwardRef, type HTMLAttributes, type MouseEventHandler, type ReactNode } from "react";
import { cn } from "@/lib/utils";

export interface NavItemProps extends Omit<HTMLAttributes<HTMLDivElement>, "onClick"> {
  icon?: ReactNode;
  label: ReactNode;
  description?: ReactNode;
  badge?: ReactNode;
  trailing?: ReactNode;
  active?: boolean;
  disabled?: boolean;
  /** Springy title movement on hover/selection and press; respects reduced motion. */
  motionFeedback?: boolean;
  onClick?: MouseEventHandler<HTMLButtonElement>;
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
    motionFeedback = false,
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
        "group group/nav-item flex w-full min-w-0 items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors select-none [app-region:no-drag]",
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
        className="group/nav-action flex min-w-0 flex-1 items-center gap-2 text-left bg-transparent border-0 p-0 text-inherit cursor-pointer disabled:cursor-default outline-none"
        onClick={onClick}
      >
        {icon && <span className="shrink-0 text-inherit">{icon}</span>}
        <div className="flex min-w-0 flex-1 flex-col justify-center">
          <div className="flex items-center gap-1.5">
            <span
              className={cn(
                "truncate",
                motionFeedback &&
                  !disabled &&
                  "origin-left motion-safe:transition-transform motion-safe:duration-300 motion-safe:ease-[cubic-bezier(0.22,1.12,0.36,1)] motion-safe:group-hover/nav-item:translate-x-0.5 motion-safe:group-active/nav-action:translate-y-px motion-safe:group-active/nav-action:scale-[0.985] motion-safe:group-active/nav-action:duration-75",
                motionFeedback && active && !disabled && "motion-safe:translate-x-0.5",
              )}
            >
              {label}
            </span>
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
