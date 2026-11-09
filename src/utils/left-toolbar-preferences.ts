export type LeftToolbarLayout = "full" | "slim" | "dynamic";

export interface LeftToolbarPreferences {
  readonly autoHide: boolean;
  readonly layout: LeftToolbarLayout;
  /** Layout to restore on leaving Auto-hide; never transient disclosure state. */
  readonly previousLayout?: LeftToolbarLayout;
}

export type LeftToolbarChange = Partial<Pick<LeftToolbarPreferences, "autoHide" | "layout">>;

export const defaultLeftToolbarPreferences = (): LeftToolbarPreferences => ({
  autoHide: false,
  layout: "dynamic",
});

/** Repair legacy/externally stored Auto-hide + Dynamic deterministically. */
export function normalizeLeftToolbarPreferences(
  value: LeftToolbarPreferences = defaultLeftToolbarPreferences(),
): LeftToolbarPreferences {
  if (!value.autoHide) return { autoHide: false, layout: value.layout };
  return {
    autoHide: true,
    layout: value.layout === "dynamic" ? "full" : value.layout,
    previousLayout: value.previousLayout ?? value.layout,
  };
}

/** Apply both axes atomically. An explicit layout wins over a restored layout. */
export function changeLeftToolbarPreferences(
  value: LeftToolbarPreferences | undefined,
  change: LeftToolbarChange,
): LeftToolbarPreferences {
  const current = normalizeLeftToolbarPreferences(value);
  const autoHide = change.autoHide ?? current.autoHide;
  if (!autoHide)
    return {
      autoHide: false,
      layout:
        change.layout ?? (current.autoHide ? current.previousLayout : current.layout) ?? "full",
    };
  return normalizeLeftToolbarPreferences({
    autoHide: true,
    layout: change.layout ?? current.layout,
    previousLayout: current.autoHide ? current.previousLayout : current.layout,
  });
}
