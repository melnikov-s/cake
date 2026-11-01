import { useEffect, useLayoutEffect } from "react";
import { applyDocumentTheme, useSystemColorTheme } from "../lib/resolved-color-theme";
import type { RootStore } from "../stores/RootStore";

export function useAppDocument(root: RootStore) {
  const settings = root.settingsStore;
  const extensionUi = root.extensionUiStore;
  const appearance = settings.appearance;
  const systemTheme = useSystemColorTheme();
  useLayoutEffect(() => {
    appearance.setSystemColorScheme(systemTheme);
  }, [appearance, systemTheme]);
  const mode = appearance.theme;
  const customTheme = appearance.activeCustomTheme;
  useLayoutEffect(() => {
    applyDocumentTheme(mode, customTheme);
    return () => applyDocumentTheme("system");
  }, [mode, customTheme]);
  useEffect(() => {
    document.title = extensionUi.title ? `${extensionUi.title} · Cake` : "Cake";
  }, [extensionUi.title]);
}
