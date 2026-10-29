import { useLayoutEffect, useRef, type HTMLAttributes } from "react";
import { arrivedKeys } from "../../hooks/use-arrivals";
import { cn } from "../../lib/utils";

const ITEM_SELECTOR = "[data-animated-list-key]";
const REORDER_DURATION_MS = 160;
const ENTER_DURATION_MS = 260;
const EASING = "cubic-bezier(0.2, 0, 0, 1)";

interface AnimatedListProps extends HTMLAttributes<HTMLElement> {
  as?: "div" | "ul";
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
  ...props
}: AnimatedListProps) {
  const listRef = useRef<HTMLElement | null>(null);
  const previousKeysRef = useRef<ReadonlySet<string> | undefined>(undefined);
  const previousTopsRef = useRef(new Map<string, number>());
  const animationsRef = useRef(new Map<string, Animation>());
  // Entrances outlive re-renders: unrelated updates must not cut them short.
  const entrancesRef = useRef(new Map<string, Animation>());

  useLayoutEffect(() => {
    const items = Array.from(
      listRef.current?.querySelectorAll<HTMLElement>(`:scope > ${ITEM_SELECTOR}`) ?? [],
    );
    const nextKeys = new Set<string>();
    const nextTops = new Map<string, number>();
    const moves: { item: HTMLElement; offset: number }[] = [];
    const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

    for (const item of items) {
      const key = item.dataset.animatedListKey;
      if (!key) continue;
      nextKeys.add(key);
      // Layout coordinates ignore scrolling and in-flight row transforms.
      const nextTop = item.offsetTop;
      nextTops.set(key, nextTop);
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
