import { useLayoutEffect, useRef, type ReactNode } from "react";
import { IconButton } from "./icon-button";
import { SidebarIcon } from "./icons";

/** Overlay disclosure for pointer, keyboard and touch; each section keeps its own scroll. */
export function NavigationRail({
  label,
  header,
  footer,
  children,
  onOverlayRightChange,
  autoHide = false,
  revealed = false,
  onRevealChange,
}: {
  label: string;
  autoHide?: boolean;
  revealed?: boolean;
  onRevealChange?(revealed: boolean): void;
  header: ReactNode;
  footer: ReactNode;
  children: ReactNode;
  onOverlayRightChange(right: number): void;
}) {
  const ref = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => {
      const rect = element.getBoundingClientRect();
      onOverlayRightChange(rect.width > 54 ? rect.right : 0);
    };
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    measure();
    return () => {
      observer.disconnect();
      onOverlayRightChange(0);
    };
  }, [onOverlayRightChange]);
  return (
    <>
      {autoHide && (
        <div
          aria-hidden="true"
          data-slot="project-rail-edge"
          className="absolute bottom-0 left-0 top-title-bar z-40 w-2 [app-region:no-drag]"
          onPointerEnter={(event) => {
            if (event.pointerType !== "touch") onRevealChange?.(true);
          }}
        />
      )}
      <nav
        ref={ref}
        aria-label={label}
        data-slot="project-rail"
        data-auto-hide={autoHide}
        data-revealed={autoHide && revealed}
        onPointerLeave={() => onRevealChange?.(false)}
        className="absolute bottom-0 left-0 top-title-bar z-50 flex w-[54px] max-w-[calc(100vw-1rem)] flex-col gap-1 overflow-hidden border-r border-border/70 bg-sidebar pt-2 text-sidebar-foreground transition-[width,box-shadow] duration-150 select-none motion-reduce:transition-none focus-within:w-60 focus-within:shadow-xl max-[700px]:w-11 max-[700px]:focus-within:w-60 max-[700px]:[@media(hover:hover)]:hover:w-60 [@media(hover:hover)]:hover:w-60 [@media(hover:hover)]:hover:shadow-xl [&_[data-slot=icon-button-label]]:invisible focus-within:[&_[data-slot=icon-button-label]]:visible [@media(hover:hover)]:hover:[&_[data-slot=icon-button-label]]:visible"
      >
        <div className="max-h-[30%] shrink-0 overflow-y-auto overflow-x-hidden px-1">
          <IconButton
            tooltip="Show navigation labels"
            label="Projects and actions"
            className="hidden h-9 [@media(hover:none)]:grid"
            onClick={(event) => event.currentTarget.focus()}
          >
            <SidebarIcon />
          </IconButton>
          {header}
        </div>
        <div
          role="region"
          aria-label="Projects"
          tabIndex={0}
          className="min-h-9 min-w-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain pl-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          <div className="flex min-w-0 flex-col gap-1 pr-1">{children}</div>
        </div>
        <div className="max-h-[45%] shrink-0 overflow-y-auto overflow-x-hidden px-1 pb-2">
          {footer}
        </div>
      </nav>
    </>
  );
}
