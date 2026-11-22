import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { LeftToolbarLayout } from "../../../utils/left-toolbar-preferences";
import { cn } from "../../lib/utils";
import { IconButton } from "./icon-button";
import { SidebarIcon } from "./icons";
import { NavigationRailContext } from "./navigation-rail-context";
import { NavigationRailLabelsContext } from "./navigation-rail-labels";

/** Stable layout track; disclosure overlays it without resizing the conversation. */
export function NavigationRail({
  label,
  header,
  listHeading,
  footer,
  children,
  onOverlayRightChange,
  autoHide = false,
  layout = "dynamic",
  revealed = false,
  onRevealChange,
  retained = false,
}: {
  label: string;
  autoHide?: boolean;
  layout?: LeftToolbarLayout;
  revealed?: boolean;
  retained?: boolean;
  onRevealChange?(revealed: boolean): void;
  header: ReactNode;
  /** Section label moves with the list; only header and footer stay fixed. */
  listHeading?: ReactNode;
  footer: ReactNode;
  children: ReactNode;
  onOverlayRightChange(right: number): void;
}) {
  const ref = useRef<HTMLElement>(null);
  const edgeRef = useRef<HTMLButtonElement>(null);
  const id = useId();
  const [hovered, setHovered] = useState(false);
  const [canHover, setCanHover] = useState(() => window.matchMedia("(hover: hover)").matches);
  useLayoutEffect(() => {
    const media = window.matchMedia("(hover: hover)");
    const update = () => setCanHover(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  const [focused, setFocused] = useState(false);
  const [interacting, setInteracting] = useState(false);
  // Set between a rail press and its release: focus it moves is not keyboard focus.
  const pointerFocus = useRef(false);
  const [dragging, setDragging] = useState(false);
  const [owners, setOwners] = useState<ReadonlySet<symbol>>(() => new Set());
  const retain = useCallback((owner: symbol, open: boolean) => {
    setOwners((current) => {
      const next = new Set(current);
      if (open) next.add(owner);
      else next.delete(owner);
      return next;
    });
  }, []);
  const menuOpen = retained || owners.size > 0;
  const active = (canHover && hovered) || focused || interacting || dragging || menuOpen;
  const visible = !autoHide || revealed || active;
  const expanded =
    layout === "full" || (layout === "dynamic" && (active || (autoHide && revealed)));
  const labelsVisible = visible && expanded;
  const context = useMemo(() => ({ retain }), [retain]);

  useEffect(() => {
    const endPointer = () => {
      pointerFocus.current = false;
      setInteracting(false);
    };
    const endDrag = () => setDragging(false);
    // Activating a rail control can replace the hovered node; Chromium then dispatches no
    // pointerleave/mouseleave for the rail, so entering any outside element ends hover.
    const pointerOver = (event: PointerEvent) => {
      if (!(event.target instanceof Node) || !ref.current?.contains(event.target))
        setHovered(false);
    };
    const blur = () => {
      setHovered(false);
      setInteracting(false);
      setDragging(false);
      onRevealChange?.(false);
    };
    window.addEventListener("pointerover", pointerOver);
    window.addEventListener("pointerup", endPointer);
    window.addEventListener("pointercancel", endPointer);
    window.addEventListener("dragend", endDrag);
    window.addEventListener("drop", endDrag);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("pointerover", pointerOver);
      window.removeEventListener("pointerup", endPointer);
      window.removeEventListener("pointercancel", endPointer);
      window.removeEventListener("dragend", endDrag);
      window.removeEventListener("drop", endDrag);
      window.removeEventListener("blur", blur);
    };
  }, [onRevealChange]);

  useEffect(() => {
    // Claim Escape only to collapse a revealed or expanded rail. A resting Dynamic rail must
    // leave Escape to the window-level dismissal of panels such as Changes or Session tree.
    const dismissible = autoHide ? visible : layout === "dynamic" && active;
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || menuOpen || !dismissible) return;
      event.preventDefault();
      setHovered(false);
      onRevealChange?.(false);
      if (ref.current?.contains(document.activeElement)) {
        if (autoHide) edgeRef.current?.focus({ preventScroll: true });
        else if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
      }
      setFocused(false);
    };
    // Nested popovers dismiss on document first; they own the first Escape.
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, [autoHide, layout, menuOpen, visible, active, onRevealChange]);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => {
      const rect = element.getBoundingClientRect();
      onOverlayRightChange(rect.width > 0 && (autoHide || rect.width > 54) ? rect.right : 0);
    };
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    measure();
    return () => {
      observer.disconnect();
      onOverlayRightChange(0);
    };
  }, [onOverlayRightChange, autoHide]);

  return (
    <NavigationRailLabelsContext.Provider value={labelsVisible}>
      <NavigationRailContext.Provider value={context}>
        {autoHide && (
          <>
            <div
              aria-hidden="true"
              data-slot="project-rail-edge"
              className="absolute bottom-0 left-0 top-title-bar z-40 w-2 [app-region:no-drag]"
              onPointerEnter={(event) => {
                if (event.pointerType !== "touch") onRevealChange?.(true);
              }}
              onPointerLeave={(event) => {
                if (
                  !(event.relatedTarget instanceof Node) ||
                  !ref.current?.contains(event.relatedTarget)
                )
                  onRevealChange?.(false);
              }}
              onDragEnter={() => onRevealChange?.(true)}
            />
            <IconButton
              ref={edgeRef}
              tooltip="Show left toolbar"
              aria-controls={id}
              aria-expanded={visible}
              className="absolute left-0 top-title-bar z-40 bg-sidebar"
              onClick={() => {
                onRevealChange?.(true);
                ref.current?.querySelector<HTMLElement>("button")?.focus({ preventScroll: true });
              }}
            >
              <SidebarIcon size={18} />
            </IconButton>
          </>
        )}
        <nav
          id={id}
          ref={ref}
          aria-label={label}
          data-slot="project-rail"
          data-auto-hide={autoHide}
          data-revealed={autoHide && visible}
          data-expanded={expanded}
          data-labels-visible={labelsVisible}
          data-layout={layout}
          onMouseEnter={() => setHovered(true)}
          onMouseLeave={() => setHovered(false)}
          onPointerEnter={(event) => {
            if (event.pointerType !== "touch") setHovered(true);
          }}
          onPointerLeave={() => {
            setHovered(false);
            onRevealChange?.(false);
          }}
          onPointerDown={() => {
            pointerFocus.current = true;
            setInteracting(true);
          }}
          onDragStart={() => setDragging(true)}
          onDragEnter={() => setDragging(true)}
          onDragLeave={(event) => {
            if (
              !(event.relatedTarget instanceof Node) ||
              !event.currentTarget.contains(event.relatedTarget)
            )
              setDragging(false);
          }}
          // Only keyboard focus holds the rail open: a clicked rail action keeps focus, and the
          // expanded rail would otherwise stay over the destination after the pointer leaves.
          onFocusCapture={(event) =>
            setFocused(!pointerFocus.current && event.currentTarget.contains(event.target))
          }
          onBlurCapture={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false);
          }}
          className={cn(
            "absolute bottom-0 left-0 top-title-bar z-50 flex max-w-[calc(100vw-1rem)] flex-col gap-1 overflow-hidden border-r border-transparent bg-chassis pt-2 text-sidebar-foreground transition-[width,box-shadow,background-color,border-color] duration-150 select-none motion-reduce:transition-none",
            expanded
              ? "w-60 [&_[data-slot=icon-button-label]]:visible"
              : "w-[54px] max-[700px]:w-11 [&_[data-slot=icon-button-label]]:invisible",
            visible &&
              expanded &&
              (autoHide || layout === "dynamic") &&
              "rounded-r-[10px] border-hairline bg-inspector shadow-xl",
            !visible && "w-0 max-[700px]:w-0 border-r-0",
          )}
        >
          <div className="max-h-[30%] shrink-0 overflow-y-auto overflow-x-hidden px-1 pb-2">
            {layout === "dynamic" && (
              <IconButton
                tooltip="Show navigation labels"
                label="Projects and actions"
                className="hidden h-9 [@media(hover:none)]:grid"
                onClick={(event) => event.currentTarget.focus()}
              >
                <SidebarIcon size={18} />
              </IconButton>
            )}
            {header}
          </div>
          <div
            data-slot="project-rail-scroll"
            className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden overflow-y-auto overscroll-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          >
            {/* Auto margins split spare height without pushing overflowing content above the scroll origin. */}
            <div className="my-auto flex min-w-0 shrink-0 flex-col gap-1">
              {listHeading}
              <div
                role="region"
                aria-label="Projects"
                tabIndex={0}
                className="flex min-w-0 flex-col gap-1 px-1"
              >
                {children}
              </div>
            </div>
          </div>
          <div className="max-h-[45%] shrink-0 overflow-y-auto overflow-x-hidden border-t border-hairline-subtle px-1 pt-1 pb-2">
            {footer}
          </div>
        </nav>
      </NavigationRailContext.Provider>
    </NavigationRailLabelsContext.Provider>
  );
}
