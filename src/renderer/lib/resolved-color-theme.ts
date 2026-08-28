import { useSyncExternalStore } from "react";

export type ResolvedColorTheme = "light" | "dark";

const darkModeQuery = "(prefers-color-scheme: dark)";
const listeners = new Set<() => void>();
let themeObserver: MutationObserver | undefined;
let colorSchemeQuery: MediaQueryList | undefined;

function currentTheme(): ResolvedColorTheme {
  const preference = document.documentElement.dataset.theme;
  if (preference === "light" || preference === "dark") return preference;
  return window.matchMedia?.(darkModeQuery).matches ? "dark" : "light";
}

function notifyThemeChanged() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (listeners.size === 1) {
    themeObserver = new MutationObserver(notifyThemeChanged);
    themeObserver.observe(document.documentElement, {
      attributeFilter: ["data-theme"],
      attributes: true,
    });
    colorSchemeQuery = window.matchMedia?.(darkModeQuery);
    colorSchemeQuery?.addEventListener("change", notifyThemeChanged);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size > 0) return;
    themeObserver?.disconnect();
    themeObserver = undefined;
    colorSchemeQuery?.removeEventListener("change", notifyThemeChanged);
    colorSchemeQuery = undefined;
  };
}

/** Resolves Cake's explicit theme and follows the OS while the preference is system. */
export function useResolvedColorTheme(): ResolvedColorTheme {
  return useSyncExternalStore<ResolvedColorTheme>(subscribe, currentTheme, () => "light");
}
