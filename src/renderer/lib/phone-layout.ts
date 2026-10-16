import { useSyncExternalStore } from "react";

// Keep in sync with the `phone:` Tailwind variant in styles.css. A short,
// coarse-pointer landscape viewport is a phone; a narrow desktop window is not.
const phoneLayoutQuery =
  "(pointer: coarse) and (max-width: 620px), (pointer: coarse) and (max-width: 1000px) and (max-height: 500px)";

export function isPhoneLayout() {
  return window.matchMedia(phoneLayoutQuery).matches;
}

function subscribe(listener: () => void) {
  const query = window.matchMedia(phoneLayoutQuery);
  query.addEventListener("change", listener);
  return () => query.removeEventListener("change", listener);
}

/** Presentation only: resizing never changes saved desktop/workspace state. */
export function usePhoneLayout() {
  return useSyncExternalStore(subscribe, isPhoneLayout, () => false);
}
