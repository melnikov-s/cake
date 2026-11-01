import { useSyncExternalStore } from "react";
import type {
  EditorColorTheme,
  ImportedColorTheme,
  AppearanceMode,
} from "../../contracts/themes/color-theme";
import { cakeThemeTokens } from "../../utils/vscode-theme";

let importedTheme: ImportedColorTheme | undefined;
let appliedTokens: string[] = [];

/** Window-scoped DOM projection of AppearanceSettingsStore, not a persistence authority. */
export function applyDocumentTheme(choice: AppearanceMode, custom?: ImportedColorTheme) {
  // Worktree status colors belong to Cake's light/dark CSS, never to a theme.
  for (const token of [...appliedTokens, "--worktree-open", "--worktree-merged"])
    document.documentElement.style.removeProperty(token);
  const tokens = custom ? cakeThemeTokens(custom) : {};
  appliedTokens = Object.keys(tokens);
  for (const [token, value] of Object.entries(tokens))
    document.documentElement.style.setProperty(token, value);
  importedTheme = custom;
  document.documentElement.dataset.theme = custom?.type ?? choice;
  notifyThemeChanged();
}

export function currentEditorTheme(): EditorColorTheme {
  return importedTheme ?? resolvedColorTheme();
}

export function useEditorColorTheme(): EditorColorTheme {
  return useSyncExternalStore(subscribe, currentEditorTheme, () => "light");
}

type ResolvedColorTheme = "light" | "dark";

const darkModeQuery = "(prefers-color-scheme: dark)";
const listeners = new Set<() => void>();
let themeObserver: MutationObserver | undefined;
let colorSchemeQuery: MediaQueryList | undefined;

function resolvedColorTheme(): ResolvedColorTheme {
  const preference = document.documentElement.dataset.theme;
  if (preference === "light" || preference === "dark") return preference;
  return systemColorTheme();
}

function systemColorTheme(): ResolvedColorTheme {
  return window.matchMedia?.(darkModeQuery).matches ? "dark" : "light";
}

/** Theme cards follow the OS independently of the current app selection. */
export function useSystemColorTheme(): ResolvedColorTheme {
  return useSyncExternalStore(subscribe, systemColorTheme, () => "light");
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
