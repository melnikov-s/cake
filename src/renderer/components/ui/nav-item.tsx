import {
  forwardRef,
  useRef,
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type MouseEventHandler,
  type ReactNode,
} from "react";
import { cn } from "@/lib/utils";

/** Advisory relationship cue, deliberately weaker than navigation selection and focus. */
export const associationHighlightClassName =
  "bg-sidebar-hover/35 outline outline-1 -outline-offset-1 outline-dashed outline-accent/25";

export interface NavItemProps extends Omit<HTMLAttributes<HTMLDivElement>, "onClick"> {
  icon?: ReactNode;
  label: ReactNode;
  description?: ReactNode;
  badge?: ReactNode;
  trailing?: ReactNode;
  active?: boolean;
  /** Related context, not navigation selection. Active always takes precedence. */
  associated?: boolean;
  disabled?: boolean;
  /** Springy title movement on hover/selection and press; respects reduced motion. */
  motionFeedback?: boolean;
  /** Select from non-interactive row content while keeping nested controls independent. */
  wholeRowAction?: boolean;
  /** Allow native text selection; selection drags must not activate row actions or controls. */
  selectableText?: boolean;
  /** Open on primary press; retain native keyboard/assistive clicks and control-click menus. */
  activateOnMouseDown?: boolean;
  /** Action semantics for composite controls such as a searchable listbox. */
  actionProps?: Pick<
    ButtonHTMLAttributes<HTMLButtonElement>,
    | "id"
    | "role"
    | "aria-selected"
    | "aria-pressed"
    | "aria-label"
    | "aria-disabled"
    | "tabIndex"
    | "onMouseDown"
  >;
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
    associated = false,
    disabled = false,
    motionFeedback = false,
    wholeRowAction = false,
    selectableText = false,
    activateOnMouseDown = false,
    actionProps,
    onClick,
    onContextMenu,
    onMouseEnter,
    onMouseDownCapture,
    onClickCapture,
    children,
    ...props
  },
  ref,
) {
  const actionRef = useRef<HTMLButtonElement>(null);
  const selectionStart = useRef<{ x: number; y: number } | null>(null);
  return (
    <div
      ref={ref}
      data-associated={associated && !active ? "true" : undefined}
      className={cn(
        "group group/nav-item flex w-full min-w-0 items-center justify-between gap-2 rounded-md px-2 py-1 text-left text-xs tracking-[-0.005em] transition-colors select-none [app-region:no-drag]",
        active
          ? "bg-sidebar-active text-primary font-medium"
          : "text-muted-foreground hover:bg-sidebar-hover hover:text-foreground",
        associated && !active && associationHighlightClassName,
        wholeRowAction && "relative",
        wholeRowAction && !disabled && "cursor-pointer",
        selectableText && "select-text cursor-text",
        disabled && "opacity-40 cursor-default hover:bg-transparent hover:text-muted-foreground",
        className,
      )}
      onClick={
        wholeRowAction
          ? (event) => {
              if (
                disabled ||
                actionProps?.["aria-disabled"] === true ||
                event.defaultPrevented ||
                !(event.target instanceof Element)
              )
                return;
              if (
                event.target.closest(
                  "button, a, input, select, textarea, summary, [role=button], [role=link], [contenteditable=true]",
                )
              )
                return;
              actionRef.current?.focus();
              actionRef.current?.click();
            }
          : undefined
      }
      onMouseDownCapture={(event) => {
        onMouseDownCapture?.(event);
        if (selectableText) selectionStart.current = { x: event.clientX, y: event.clientY };
      }}
      onClickCapture={(event) => {
        onClickCapture?.(event);
        if (!selectableText || event.detail === 0) return;
        const start = selectionStart.current;
        const dragged = start && Math.hypot(event.clientX - start.x, event.clientY - start.y) > 3;
        const selection = event.currentTarget.ownerDocument.getSelection();
        if (dragged || (event.shiftKey && selection && !selection.isCollapsed)) {
          event.preventDefault();
          event.stopPropagation();
        }
      }}
      onMouseEnter={onMouseEnter}
      onContextMenu={onContextMenu}
      {...props}
    >
      <button
        ref={actionRef}
        {...actionProps}
        type="button"
        disabled={disabled}
        aria-current={
          active && actionProps?.role !== "option" && actionProps?.["aria-pressed"] === undefined
            ? "page"
            : undefined
        }
        className={cn(
          "group/nav-action flex min-w-0 flex-1 items-center gap-2 text-left bg-transparent border-0 p-0 text-inherit cursor-pointer disabled:cursor-default outline-none",
          selectableText && "select-text cursor-text",
          wholeRowAction &&
            "after:pointer-events-none after:absolute after:inset-0 after:rounded-md focus-visible:after:ring-2 focus-visible:after:ring-ring focus-visible:after:ring-offset-2",
        )}
        onMouseDown={(event) => {
          actionProps?.onMouseDown?.(event);
          if (
            activateOnMouseDown &&
            event.button === 0 &&
            !event.ctrlKey &&
            !event.defaultPrevented &&
            actionProps?.["aria-disabled"] !== true
          ) {
            onClick?.(event);
          }
        }}
        onClick={(event) => {
          // Pointer clicks already opened on press. detail=0 retains native keyboard,
          // assistive technology and programmatic activation. Control-click stays native.
          if (activateOnMouseDown && event.detail > 0 && !event.ctrlKey) return;
          if (actionProps?.["aria-disabled"] !== true) onClick?.(event);
        }}
      >
        {icon && <span className="shrink-0 text-inherit">{icon}</span>}
        <div className="flex min-w-0 flex-1 flex-col justify-center">
          <div className="flex items-center gap-1.5">
            <span
              className={cn(
                wholeRowAction ? "whitespace-normal break-words" : "truncate",
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
            <div
              className={cn(
                "mt-0.5 text-xs font-normal leading-snug",
                active ? "text-primary/75" : "text-muted-foreground/75",
              )}
            >
              {description}
            </div>
          )}
        </div>
      </button>
      {trailing && (
        <div data-slot="nav-trailing" className="shrink-0 text-inherit">
          {trailing}
        </div>
      )}
      {children}
    </div>
  );
});
