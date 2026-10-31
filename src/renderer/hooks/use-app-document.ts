import { useEffect, useLayoutEffect } from "react";
import { applyDocumentTheme } from "../lib/resolved-color-theme";
import type { RootStore } from "../stores/RootStore";

export function useAppDocument(root: RootStore) {
  const settings = root.settingsStore;
  const extensionUi = root.extensionUiStore;
  const customTheme = settings.appearance.activeImportedTheme;
  const themeChoice = settings.appearance.selectedThemeChoice;
  useLayoutEffect(() => {
    applyDocumentTheme(themeChoice, customTheme);
    return () => applyDocumentTheme("system");
  }, [themeChoice, customTheme]);
  useEffect(() => {
    document.title = extensionUi.title ? `${extensionUi.title} · Cake` : "Cake";
  }, [extensionUi.title]);
}
