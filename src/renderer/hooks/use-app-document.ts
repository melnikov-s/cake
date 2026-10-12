import { useEffect } from "react";
import type { RootStore } from "../stores/RootStore";

export function useAppDocument(root: RootStore) {
  const settings = root.settingsStore;
  const extensionUi = root.extensionUiStore;
  useEffect(() => {
    document.documentElement.dataset.theme = settings.appearance.theme;
    return () => {
      delete document.documentElement.dataset.theme;
    };
  }, [settings.appearance.theme]);
  useEffect(() => {
    document.title = extensionUi.title ? `${extensionUi.title} · Cake` : "Cake";
  }, [extensionUi.title]);
}
