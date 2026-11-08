import { useSyncExternalStore } from "react";

// Any input, not just the primary one: a touch-first hybrid may have a mouse.
const hoverPointerQuery = "(any-hover: hover) and (any-pointer: fine)";
const snapshot = () => window.matchMedia(hoverPointerQuery).matches;
function subscribe(listener: () => void) {
  const query = window.matchMedia(hoverPointerQuery);
  query.addEventListener("change", listener);
  return () => query.removeEventListener("change", listener);
}

export function useHoverPointer() {
  return useSyncExternalStore(subscribe, snapshot, () => false);
}
