import { useLayoutEffect, useRef, type HTMLAttributes } from "react";
import { cn } from "../../lib/utils";

const ITEM_SELECTOR = "[data-animated-list-key]";
const REORDER_DURATION_MS = 160;

/** Animates existing direct list items to their new vertical position after a reorder. */
export function AnimatedList({ className, children, ...props }: HTMLAttributes<HTMLDivElement>) {
  const listRef = useRef<HTMLDivElement>(null);
  const previousTopsRef = useRef(new Map<string, number>());
  const animationsRef = useRef<Animation[]>([]);

  useLayoutEffect(() => {
    for (const animation of animationsRef.current) animation.cancel();
    animationsRef.current = [];

    const items = Array.from(
      listRef.current?.querySelectorAll<HTMLElement>(`:scope > ${ITEM_SELECTOR}`) ?? [],
    );
    const nextTops = new Map<string, number>();
    const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

    for (const item of items) {
      const key = item.dataset.animatedListKey;
      if (!key) continue;

      const nextTop = item.getBoundingClientRect().top;
      nextTops.set(key, nextTop);
      const previousTop = previousTopsRef.current.get(key);
      const offset = previousTop === undefined ? 0 : previousTop - nextTop;
      if (!reduceMotion && Math.abs(offset) >= 0.5) {
        animationsRef.current.push(
          item.animate([{ translate: `0 ${offset}px` }, { translate: "none" }], {
            duration: REORDER_DURATION_MS,
            easing: "cubic-bezier(0.2, 0, 0, 1)",
          }),
        );
      }
    }

    previousTopsRef.current = nextTops;
  });

  useLayoutEffect(
    () => () => {
      for (const animation of animationsRef.current) animation.cancel();
    },
    [],
  );

  return (
    <div ref={listRef} className={cn(className)} {...props}>
      {children}
    </div>
  );
}
