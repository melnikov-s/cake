import { useLayoutEffect, useRef, type HTMLAttributes } from "react";
import { cn } from "../../lib/utils";

const itemSelector = "[data-navigation-item]";
const selectedSelector = `${itemSelector}[data-navigation-active=true]`;

/** Shared moving backgrounds for descendant navigation rows.
 * Rows declare data-navigation-item and data-navigation-active; their existing
 * controls still own selection and accessibility. This owns only disposable DOM
 * geometry/hover for its mounted lifetime, never application or persisted state.
 */
export function NavigationHighlight({
  className,
  children,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  const rootRef = useRef<HTMLDivElement>(null);
  const selectionRef = useRef<HTMLDivElement>(null);
  const hoverRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const root = rootRef.current!;
    const selection = selectionRef.current!;
    const hover = hoverRef.current!;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    const animations = new Map<HTMLElement, Animation>();
    const destinations = new Map<HTMLElement, string>();
    let hovered: HTMLElement | null = null;
    let focused: HTMLElement | null = null;
    let frame = 0;

    const move = (layer: HTMLElement, item: HTMLElement | null, visible: boolean) => {
      layer.dataset.visible = String(visible);
      if (!item) {
        animations.get(layer)?.cancel();
        animations.delete(layer);
        return;
      }
      // Layout coordinates deliberately ignore AnimatedList's temporary reorder
      // transforms. Both layers live inside the same scrolling content as rows.
      let x = 0;
      let y = 0;
      let ancestor: HTMLElement | null = item;
      while (ancestor && ancestor !== root) {
        x += ancestor.offsetLeft;
        y += ancestor.offsetTop;
        ancestor = ancestor.offsetParent instanceof HTMLElement ? ancestor.offsetParent : null;
      }
      const destination = `${x},${y},${item.offsetWidth},${item.offsetHeight}`;
      if (destinations.get(layer) === destination && !reduced.matches && !document.hidden) return;
      const previous = destinations.get(layer);
      const current = getComputedStyle(layer);
      const from = { transform: current.transform, width: current.width, height: current.height };
      animations.get(layer)?.cancel();
      animations.delete(layer);
      const to = {
        transform: `translate(${x}px, ${y}px)`,
        width: `${item.offsetWidth}px`,
        height: `${item.offsetHeight}px`,
      };
      Object.assign(layer.style, to);
      destinations.set(layer, destination);
      if (!previous || reduced.matches || document.hidden) return;
      // Interrupted movement starts from the displayed geometry, not the old row.
      const animation = layer.animate([from, to], {
        duration: layer === selection ? 340 : 220,
        easing:
          layer === selection
            ? "cubic-bezier(0.22, 1.12, 0.36, 1)"
            : "cubic-bezier(0.22, 1, 0.36, 1)",
      });
      animations.set(layer, animation);
      animation.onfinish = () => {
        animations.delete(layer);
        animation.cancel();
      };
    };
    const refresh = () => {
      frame = 0;
      if (hovered && !root.contains(hovered)) hovered = null;
      if (focused && !root.contains(focused)) focused = null;
      const selected = root.querySelector<HTMLElement>(selectedSelector);
      const preview = hovered ?? focused;
      move(selection, selected, Boolean(selected));
      // Fade hover into the arriving selection instead of stacking two fills.
      move(hover, preview ?? selected, Boolean(preview && preview !== selected));
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(refresh);
    };
    const rowFor = (target: EventTarget | null) => {
      const row = target instanceof Element ? target.closest<HTMLElement>(itemSelector) : null;
      return row && root.contains(row) ? row : null;
    };
    const pointerOver = (event: PointerEvent) => {
      if (event.pointerType === "touch") return;
      hovered = rowFor(event.target);
      schedule();
    };
    const pointerLeave = () => {
      hovered = null;
      schedule();
    };
    const focusIn = (event: FocusEvent) => {
      focused = rowFor(event.target);
      schedule();
    };
    const focusOut = (event: FocusEvent) => {
      focused = rowFor(event.relatedTarget);
      schedule();
    };
    const resize = new ResizeObserver(schedule);
    const observeRows = () => {
      resize.disconnect();
      resize.observe(root);
      for (const row of root.querySelectorAll(itemSelector)) resize.observe(row);
      schedule();
    };
    const mutations = new MutationObserver(observeRows);
    mutations.observe(root, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["data-navigation-active"],
    });
    root.addEventListener("pointerover", pointerOver);
    root.addEventListener("pointerleave", pointerLeave);
    root.addEventListener("focusin", focusIn);
    root.addEventListener("focusout", focusOut);
    reduced.addEventListener("change", schedule);
    document.addEventListener("visibilitychange", schedule);
    observeRows();
    cancelAnimationFrame(frame);
    refresh();
    return () => {
      cancelAnimationFrame(frame);
      resize.disconnect();
      mutations.disconnect();
      for (const animation of animations.values()) animation.cancel();
      root.removeEventListener("pointerover", pointerOver);
      root.removeEventListener("pointerleave", pointerLeave);
      root.removeEventListener("focusin", focusIn);
      root.removeEventListener("focusout", focusOut);
      reduced.removeEventListener("change", schedule);
      document.removeEventListener("visibilitychange", schedule);
    };
  }, []);

  return (
    <div
      ref={rootRef}
      data-slot="navigation-highlight"
      className={cn("relative isolate", className)}
      {...props}
    >
      <div
        ref={selectionRef}
        aria-hidden="true"
        data-slot="navigation-selection"
        className="pointer-events-none absolute left-0 top-0 -z-10 rounded-md bg-sidebar-active opacity-0 transition-opacity duration-200 data-[visible=true]:opacity-100 motion-reduce:transition-none"
      />
      <div
        ref={hoverRef}
        aria-hidden="true"
        data-slot="navigation-hover"
        className="pointer-events-none absolute left-0 top-0 -z-10 rounded-md bg-sidebar-hover opacity-0 transition-opacity duration-150 data-[visible=true]:opacity-100 motion-reduce:transition-none"
      />
      {children}
    </div>
  );
}
