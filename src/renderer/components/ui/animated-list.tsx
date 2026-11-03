import { useLayoutEffect, useRef, type HTMLAttributes } from "react";
import { arrivedKeys } from "../../hooks/use-arrivals";
import { cn } from "../../lib/utils";

const ITEM_SELECTOR = "[data-animated-list-key]";
const REORDER_DURATION_MS = 160;
const ENTER_DURATION_MS = 260;
const EASING = "cubic-bezier(0.2, 0, 0, 1)";

interface AnimatedListProps extends HTMLAttributes<HTMLElement> {
  as?: "div" | "ul";
  /** Track grouped rows sharing this container as their offsetParent. */
  nested?: boolean;
  animateRemovals?: boolean;
}

/**
 * Animates existing direct list items to their new vertical position after a reorder,
 * and lets rows inserted into an already-rendered list grow into place. Items present
 * when the list mounts, or a bulk load, appear without an entrance.
 */
export function AnimatedList({
  as: Element = "div",
  className,
  children,
  nested = false,
  animateRemovals = false,
  ...props
}: AnimatedListProps) {
  const listRef = useRef<HTMLElement | null>(null);
  const previousKeysRef = useRef<ReadonlySet<string> | undefined>(undefined);
  const previousTopsRef = useRef(new Map<string, number>());
  const animationsRef = useRef(new Map<string, Animation>());
  // Entrances outlive re-renders: unrelated updates must not cut them short.
  const entrancesRef = useRef(new Map<string, Animation>());
  const previousRowsRef = useRef(
    new Map<
      string,
      { element: HTMLElement; top: number; left: number; width: number; height: number }
    >(),
  );
  const exitsRef = useRef(new Map<HTMLElement, Animation>());

  useLayoutEffect(() => {
    const items = Array.from(
      listRef.current?.querySelectorAll<HTMLElement>(
        nested ? ITEM_SELECTOR : `:scope > ${ITEM_SELECTOR}`,
      ) ?? [],
    );
    const nextKeys = new Set<string>();
    const nextTops = new Map<string, number>();
    const moves: { item: HTMLElement; offset: number }[] = [];
    const nextRows = new Map<
      string,
      { element: HTMLElement; top: number; left: number; width: number; height: number }
    >();
    const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

    for (const item of items) {
      const key = item.dataset.animatedListKey;
      if (!key) continue;
      nextKeys.add(key);
      // Layout coordinates ignore scrolling and in-flight row transforms.
      const nextTop = item.offsetTop;
      nextTops.set(key, nextTop);
      if (animateRemovals)
        nextRows.set(key, {
          element: item,
          top: nextTop,
          left: item.offsetLeft,
          width: item.offsetWidth,
          height: item.offsetHeight,
        });
      const previousTop = previousTopsRef.current.get(key);
      const offset = previousTop === undefined ? 0 : previousTop - nextTop;
      if (!reduceMotion && Math.abs(offset) >= 0.5) moves.push({ item, offset });
    }
    const entering =
      previousKeysRef.current && !reduceMotion
        ? new Set(arrivedKeys(previousKeysRef.current, nextKeys))
        : new Set<string>();

    // Unrelated renders leave in-flight reorders alone. Only a new destination,
    // removal, or reduced-motion request should interrupt them.
    for (const [key, animation] of animationsRef.current) {
      if (
        !reduceMotion &&
        nextKeys.has(key) &&
        nextTops.get(key) === previousTopsRef.current.get(key)
      )
        continue;
      animation.cancel();
      animationsRef.current.delete(key);
    }

    for (const [copy, animation] of exitsRef.current) {
      if (!reduceMotion) continue;
      animation.cancel();
      copy.remove();
      exitsRef.current.delete(copy);
    }
    if (animateRemovals && !reduceMotion) {
      for (const [key, row] of previousRowsRef.current) {
        if (nextKeys.has(key)) continue;
        // Retain only inert pixels, never a second interactive row or mounted Store.
        // SAFETY: cloneNode preserves the tag of the measured HTMLElement row.
        const copy = row.element.cloneNode(true) as HTMLElement;
        // Keep appearance but strip the live row identity from the outgoing root.
        for (const attribute of Array.from(copy.attributes)) {
          if (attribute.name !== "class" && attribute.name !== "style")
            copy.removeAttribute(attribute.name);
        }
        for (const element of copy.querySelectorAll("[id]")) element.removeAttribute("id");
        copy.inert = true;
        copy.setAttribute("aria-hidden", "true");
        copy.classList.add("pointer-events-none", "absolute", "m-0!");
        Object.assign(copy.style, {
          top: `${row.top}px`,
          left: `${row.left}px`,
          width: `${row.width}px`,
          height: `${row.height}px`,
        });
        listRef.current?.append(copy);
        const animation = copy.animate(
          [{ opacity: 1 }, { opacity: 0, transform: "translateY(-4px) scale(0.97)" }],
          { duration: REORDER_DURATION_MS, easing: EASING },
        );
        exitsRef.current.set(copy, animation);
        animation.onfinish = () => {
          copy.remove();
          exitsRef.current.delete(copy);
        };
      }
    }
    previousRowsRef.current = nextRows;

    // Measure the entire list before starting any animations. Interleaving
    // animate() with layout reads forces layout for every shifted row.
    for (const { item, offset } of moves) {
      const key = item.dataset.animatedListKey!;
      const animation = item.animate([{ translate: `0 ${offset}px` }, { translate: "none" }], {
        duration: REORDER_DURATION_MS,
        easing: EASING,
      });
      animationsRef.current.set(key, animation);
      animation.onfinish = () => {
        if (animationsRef.current.get(key) === animation) animationsRef.current.delete(key);
      };
    }
    for (const item of items) {
      const key = item.dataset.animatedListKey;
      if (!key || !entering.has(key)) continue;
      const animation = item.animate(
        [
          { opacity: 0, transform: "translateY(-4px) scale(0.97)" },
          { opacity: 1, transform: "none" },
        ],
        { duration: ENTER_DURATION_MS, easing: EASING },
      );
      entrancesRef.current.set(key, animation);
      animation.onfinish = () => {
        if (entrancesRef.current.get(key) === animation) entrancesRef.current.delete(key);
      };
    }
    for (const [key, animation] of entrancesRef.current) {
      if (nextKeys.has(key)) continue;
      animation.cancel();
      entrancesRef.current.delete(key);
    }

    previousKeysRef.current = nextKeys;
    previousTopsRef.current = nextTops;
  });

  useLayoutEffect(
    () => () => {
      for (const animation of animationsRef.current.values()) animation.cancel();
      for (const animation of entrancesRef.current.values()) animation.cancel();
      for (const [copy, animation] of exitsRef.current) {
        animation.cancel();
        copy.remove();
      }
    },
    [],
  );

  return (
    <Element
      ref={(element: HTMLElement | null) => {
        listRef.current = element;
      }}
      className={cn("relative", className)}
      {...props}
    >
      {children}
    </Element>
  );
}
