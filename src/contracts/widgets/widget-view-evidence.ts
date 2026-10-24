export const INITIAL_WIDGET_PREVIEW_LABEL = "Initial state—not current interactive view";

export function retainedWidgetPreviewEvidence(exactRef: string) {
  return {
    provenance: "retained-initial-state" as const,
    label: INITIAL_WIDGET_PREVIEW_LABEL,
    exactRef,
    interactiveState: "unavailable: retained preview does not track interactive selections",
  };
}
